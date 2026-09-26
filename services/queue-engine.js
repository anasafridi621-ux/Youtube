'use strict';
/**
 * services/queue-engine.js
 * ---------------------------------------------------------------------------
 * The rolling-advance-buffer scheduler.
 *
 * Invariants enforced here:
 *
 *  1. Exactly 5 publishing slots per calendar day in America/New_York.
 *  2. Never schedule into a slot that has already passed.
 *  3. The active processing set is at most:
 *        today's remaining slots  +  tomorrow's 5 slots
 *     i.e. normally <= 10 videos. 1,000 uploaded videos stay in the queue and
 *     are NOT sent to any AI provider.
 *  4. If only 2 slots remain today, only 2 videos are used today, plus the
 *     5-video advance buffer. Nothing is forced into a passed slot.
 *  5. When the queue is empty, scheduling stops and the dashboard shows
 *     QUEUE EMPTY. No video is ever fabricated.
 *  6. Every transition is persisted, so a restart resumes exactly here.
 */

const slots = require('./slot-engine');

const SLOT_LEAD_MS = 5 * 60 * 1000;

class QueueEngine {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || require('../config').config;
    this.db = opts.db;
    this.slotTimes = this.cfg.schedule.effectiveSlots;
    this.zone = this.cfg.timezone.zone;
    this.leadMs = this.cfg.timezone.slotLeadMinutes * 60 * 1000;
  }

  /** Effective slots for a date, already capped by videosPerDay. */
  slotsFor(dateKey) {
    return slots.slotsForDate(dateKey, this.slotTimes, this.zone);
  }

  /** Today's slots that have not passed yet. */
  remainingToday(now = new Date()) {
    return slots.remainingSlotsToday(now, this.slotTimes, this.zone, this.leadMs);
  }

  /** Tomorrow's five slots. */
  tomorrow(now = new Date()) {
    return slots.nextDaySlots(now, this.slotTimes, this.zone);
  }

  /**
   * The full active window: today's remaining + tomorrow's 5.
   * Capped by maxActiveVideos so a misconfiguration can never explode cost.
   */
  activeWindow(now = new Date()) {
    const win = [...this.remainingToday(now), ...this.tomorrow(now)];
    return win.slice(0, this.cfg.schedule.maxActiveVideos);
  }

  /**
   * Assign free slots from the queue.
   *
   * Called after every ingest and after every publish, so the buffer is
   * continuously topped up. Idempotent: slots already taken are skipped.
   */
  topUp(now = new Date()) {
    const win = this.activeWindow(now);
    const taken = this.db.takenSlotKeys();
    const queued = this.db.queuedVideos();

    const assigned = [];
    let cursor = 0;

    for (const slot of win) {
      const key = `${slot.dateKey}#${slot.index}`;
      if (taken.has(key)) continue;
      if (cursor >= queued.length) break;
      const video = queued[cursor];
      cursor += 1;

      this.db.transaction(() => {
        this.db.assignSlot(video.id, slot);
        this.db.updateVideo(video.id, { status: 'processing' });
      });

      assigned.push({
        videoId: video.id,
        slot: `${slot.dateKey}#${slot.index}`,
        wall: slot.wall,
        utc: slot.utcIso
      });
      this.log.info?.('queue: slot assigned', {
        videoId: video.id,
        slot: `${slot.dateKey} ${slot.wall} ET`,
        utc: slot.utcIso
      });
    }

    this.reindex();

    return {
      assigned,
      queueEmpty: queued.length === 0 && this.db.totalQueued() === 0,
      activeCount: this.db.activeVideos().length
    };
  }

  /** Compact queue_position values (1..N) for the not-yet-consumed queue. */
  reindex() {
    const queued = this.db.queuedVideos();
    this.db.transaction(() => {
      queued.forEach((v, i) => {
        if (v.queue_position !== i + 1) this.db.updateVideo(v.id, { queue_position: i + 1 });
      });
    });
  }

  /**
   * Release slots that have passed without being filled, so a late ingest
   * does not try to use them. Called on every sweep.
   */
  releaseStaleSlots(now = new Date()) {
    const cutoff = now.getTime() - this.leadMs;
    const rows = this.db.all(
      `SELECT sa.*, v.status, v.youtube_status FROM slot_assignments sa
       LEFT JOIN ingest_videos v ON v.id = sa.video_id
       WHERE sa.status = 'planned'`
    );
    let released = 0;
    for (const row of rows) {
      const slotMs = new Date(row.slot_time_utc).getTime();
      if (slotMs <= cutoff) {
        this.db.releaseSlot(row.video_id);
        released += 1;
        this.log.warn?.('queue: released a passed slot', {
          videoId: row.video_id,
          slot: `${row.slot_date_et} ${row.slot_time_et} ET`
        });
      }
    }
    return released;
  }

  /** Dashboard payload for TODAY / TOMORROW BUFFER / QUEUE / PROCESSING. */
  dashboard(now = new Date()) {
    const todayKey = slots.dateKeyIn(now, this.zone);
    const tomorrowKey = slots.addDaysToKey(todayKey, 1);

    const videos = this.db.listVideos();
    const bySlot = new Map();
    for (const v of videos) {
      if (v.slot_date_et && v.slot_index !== null) bySlot.set(`${v.slot_date_et}#${v.slot_index}`, v);
    }

    const todayRows = this.slotsFor(todayKey).map((s) => {
      const v = bySlot.get(`${todayKey}#${s.index}`);
      return {
        index: s.index,
        timeEt: s.wall,
        timeUtc: s.utcIso,
        utcMs: s.utcMs,
        passed: s.utcMs <= now.getTime() - this.leadMs,
        display: slots.formatSlotForDisplay(s.utc, this.cfg.timezone.displayZones),
        video: v ? summarize(v) : null
      };
    });

    const tomorrowRows = this.slotsFor(tomorrowKey).map((s) => {
      const v = bySlot.get(`${tomorrowKey}#${s.index}`);
      return {
        index: s.index,
        timeEt: s.wall,
        timeUtc: s.utcIso,
        display: slots.formatSlotForDisplay(s.utc, this.cfg.timezone.displayZones),
        video: v ? summarize(v) : null
      };
    });

    const queued = this.db.queuedVideos();
    const active = this.db.activeVideos();
    const failed = videos.filter((v) => v.status === 'failed' || v.youtube_status === 'failed');
    const paused = videos.filter((v) => v.ai_status === 'paused');

    return {
      timezone: this.zone,
      now: now.toISOString(),
      nowEt: slots.formatSlotForDisplay(now, [this.zone])[this.zone],
      slotsPerDay: this.slotTimes.length,
      videosPerDay: this.cfg.schedule.effectiveVideosPerDay,
      queueEmpty: queued.length === 0 && active.length === 0,
      today: {
        dateEt: todayKey,
        filled: todayRows.filter((r) => r.video).length,
        target: this.slotTimes.length,
        remaining: todayRows.filter((r) => !r.passed && !r.video).length,
        slots: todayRows
      },
      tomorrowBuffer: {
        dateEt: tomorrowKey,
        ready: tomorrowRows.filter((r) => r.video).length,
        target: this.slotTimes.length,
        complete: tomorrowRows.filter((r) => r.video).length === this.slotTimes.length,
        slots: tomorrowRows
      },
      queue: {
        total: queued.length,
        nextPosition: queued.length ? queued[0].queue_position : null,
        items: queued.slice(0, 50).map(summarize)
      },
      processing: active
        .filter((v) => ['analyzing', 'processing', 'uploading'].includes(v.status))
        .map(summarize),
      failed: failed.map((v) => ({
        id: v.id,
        filename: v.original_name,
        reason: v.youtube_error || v.ai_error || v.thumbnail_error || 'unknown',
        httpStatus: v.youtube_http_status,
        operation: v.youtube_operation,
        retryCount: v.youtube_retry_count,
        youtubeVideoId: v.youtube_video_id,
        uncertain: Boolean(v.youtube_uncertain),
        updatedAt: v.updated_at
      })),
      paused: paused.map((v) => ({
        id: v.id,
        filename: v.original_name,
        reason: v.ai_error,
        pausedAt: v.ai_paused_at
      }))
    };
  }

  /** Retry a failed video: release any stale slot and put it back in the queue. */
  retry(videoId) {
    const video = this.db.getVideo(videoId);
    if (!video) return { ok: false, error: 'video not found' };

    this.db.transaction(() => {
      this.db.releaseSlot(videoId);
      this.db.resetVideo(videoId);
      const pos = this.db.nextQueuePosition();
      this.db.updateVideo(videoId, { queue_position: pos, status: 'queued' });
    });
    this.reindex();
    this.topUp();
    return { ok: true, videoId };
  }

  /** Clear failed rows. Source files on disk are kept untouched. */
  clearFailed() {
    const rows = this.db.all(
      `SELECT id FROM ingest_videos WHERE status = 'failed' OR youtube_status = 'failed'`
    );
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run('DELETE FROM ingest_videos WHERE id = ?', [r.id]);
        this.db.run('DELETE FROM ingest_checkpoints WHERE video_id = ?', [r.id]);
      }
    });
    return { cleared: rows.length };
  }
}

function summarize(v) {
  return {
    id: v.id,
    filename: v.original_name,
    status: v.status,
    queuePosition: v.queue_position,
    fileSize: v.file_size,
    durationSeconds: v.duration_seconds,
    uploadedAt: v.uploaded_at,
    aiStatus: v.ai_status,
    aiProvider: v.ai_provider,
    aiError: v.ai_error,
    thumbnailStatus: v.thumbnail_status,
    thumbnailSource: v.thumbnail_source,
    youtubeStatus: v.youtube_status,
    youtubeVideoId: v.youtube_video_id,
    youtubeUrl: v.youtube_url,
    youtubeError: v.youtube_error,
    youtubeRetryCount: v.youtube_retry_count,
    youtubeUncertain: Boolean(v.youtube_uncertain),
    scheduledAtEt: v.scheduled_at_et,
    scheduledAtUtc: v.scheduled_at_utc,
    slotDateEt: v.slot_date_et,
    slotIndex: v.slot_index,
    slotTimeEt: v.slot_time_et,
    title: v.title,
    description: v.description,
    tags: v.tags,
    hashtags: v.hashtags,
    categoryId: v.category_id,
    madeForKids: v.made_for_kids,
    containsSynthetic: v.contains_synthetic,
    cleanupStatus: v.cleanup_status,
    updatedAt: v.updated_at
  };
}

module.exports = { QueueEngine, summarize, SLOT_LEAD_MS };
