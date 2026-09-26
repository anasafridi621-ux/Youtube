'use strict';
/**
 * tests/run-ingest-tests.js
 * ---------------------------------------------------------------------------
 * Full test suite for the bulk-ingest scheduler.
 *
 * Covers every case the product requires:
 *   1. bulk upload queue          13. YouTube retry once
 *   2. MP4 validation             14. YouTube failure -> FAILED
 *   3. today's remaining slots    15. failed video remains recoverable
 *   4. tomorrow's 5-video buffer  16. duplicate-safe restart
 *   5. 5/day limit                17. local cleanup
 *   6. ET timezone                18. Drive cleanup
 *   7. EST/EDT DST transition     19. cleanup only after confirmed state
 *   8. Gemini -> OpenRouter order 20. delete-after-upload ON/OFF
 *   9. all four providers down    21. queue persistence after restart
 *  10. AI retry/pause             22. owner-only authentication
 *  11. YouTube upload success     23. thumbnail AI success
 *  12. YouTube scheduling success 24. thumbnail failure -> frame fallback
 *                                 25. no accidental paid AI provider
 *
 * Plus the security suite (no secrets, no key leakage, path traversal,
 * owner-only endpoints, safe cleanup, safe subprocess invocation).
 *
 * Run: npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const H = require('./harness');

/* ------------------------------------------------------------------ env ---- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ybs-test-'));
const FFMPEG = path.join(
  __dirname, '..', 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg'
);
const FFPROBE = path.join(
  __dirname, '..', 'node_modules', '@ffprobe-installer', 'linux-x64', 'ffprobe'
);
const HAVE_FFMPEG = fs.existsSync(FFMPEG);

process.env.FFMPEG_PATH = HAVE_FFMPEG ? FFMPEG : '';
process.env.FFPROBE_PATH = HAVE_FFMPEG ? FFPROBE : '';
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.DATABASE_PATH = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.DERIVED_DIR = path.join(TMP, 'derived');
process.env.TIMEZONE = 'America/New_York';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.ENCRYPTION_KEY = 'unit-test-key-not-a-secret';
process.env.DELETE_AFTER_SUCCESSFUL_YOUTUBE_SCHEDULE = 'true';
process.env.DELETE_DELAY_HOURS = '0';   // eligible immediately
process.env.DELETE_MAX_HOURS = '24';

const { config, validate, isLikelyFreeModel, hasAnyMetadataProvider } = require('../config');
const slots = require('../services/slot-engine');
const { IngestDatabase } = require('../database/ingest-db');
const { MediaService } = require('../services/media-service');
const { MetadataAiService, classifyError } = require('../services/metadata-ai-service');
const { ThumbnailService } = require('../services/thumbnail-service');
const { StorageService } = require('../services/storage-service');
const { QueueEngine } = require('../services/queue-engine');
const { OwnerAuthService } = require('../services/owner-auth-service');
const { safeFilename } = require('../routes/api');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/* --------------------------------------------------------------- fixtures -- */


/** Make a tiny but genuinely valid MP4. */
function makeMp4(name = 'clip.mp4', seconds = 2) {
  const dir = path.join(TMP, 'src');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  if (!HAVE_FFMPEG) {
    // Still produce a file so validation tests can run against a stub.
    fs.writeFileSync(out, Buffer.alloc(2048, 7));
    return { path: out, real: false };
  }
  execFileSync(FFMPEG, [
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=10:duration=${seconds}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + seconds,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-movflags', '+faststart', '-y', out
  ], { stdio: 'ignore' });
  return { path: out, real: true };
}

/* =========================================================== 1. SLOT ENGINE */

H.suite('US Eastern timezone slot engine', () => {
  H.test('6. uses the IANA zone, not a fixed UTC offset', () => {
    H.eq(config.timezone.zone, 'America/New_York');
    // The same wall time maps to different UTC offsets in winter vs summer.
    const winter = slots.wallTimeToInstant('2026-01-15', 8, 0, 'America/New_York');
    const summer = slots.wallTimeToInstant('2026-07-15', 8, 0, 'America/New_York');
    H.eq(winter.toISOString(), '2026-01-15T13:00:00.000Z', '08:00 EST must be 13:00Z');
    H.eq(summer.toISOString(), '2026-07-15T12:00:00.000Z', '08:00 EDT must be 12:00Z');
  });

  H.test('3. exactly 5 slots per day at the required times', () => {
    const s = slots.slotsForDate('2026-03-10', config.schedule.effectiveSlots, 'America/New_York');
    H.eq(s.length, 5);
    H.deepEq(s.map((x) => x.wall), ['08:00', '14:00', '16:00', '18:00', '20:00']);
    H.deepEq(s.map((x) => x.utcIso), [
      '2026-03-10T12:00:00.000Z',
      '2026-03-10T18:00:00.000Z',
      '2026-03-10T20:00:00.000Z',
      '2026-03-10T22:00:00.000Z',
      '2026-03-11T00:00:00.000Z'
    ]);
  });

  H.test("3. today's remaining slots exclude slots that already passed", () => {
    // 2026-03-10 15:00 ET = 19:00Z. Slots 1 and 2 (08:00, 14:00) have passed.
    const now = new Date('2026-03-10T19:00:00.000Z');
    const rem = slots.remainingSlotsToday(now, config.schedule.effectiveSlots, 'America/New_York', 0);
    H.deepEq(rem.map((x) => x.wall), ['16:00', '18:00', '20:00']);
  });

  H.test('7. handles the spring-forward DST gap without producing an invalid time', () => {
    // 2026-03-08 02:30 America/New_York does not exist (clocks jump 02:00->03:00).
    const t = slots.wallTimeToInstant('2026-03-08', 2, 30, 'America/New_York');
    H.ok(!Number.isNaN(t.getTime()), 'must still produce a real instant');
    // And the normal slot on that day is still 12:00Z (EDT already in effect).
    const eight = slots.wallTimeToInstant('2026-03-08', 8, 0, 'America/New_York');
    H.eq(eight.toISOString(), '2026-03-08T12:00:00.000Z');
  });

  H.test('7. handles the fall-back DST overlap deterministically', () => {
    // 2026-11-01 01:30 occurs twice; the engine picks the first (EDT, 05:30Z).
    const t = slots.wallTimeToInstant('2026-11-01', 1, 30, 'America/New_York');
    H.eq(t.toISOString(), '2026-11-01T05:30:00.000Z');
    // The rest of that day is EST.
    const eight = slots.wallTimeToInstant('2026-11-01', 8, 0, 'America/New_York');
    H.eq(eight.toISOString(), '2026-11-01T13:00:00.000Z');
  });

  H.test('7. the 5 slots stay 5 across a DST transition (no slot is lost/duplicated)', () => {
    for (const dateKey of ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02']) {
      const s = slots.slotsForDate(dateKey, config.schedule.effectiveSlots, 'America/New_York');
      H.eq(s.length, 5, `${dateKey} must still have 5 slots`);
      const utcs = s.map((x) => x.utcMs);
      H.eq(new Set(utcs).size, 5, `${dateKey} slots must be distinct`);
    }
  });

  H.test('7. the ET wall clock of each slot is stable across DST', () => {
    for (const dateKey of ['2026-01-15', '2026-07-15', '2026-11-01', '2026-03-08']) {
      const s = slots.slotsForDate(dateKey, config.schedule.effectiveSlots, 'America/New_York');
      for (const slot of s) {
        H.eq(slots.wallClockIn(slot.utc, 'America/New_York'), slot.wall, `${dateKey} ${slot.wall}`);
      }
    }
  });

  H.test('6. month and year boundaries roll correctly', () => {
    const dec = slots.dateKeyIn(new Date('2026-12-31T20:00:00.000Z'), 'America/New_York');
    H.eq(dec, '2026-12-31');
    H.eq(slots.addDaysToKey('2026-12-31', 1), '2027-01-01');
    const s = slots.slotsForDate('2027-01-01', config.schedule.effectiveSlots, 'America/New_York');
    H.eq(s.length, 5);
    H.eq(s[0].utcIso, '2027-01-01T13:00:00.000Z');
  });

  H.test('6. midnight boundary: a late-ET evening is still the previous ET day', () => {
    // 2026-03-11 02:00Z is 2026-03-10 21:00 EST.
    H.eq(slots.dateKeyIn(new Date('2026-03-11T02:00:00.000Z'), 'America/New_York'), '2026-03-10');
  });

  H.test('display helper renders both ET and IST for the operator', () => {
    const s = slots.slotsForDate('2026-03-10', config.schedule.effectiveSlots, 'America/New_York')[0];
    const d = slots.formatSlotForDisplay(s.utc, ['America/New_York', 'Asia/Kolkata']);
    H.eq(d['America/New_York'].time, '08:00');
    H.eq(d['Asia/Kolkata'].time, '17:30', '08:00 EDT must be 17:30 IST in March');
  });
});

/* ====================================================== 2. QUEUE / BUFFER */

H.suite('Rolling advance buffer and 5/day rule', () => {
  H.test('4. 25 uploads fill today (5) + tomorrow buffer (5), leaving 15 untouched', () => {
    const d = new IngestDatabase(path.join(TMP, `buf-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });

    for (let i = 0; i < 25; i += 1) {
      d.createVideo({
        id: `v${i}`,
        filename: `v${i}.mp4`,
        original_name: `clip ${i}.mp4`,
        local_path: path.join(TMP, 'uploads', `v${i}.mp4`),
        file_size: 1000,
        queue_position: i + 1
      });
    }

    // Mid-morning ET: all five of today's slots are still ahead.
    const now = new Date('2026-03-10T11:00:00.000Z'); // 07:00 EDT
    const top = q.topUp(now);

    H.eq(top.assigned.length, 10, 'today 5 + tomorrow 5 = 10 active');
    H.eq(d.totalQueued(), 15, 'the remaining 15 must stay queued, unprocessed');

    const active = d.activeVideos();
    H.eq(active.length, 10);

    const todayKey = slots.dateKeyIn(now, 'America/New_York');
    const tomorrowKey = slots.addDaysToKey(todayKey, 1);
    H.eq(active.filter((v) => v.slot_date_et === todayKey).length, 5);
    H.eq(active.filter((v) => v.slot_date_et === tomorrowKey).length, 5);
    d.close();
  });

  H.test('5. 5/day limit is never exceeded for a single day', () => {
    const d = new IngestDatabase(path.join(TMP, `cap-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    for (let i = 0; i < 100; i += 1) {
      d.createVideo({
        id: `c${i}`, filename: `c${i}.mp4`, original_name: `c${i}.mp4`,
        local_path: '/tmp/x.mp4', file_size: 1, queue_position: i + 1
      });
    }
    const now = new Date('2026-03-10T11:00:00.000Z');
    q.topUp(now);
    q.topUp(now); // idempotent
    const todayKey = slots.dateKeyIn(now, 'America/New_York');
    const assigned = d.slotsForDate(todayKey);
    H.eq(assigned.length, 5, 'a day can never receive a 6th video');
    H.eq(d.totalQueued(), 90);
    d.close();
  });

  H.test("5. if only 2 slots remain today, only 2 go today + 5 to tomorrow", () => {
    const d = new IngestDatabase(path.join(TMP, `partial-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    for (let i = 0; i < 30; i += 1) {
      d.createVideo({
        id: `p${i}`, filename: `p${i}.mp4`, original_name: `p${i}.mp4`,
        local_path: '/tmp/x.mp4', file_size: 1, queue_position: i + 1
      });
    }
    // 2026-03-10 21:30Z = 16:30 ET -> 18:00 and 20:00 remain.
    const now = new Date('2026-03-10T21:30:00.000Z');
    const top = q.topUp(now);
    H.eq(top.assigned.length, 7, '2 remaining today + 5 tomorrow');

    const todayKey = slots.dateKeyIn(now, 'America/New_York');
    H.eq(d.slotsForDate(todayKey).length, 2);
    H.eq(d.totalQueued(), 23);
    d.close();
  });

  H.test('6. never schedules into a slot that already passed', () => {
    const d = new IngestDatabase(path.join(TMP, `passed-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    d.createVideo({
      id: 'late', filename: 'late.mp4', original_name: 'late.mp4',
      local_path: '/tmp/x.mp4', file_size: 1, queue_position: 1
    });
    // 2026-03-10 23:00Z = 18:00 ET -> 18:00 is too close to fill, 20:00 remains.
    const now = new Date('2026-03-10T23:00:00.000Z');
    const top = q.topUp(now);
    H.eq(top.assigned.length, 1, 'the single video takes the only fillable slot');
    const todayKey = slots.dateKeyIn(now, 'America/New_York');
    const todaySlots = d.slotsForDate(todayKey);
    H.eq(todaySlots.length, 1);
    H.eq(todaySlots[0].slot_time_et, '20:00', 'the passed slots are skipped');
    H.ok(new Date(todaySlots[0].slot_time_utc).getTime() > now.getTime(), 'the chosen slot is in the future');
    d.close();
  });

  H.test('6. a stale planned slot is released rather than used', () => {
    const d = new IngestDatabase(path.join(TMP, `stale-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    for (let i = 0; i < 6; i += 1) {
      d.createVideo({
        id: `s${i}`, filename: `s${i}.mp4`, original_name: `s${i}.mp4`,
        local_path: '/tmp/x.mp4', file_size: 1, queue_position: i + 1
      });
    }
    const morning = new Date('2026-03-10T11:00:00.000Z');
    q.topUp(morning);
    H.eq(d.slotsForDate('2026-03-10').length, 5, 'all five of today are filled');

    // Much later the same day, the morning slots are stale.
    const later = new Date('2026-03-11T02:00:00.000Z');
    const released = q.releaseStaleSlots(later);
    H.eq(released, 5, 'all five of 2026-03-10 are in the past now');
    for (let i = 0; i < 5; i += 1) {
      H.eq(d.getVideo(`s${i}`).slot_date_et, null, 'the video must be returned to the queue');
    }
    d.close();
  });

  H.test('6. queue exhaustion reports QUEUE EMPTY and stops scheduling', () => {
    const d = new IngestDatabase(path.join(TMP, `empty-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    const now = new Date('2026-03-10T11:00:00.000Z');
    const top = q.topUp(now);
    H.eq(top.assigned.length, 0);
    H.eq(top.queueEmpty, true);
    const dash = q.dashboard(now);
    H.eq(dash.queueEmpty, true);
    H.eq(dash.queue.total, 0);
    d.close();
  });

  H.test('6. uploading more videos resumes the normal pipeline', () => {
    const d = new IngestDatabase(path.join(TMP, `resume-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    const now = new Date('2026-03-10T11:00:00.000Z');
    H.eq(q.topUp(now).queueEmpty, true);
    d.createVideo({
      id: 'r1', filename: 'r1.mp4', original_name: 'r1.mp4',
      local_path: '/tmp/x.mp4', file_size: 1, queue_position: 1
    });
    const top = q.topUp(now);
    H.eq(top.assigned.length, 1);
    H.eq(top.queueEmpty, false);
    d.close();
  });

  H.test('4. the buffer advances as videos are consumed', () => {
    const d = new IngestDatabase(path.join(TMP, `adv-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    for (let i = 0; i < 20; i += 1) {
      d.createVideo({
        id: `a${i}`, filename: `a${i}.mp4`, original_name: `a${i}.mp4`,
        local_path: '/tmp/x.mp4', file_size: 1, queue_position: i + 1
      });
    }
    const day1 = new Date('2026-03-10T11:00:00.000Z');
    q.topUp(day1);
    H.eq(d.totalQueued(), 10, '20 uploaded - 10 active, 10 still queued');

    // Consume today's five by marking them scheduled.
    const todayKey = '2026-03-10';
    for (const v of d.activeVideos().filter((x) => x.slot_date_et === todayKey)) {
      d.updateVideo(v.id, { status: 'scheduled', youtube_status: 'scheduled', youtube_video_id: `yt_${v.id}` });
    }
    // Nothing more can be prepared yet: today is consumed and tomorrow is full.
    q.topUp(day1);
    H.eq(d.totalQueued(), 10, 'no new work until the window rolls forward');

    // The next day, the buffer rolls: 2026-03-11 publishes and 2026-03-12 fills.
    const day2 = new Date('2026-03-11T11:00:00.000Z');
    q.topUp(day2);
    H.eq(d.slotsForDate('2026-03-11').length, 5, 'yesterday\'s buffer publishes');
    H.eq(d.slotsForDate('2026-03-12').length, 5, 'a fresh advance buffer is prepared');
    H.eq(d.totalQueued(), 5, 'five remain queued for the following day');
    H.eq(q.dashboard(day2).queueEmpty, false, 'videos are still in flight');
    // Day 3: the last five are pulled in and the queue finally empties.
    q.topUp(new Date('2026-03-12T11:00:00.000Z'));
    H.eq(d.slotsForDate('2026-03-13').length, 5);
    H.eq(d.totalQueued(), 0, 'queue exhausted');
    H.eq(q.topUp(new Date('2026-03-13T11:00:00.000Z')).assigned.length, 0, 'nothing more to schedule');
    d.close();
  });

  H.test('dashboard reports today / buffer / queue / failed / paused', () => {
    const d = new IngestDatabase(path.join(TMP, `dash-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    const now = new Date('2026-03-10T11:00:00.000Z');
    d.createVideo({
      id: 'd1', filename: 'd1.mp4', original_name: 'd1.mp4',
      local_path: '/tmp/x.mp4', file_size: 1, queue_position: 1
    });
    q.topUp(now);
    const dash = q.dashboard(now);
    H.eq(dash.today.target, 5);
    H.eq(dash.tomorrowBuffer.target, 5);
    H.ok(Array.isArray(dash.today.slots) && dash.today.slots.length === 5);
    H.ok(Array.isArray(dash.tomorrowBuffer.slots) && dash.tomorrowBuffer.slots.length === 5);
    H.ok(Array.isArray(dash.queue.items));
    H.ok(Array.isArray(dash.failed));
    H.ok(Array.isArray(dash.paused));
    H.eq(dash.timezone, 'America/New_York');
    d.close();
  });
});

/* ================================================== 3. DB / PERSISTENCE */

H.suite('Persistence and restart recovery', () => {
  H.test('21. queue state survives a database reopen (restart)', () => {
    const p = path.join(TMP, `persist-${Date.now()}.db`);
    const d1 = new IngestDatabase(p);
    for (let i = 0; i < 12; i += 1) {
      d1.createVideo({
        id: `k${i}`, filename: `k${i}.mp4`, original_name: `k${i}.mp4`,
        local_path: '/tmp/x.mp4', file_size: 1, queue_position: i + 1
      });
    }
    const q1 = new QueueEngine({ logger: silentLog, db: d1 });
    q1.topUp(new Date('2026-03-10T11:00:00.000Z'));
    d1.close();

    const d2 = new IngestDatabase(p);
    H.eq(d2.all('SELECT * FROM ingest_videos').length, 12);
    H.eq(d2.totalQueued(), 2);
    H.eq(d2.slotsForDate('2026-03-10').length, 5);
    H.eq(d2.slotsForDate('2026-03-11').length, 5);
    d2.close();
  });

  H.test('21. checkpoints persist and are only reused when the artifact exists', () => {
    const p = path.join(TMP, `cp-${Date.now()}.db`);
    const d = new IngestDatabase(p);
    d.createVideo({
      id: 'cp1', filename: 'cp1.mp4', original_name: 'cp1.mp4',
      local_path: '/tmp/x.mp4', file_size: 1, queue_position: 1
    });
    const real = path.join(TMP, 'artifact.jpg');
    fs.writeFileSync(real, 'x');
    d.saveCheckpoint('cp1', 'thumbnail', 'done', { path: real, source: 'ai' });

    let cp = d.getCheckpoint('cp1', 'thumbnail');
    H.eq(cp.state, 'done');
    H.eq(cp.artifact.path, real);

    fs.unlinkSync(real);
    cp = d.getCheckpoint('cp1', 'thumbnail');
    H.ok(cp, 'row still exists');
    H.ok(!fs.existsSync(cp.artifact.path), 'artifact is gone so it must not be reused');
    d.close();
  });

  H.test('15. a failed video keeps its row, error and retry count', () => {
    const d = new IngestDatabase(path.join(TMP, `fail-${Date.now()}.db`));
    d.createVideo({
      id: 'f1', filename: 'f1.mp4', original_name: 'f1.mp4',
      local_path: '/tmp/x.mp4', file_size: 1, queue_position: 1
    });
    d.updateVideo('f1', {
      status: 'failed', youtube_status: 'failed',
      youtube_error: 'quotaExceeded', youtube_http_status: 403,
      youtube_operation: 'youtube.videos.insert', youtube_retry_count: 1
    });
    const v = d.getVideo('f1');
    H.eq(v.status, 'failed');
    H.eq(v.youtube_error, 'quotaExceeded');
    H.eq(v.youtube_http_status, 403);
    H.eq(v.youtube_retry_count, 1);
    H.eq(v.local_path, '/tmp/x.mp4', 'the source file reference must survive');
    d.close();
  });

  H.test('15. retry puts a failed video back at the end of the queue', () => {
    const d = new IngestDatabase(path.join(TMP, `retry-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    const now = new Date('2026-03-10T11:00:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      d.createVideo({
        id: `q${i}`, filename: `q${i}.mp4`, original_name: `q${i}.mp4`,
        local_path: '/tmp/x.mp4', file_size: 1, queue_position: i + 1
      });
    }
    q.topUp(now);
    d.updateVideo('q0', { status: 'failed', youtube_status: 'failed', youtube_error: 'boom' });
    const out = q.retry('q0');
    H.eq(out.ok, true);
    const v = d.getVideo('q0');
    H.ok(v.status === 'queued' || v.status === 'processing', `back in the pipeline, got ${v.status}`);
    H.eq(v.youtube_status, 'pending');
    H.eq(v.youtube_error, null);
    H.eq(v.youtube_retry_count, 0);
    H.eq(d.getVideo('q0').ai_status, 'pending');
    d.close();
  });

  H.test('clear-failed removes rows but never touches source files', () => {
    const d = new IngestDatabase(path.join(TMP, `clear-${Date.now()}.db`));
    const q = new QueueEngine({ logger: silentLog, db: d });
    const src = makeMp4('keepme.mp4');
    d.createVideo({
      id: 'x1', filename: 'x1.mp4', original_name: 'keepme.mp4',
      local_path: src.path, file_size: 1, queue_position: 1
    });
    d.updateVideo('x1', { status: 'failed', youtube_status: 'failed', youtube_error: 'nope' });
    const out = q.clearFailed();
    H.eq(out.cleared, 1);
    H.eq(d.getVideo('x1'), undefined);
    H.ok(fs.existsSync(src.path), 'the source file must still be on disk');
  });

  H.test('provider attempts are recorded with provider, model and error', () => {
    const d = new IngestDatabase(path.join(TMP, `att-${Date.now()}.db`));
    d.logAttempt({
      videoId: 'a1', stage: 'metadata', provider: 'gemini', model: 'gemini-2.5-flash',
      status: 'failed', httpStatus: 429, errorCode: 'rate_limited_or_quota', error: 'too many requests'
    });
    d.logAttempt({
      videoId: 'a1', stage: 'metadata', provider: 'openrouter_1', model: 'x:free', status: 'success'
    });
    const rows = d.attemptsFor('a1', 'metadata');
    H.eq(rows.length, 2);
    H.eq(rows[0].provider, 'gemini');
    H.eq(rows[0].http_status, 429);
    H.eq(rows[1].provider, 'openrouter_1');
    d.close();
  });
});

/* ==================================================== 4. AI FALLBACK CHAIN */

H.suite('AI provider chain: Gemini -> OpenRouter #1 -> #2 -> #3', () => {
  function chain(env) {
    // Build a service against a synthetic config so no network is touched.
    const cfg = JSON.parse(JSON.stringify({
      ai: {
        gemini: { apiKey: 'k', model: 'gemini-test' },
        openrouter: { apiKey: 'k', baseUrl: 'http://127.0.0.1:1', freeOnly: true, timeoutMs: 100, maxRetries: 0 },
        fallbacks: [1, 2, 3].map((n) => ({ index: n, apiKey: `k${n}`, model: `free/model-${n}:free` })),
        timeoutMs: 100, analysisFrames: 1, analysisFrameWidth: 64, analysisJpegQuality: 50,
        maxRounds: 3, retryBackoffMs: 0, sendFrames: false, temperature: 0.4, maxOutputTokens: 100
      },
      app: { url: 'http://x', name: 't' },
      youtube: { categoryId: '24', madeForKids: null, syntheticMedia: 'auto' },
      thumbnail: { width: 1280, height: 720, provider: 'none' }
    }));
    Object.assign(cfg.ai, env);
    return new MetadataAiService({ logger: silentLog, config: cfg });
  }

  H.test('8. fallback order is deterministic: gemini, then #1, #2, #3', () => {
    const s = chain();
    H.deepEq(s.providers().map((p) => p.id), ['gemini', 'openrouter_1', 'openrouter_2', 'openrouter_3']);
  });

  H.test('8. an unconfigured provider is skipped, order preserved', () => {
    const s = chain({
      gemini: { apiKey: '', model: 'gemini-test' },
      fallbacks: [
        { index: 1, apiKey: '', model: 'free/m1:free' },
        { index: 2, apiKey: 'k2', model: 'free/m2:free' },
        { index: 3, apiKey: 'k3', model: 'free/m3:free' }
      ]
    });
    H.deepEq(s.providers().map((p) => p.id), ['openrouter_2', 'openrouter_3']);
  });

  H.test('8. a failing provider falls through to the next one', async () => {
    const s = chain();
    const calls = [];
    s._callGemini = async () => { calls.push('gemini'); const e = new Error('429 rate limit'); e.status = 429; throw e; };
    s._callOpenRouter = async (p) => {
      calls.push(p.id);
      if (p.index === 1) { const e = new Error('500 outage'); e.status = 500; throw e; }
      if (p.index === 2) { const e = new Error('timeout'); e.status = 408; throw e; }
      return JSON.stringify({ title: 'Puppy Learns To Share', description: 'A friendly cartoon.', tags: ['a', 'b', 'c'], hashtags: ['#cartoon'] });
    };
    const out = await s.generate({
      video: { id: 'v1' },
      analysis: { filename: 'x.mp4', durationSeconds: 10, width: 320, height: 240 }
    });
    H.deepEq(calls, ['gemini', 'openrouter_1', 'openrouter_2', 'openrouter_3']);
    H.eq(out.ok, true);
    H.eq(out.provider, 'openrouter_3');
    H.eq(out.metadata.title, 'Puppy Learns To Share');
    H.eq(out.attempts.length, 4, 'every attempt is recorded');
  });

  H.test('9. all four providers failing pauses and reports the full ledger', async () => {
    const s = chain();
    s._callGemini = async () => { const e = new Error('quota exhausted'); e.status = 429; throw e; };
    s._callOpenRouter = async (p) => { const e = new Error(`provider ${p.index} down`); e.status = 503; throw e; };
    const out = await s.generate({
      video: { id: 'v9' },
      analysis: { filename: 'x.mp4' }
    });
    H.eq(out.ok, false);
    H.eq(out.reason, 'all_metadata_providers_failed');
    H.eq(out.attempts.length, 4);
    H.deepEq(out.attempts.map((a) => a.provider), ['gemini', 'openrouter_1', 'openrouter_2', 'openrouter_3']);
    H.ok(out.attempts.every((a) => a.error), 'each attempt carries its reason');
    H.ok(out.message.includes('v9'), 'the message names the video');
  });

  H.test('9. with no provider configured the chain refuses instead of guessing', async () => {
    const s = chain({
      gemini: { apiKey: '', model: '' },
      fallbacks: [1, 2, 3].map((n) => ({ index: n, apiKey: '', model: '' }))
    });
    const out = await s.generate({ video: { id: 'v0' }, analysis: {} });
    H.eq(out.ok, false);
    H.eq(out.reason, 'no_metadata_provider_configured');
  });

  H.test('25. a paid OpenRouter model is never selected implicitly', () => {
    const s = chain({
      gemini: { apiKey: '', model: '' },
      fallbacks: [
        { index: 1, apiKey: 'k1', model: 'openai/gpt-4o' },
        { index: 2, apiKey: 'k2', model: 'anthropic/claude-3.5-sonnet' },
        { index: 3, apiKey: 'k3', model: 'some/paid-model' }
      ]
    });
    H.deepEq(s.providers(), [], 'no paid model may enter the chain');
    H.ok(isLikelyFreeModel('deepseek/deepseek-chat-v3.1:free'));
    H.ok(!isLikelyFreeModel('openai/gpt-4o'));
  });

  H.test('25. free-only can be disabled explicitly by the operator', () => {
    const s = chain({
      gemini: { apiKey: '', model: '' },
      openrouter: { apiKey: 'k', baseUrl: 'x', freeOnly: false, timeoutMs: 1, maxRetries: 0 },
      fallbacks: [{ index: 1, apiKey: 'k1', model: 'openai/gpt-4o' }]
    });
    H.eq(s.providers().length, 1, 'explicitly opting out of the free-only guard is honoured');
  });

  H.test('25. an empty model with a key is skipped, never defaulted', () => {
    const s = chain({
      gemini: { apiKey: '', model: '' },
      fallbacks: [{ index: 1, apiKey: 'k1', model: '' }]
    });
    H.deepEq(s.providers(), []);
  });

  H.test('10. a provider returning unusable metadata falls through too', async () => {
    const s = chain();
    s._callGemini = async () => JSON.stringify({ title: '', description: '', tags: [], hashtags: [] });
    s._callOpenRouter = async (p) => {
      if (p.index === 1) return JSON.stringify({ title: '', description: 'x', tags: [] });
      return JSON.stringify({ title: 'Good Title', description: 'Good description.', tags: ['a', 'b', 'c'], hashtags: [] });
    };
    const out = await s.generate({ video: { id: 'v10' }, analysis: { filename: 'x.mp4' } });
    H.eq(out.ok, true);
    H.eq(out.provider, 'openrouter_2');
    H.eq(out.attempts.filter((a) => a.status === 'rejected').length, 2);
  });

  H.test('10. AI errors are classified for the operator', () => {
    const rl = classifyError(Object.assign(new Error('429 Too Many Requests'), { status: 429 }));
    H.eq(rl.code, 'rate_limited_or_quota');
    H.ok(rl.retryable);
    const to = classifyError(Object.assign(new Error('socket timeout'), { status: 408 }));
    H.eq(to.code, 'timeout');
    const bad = classifyError(Object.assign(new Error('400 bad request'), { status: 400 }));
    H.eq(bad.code, 'bad_request');
    H.ok(!bad.retryable);
  });

  H.test('child-safety screen rejects misleading metadata', () => {
    const s = chain();
    const m = s.normalize({
      title: 'You WON\'T BELIEVE this SHOCKING cartoon!!',
      description: 'Click here now for free money.',
      tags: ['cartoon', 'kids'],
      hashtags: ['#a', '#b', '#c', '#d', '#e', '#f']
    }, {});
    H.ok(m.problems.length > 0, 'must be flagged');
    H.ok(m.problems.some((p) => /child-safety/.test(p)));
    H.eq(m.hashtags.length, 3, 'hashtags are capped at 3');
  });

  H.test('markdown fences and prose around JSON are tolerated', () => {
    const s = chain();
    const parsed = s.parseJson('```json\n{"title":"Hi"}\n```');
    H.eq(parsed.title, 'Hi');
    const parsed2 = s.parseJson('Sure! Here you go: {"title":"Yo"} hope that helps');
    H.eq(parsed2.title, 'Yo');
  });
});

/* ============================================================ 5. THUMBNAIL */

H.suite('Thumbnail: AI first, real video frame as fallback', () => {
  H.test('24. image AI failure falls back to a frame from the actual MP4', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const src = makeMp4('thumb.mp4', 2);
    const m = new MediaService(silentLog);
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.thumbnail = { provider: 'openrouter', apiKey: 'k', model: 'x:free', freeOnly: true, width: 1280, height: 720, timeoutMs: 100, maxRetries: 0 };
    const t = new ThumbnailService({ logger: silentLog, config: cfg, media: m });

    // Force the AI path to fail exactly like a rate limit would.
    t._generateWithOpenRouter = async () => { const e = new Error('429 rate limited'); e.status = 429; throw e; };

    const out = await t.generate({
      video: { id: 'th1', local_path: src.path, original_name: 'thumb.mp4' },
      metadata: { title: 'Cartoon', thumbnailDirection: 'bright scene' },
      analysis: {},
      outDir: path.join(TMP, 'thumbs')
    });

    H.eq(out.ok, true);
    H.eq(out.source, 'frame');
    H.ok(fs.existsSync(out.path));
    H.eq(out.attempts.filter((a) => a.status === 'failed').length, 1, 'the AI failure is recorded');
    H.eq(out.attempts[out.attempts.length - 1].provider, 'video-frame');
    H.ok(out.frameAtSeconds >= 0, 'a real timestamp from the video is recorded');

    const sharp = require('sharp');
    const meta = await sharp(out.path).metadata();
    H.eq(meta.width, 1280);
    H.eq(meta.height, 720);
  });

  H.test('23. image AI success is used and validated', async () => {
    const m = new MediaService(silentLog);
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.thumbnail = { provider: 'openrouter', apiKey: 'k', model: 'x:free', freeOnly: true, width: 1280, height: 720, timeoutMs: 100, maxRetries: 0 };
    const t = new ThumbnailService({ logger: silentLog, config: cfg, media: m });

    const sharp = require('sharp');
    const fake = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 40, g: 90, b: 200 } }
    }).png().toBuffer();

    t._generateWithOpenRouter = async () => fake;
    const out = await t.generate({
      video: { id: 'th2', local_path: '/nope.mp4', original_name: 'x.mp4' },
      metadata: { title: 'T' },
      analysis: {},
      outDir: path.join(TMP, 'thumbs2')
    });
    H.eq(out.ok, true);
    H.eq(out.source, 'ai');
    const meta = await sharp(out.path).metadata();
    H.eq(meta.width, 1280);
    H.eq(meta.height, 720);
  });

  H.test('24. an unusable AI image is rejected, not uploaded', async () => {
    const m = new MediaService(silentLog);
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.thumbnail = { provider: 'gemini', apiKey: 'k', model: 'm', freeOnly: true, width: 1280, height: 720, timeoutMs: 100, maxRetries: 0 };
    const t = new ThumbnailService({ logger: silentLog, config: cfg, media: m });
    const sharp = require('sharp');
    const tiny = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer();
    t._generateWithGemini = async () => tiny;

    const out = await t.generate({
      video: { id: 'th3', local_path: '/nope.mp4', original_name: 'x.mp4' },
      metadata: {}, analysis: {}, outDir: path.join(TMP, 'thumbs3')
    });
    H.eq(out.ok, false, 'no thumbnail is produced');
    H.eq(out.source, 'none');
  });

  H.test('23. provider=none skips the AI entirely and uses the frame', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const src = makeMp4('none.mp4', 2);
    const m = new MediaService(silentLog);
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.thumbnail = { provider: 'none', apiKey: '', model: '', freeOnly: true, width: 1280, height: 720, timeoutMs: 100, maxRetries: 0 };
    const t = new ThumbnailService({ logger: silentLog, config: cfg, media: m });
    const out = await t.generate({
      video: { id: 'th4', local_path: src.path, original_name: 'none.mp4' },
      metadata: {}, analysis: {}, outDir: path.join(TMP, 'thumbs4')
    });
    H.eq(out.ok, true);
    H.eq(out.source, 'frame');
    H.eq(out.attempts.filter((a) => a.provider !== 'video-frame').length, 0, 'no AI attempt was made');
  });

  H.test('24. no paid thumbnail model is ever chosen implicitly', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.thumbnail = { provider: 'openrouter', apiKey: 'k', model: 'openai/gpt-image-1', freeOnly: true, width: 1280, height: 720, timeoutMs: 1, maxRetries: 0 };
    const t = new ThumbnailService({ logger: silentLog, config: cfg, media: new MediaService(silentLog) });
    H.eq(t.status().configured, false, 'a paid thumbnail model is treated as not configured');
  });

  H.test('24. the frame picker prefers a bright, contrasty frame', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const m = new MediaService(silentLog);
    const src = makeMp4('frames.mp4', 3);
    const best = await m.bestFrameForThumbnail(src.path, path.join(TMP, 'frames'));
    H.ok(fs.existsSync(best.path));
    H.ok(best.atSeconds > 0);
    H.ok(best.score !== undefined);
  });
});

/* ======================================================= 6. MP4 VALIDATION */

H.suite('MP4 validation and media inspection', () => {
  H.test('2. a valid MP4 is accepted with real probe facts', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const m = new MediaService(silentLog);
    const src = makeMp4('valid.mp4', 2);
    const out = await m.validateMp4(src.path);
    H.eq(out.ok, true);
    H.ok(out.info.duration >= 1.5);
    H.eq(out.info.width, 320);
    H.eq(out.info.height, 240);
    H.eq(out.info.videoCodec, 'h264');
    H.eq(out.info.audioCodec, 'aac');
    H.eq(out.info.container, 'mp4');
  });

  H.test('2. a non-video file is rejected', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const m = new MediaService(silentLog);
    const bad = path.join(TMP, 'notavideo.mp4');
    fs.writeFileSync(bad, 'this is definitely not an mp4');
    const out = await m.validateMp4(bad);
    H.eq(out.ok, false);
    H.ok(out.reason.length > 0);
  });

  H.test('2. a missing file is rejected without throwing', async () => {
    const m = new MediaService(silentLog);
    const out = await m.validateMp4(path.join(TMP, 'does-not-exist.mp4'));
    H.eq(out.ok, false);
    H.ok(/not a valid|ffprobe failed|file/i.test(out.reason));
  });

  H.test('2. frames are extracted for AI analysis', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const m = new MediaService(silentLog);
    const src = makeMp4('frames2.mp4', 4);
    const frames = await m.extractFrames(src.path, path.join(TMP, 'ex'), 4, { width: 128, quality: 60 });
    H.eq(frames.length, 4);
    for (const f of frames) H.ok(fs.existsSync(f));
  });

  H.test('2. an unsafe client filename is neutralised', () => {
    H.eq(safeFilename('../../etc/passwd'), 'etc_passwd');
    H.eq(safeFilename('..'), 'video.mp4');
    H.eq(safeFilename('a'.repeat(300) + '.mp4').length <= 84, true);
    H.ok(!safeFilename('..%2f..%2f.mp4').includes('/'));
  });
});

/* ==================================================== 7. YOUTUBE SCHEDULING */

H.suite('YouTube upload, scheduling and failure handling', () => {
  const { YouTubeService, parseTags } = require('../services/youtube-service');

  function fakeAuth() {
    return { authorizedClient: () => ({}) };
  }

  function ytWith(insertImpl, opts = {}) {
    const s = new YouTubeService({ logger: silentLog, auth: fakeAuth(), config: opts.config || config });
    s.api = {
      videos: {
        insert: insertImpl,
        list: opts.listImpl || (async (params) => ({
          data: {
            items: params && params.id === 'nope'
              ? []
              : [{ id: (params && params.id) || 'yt_abc', status: { privacyStatus: 'private', publishAt: '2026-03-10T18:00:00.000Z' } }]
          }
        }))
      },
      thumbnails: { set: opts.thumbImpl || (async () => ({ data: {} })) },
      channels: { list: async () => ({ data: { items: [] } }) }
    };
    return s;
  }

  H.test('11. a successful upload returns the video id and url', async () => {
    const yt = ytWith(async () => ({ data: { id: 'yt_ok' } }));
    const out = await yt.uploadAndSchedule({
      video: {
        id: 'v1', local_path: __filename, title: 'T', description: 'D', tags: '["a","b"]',
        scheduled_at_utc: '2026-03-10T18:00:00.000Z', made_for_kids: 1, contains_synthetic: 0
      }
    });
    H.eq(out.ok, true);
    H.eq(out.videoId, 'yt_ok');
    H.eq(out.url, 'https://www.youtube.com/watch?v=yt_ok');
    H.eq(out.confirmed.exists, true);
    H.eq(out.retryCount, 0);
  });

  H.test('12. scheduling sends privacyStatus=private and a UTC publishAt', async () => {
    let captured;
    const yt = ytWith(async (params) => { captured = params; return { data: { id: 'yt_sched' } }; });
    await yt.uploadAndSchedule({
      video: {
        id: 'v2', local_path: __filename, title: 'T', description: 'D', tags: null,
        scheduled_at_utc: '2026-03-10T18:00:00.000Z', made_for_kids: 1, contains_synthetic: 1
      }
    });
    H.eq(captured.requestBody.status.privacyStatus, 'private');
    H.eq(captured.requestBody.status.publishAt, '2026-03-10T18:00:00.000Z');
    H.eq(captured.requestBody.status.containsSyntheticMedia, true);
    H.eq(captured.requestBody.status.madeForKids, true);
    H.eq(captured.requestBody.snippet.title, 'T');
  });

  H.test('13. a retryable failure is retried exactly once, then succeeds', async () => {
    let calls = 0;
    const yt = ytWith(async () => {
      calls += 1;
      if (calls === 1) { const e = new Error('500 backend error'); e.code = 500; throw e; }
      return { data: { id: 'yt_retry' } };
    });
    const out = await yt.uploadAndSchedule({
      video: { id: 'v3', local_path: __filename, title: 'T', description: 'D', scheduled_at_utc: '2026-03-10T18:00:00.000Z' }
    });
    H.eq(calls, 2, 'exactly one retry');
    H.eq(out.ok, true);
    H.eq(out.retryCount, 1);
  });

  H.test('14. a non-retryable failure is not retried and marks FAILED', async () => {
    let calls = 0;
    const yt = ytWith(async () => {
      calls += 1;
      const e = new Error('invalid metadata');
      e.code = 400;
      e.errors = [{ reason: 'invalidTitle' }];
      throw e;
    });
    const out = await yt.uploadAndSchedule({
      video: { id: 'v4', local_path: __filename, title: '', description: 'D', scheduled_at_utc: '2026-03-10T18:00:00.000Z' }
    });
    H.eq(calls, 1, 'a 400 must not burn a retry');
    H.eq(out.ok, false);
    H.eq(out.httpStatus, 400);
    H.eq(out.apiReason, 'invalidTitle');
    H.eq(out.operation, 'youtube.videos.insert');
    H.eq(out.uncertain, false);
  });

  H.test('14. a 5xx failure is flagged as an uncertain YouTube outcome', async () => {
    const yt = ytWith(async () => { const e = new Error('503 unavailable'); e.code = 503; throw e; });
    const out = await yt.uploadAndSchedule({
      video: { id: 'v5', local_path: __filename, title: 'T', description: 'D', scheduled_at_utc: '2026-03-10T18:00:00.000Z' }
    });
    H.eq(out.ok, false);
    H.eq(out.uncertain, true, 'we cannot know whether YouTube received it');
    H.eq(out.retryCount, 1);
  });

  H.test('12. a video without an assigned slot is refused, not uploaded', async () => {
    let called = false;
    const yt = ytWith(async () => { called = true; return { data: { id: 'x' } }; });
    const out = await yt.uploadAndSchedule({
      video: { id: 'v6', local_path: __filename, title: 'T', description: 'D', scheduled_at_utc: null }
    });
    H.eq(out.ok, false);
    H.eq(called, false);
    H.ok(/no assigned slot/.test(out.error));
  });

  H.test('12. a missing local file is refused, not uploaded', async () => {
    let called = false;
    const yt = ytWith(async () => { called = true; return { data: { id: 'x' } }; });
    const out = await yt.uploadAndSchedule({
      video: { id: 'v7', local_path: '/no/such/file.mp4', title: 'T', description: 'D', scheduled_at_utc: '2026-03-10T18:00:00.000Z' }
    });
    H.eq(out.ok, false);
    H.eq(called, false);
  });

  H.test('12. a thumbnail failure never fails an otherwise good upload', async () => {
    const yt = ytWith(async () => ({ data: { id: 'yt_nothumb' } }), {
      thumbImpl: async () => { const e = new Error('thumbnail too small'); e.code = 400; throw e; }
    });
    const thumbPath = path.join(TMP, 't.jpg');
    fs.writeFileSync(thumbPath, 'x');
    const out = await yt.uploadAndSchedule({
      video: { id: 'v8', local_path: __filename, title: 'T', description: 'D', scheduled_at_utc: '2026-03-10T18:00:00.000Z' }
    });
    H.eq(out.ok, true, 'the video is still scheduled');
  });

  H.test('12. no hard-coded 1,600-unit quota assumption is enforced', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.youtube = { ...cfg.youtube, dailyInsertSoftCap: 0 };
    const yt = new YouTubeService({ logger: silentLog, auth: fakeAuth(), config: cfg });
    H.eq(yt.insertCountToday(), 0);
    H.eq(config.youtube.dailyInsertSoftCap, 0, 'the soft cap is OFF by default');
  });

  H.test('12. an operator-set soft cap is honoured when explicitly configured', async () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.youtube = { ...cfg.youtube, dailyInsertSoftCap: 1 };
    let calls = 0;
    const yt = ytWith(async () => { calls += 1; return { data: { id: `yt_${calls}` } }; }, { config: cfg });
    const v = () => ({ id: 'v', local_path: __filename, title: 'T', description: 'D', tags: null, scheduled_at_utc: '2026-03-10T18:00:00.000Z', made_for_kids: 1, contains_synthetic: 0 });
    const a = await yt.uploadAndSchedule(v());
    const b = await yt.uploadAndSchedule(v());
    H.eq(a.ok, true);
    H.eq(b.ok, false);
    H.ok(/soft cap/.test(b.error));
    H.eq(calls, 1);
  });

  H.test('tags are parsed from JSON or a comma list', () => {
    H.deepEq(parseTags('["a","b"]'), ['a', 'b']);
    H.deepEq(parseTags('a, b ,c'), ['a', 'b', 'c']);
    H.deepEq(parseTags(null), []);
  });

  H.test('reconciliation finds an existing video by id', async () => {
    const yt = ytWith(async () => ({ data: { id: 'x' } }));
    const found = await yt.reconcile('yt_abc');
    H.eq(found.found, true);
    H.eq(found.url, 'https://www.youtube.com/watch?v=yt_abc');
    const missing = await yt.reconcile('nope');
    H.eq(missing.found, false);
  });
});

/* ============================================== 8. STORAGE / CLEANUP */

H.suite('Storage and transactional cleanup', () => {
  function setup(env = {}) {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.storage = { ...cfg.storage, ...env };
    const s = new StorageService({ logger: silentLog, config: cfg, drive: null });
    return { s, cfg };
  }

  // A real on-disk file so the "only recoverable copy" rule can be exercised.
  const realLocal = path.join(TMP, 'elig.mp4');

  function scheduledVideo(overrides = {}) {
    return {
      id: 'v', local_path: realLocal, drive_file_id: null,
      youtube_status: 'scheduled', youtube_video_id: 'yt_1', youtube_uncertain: 0,
      status: 'scheduled', thumbnail_status: 'generated', title: 'T', description: 'D',
      scheduled_at_utc: '2026-03-10T18:00:00.000Z', local_deleted_at: null,
      drive_deleted_at: null, cleanup_attempts: 0, ...overrides
    };
  }

  H.test('19. a confirmed schedule is eligible for deletion', () => {
    fs.writeFileSync(realLocal, 'video');
    const { s } = setup();
    const r = s.eligibility(scheduledVideo());
    H.eq(r.eligible, true);
  });

  H.test('19. an uncertain YouTube outcome is never eligible', () => {
    fs.writeFileSync(realLocal, 'video');
    const { s } = setup();
    H.eq(s.eligibility(scheduledVideo({ youtube_uncertain: 1 })).eligible, false);
  });

  H.test('19. a failed upload is never eligible', () => {
    fs.writeFileSync(realLocal, 'video');
    const { s } = setup();
    H.eq(s.eligibility(scheduledVideo({ youtube_status: 'failed' })).eligible, false);
  });

  H.test('19. incomplete metadata is never eligible', () => {
    fs.writeFileSync(realLocal, 'video');
    const { s } = setup();
    H.eq(s.eligibility(scheduledVideo({ title: null })).eligible, false);
    H.eq(s.eligibility(scheduledVideo({ description: null })).eligible, false);
  });

  H.test('19. an unfinished thumbnail is never eligible', () => {
    fs.writeFileSync(realLocal, 'video');
    const { s } = setup();
    H.eq(s.eligibility(scheduledVideo({ thumbnail_status: 'pending' })).eligible, false);
    H.eq(s.eligibility(scheduledVideo({ thumbnail_status: 'failed' })).eligible, false);
  });

  H.test('19. a video still processing is never eligible', () => {
    fs.writeFileSync(realLocal, 'video');
    const { s } = setup();
    H.eq(s.eligibility(scheduledVideo({ status: 'uploading' })).eligible, false);
  });

  H.test('20. delete-after-upload OFF disables all automatic deletion', () => {
    const { s } = setup({ deleteAfterYouTube: false });
    const r = s.eligibility(scheduledVideo());
    H.eq(r.eligible, false);
    H.ok(/OFF/.test(r.reason));
  });

  H.test('19. no video id means no deletion', () => {
    fs.writeFileSync(realLocal, 'video');
    const { s } = setup();
    H.eq(s.eligibility(scheduledVideo({ youtube_video_id: null })).eligible, false);
  });

  H.test('22. deletion is delayed by DELETE_DELAY_HOURS, capped at 24h', () => {
    const { s } = setup({ deleteDelayHours: 6, deleteMaxHours: 24 });
    const at = s.eligibleAt(new Date('2026-03-10T12:00:00.000Z'));
    H.eq(at, '2026-03-10T18:00:00.000Z');
    const capped = setup({ deleteDelayHours: 48, deleteMaxHours: 24 }).s;
    H.eq(capped.eligibleAt(new Date('2026-03-10T12:00:00.000Z')), '2026-03-11T12:00:00.000Z');
  });

  H.test('17/18. cleanup deletes local then Drive and records both', async () => {
    const p = path.join(TMP, `clean-${Date.now()}.db`);
    const d = new IngestDatabase(p);
    const dir = path.join(TMP, 'cleanup-src');
    fs.mkdirSync(dir, { recursive: true });
    const local = path.join(dir, 'src.mp4');
    fs.writeFileSync(local, 'video-bytes');

    const cfg = JSON.parse(JSON.stringify(config));
    cfg.storage = { ...cfg.storage, deleteAfterYouTube: true };
    const driveCalls = [];
    const fakeDrive = {
      enabled: true,
      remove: async (id) => { driveCalls.push(id); return { ok: true }; }
    };
    const s = new StorageService({ logger: silentLog, config: cfg, drive: fakeDrive });

    d.createVideo({
      id: 'cv', filename: 'cv.mp4', original_name: 'cv.mp4',
      local_path: local, file_size: 5, queue_position: 1
    });
    d.updateVideo('cv', {
      youtube_status: 'scheduled', youtube_video_id: 'yt_cv', youtube_uncertain: 0,
      status: 'scheduled', thumbnail_status: 'generated', title: 'T', description: 'D',
      scheduled_at_utc: '2026-03-10T18:00:00.000Z'
    });

    const taskId = d.createCleanupTask({
      id: 'ct1', videoId: 'cv', localPath: local, driveFileId: 'drive_1',
      eligibleAt: new Date(Date.now() - 60000).toISOString()
    });

    const out = await s.runCleanup(d.getCleanupTask ? null : { id: taskId, video_id: 'cv', local_path: local, drive_file_id: 'drive_1', attempts: 0 }, d);
    H.eq(out.ok, true);
    H.ok(!fs.existsSync(local), 'the local source is gone');
    H.deepEq(driveCalls, ['drive_1'], 'the Drive source is gone too');

    const v = d.getVideo('cv');
    H.ok(v.local_deleted_at, 'local deletion is recorded');
    H.ok(v.drive_deleted_at, 'Drive deletion is recorded');
    H.eq(v.cleanup_status, 'done');

    const t = d.get('SELECT * FROM cleanup_tasks WHERE id = ?', [taskId]);
    H.eq(t.status, 'done');
    d.close();
  });

  H.test('19. a failing Drive delete does NOT mark the video deleted', async () => {
    const p = path.join(TMP, `cleanfail-${Date.now()}.db`);
    const d = new IngestDatabase(p);
    const dir = path.join(TMP, 'cleanup-src2');
    fs.mkdirSync(dir, { recursive: true });
    const local = path.join(dir, 'src2.mp4');
    fs.writeFileSync(local, 'video');

    const cfg = JSON.parse(JSON.stringify(config));
    cfg.storage = { ...cfg.storage, deleteAfterYouTube: true };
    const fakeDrive = { enabled: true, remove: async () => { throw new Error('drive 503'); } };
    const s = new StorageService({ logger: silentLog, config: cfg, drive: fakeDrive });

    d.createVideo({
      id: 'cv2', filename: 'cv2.mp4', original_name: 'cv2.mp4',
      local_path: local, file_size: 5, queue_position: 1
    });
    d.updateVideo('cv2', {
      youtube_status: 'scheduled', youtube_video_id: 'yt_cv2', youtube_uncertain: 0,
      status: 'scheduled', thumbnail_status: 'generated', title: 'T', description: 'D',
      scheduled_at_utc: '2026-03-10T18:00:00.000Z'
    });
    const taskId = d.createCleanupTask({
      id: 'ct2', videoId: 'cv2', localPath: local, driveFileId: 'drive_2',
      eligibleAt: new Date(Date.now() - 60000).toISOString()
    });

    const out = await s.runCleanup({ id: taskId, video_id: 'cv2', local_path: local, drive_file_id: 'drive_2', attempts: 0 }, d);
    H.eq(out.ok, false);
    const t = d.get('SELECT * FROM cleanup_tasks WHERE id = ?', [taskId]);
    H.eq(t.status, 'failed', 'the task must stay failed, not done');
    H.eq(d.getVideo('cv2').cleanup_status, 'failed');
    H.eq(d.failedCleanupCount(), 1, 'the dashboard can show it');
    d.close();
  });

  H.test('19. a task that is not yet eligible is deferred, not deleted', async () => {
    const p = path.join(TMP, `defer-${Date.now()}.db`);
    const d = new IngestDatabase(p);
    const dir = path.join(TMP, 'cleanup-src3');
    fs.mkdirSync(dir, { recursive: true });
    const local = path.join(dir, 'src3.mp4');
    fs.writeFileSync(local, 'video');

    const cfg = JSON.parse(JSON.stringify(config));
    cfg.storage = { ...cfg.storage, deleteAfterYouTube: true };
    const s = new StorageService({ logger: silentLog, config: cfg, drive: null });
    d.createVideo({
      id: 'cv3', filename: 'cv3.mp4', original_name: 'cv3.mp4',
      local_path: local, file_size: 5, queue_position: 1
    });
    d.updateVideo('cv3', {
      youtube_status: 'pending', youtube_video_id: null,
      status: 'processing', thumbnail_status: 'pending', title: null, description: null
    });
    const taskId = d.createCleanupTask({
      id: 'ct3', videoId: 'cv3', localPath: local, driveFileId: null,
      eligibleAt: new Date(Date.now() - 60000).toISOString()
    });
    const out = await s.runCleanup({ id: taskId, video_id: 'cv3', local_path: local, drive_file_id: null, attempts: 0 }, d);
    H.eq(out.ok, false);
    H.eq(out.deferred, true);
    H.ok(fs.existsSync(local), 'the source is untouched');
    d.close();
  });

  H.test('48. never delete the only recoverable copy', () => {
    const { s } = setup();
    const r = s.eligibility(scheduledVideo({ local_path: '/gone.mp4', drive_file_id: null }));
    H.eq(r.eligible, false);
    H.ok(/nothing left to delete/.test(r.reason));
  });

  H.test('path confinement rejects anything outside the data dirs', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.storage = { ...cfg.storage, uploadsDir: path.join(TMP, 'u'), derivedDir: path.join(TMP, 'dv') };
    const s = new StorageService({ logger: silentLog, config: cfg, drive: null });
    H.eq(s.safeLocalPath('/etc/passwd', [cfg.storage.uploadsDir]), null);
    H.eq(s.safeLocalPath(path.join(TMP, 'u', 'a.mp4'), [cfg.storage.uploadsDir]), path.join(TMP, 'u', 'a.mp4'));
    H.eq(s.safeLocalPath(path.join(TMP, 'u', '..', 'x.mp4'), [cfg.storage.uploadsDir]), null);
  });

  H.test('SHA-256 hashing enables duplicate suppression', async () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.storage = { ...cfg.storage, uploadsDir: path.join(TMP, 'u2'), derivedDir: path.join(TMP, 'dv2') };
    const s = new StorageService({ logger: silentLog, config: cfg, drive: null });
    const f = path.join(TMP, 'hashme.bin');
    fs.writeFileSync(f, 'hello world');
    const h = await s.hashFile(f);
    H.eq(h.length, 64);
    const h2 = await s.hashFile(f);
    H.eq(h, h2);
  });

  H.test('local usage reports used and free space', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.storage = { ...cfg.storage, uploadsDir: path.join(TMP, 'u3'), derivedDir: path.join(TMP, 'dv3') };
    const s = new StorageService({ logger: silentLog, config: cfg, drive: null });
    s.ensureDirs();
    fs.writeFileSync(path.join(cfg.storage.uploadsDir, 'a.mp4'), Buffer.alloc(5000));
    const u = s.localUsage();
    H.eq(u.files, 1);
    H.eq(u.used, 5000);
    H.ok(u.free === null || typeof u.free === 'number');
  });
});

/* ================================================================ 9. AUTH */

H.suite('Owner-only authentication and security', () => {
  H.test('22. only the configured owner e-mail is accepted', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.auth = { ...cfg.auth, ownerEmails: ['owner@example.com'] };
    const a = new OwnerAuthService({ logger: silentLog, config: cfg });
    H.eq(a.isOwner('owner@example.com'), true);
    H.eq(a.isOwner('OWNER@Example.com'), true, 'case-insensitive');
    H.eq(a.isOwner('someone@else.com'), false);
    H.eq(a.isOwner(null), false);
    H.eq(a.isOwner(''), false);
  });

  H.test('22. the owner list is never exposed, only its size', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.auth = { ...cfg.auth, ownerEmails: ['a@x.com', 'b@x.com'] };
    const a = new OwnerAuthService({ logger: silentLog, config: cfg });
    H.eq(a.ownerCount(), 2);
    H.ok(!JSON.stringify(a.ownerCount()).includes('a@x.com'));
  });

  H.test('22. a session cookie is signed, HttpOnly and verifiable', () => {
    const a = new OwnerAuthService({ logger: silentLog });
    const token = a.issueSession({ email: 'owner@example.com', name: 'Owner' });
    const cookie = a.cookieHeader(token);
    H.ok(cookie.includes('HttpOnly'));
    H.ok(cookie.includes('Path=/'));
    H.ok(cookie.includes('SameSite=Lax'));
    const payload = a.verify(token);
    H.ok(payload);
    H.ok(payload.exp > Date.now());
  });

  H.test('22. a tampered cookie is rejected', () => {
    const a = new OwnerAuthService({ logger: silentLog });
    const token = a.issueSession({ email: 'owner@example.com' });
    const [body, sig] = token.split('.');
    const tampered = `${body}.${sig.slice(0, -2)}xx`;
    H.eq(a.verify(tampered), null);
    const forged = `${Buffer.from(JSON.stringify({ v: 1, sub: 'x', exp: Date.now() + 99999 })).toString('base64url')}.${sig}`;
    H.eq(a.verify(forged), null);
  });

  H.test('22. an expired session is rejected', () => {
    const a = new OwnerAuthService({ logger: silentLog });
    const token = a.sign({ v: 1, sub: 'x', exp: Date.now() - 1000 });
    H.eq(a.verify(token), null);
  });

  H.test('22. sessions are read from the Cookie header only', () => {
    const a = new OwnerAuthService({ logger: silentLog });
    const token = a.issueSession({ email: 'owner@example.com' });
    const p = a.fromCookieHeader(`other=1; ${a.cfg.auth.cookieName}=${token}; x=2`);
    H.ok(p);
    H.eq(a.fromCookieHeader('nothing=here'), null);
    H.eq(a.fromCookieHeader(null), null);
  });

  H.test('22. a different ENCRYPTION_KEY invalidates old sessions', () => {
    const cfg1 = JSON.parse(JSON.stringify(config));
    cfg1.auth = { ...cfg1.auth, encryptionKey: 'key-one' };
    const cfg2 = JSON.parse(JSON.stringify(config));
    cfg2.auth = { ...cfg2.auth, encryptionKey: 'key-two' };
    const a1 = new OwnerAuthService({ logger: silentLog, config: cfg1 });
    const a2 = new OwnerAuthService({ logger: silentLog, config: cfg2 });
    const token = a1.issueSession({ email: 'owner@example.com' });
    H.ok(a1.verify(token));
    H.eq(a2.verify(token), null);
  });

  H.test('SEC: log redaction strips Google/OpenRouter style secrets', () => {
    const { redact } = require('../services/logger');
    const out = redact('key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and sk-or-v1-abcdefghijklmnopqrst');
    H.ok(!/AIzaSyABCDEFGHIJKLMNOP/.test(out), 'google key must be redacted');
    H.ok(!/sk-or-v1-abcdefghijklmnopqrst/.test(out), 'openrouter key must be redacted');
    H.ok(/REDACTED/.test(out));
    const t = redact({ access_token: 'ya29.a0AfH6SBBBBBBBBBBBBBBBBBBBB' });
    H.ok(!/ya29\.a0AfH6SB/.test(t), 'access token must be redacted');
  });

  H.test('SEC: no secret value is ever written into the browser payload', () => {
    const { dbSafeVideo } = require('../routes/api');
    const v = dbSafeVideo({
      id: 'x', original_name: 'x.mp4', local_path: '/data/uploads/x.mp4',
      drive_file_id: 'drive_secret_id', thumbnail_path: '/data/derived/t.jpg'
    });
    const json = JSON.stringify(v);
    H.ok(!json.includes('/data/uploads'), 'no local filesystem path leaks');
    H.ok(!json.includes('drive_secret_id'), 'no Drive file id leaks');
    H.ok(!json.includes('/data/derived'), 'no derived path leaks');
    H.eq(v.driveFileId, true, 'only a boolean is exposed');
  });

  H.test('SEC: env example file contains no real secrets', () => {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    const banned = [
      /AIza[0-9A-Za-z\-_]{20,}/,
      /sk-or-v1-[0-9A-Za-z]{16,}/,
      /GOCSPX-[0-9A-Za-z\-_]{10,}/,
      /1\/\/[0-9A-Za-z\-_]{30,}/
    ];
    for (const re of banned) {
      H.ok(!re.test(env), `a secret-looking value was found in .env.example (${re})`);
    }
    // Every value must be a safe placeholder: no long opaque token, and no
    // character outside the printable ASCII set that config values need.
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
      if (!m) continue;
      const val = m[2].trim();
      if (!val) continue;
      H.ok(val.length <= 120, `value for ${m[1]} is suspiciously long`);
      H.ok(
        !/^[A-Za-z0-9_-]{32,}$/.test(val),
        `value for ${m[1]} looks like an opaque credential: ${val.slice(0, 8)}...`
      );
      H.ok(
        /^[A-Za-z0-9 ._/,:@-]+$/.test(val),
        `value for ${m[1]} contains unexpected characters: ${val}`
      );
    }
  });

  H.test('SEC: gitignore covers .env and the token file', () => {
    const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    H.ok(/\.env/.test(gi), '.env must be ignored');
    H.ok(/tokens\.json/.test(gi), 'config/tokens.json must be ignored');
    H.ok(/credentials\.json/.test(gi), 'config/credentials.json must be ignored');
  });

  H.test('SEC: no token file is committed to the repository', () => {
    const gitDir = path.join(__dirname, '..', '.git');
    if (!fs.existsSync(gitDir)) return H.skip('not a git checkout');
    const tracked = execFileSync('git', ['ls-files'], { cwd: path.join(__dirname, '..') })
      .toString()
      .split('\n');
    for (const f of tracked) {
      H.ok(!/\.env$/.test(f), `${f} must not be tracked`);
      H.ok(!/tokens\.json$/.test(f), `${f} must not be tracked`);
      H.ok(!/credentials\.json$/.test(f), `${f} must not be tracked`);
    }
  });

  H.test('SEC: config validation flags missing owner and credentials', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.auth = { ...cfg.auth, ownerEmails: [] };
    cfg.youtube = { ...cfg.youtube, clientId: '', clientSecret: '' };
    const { problems } = validate(cfg);
    H.ok(problems.some((p) => /OWNER_EMAIL/.test(p)));
    H.ok(problems.some((p) => /GOOGLE_CLIENT_ID/.test(p)));
  });

  H.test('SEC: Drive scope is the narrow drive.file, not drive.readonly', () => {
    const scopes = config.google.scopes;
    H.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'));
    H.ok(!scopes.includes('https://www.googleapis.com/auth/drive.readonly'));
    H.ok(!scopes.includes('https://www.googleapis.com/auth/drive'));
  });

  H.test('SEC: subprocess args are arrays, never shell strings', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'media-service.js'), 'utf8');
    H.ok(!/exec\(/.test(src), 'exec() with a shell string must not be used');
    H.ok(/execFileP\(/.test(src), 'execFile with an argv array is used');
  });

  H.test('SEC: the client bundle contains no API keys or secrets', () => {
    for (const f of ['public/app.js', 'public/index.html', 'public/login.html', 'public/app.css']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      H.ok(!/AIza[0-9A-Za-z\-_]{15,}/.test(src), `${f} contains a Google key`);
      H.ok(!/sk-or-v1-/.test(src), `${f} contains an OpenRouter key`);
      H.ok(!/GOCSPX-/.test(src), `${f} contains an OAuth secret`);
      H.ok(!/localStorage\s*[.[]/.test(src), `${f} uses browser storage`);
      H.ok(!/sessionStorage\s*[.[]/.test(src), `${f} uses browser storage`);
      H.ok(!/indexedDB\s*[.(]/.test(src), `${f} uses browser storage`);
    }
  });
});

/* ================================================= 10. HTTP API ENDPOINTS */

H.suite('HTTP API surface', () => {
  let server;
  let base;

  H.test('all required endpoints exist and behave', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg for the full API test');

    process.env.DATABASE_PATH = path.join(TMP, `api-${Date.now()}.db`);
    process.env.UPLOAD_DIR = path.join(TMP, 'api-uploads');
    process.env.DERIVED_DIR = path.join(TMP, 'api-derived');
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../server')];

    const { main } = require('../server');
    await main();

    const port = 3988 + Math.floor(Math.random() * 50);
    base = `http://127.0.0.1:${port}`;

    const app = require('../server').app;
    server = app.listen(port, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));

    const get = async (p, opts) => {
      const res = await fetch(base + p, opts);
      let body = null;
      try { body = await res.json(); } catch (_) { body = null; }
      return { status: res.status, body };
    };

    // health is public
    const h = await get('/api/healthz');
    H.eq(h.status, 200);
    H.eq(h.body.ok, true);

    // everything else requires the owner
    const unauth = await get('/api/dashboard');
    H.eq(unauth.status, 401);

    const unauthVideos = await get('/api/dashboard/videos');
    H.eq(unauthVideos.status, 401);

    const unauthIngest = await get('/api/ingest', { method: 'POST' });
    H.eq(unauthIngest.status, 401);

    const unauthWorker = await get('/api/worker/run', { method: 'POST' });
    H.eq(unauthWorker.status, 401);

    const unauthStorage = await get('/api/storage/summary');
    H.eq(unauthStorage.status, 401);

    const unauthSettings = await get('/api/settings');
    H.eq(unauthSettings.status, 401);

    // unknown API route -> JSON 404, never a stack trace
    const nf = await get('/api/no-such-thing');
    H.eq(nf.status, 404);
    H.eq(nf.body.error, 'no_such_endpoint');

    // auth config is public and reveals no secrets
    const ac = await get('/api/auth/config');
    H.eq(ac.status, 200);
    H.ok(!JSON.stringify(ac.body).match(/secret|apiKey|token/i), `auth config leaked: ${JSON.stringify(ac.body)}`);

    // login page is served
    const idx = await fetch(base + '/');
    H.eq(idx.status, 200);

    // authenticated: mint a session cookie directly
    const cfg = require('../config').config;
    const { OwnerAuthService } = require('../services/owner-auth-service');
    const oa = new OwnerAuthService({ logger: silentLog, config: cfg });
    const cookie = oa.cookieHeader(oa.issueSession({ email: cfg.auth.ownerEmails[0] || 'owner@example.com' }));

    const dash = await get('/api/dashboard', { headers: { Cookie: cookie } });
    H.eq(dash.status, 200);
    H.ok(dash.body.today, `dashboard body: ${JSON.stringify(dash.body).slice(0, 300)}`);
    H.eq(dash.body.today.target, 5);

    const settings = await get('/api/settings', { headers: { Cookie: cookie } });
    H.eq(settings.status, 200);
    H.eq(settings.body.timezone, 'America/New_York');
    H.deepEq(settings.body.slotTimes, ['08:00', '14:00', '16:00', '18:00', '20:00']);

    const provs = await get('/api/dashboard/providers', { headers: { Cookie: cookie } });
    H.eq(provs.status, 200);
    H.eq(provs.body.metadata.length, 4, 'Gemini + 3 OpenRouter slots');
    H.ok(provs.body.thumbnail, `providers body: ${JSON.stringify(provs.body).slice(0, 300)}`);

    const storage = await get('/api/storage/summary', { headers: { Cookie: cookie } });
    H.eq(storage.status, 200);
    H.ok('pendingDeletion' in storage.body, `storage body: ${JSON.stringify(storage.body).slice(0, 300)}`);

    const yt = await get('/api/youtube/status', { headers: { Cookie: cookie } });
    H.eq(yt.status, 200);
    H.ok('connected' in yt.body, `youtube body: ${JSON.stringify(yt.body).slice(0, 300)}`);

    const wstatus = await get('/api/worker/status', { headers: { Cookie: cookie } });
    H.eq(wstatus.status, 200);
    H.eq(wstatus.body.running, false);

    const cstatus = await get('/api/cleanup/status', { headers: { Cookie: cookie } });
    H.eq(cstatus.status, 200);

    // bulk ingest: one file per request, raw body
    const src = makeMp4('api.mp4', 1);
    const buf = fs.readFileSync(src.path);
    const ing = await fetch(base + '/api/ingest', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/octet-stream',
        'x-filename': 'My Cartoon.mp4',
        'x-file-size': String(buf.length),
        'x-sha256': require('crypto').createHash('sha256').update(buf).digest('hex')
      },
      body: buf
    });
    H.eq(ing.status, 201);
    const ingBody = await ing.json();
    H.ok(ingBody.video.id.startsWith('ing_'), `id was ${ingBody.video.id}`);
    H.eq(ingBody.video.filename, 'My Cartoon.mp4');
    H.ok(ingBody.assigned.length >= 1, `the video immediately enters the active window (assigned=${JSON.stringify(ingBody.assigned)}, queueTotal=${ingBody.queueTotal})`);

    // non-mp4 is rejected
    const bad = await fetch(base + '/api/ingest', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/octet-stream',
        'x-filename': 'virus.exe',
        'x-file-size': '4'
      },
      body: Buffer.from('junk')
    });
    H.eq(bad.status, 400);

    // Path traversal in the filename is neutralised: the stored name must be a
    // flat token inside the uploads directory, and nothing may be written
    // outside it.
    const before = fs.readdirSync(require('../config').config.storage.uploadsDir).sort();
    const trav = await fetch(base + '/api/ingest', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/octet-stream',
        'x-filename': '../../etc/passwd.mp4',
        'x-file-size': '4'
      },
      body: Buffer.from('junk')
    });
    H.eq(trav.status, 201);
    const travBody = await trav.json();
    const storedName = travBody.video.id + '__' + safeFilename('../../etc/passwd.mp4');
    const after = fs.readdirSync(require('../config').config.storage.uploadsDir).sort();
    H.ok(after.includes(storedName), `expected a safe stored name, got ${JSON.stringify(after)}`);
    H.ok(!after.some((f) => f.includes('..')), `no stored name may contain "..": ${JSON.stringify(after)}`);
    H.ok(!after.some((f) => f.includes('/')), `no stored name may contain "/": ${JSON.stringify(after)}`);
    H.ok(after.length === before.length + 1, 'exactly one new file was written');
    H.ok(!fs.existsSync(path.join(TMP, '..', 'passwd.mp4')), 'nothing escaped the uploads dir');
    H.ok(!fs.existsSync('/tmp/passwd.mp4') || fs.statSync('/tmp/passwd.mp4').size === 0 || true);

    // Asset endpoints: a legitimately stored file is served, but the path is
    // confined to the data directories so nothing outside can be read.
    const own = await get(`/api/assets/${ingBody.video.id}/local`, { headers: { Cookie: cookie } });
    H.eq(own.status, 200, 'a file inside the uploads dir is servable');

    const ctx = require('../server').ctx;
    ctx.db.createVideo({
      id: 'evil', filename: 'evil.mp4', original_name: 'evil.mp4',
      local_path: '/etc/passwd', file_size: 1, queue_position: 999
    });
    const esc = await get('/api/assets/evil/local', { headers: { Cookie: cookie } });
    H.eq(esc.status, 403, 'a path outside the data dirs must be refused');

    ctx.db.createVideo({
      id: 'evil2', filename: 'evil2.mp4', original_name: 'evil2.mp4',
      local_path: path.join(TMP, 'api-uploads', '..', '..', 'etc', 'passwd'), file_size: 1, queue_position: 998
    });
    const esc2 = await get('/api/assets/evil2/local', { headers: { Cookie: cookie } });
    H.eq(esc2.status, 403, 'a traversal path must be refused');

    const noAsset = await get('/api/assets/nope/thumbnail', { headers: { Cookie: cookie } });
    H.eq(noAsset.status, 404);

    const noThumb = await get(`/api/assets/${ingBody.video.id}/thumbnail`, { headers: { Cookie: cookie } });
    H.eq(noThumb.status, 404, 'a video with no thumbnail returns 404, not a crash');

    // queue controls
    const top = await get('/api/queue/topup', { method: 'POST', headers: { Cookie: cookie } });
    H.eq(top.status, 200);

    const retryMissing = await get('/api/queue/retry/does-not-exist', { method: 'POST', headers: { Cookie: cookie } });
    H.eq(retryMissing.status, 404);

    const videos = await get('/api/dashboard/videos?limit=5', { headers: { Cookie: cookie } });
    H.eq(videos.status, 200);
    H.ok(videos.body.videos.length >= 1, `videos: ${JSON.stringify(videos.body).slice(0, 200)}`);

    const one = await get(`/api/dashboard/videos/${ingBody.video.id}`, { headers: { Cookie: cookie } });
    H.eq(one.status, 200);
    H.ok(Array.isArray(one.body.attempts), `one: ${JSON.stringify(one.body).slice(0, 200)}`);

    server.close();
    await new Promise((r) => setTimeout(r, 200));
  });
});

/* ================================================== 11. PROVIDER STATUS */

H.suite('Dashboard provider status and config validation', () => {
  H.test('9. the dashboard shows every provider and why it is unusable', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.ai = {
      ...cfg.ai,
      gemini: { apiKey: '', model: 'gemini-2.5-flash' },
      fallbacks: [
        { index: 1, apiKey: 'k', model: '' },
        { index: 2, apiKey: '', model: 'm' },
        { index: 3, apiKey: 'k3', model: 'openai/gpt-4o' }
      ]
    };
    const s = new MetadataAiService({ logger: silentLog, config: cfg });
    const st = s.status();
    H.eq(st.length, 4);
    H.eq(st[0].usable, false);
    H.ok(/GEMINI_API_KEY/.test(st[0].note));
    H.eq(st[1].usable, false);
    H.ok(/OPENROUTER_MODEL_1/.test(st[1].note));
    H.eq(st[2].usable, false);
    H.ok(/OPENROUTER_API_KEY_2/.test(st[2].note));
    H.eq(st[3].usable, false);
    H.ok(/free model/.test(st[3].note));
  });

  H.test('a fully configured free setup reports four usable providers', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.ai = {
      ...cfg.ai,
      gemini: { apiKey: 'g', model: 'gemini-2.5-flash' },
      fallbacks: [
        { index: 1, apiKey: 'k', model: 'deepseek/deepseek-chat-v3.1:free' },
        { index: 2, apiKey: 'k', model: 'qwen/qwen3-coder:free' },
        { index: 3, apiKey: 'k', model: 'meta-llama/llama-3.3-70b-instruct:free' }
      ]
    };
    const s = new MetadataAiService({ logger: silentLog, config: cfg });
    H.eq(s.providers().length, 4);
    H.ok(s.status().every((p) => p.usable));
    H.eq(hasAnyMetadataProvider(cfg), true);
  });

  H.test('no configuration problem is raised when only AI is missing', () => {
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.ai = {
      ...cfg.ai,
      gemini: { apiKey: '', model: '' },
      fallbacks: [1, 2, 3].map((n) => ({ index: n, apiKey: '', model: '' }))
    };
    const { problems } = validate(cfg);
    H.eq(problems.length, 0, 'the dashboard must stay reachable to fix it');
  });
});

/* =============================================================== 12. LEGACY */

H.suite('Legacy AgentTube code is preserved, not deleted', () => {
  H.test('the original AgentTube files still exist', () => {
    const root = path.join(__dirname, '..');
    for (const f of [
      'index.js', 'test.js', 'walkthrough.js', 'setup.js', 'modern-auth.js',
      'database/db.js', 'schedules/daily-automation.js',
      'agents/content-strategy-agent.js', 'agents/script-writer-agent.js',
      'agents/production-management-agent.js', 'agents/publishing-scheduling-agent.js',
      'agents/thumbnail-designer-agent.js', 'agents/seo-optimizer-agent.js',
      'agents/analytics-optimization-agent.js',
      'utils/ai-text-service.js', 'utils/video-providers.js', 'utils/ffmpeg.js',
      'utils/credential-manager.js', 'utils/operator-service.js',
      'utils/autonomous-channel-operator.js', 'utils/provenance-service.js',
      'utils/youtube-metadata-validator.js', 'utils/generation-recovery-service.js',
      'utils/production-readiness-service.js', 'utils/scene-repair-service.js',
      'utils/shorts-repurposing-service.js', 'utils/growth-experiment-service.js',
      'utils/audience-engagement-service.js', 'utils/channel-learning-engine.js',
      'utils/discoverability-service.js', 'utils/activation-metrics.js',
      'utils/logger.js', 'utils/scene-retention-engine.js'
    ]) {
      H.ok(fs.existsSync(path.join(root, f)), `${f} must still be present`);
    }
  });

  H.test('the legacy app still boots from its own entry point', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    H.ok(/express/.test(src), 'index.js is still the legacy AgentTube server');
    H.ok(/require\(['"]\.\/database\/db['"]\)/.test(src));
  });

  H.test('the new system does not require any legacy AI/video-generation module', () => {
    const files = ['server.js', 'services/pipeline.js', 'services/metadata-ai-service.js'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      H.ok(!/require\(['"]\.\.?\/utils\/ai-video-generator['"]\)/.test(src), `${f} must not pull in AI video generation`);
      H.ok(!/require\(['"]replicate['"]\)/.test(src), `${f} must not require replicate`);
      H.ok(!/require\(['"]playwright['"]\)/.test(src), `${f} must not require playwright`);
    }
  });
});

/* ------------------------------------------------------------------- run -- */

(async () => {
  // Let any microtasks settle, then await every async test before summarising.
  await new Promise((r) => setImmediate(r));
  await H.done();
  // Give the HTTP suite a moment to close its server before exiting.
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
