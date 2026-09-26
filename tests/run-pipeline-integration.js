'use strict';
/**
 * tests/run-pipeline-integration.js
 * ---------------------------------------------------------------------------
 * End-to-end pipeline integration test.
 *
 * Exercises the REAL pipeline (validate -> analyze -> metadata -> thumbnail ->
 * upload -> confirm -> cleanup) against stub AI and YouTube services, using
 * REAL MP4 files and REAL FFmpeg. Nothing here talks to the network.
 *
 * This is the test that proves the whole chain works, not just its parts.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const H = require('./harness');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ybs-e2e-'));
const FFMPEG = path.join(__dirname, '..', 'node_modules', '@ffmpeg-installer', 'linux-x64', 'ffmpeg');
const FFPROBE = path.join(__dirname, '..', 'node_modules', '@ffprobe-installer', 'linux-x64', 'ffprobe');
const HAVE_FFMPEG = fs.existsSync(FFMPEG);

process.env.FFMPEG_PATH = HAVE_FFMPEG ? FFMPEG : '';
process.env.FFPROBE_PATH = HAVE_FFMPEG ? FFPROBE : '';
process.env.LOG_DIR = path.join(TMP, 'logs');
process.env.DATABASE_PATH = path.join(TMP, 'e2e.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.DERIVED_DIR = path.join(TMP, 'derived');
process.env.TIMEZONE = 'America/New_York';
process.env.OWNER_EMAIL = 'owner@example.com';
process.env.ENCRYPTION_KEY = 'integration-test-key';
process.env.DELETE_AFTER_SUCCESSFUL_YOUTUBE_SCHEDULE = 'true';
process.env.DELETE_DELAY_HOURS = '0';
process.env.DELETE_MAX_HOURS = '24';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

const { config } = require('../config');
const { IngestDatabase } = require('../database/ingest-db');
const { MediaService } = require('../services/media-service');
const { MetadataAiService } = require('../services/metadata-ai-service');
const { ThumbnailService } = require('../services/thumbnail-service');
const { YouTubeService } = require('../services/youtube-service');
const { StorageService } = require('../services/storage-service');
const { QueueEngine } = require('../services/queue-engine');
const { Pipeline } = require('../services/pipeline');
const { CleanupWorker } = require('../services/cleanup-worker');

/* ------------------------------------------------------------------ helpers */

function makeMp4(name, seconds = 2) {
  const dir = path.join(TMP, 'src');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  execFileSync(FFMPEG, [
    '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=12:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-movflags', '+faststart', '-y', out
  ], { stdio: 'ignore' });
  return out;
}

/**
 * A YouTube service whose network calls are replaced by an in-memory store.
 * It still enforces the real code paths: private + publishAt, one retry,
 * confirmation read-back, reconciliation.
 */
function fakeYouTube(behaviour = {}) {
  const yt = new YouTubeService({ logger: silent, auth: { authorizedClient: () => ({}) }, config });
  const store = new Map();       // videoId -> {privacyStatus, publishAt, title}
  const uploads = [];
  const thumbnailSets = [];
  let seq = 0;

  yt.api = {
    videos: {
      insert: async (params) => {
        // A real resumable upload consumes the stream. Drain it so the
        // pipeline's fs.createReadStream is closed rather than left pending.
        await drain(params.media && params.media.body);
        uploads.push(params);
        if (behaviour.failUploads && uploads.length <= behaviour.failUploads) {
          const e = new Error('503 backend error');
          e.code = 503;
          throw e;
        }
        if (behaviour.rejectUpload) {
          const e = new Error('invalid metadata');
          e.code = 400;
          e.errors = [{ reason: 'invalidTitle' }];
          throw e;
        }
        seq += 1;
        const id = `yt_${seq}`;
        store.set(id, {
          privacyStatus: params.requestBody.status.privacyStatus,
          publishAt: params.requestBody.status.publishAt,
          title: params.requestBody.snippet.title
        });
        return { data: { id } };
      },
      list: async (params) => {
        const id = params && params.id;
        if (store.has(id)) return { data: { items: [{ id, status: store.get(id) }] } };
        return { data: { items: [] } };
      }
    },
    thumbnails: {
      set: async (params) => {
        thumbnailSets.push(params);
        if (behaviour.failThumbnail) {
          const e = new Error('thumbnail too small');
          e.code = 400;
          throw e;
        }
        return { data: {} };
      }
    },
    channels: { list: async () => ({ data: { items: [] } }) }
  };

  return { yt, store, uploads, thumbnailSets };
}

/** A metadata AI service that walks the real chain with stubbed transports. */
function fakeMetadataAi(scenario) {
  const s = new MetadataAiService({ logger: silent, config });
  const calls = [];
  // Register the four providers so the chain is walked even when no API keys
  // are present in the environment. The transports below are stubbed anyway.
  const state = { down: scenario === 'all-down' };
  // healthProbe mirrors the stub transports so resume logic can be exercised
  // without any network access.
  s.healthProbe = async () => (state.down ? null : { provider: 'gemini', model: 'gemini-test', ok: true });
  s.setDown = (v) => { state.down = Boolean(v); };
  s.providers = () => [
    { id: 'gemini', label: 'Gemini', model: 'gemini-test', kind: 'gemini' },
    { id: 'openrouter_1', label: 'OpenRouter #1', model: 'free-1:free', kind: 'openrouter', index: 1 },
    { id: 'openrouter_2', label: 'OpenRouter #2', model: 'free-2:free', kind: 'openrouter', index: 2 },
    { id: 'openrouter_3', label: 'OpenRouter #3', model: 'free-3:free', kind: 'openrouter', index: 3 }
  ];
  s._callGemini = async () => {
    calls.push('gemini');
    if (scenario === 'gemini-down' || scenario === 'all-down') {
      const e = new Error('429 quota exhausted');
      e.status = 429;
      throw e;
    }
    return JSON.stringify({
      title: 'Puppy Learns To Share Toys',
      description: 'A gentle cartoon about sharing.\n\nPerfect for young viewers.',
      tags: ['cartoon', 'kids', 'sharing', 'puppy', 'friendship', 'animation'],
      hashtags: ['#cartoon', '#kids'],
      topic: 'sharing and friendship',
      categoryId: '24',
      madeForKids: true,
      appearsAIGenerated: true,
      syntheticConfidence: 'high',
      thumbnailDirection: 'bright close-up of the puppy holding a toy',
      evidence: ['puppy character on screen', 'bright colours'],
      confidence: 0.9
    });
  };
  s._callOpenRouter = async (p) => {
    calls.push(`openrouter_${p.index}`);
    if (scenario === 'all-down') {
      const e = new Error('503 outage');
      e.status = 503;
      throw e;
    }
    return JSON.stringify({
      title: 'Kitten Builds A Tower Of Blocks',
      description: 'A playful cartoon about building.',
      tags: ['cartoon', 'kitten', 'blocks', 'kids'],
      hashtags: ['#cartoon'],
      topic: 'building and play',
      categoryId: '24',
      madeForKids: true,
      appearsAIGenerated: false,
      thumbnailDirection: 'kitten stacking blocks',
      confidence: 0.8
    });
  };
  return { s, calls };
}

function build(env = {}) {
  const db = new IngestDatabase(path.join(TMP, `${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  const media = new MediaService(silent);
  const cfg = JSON.parse(JSON.stringify(config));
  // Isolated storage per instance so concurrent tests can never delete each
  // other's files.
  const root = path.join(TMP, `case-${Math.random().toString(36).slice(2)}`);
  cfg.storage = {
    ...cfg.storage,
    uploadsDir: path.join(root, 'uploads'),
    derivedDir: path.join(root, 'derived'),
    deleteAfterYouTube: true,
    deleteDelayHours: 0,
    ...(env.storage || {})
  };
  cfg.thumbnail = { ...cfg.thumbnail, ...(env.thumbnail || {}) };

  const yt = fakeYouTube(env.youtube || {});
  const ai = fakeMetadataAi(env.aiScenario);
  const drive = env.drive || null;
  const storage = new StorageService({ logger: silent, config: cfg, drive });
  const queue = new QueueEngine({ logger: silent, db, config: cfg });
  const pipeline = new Pipeline({
    logger: silent, db, queue, media,
    metadataAi: ai.s,
    thumbnail: new ThumbnailService({ logger: silent, config: cfg, media }),
    youtube: yt.yt, storage, trends: { enabled: false }
  });
  return { db, media, cfg, yt, ai, drive, storage, queue, pipeline };
}

/** Fully consume a readable stream, the way a real HTTP upload would. */
function drain(stream) {
  if (!stream || typeof stream.on !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    stream.on('data', () => {});
    stream.on('end', done);
    stream.on('error', done);
    stream.on('close', done);
    setImmediate(done);
  });
}

function ingest(d, storage, name) {
  const src = makeMp4(name);
  const id = `ing_${Math.random().toString(36).slice(2, 10)}`;
  storage.ensureDirs();
  const dest = path.join(storage.cfg.storage.uploadsDir, `${id}__${name}`);
  fs.copyFileSync(src, dest);
  return d.createVideo({
    id, filename: `${id}__${name}`, original_name: name,
    local_path: dest, file_size: fs.statSync(dest).size, queue_position: d.nextQueuePosition()
  });
}

/* ============================================================== THE SUITE */

H.suite('Full pipeline end-to-end (real MP4, real FFmpeg, stubbed providers)', () => {
  H.test('the complete chain produces a scheduled video with real metadata', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build();
    b.queue.topUp();
    const v = ingest(b.db, b.storage, 'Happy Puppy Cartoon.mp4');
    b.queue.topUp();

    const out = await b.pipeline.runOnce();

    H.eq(out.scheduled, 1, `expected 1 scheduled, got ${JSON.stringify(out.details)}`);
    const row = b.db.getVideo(v.id);

    H.eq(row.status, 'scheduled');
    H.eq(row.youtube_status, 'scheduled');
    H.ok(row.youtube_video_id, 'a YouTube video id was assigned');
    H.eq(row.title, 'Puppy Learns To Share Toys');
    H.ok(row.description.includes('sharing'));
    H.eq(row.thumbnail_status, 'fallback', 'no AI thumbnail configured -> frame fallback');
    H.ok(row.thumbnail_source === 'frame');
    H.ok(fs.existsSync(row.thumbnail_path), 'the thumbnail file exists on disk');
    H.eq(row.duration_seconds > 1, true, 'real duration from ffprobe');
    H.eq(row.width, 640);
    H.eq(row.height, 360);
    H.eq(row.video_codec, 'h264');
    H.eq(row.audio_codec, 'aac');
    H.eq(row.made_for_kids, 1);
    H.eq(row.contains_synthetic, 1, 'the synthetic disclosure came from the model');
    H.eq(row.ai_provider, 'gemini');
    H.ok(row.scheduled_at_utc, 'a UTC publish time was recorded');
    H.ok(row.cleanup_status === 'eligible');

    // YouTube received the right thing.
    H.eq(b.yt.uploads.length, 1);
    const body = b.yt.uploads[0].requestBody;
    H.eq(body.status.privacyStatus, 'private');
    H.eq(body.status.publishAt, row.scheduled_at_utc);
    H.eq(body.status.madeForKids, true);
    H.eq(body.status.containsSyntheticMedia, true);
    H.eq(body.snippet.title, 'Puppy Learns To Share Toys');
    H.ok(b.yt.store.has(row.youtube_video_id), 'the video exists in the YouTube store');
    H.eq(b.yt.thumbnailSets.length, 1, 'the custom thumbnail was uploaded');
    H.eq(b.yt.thumbnailSets[0].videoId, row.youtube_video_id);

    // The AI chain was entered at Gemini and never fell through.
    H.deepEq(b.ai.calls, ['gemini']);
    b.db.close();
  });

  H.test('Gemini down -> OpenRouter #1 is used, in order', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build({ aiScenario: 'gemini-down' });
    const v = ingest(b.db, b.storage, 'Kitten Blocks.mp4');
    b.queue.topUp();
    const out = await b.pipeline.runOnce();

    H.eq(out.scheduled, 1);
    H.deepEq(b.ai.calls, ['gemini', 'openrouter_1']);
    const row = b.db.getVideo(v.id);
    H.eq(row.ai_provider, 'openrouter_1');
    H.eq(row.title, 'Kitten Builds A Tower Of Blocks');
    b.db.close();
  });

  H.test('all four AI providers down -> PAUSED, nothing uploaded, retryable', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build({ aiScenario: 'all-down' });
    const v = ingest(b.db, b.storage, 'Paused Video.mp4');
    b.queue.topUp();
    const out = await b.pipeline.runOnce();

    H.eq(out.paused, 1);
    H.eq(out.scheduled, 0);
    H.deepEq(b.ai.calls, ['gemini', 'openrouter_1', 'openrouter_2', 'openrouter_3'],
      'the full chain must be attempted before pausing');

    const row = b.db.getVideo(v.id);
    H.eq(row.ai_status, 'paused');
    H.eq(row.status, 'paused');
    H.ok(row.ai_error && row.ai_error.length > 0, 'a reason is recorded');
    H.eq(b.yt.uploads.length, 0, 'nothing was uploaded');

    // The attempt ledger is in the database for the dashboard.
    const attempts = b.db.attemptsFor(v.id, 'metadata');
    H.eq(attempts.length, 4);
    H.deepEq(attempts.map((a) => a.provider), ['gemini', 'openrouter_1', 'openrouter_2', 'openrouter_3']);
    H.ok(attempts.every((a) => a.error), 'every attempt carries its reason');
    b.db.close();
  });

  H.test('a paused video resumes when a provider comes back', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build({ aiScenario: 'all-down' });
    const v = ingest(b.db, b.storage, 'Resume Me.mp4');
    b.queue.topUp();
    await b.pipeline.runOnce();
    H.eq(b.db.getVideo(v.id).ai_status, 'paused');

    // The provider recovers: the stub now answers.
    b.ai.s.setDown(false);
    b.ai.s._callGemini = async () => JSON.stringify({
      title: 'Recovered Cartoon',
      description: 'Now it works.',
      tags: ['a', 'b', 'c'],
      hashtags: ['#x']
    });

    const resumed = await b.pipeline.resumePaused();
    H.eq(resumed.resumed, 1);
    H.eq(resumed.provider, 'gemini');

    const out = await b.pipeline.runOnce();
    H.eq(out.scheduled, 1);
    H.eq(b.db.getVideo(v.id).title, 'Recovered Cartoon');
    b.db.close();
  });

  H.test('YouTube failure -> retry once -> FAILED, and the video stays retryable', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build({ youtube: { failUploads: 5 } }); // always fails with a 503
    const v = ingest(b.db, b.storage, 'Doomed.mp4');
    b.queue.topUp();
    const out = await b.pipeline.runOnce();

    H.eq(out.failed, 1);
    const row = b.db.getVideo(v.id);
    H.eq(row.status, 'failed');
    H.eq(row.youtube_status, 'failed');
    H.eq(row.youtube_retry_count, 1, 'exactly one retry was attempted');
    H.eq(row.youtube_uncertain, 1, 'a 5xx means we cannot know if YouTube got it');
    H.ok(row.youtube_error.includes('503'));
    H.eq(row.youtube_operation, 'youtube.videos.insert');
    H.eq(b.yt.uploads.length, 2, 'attempt + one retry');
    H.eq(row.cleanup_status, 'pending', 'a failed video is never eligible for deletion');

    // The source file is still on disk.
    H.ok(fs.existsSync(row.local_path), 'the source file survives a failure');

    // And it can be retried later.
    const retry = b.queue.retry(v.id);
    H.eq(retry.ok, true);
    H.eq(b.db.getVideo(v.id).status, 'processing');
    b.db.close();
  });

  H.test('a non-retryable YouTube error does not burn the retry', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build({ youtube: { rejectUpload: true } });
    const v = ingest(b.db, b.storage, 'Bad Metadata.mp4');
    b.queue.topUp();
    await b.pipeline.runOnce();

    const row = b.db.getVideo(v.id);
    H.eq(row.status, 'failed');
    H.eq(b.yt.uploads.length, 1, 'a 400 must not be retried');
    H.eq(row.youtube_http_status, 400);
    H.eq(row.youtube_uncertain, 0, 'a 4xx is a definite failure');
    b.db.close();
  });

  H.test('a thumbnail failure never fails the upload', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build({ youtube: { failThumbnail: true } });
    const v = ingest(b.db, b.storage, 'No Thumb.mp4');
    b.queue.topUp();
    const out = await b.pipeline.runOnce();

    H.eq(out.scheduled, 1, 'the video is still scheduled');
    H.eq(b.yt.uploads.length, 1);
    H.eq(b.db.getVideo(v.id).youtube_status, 'scheduled');
    b.db.close();
  });

  H.test('cleanup deletes the local source and the Drive copy, in order', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const driveCalls = [];
    const drive = {
      enabled: true,
      remove: async (id) => { driveCalls.push(id); return { ok: true }; },
      upload: async () => ({ fileId: 'drive_x' })
    };
    const b = build({ drive });
    const v = ingest(b.db, b.storage, 'Cleanup Me.mp4');
    b.queue.topUp();
    await b.pipeline.runOnce();

    const row = b.db.getVideo(v.id);
    H.ok(fs.existsSync(row.local_path), 'the source exists before cleanup');
    H.eq(row.cleanup_status, 'eligible');
    H.ok(row.cleanup_eligible_at, 'an eligible-at timestamp was recorded');

    const worker = new CleanupWorker({ logger: silent, db: b.db, storage: b.storage });
    const res = await worker.runOnce();

    H.eq(res.deleted, 1, `expected 1 deletion, got ${JSON.stringify(res)}`);
    H.ok(!fs.existsSync(row.local_path), 'the local source is gone');
    const after = b.db.getVideo(v.id);
    H.ok(after.local_deleted_at, 'local deletion is recorded');
    H.ok(after.drive_deleted_at, 'Drive deletion is recorded');
    H.eq(after.cleanup_status, 'done');
    b.db.close();
  });

  H.test('a Drive deletion failure does NOT mark the video deleted', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const drive = {
      enabled: true,
      remove: async () => { throw new Error('drive 503'); },
      upload: async () => ({ fileId: 'drive_y' })
    };
    const b = build({ drive });
    const v = ingest(b.db, b.storage, 'Drive Fail.mp4');
    b.queue.topUp();
    await b.pipeline.runOnce();

    const worker = new CleanupWorker({ logger: silent, db: b.db, storage: b.storage });
    const res = await worker.runOnce();
    const pre = b.db.getVideo(v.id);
    H.eq(res.failed, 1, `res=${JSON.stringify(res)} video(status=${pre.status},yt=${pre.youtube_status},err=${pre.youtube_error},thumb=${pre.thumbnail_status},drive=${pre.drive_file_id},cleanup=${pre.cleanup_status},elig=${pre.cleanup_eligible_at})`);
    const row = b.db.getVideo(v.id);
    H.eq(row.cleanup_status, 'failed', 'not marked deleted');
    H.ok(row.cleanup_error.includes('drive'), 'the failure reason is stored');
    H.eq(b.db.failedCleanupCount(), 1, 'the dashboard can show it');
    b.db.close();
  });

  H.test('DELETE_AFTER_SUCCESSFUL_YOUTUBE_SCHEDULE=false keeps every source file', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build({ storage: { deleteAfterYouTube: false } });
    const v = ingest(b.db, b.storage, 'Keep Me.mp4');
    b.queue.topUp();
    await b.pipeline.runOnce();

    const worker = new CleanupWorker({ logger: silent, db: b.db, storage: b.storage });
    const res = await worker.runOnce();

    H.eq(res.deleted, 0);
    H.ok(fs.existsSync(b.db.getVideo(v.id).local_path), 'the source is untouched');
    H.eq(b.db.getVideo(v.id).cleanup_status, 'pending');
    b.db.close();
  });

  H.test('1,000 uploads put only 10 into the active AI set', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build();
    // A single reusable source file keeps this fast.
    const src = makeMp4('bulk.mp4', 1);
    b.storage.ensureDirs();
    for (let i = 0; i < 1000; i += 1) {
      const id = `bulk_${i}`;
      const dest = path.join(b.storage.cfg.storage.uploadsDir, `${id}__bulk.mp4`);
      fs.copyFileSync(src, dest);
      b.db.createVideo({
        id, filename: `${id}__bulk.mp4`, original_name: `Bulk ${i}.mp4`,
        local_path: dest, file_size: 1000, queue_position: i + 1
      });
    }

    // Expected active set = today's still-fillable slots + tomorrow's 5,
    // capped by MAX_ACTIVE_VIDEOS. Computed from the real slot engine so the
    // assertion holds whatever time of day the suite runs at.
    const now = new Date();
    const slots = require('../services/slot-engine');
    const expectedActive = Math.min(
      slots.remainingSlotsToday(now, config.schedule.effectiveSlots, config.timezone.zone, config.timezone.slotLeadMinutes * 60000).length + 5,
      config.schedule.maxActiveVideos
    );
    H.ok(expectedActive >= 5 && expectedActive <= 10, `sanity: expectedActive=${expectedActive}`);

    const top = b.queue.topUp();
    H.eq(top.assigned.length, expectedActive, 'exactly today + tomorrow, never more');
    H.eq(b.db.totalQueued(), 1000 - expectedActive, 'the rest stay in the queue');
    H.eq(b.db.activeVideos().length, expectedActive);

    const out = await b.pipeline.runOnce();
    H.eq(out.processed, 1, `only one video is processed per pass: ${JSON.stringify(out.details)}`);

    const statuses = {};
    for (const v of b.db.all('SELECT status, COUNT(*) AS n FROM ingest_videos GROUP BY status')) statuses[v.status] = v.n;
    // One video moved from processing -> scheduled. The active window is
    // saturated, so no new video is pulled in until the window rolls forward.
    H.eq(statuses.scheduled, 1);
    H.eq(statuses.processing, expectedActive - 1, `statuses=${JSON.stringify(statuses)}`);
    H.eq(b.db.totalQueued(), 1000 - expectedActive, 'the queue did not grow');
    H.eq(b.db.activeVideos().length, expectedActive, 'the active set size is stable');

    // The AI providers were touched exactly once, not 1000 times.
    H.eq(b.ai.calls.length, 1, `the AI chain was entered ${b.ai.calls.length} times for 1000 uploads`);
    b.db.close();
  });

  H.test('an interrupted upload is reconciled, never duplicated', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build();
    const v = ingest(b.db, b.storage, 'Crash Mid Upload.mp4');
    b.queue.topUp();

    // Simulate a crash between the YouTube response and our own DB write.
    b.db.updateVideo(v.id, { status: 'uploading', youtube_status: 'uploading', youtube_uncertain: 1 });
    H.eq(b.db.getVideo(v.id).status, 'uploading');

    const rec = await b.pipeline.reconcileInterrupted();
    H.eq(rec.checked, 1);
    const row = b.db.getVideo(v.id);
    H.eq(row.status, 'queued', 'returned to the queue');
    H.eq(row.youtube_uncertain, 0);
    H.eq(row.slot_date_et, null, 'the slot was released so it cannot be reused after it passed');

    // And a re-run uploads exactly once.
    const out = await b.pipeline.runOnce();
    H.eq(out.scheduled, 1);
    H.eq(b.yt.uploads.length, 1);
    b.db.close();
  });

  H.test('an interrupted upload WITH a known id is adopted, not re-uploaded', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build();
    const v = ingest(b.db, b.storage, 'Crash After Response.mp4');
    b.queue.topUp();
    await b.pipeline.runOnce();
    H.eq(b.db.getVideo(v.id).status, 'scheduled');
    const realId = b.db.getVideo(v.id).youtube_video_id;
    H.ok(realId, 'YouTube really has this video');

    // Now simulate the crash: the row looks mid-upload again, but the id is real.
    b.db.updateVideo(v.id, {
      status: 'uploading', youtube_status: 'uploading', youtube_uncertain: 1,
      youtube_video_id: realId
    });

    const rec = await b.pipeline.reconcileInterrupted();
    H.eq(rec.resolved, 1);
    const row = b.db.getVideo(v.id);
    H.eq(row.status, 'scheduled');
    H.eq(row.youtube_status, 'scheduled');
    H.eq(row.youtube_video_id, realId);
    H.eq(row.youtube_uncertain, 0);
    H.eq(row.cleanup_status, 'eligible');

    // A subsequent pipeline pass must NOT upload it again.
    const uploadsBefore = b.yt.uploads.length;
    const out = await b.pipeline.runOnce();
    H.eq(out.processed, 0, 'nothing left to process');
    H.eq(b.yt.uploads.length, uploadsBefore, 'no duplicate upload');
    b.db.close();
  });

  H.test('an invalid MP4 is marked FAILED and the next video continues', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build();
    b.storage.ensureDirs();

    const badId = 'ing_bad';
    const badPath = path.join(b.storage.cfg.storage.uploadsDir, 'ing_bad__notavideo.mp4');
    fs.writeFileSync(badPath, 'this is not an mp4 at all');
    b.db.createVideo({
      id: badId, filename: 'ing_bad__notavideo.mp4', original_name: 'Broken.mp4',
      local_path: badPath, file_size: 27, queue_position: 1
    });
    const good = ingest(b.db, b.storage, 'Good One.mp4');
    b.queue.topUp();

    const out = await b.pipeline.runOnce();
    H.eq(out.failed, 1, 'the broken file failed');
    H.eq(b.db.getVideo(badId).status, 'failed');
    H.ok(b.db.getVideo(badId).youtube_error.includes('validation'));

    // The good video is still processed on the next pass.
    const out2 = await b.pipeline.runOnce();
    H.eq(out2.scheduled, 1);
    H.eq(b.db.getVideo(good.id).status, 'scheduled');
    b.db.close();
  });

  H.test('a full restart preserves the queue and the buffer', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const dbPath = path.join(TMP, `restart-${Date.now()}.db`);
    const _d1 = new IngestDatabase(dbPath);
    const b1 = build();
    b1.db.close();

    // Reopen the same file the way a restart would.
    const d2 = new IngestDatabase(dbPath);
    const cfg = JSON.parse(JSON.stringify(config));
    const media = new MediaService(silent);
    const ai = fakeMetadataAi('ok');
    const yt = fakeYouTube();
    const storage = new StorageService({ logger: silent, config: cfg, drive: null });
    const queue = new QueueEngine({ logger: silent, db: d2, config: cfg });
    const pipeline = new Pipeline({
      logger: silent, db: d2, queue, media, metadataAi: ai.s,
      thumbnail: new ThumbnailService({ logger: silent, config: cfg, media }),
      youtube: yt.yt, storage, trends: { enabled: false }
    });

    // Nothing was queued, so the restart is a no-op.
    const rec = await pipeline.reconcileInterrupted();
    H.eq(rec.checked, 0);
    const top = queue.topUp();
    H.eq(top.queueEmpty, true);
    H.eq(top.assigned.length, 0);
    d2.close();
  });

  H.test('checkpoints let a resumed video skip already-done stages', async () => {
    if (!HAVE_FFMPEG) return H.skip('needs ffmpeg');
    const b = build();
    const v = ingest(b.db, b.storage, 'Resumable.mp4');
    b.queue.topUp();

    // Run once to populate the checkpoints.
    await b.pipeline.runOnce();
    const cp = b.db.getCheckpoint(v.id, 'metadata');
    H.ok(cp, 'a metadata checkpoint exists');
    H.eq(cp.state, 'done');
    H.ok(b.db.getCheckpoint(v.id, 'analyzed'), 'an analysis checkpoint exists');
    H.ok(b.db.getCheckpoint(v.id, 'thumbnail'), 'a thumbnail checkpoint exists');
    H.ok(b.db.getCheckpoint(v.id, 'validated'), 'a validation checkpoint exists');

    // Reset the pipeline state but keep the checkpoints: the next run must
    // reuse them instead of calling the AI providers again.
    const callsBefore = b.ai.calls.length;
    b.db.updateVideo(v.id, { status: 'processing', youtube_status: 'pending' });
    const out = await b.pipeline.runOnce();
    H.eq(out.scheduled, 1);
    H.eq(b.ai.calls.length, callsBefore, 'no extra AI call was made - the checkpoint was reused');
    b.db.close();
  });
});

/* ------------------------------------------------------------------- run -- */

(async () => {
  await new Promise((r) => setImmediate(r));
  await H.done();
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})().catch((err) => {
  console.error('integration runner crashed:', err);
  process.exit(1);
});
