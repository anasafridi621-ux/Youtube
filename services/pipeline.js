'use strict';
/**
 * services/pipeline.js
 * ---------------------------------------------------------------------------
 * The active-set worker.
 *
 * Processes ONLY the videos that the queue engine has placed in the active
 * window (today's remaining slots + tomorrow's 5). Everything else stays in
 * the queue and is never touched by an AI provider.
 *
 * Per video, the stages are:
 *
 *   1. validate  - MP4 sanity check (ffprobe). Bad file -> FAILED, next video.
 *   2. analyze   - probe facts + local visual brief + frames.
 *   3. metadata  - Gemini -> OpenRouter #1 -> #2 -> #3 (strict sequential).
 *                  All four down -> PAUSED with the full attempt ledger.
 *   4. thumbnail - configured image AI, else best local frame. Never paid.
 *   5. upload    - resumable videos.insert, private + publishAt (UTC).
 *                  Fail -> one retry -> FAILED (recoverable) -> next video.
 *   6. confirm   - videos.list read-back, then mark scheduled + eligible.
 *   7. topup     - pull the next queued video into the active window.
 *
 * Every stage writes a checkpoint row, so a crash mid-way resumes instead of
 * repeating expensive provider work. Artifacts are re-validated on disk before
 * being reused.
 */

const fs = require('fs');
const path = require('path');

class Pipeline {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || require('../config').config;
    this.db = opts.db;
    this.queue = opts.queue;
    this.media = opts.media;
    this.metadataAi = opts.metadataAi;
    this.thumbnail = opts.thumbnail;
    this.youtube = opts.youtube;
    this.storage = opts.storage;
    this.trends = opts.trends;
    this.channel = null; // populated lazily from channels.list

    this.running = false;
    this._stopRequested = false;
    this._current = null;
  }

  get busy() {
    return this.running;
  }

  current() {
    return this._current;
  }

  stop() {
    this._stopRequested = true;
  }

  /* ---------------------------------------------------------------- helpers */

  /** Read the channel once so we honour its live madeForKids setting. */
  async getChannel() {
    if (this.channel) return this.channel;
    try {
      this.channel = await this.youtube.getMyChannel();
    } catch (err) {
      this.log.warn?.('pipeline: channel lookup failed', { error: String(err.message).slice(0, 200) });
      this.channel = null;
    }
    return this.channel;
  }

  /** Local visual brief: cheap, offline, and gives the model real evidence. */
  async buildVisualBrief(frames) {
    const sharp = require('sharp');
    const notes = [];
    for (const f of frames.slice(0, 4)) {
      try {
        const stats = await sharp(f).stats();
        const mean = stats.channels.reduce((a, c) => a + c.mean, 0) / stats.channels.length / 255;
        const contrast = stats.channels.reduce((a, c) => a + c.stdev, 0) / stats.channels.length / 128;
        const warm = stats.channels[0].mean >= stats.channels[2].mean;
        notes.push(
          `${path.basename(f)}: brightness=${mean.toFixed(2)} contrast=${contrast.toFixed(2)} ${warm ? 'warm palette' : 'cool palette'}`
        );
      } catch (_) {
        /* skip unreadable frame */
      }
    }
    return notes;
  }

  /** Artifact reuse: only trust a checkpoint whose file still exists. */
  reusableArtifact(videoId, stage) {
    const cp = this.db.getCheckpoint(videoId, stage);
    if (!cp || cp.state !== 'done' || !cp.artifact) return null;
    // File-backed artifacts (analysis frames, thumbnails) must still exist on
    // disk. Value-only artifacts such as metadata carry no path and are
    // trusted as-is.
    const p = cp.artifact.path;
    if (p && !fs.existsSync(p)) return null;
    return cp.artifact;
  }

  /* ----------------------------------------------------------------- stages */

  async stageValidate(video) {
    const result = await this.media.validateMp4(video.local_path);
    if (!result.ok) return { ok: false, reason: result.reason };

    this.db.saveCheckpoint(video.id, 'validated', 'done', { path: video.local_path });
    this.db.updateVideo(video.id, {
      status: 'analyzing',
      duration_seconds: result.info.duration,
      width: result.info.width,
      height: result.info.height,
      video_codec: result.info.videoCodec,
      audio_codec: result.info.audioCodec,
      container: result.info.container
    });
    return { ok: true, info: result.info };
  }

  async stageAnalyze(video) {
    const reuse = this.reusableArtifact(video.id, 'analyzed');
    if (reuse) {
      this.log.debug?.('pipeline: reusing analysis checkpoint', { videoId: video.id });
      return { ok: true, analysis: reuse, reused: true };
    }

    const frameDir = path.join(this.cfg.storage.derivedDir, 'frames', video.id);
    let frames = [];
    try {
      frames = await this.media.extractFrames(
        video.local_path,
        frameDir,
        this.cfg.ai.analysisFrames,
        { width: this.cfg.ai.analysisFrameWidth, quality: this.cfg.ai.analysisJpegQuality }
      );
    } catch (err) {
      return { ok: false, reason: `frame extraction failed: ${err.message}` };
    }

    const visualBrief = await this.buildVisualBrief(frames);
    const analysis = {
      videoId: video.id,
      filename: video.original_name,
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      hasAudio: Boolean(video.audio_codec),
      framePaths: frames,
      visualBrief
    };

    this.db.saveCheckpoint(video.id, 'analyzed', 'done', analysis);
    this.db.updateVideo(video.id, {
      analysis_json: JSON.stringify({ ...analysis, framePaths: undefined })
    });
    return { ok: true, analysis };
  }

  async stageMetadata(video, analysis) {
    // Checkpoint reuse must be evaluated BEFORE any updateVideo() call: the
    // row's updated_at is what the freshness check compares against, so
    // touching the row first would make the checkpoint look stale.
    const reuseMeta = this.reusableArtifact(video.id, 'metadata');
    if (reuseMeta && reuseMeta.metadata) {
      const m = reuseMeta.metadata;
      this.db.updateVideo(video.id, {
        ai_status: 'done',
        ai_provider: reuseMeta.provider || video.ai_provider || null,
        ai_error: null,
        title: m.title,
        description: m.description,
        tags: JSON.stringify(m.tags || []),
        hashtags: JSON.stringify(m.hashtags || []),
        category_id: m.categoryId || null,
        made_for_kids: m.madeForKids === undefined ? null : (m.madeForKids ? 1 : 0),
        contains_synthetic: m.containsSynthetic === undefined ? null : (m.containsSynthetic ? 1 : 0),
        synthetic_confidence: m.syntheticConfidence || null
      });
      this.log.info?.('pipeline: metadata checkpoint reused', { videoId: video.id });
      return { ok: true, metadata: m, provider: reuseMeta.provider, reused: true };
    }

    this.db.updateVideo(video.id, { ai_status: 'running', ai_error: null });

    let trendNotes = [];
    if (this.trends && this.trends.enabled) {
      try {
        trendNotes = await this.trends.notesFor(analysis);
      } catch (err) {
        this.log.warn?.('pipeline: trend lookup failed, continuing with content-based SEO', {
          error: String(err.message).slice(0, 200)
        });
      }
    }

    const result = await this.metadataAi.generate({
      video,
      analysis,
      trendNotes,
      onAttempt: (a) => this.db.logAttempt(a)
    });

    if (!result.ok) {
      // All providers down. Pause instead of paying for another provider.
      const reason = result.message || 'all metadata AI providers failed';
      this.db.updateVideo(video.id, {
        ai_status: 'paused',
        ai_error: reason,
        ai_paused_at: new Date().toISOString(),
        ai_attempts: (video.ai_attempts || 0) + result.attempts.length,
        status: 'paused'
      });
      return { ok: false, paused: true, reason, attempts: result.attempts };
    }

    const m = result.metadata;
    this.db.saveCheckpoint(video.id, 'metadata', 'done', { metadata: m, provider: result.provider });
    this.db.updateVideo(video.id, {
      ai_status: 'done',
      ai_provider: result.provider,
      ai_model: result.model,
      ai_error: null,
      title: m.title,
      description: m.description,
      tags: JSON.stringify(m.tags),
      hashtags: JSON.stringify(m.hashtags),
      category_id: m.categoryId,
      made_for_kids: m.madeForKids ? 1 : 0,
      contains_synthetic: m.containsSynthetic ? 1 : 0,
      synthetic_confidence: m.syntheticConfidence
    });
    return { ok: true, metadata: m, provider: result.provider, model: result.model };
  }

  async stageThumbnail(video, metadata, analysis) {
    const reuse = this.reusableArtifact(video.id, 'thumbnail');
    if (reuse && fs.existsSync(reuse.path)) {
      this.db.updateVideo(video.id, {
        thumbnail_status: reuse.source === 'ai' ? 'generated' : 'fallback',
        thumbnail_path: reuse.path,
        thumbnail_source: reuse.source
      });
      return { ok: true, path: reuse.path, source: reuse.source, reused: true };
    }

    const outDir = path.join(this.cfg.storage.derivedDir, 'thumbnails');
    const result = await this.thumbnail.generate({ video, metadata, analysis, outDir });

    for (const a of result.attempts) this.db.logAttempt(a);

    if (!result.ok) {
      this.db.updateVideo(video.id, { thumbnail_status: 'failed', thumbnail_error: result.error });
      return { ok: false, reason: result.error };
    }

    this.db.saveCheckpoint(video.id, 'thumbnail', 'done', { path: result.path, source: result.source });
    this.db.updateVideo(video.id, {
      thumbnail_status: result.source === 'ai' ? 'generated' : 'fallback',
      thumbnail_path: result.path,
      thumbnail_source: result.source,
      thumbnail_error: null
    });
    return { ok: true, path: result.path, source: result.source };
  }

  async stageUpload(video, thumbnailPath) {
    this.db.updateVideo(video.id, {
      status: 'uploading',
      youtube_status: 'uploading',
      youtube_error: null,
      youtube_uncertain: 0
    });

    const res = await this.youtube.uploadAndSchedule({
      video,
      thumbnailPath,
      onProgress: (evt) => {
        this.log.debug?.('pipeline: upload progress', { videoId: video.id, bytes: evt.bytesRead });
      }
    });

    if (!res.ok) {
      const uncertain = res.uncertain ? 1 : 0;
      this.db.updateVideo(video.id, {
        status: 'failed',
        youtube_status: 'failed',
        youtube_error: res.error,
        youtube_http_status: res.httpStatus,
        youtube_operation: res.operation,
        youtube_retry_count: res.retryCount,
        youtube_uncertain: uncertain
      });
      this.db.releaseSlot(video.id);
      return { ok: false, uncertain, reason: res.error };
    }

    this.db.markSlotUploaded(video.slot_date_et, video.slot_index, res.videoId);

    // The retention toggle decides whether this video ever becomes eligible
    // for deletion. With it OFF the row stays 'pending' forever and no
    // cleanup task is created, so the source file is never removed.
    const cleanupOn = Boolean(this.storage.deleteAfterYouTube);
    const patch = {
      status: 'scheduled',
      youtube_status: 'scheduled',
      youtube_video_id: res.videoId,
      youtube_url: res.url,
      youtube_error: null,
      youtube_retry_count: res.retryCount,
      youtube_uncertain: 0
    };
    if (cleanupOn) {
      patch.cleanup_status = 'eligible';
      patch.cleanup_eligible_at = this.storage.eligibleAt();
    }
    this.db.updateVideo(video.id, patch);

    if (cleanupOn) {
      this.db.createCleanupTask({
        id: `cleanup_${video.id}`,
        videoId: video.id,
        localPath: video.local_path,
        driveFileId: video.drive_file_id || null,
        eligibleAt: this.storage.eligibleAt()
      });
    }

    this.log.info?.('pipeline: video scheduled', {
      videoId: video.id,
      youtubeVideoId: res.videoId,
      slot: `${video.slot_date_et} ${video.slot_time_et} ET`,
      publishAt: video.scheduled_at_utc
    });

    return { ok: true, videoId: res.videoId, url: res.url };
  }

  /* ------------------------------------------------------------ reconcile */

  /**
   * On boot, resolve any row left in an ambiguous state by a crash.
   * This is what makes restarts duplicate-safe.
   */
  async reconcileInterrupted() {
    const rows = this.db.all(
      `SELECT * FROM ingest_videos
       WHERE youtube_status IN ('uploading','uncertain') OR status = 'uploading'`
    );
    let resolved = 0;
    for (const v of rows) {
      if (v.youtube_video_id) {
        const found = await this.youtube.reconcile(v.youtube_video_id);
        if (found.found) {
          const reconPatch = {
            status: 'scheduled',
            youtube_status: 'scheduled',
            youtube_url: found.url,
            youtube_uncertain: 0
          };
          if (this.storage.deleteAfterYouTube) {
            reconPatch.cleanup_status = 'eligible';
            reconPatch.cleanup_eligible_at = this.storage.eligibleAt();
          }
          this.db.updateVideo(v.id, reconPatch);
          resolved += 1;
          continue;
        }
      }
      // No id, or the id does not exist: put it back in the queue for a clean
      // re-run. The slot is released so it can never land in a passed slot.
      this.db.releaseSlot(v.id);
      this.db.updateVideo(v.id, { status: 'queued', youtube_status: 'pending', youtube_uncertain: 0 });
      resolved += 1;
    }

    this.queue.releaseStaleSlots();
    return { resolved, checked: rows.length };
  }

  /* ------------------------------------------------------------------ main */

  /** Run one pass over the active set. Returns a summary. */
  async runOnce() {
    if (this.running) return { skipped: 'already running' };
    this.running = true;
    this._stopRequested = false;

    const summary = { processed: 0, scheduled: 0, failed: 0, paused: 0, skipped: 0, details: [] };

    try {
      this.queue.releaseStaleSlots();
      this.queue.topUp();

      const active = this.db
        .activeVideos()
        .filter((v) => ['analyzing', 'processing', 'uploading', 'paused'].includes(v.status))
        .filter((v) => v.slot_date_et) // must hold a real slot
        .slice(0, this.cfg.worker.concurrency);

      for (const video of active) {
        if (this._stopRequested) break;
        this._current = { id: video.id, filename: video.original_name, stage: 'starting' };

        try {
          const outcome = await this.processVideo(video);
          summary.processed += 1;
          if (outcome.status === 'scheduled') summary.scheduled += 1;
          else if (outcome.status === 'paused') summary.paused += 1;
          else summary.failed += 1;
          summary.details.push({ videoId: video.id, ...outcome });
        } catch (err) {
          this.log.error?.('pipeline: unexpected error', {
            videoId: video.id,
            error: String(err && err.message).slice(0, 300)
          });
          this.db.updateVideo(video.id, {
            status: 'failed',
            youtube_status: 'failed',
            youtube_error: `pipeline error: ${String(err && err.message).slice(0, 400)}`
          });
          summary.failed += 1;
          summary.details.push({
            videoId: video.id,
            status: 'failed',
            reason: String(err && err.message).slice(0, 300)
          });
        }
      }
    } finally {
      this.running = false;
      this._current = null;
    }

    this.queue.topUp();
    return summary;
  }

  /** Full per-video pipeline. */
  async processVideo(video) {
    const fail = (reason) => {
      this.db.updateVideo(video.id, { status: 'failed', youtube_error: reason });
      return { status: 'failed', reason };
    };

    // 1. validate
    const validated = await this.stageValidate(video);
    if (!validated.ok) return fail(`MP4 validation failed: ${validated.reason}`);
    video = this.db.getVideo(video.id);

    // Mirror to Drive BEFORE anything destructive. Best effort.
    if (this.storage.drive && this.storage.drive.enabled && !video.drive_file_id) {
      const mirror = await this.storage.mirrorToDrive(video, video.filename);
      if (mirror.ok) {
        this.db.updateVideo(video.id, { drive_file_id: mirror.fileId });
        video = this.db.getVideo(video.id);
      }
    }

    // 2. analyze
    this._current.stage = 'analyze';
    const analyzed = await this.stageAnalyze(video);
    if (!analyzed.ok) return fail(`analysis failed: ${analyzed.reason}`);
    video = this.db.getVideo(video.id);

    // 3. metadata
    this._current.stage = 'metadata';
    const meta = await this.stageMetadata(video, analyzed.analysis);
    if (!meta.ok) {
      if (meta.paused) return { status: 'paused', reason: meta.reason };
      return fail(`metadata failed: ${meta.reason}`);
    }
    video = this.db.getVideo(video.id);

    // 4. thumbnail
    this._current.stage = 'thumbnail';
    const thumb = await this.stageThumbnail(video, meta.metadata, analyzed.analysis);
    if (!thumb.ok) return fail(`thumbnail failed: ${thumb.reason}`);
    video = this.db.getVideo(video.id);

    // 5. upload
    this._current.stage = 'youtube-upload';
    const uploaded = await this.stageUpload(video, thumb.path);
    if (!uploaded.ok) {
      return { status: 'failed', reason: uploaded.reason, uncertain: uploaded.uncertain };
    }

    this._current.stage = 'done';
    return { status: 'scheduled', youtubeVideoId: uploaded.videoId, url: uploaded.url };
  }

  /**
   * Re-probe AI provider health and resume anything that was paused only
   * because the providers were unavailable.
   */
  async resumePaused() {
    const paused = this.db.all(
      `SELECT * FROM ingest_videos WHERE ai_status = 'paused' AND status = 'paused'`
    );
    if (!paused.length) return { resumed: 0 };
    const health = await this.metadataAi.healthProbe();
    if (!health) {
      this.log.info?.('pipeline: AI providers still unavailable, keeping videos paused', {
        paused: paused.length
      });
      return { resumed: 0, reason: 'no provider available yet' };
    }
    this.log.info?.('pipeline: provider available again, resuming', {
      provider: health.provider,
      paused: paused.length
    });
    for (const v of paused) {
      this.db.updateVideo(v.id, { status: 'processing', ai_status: 'pending', ai_paused_at: null });
    }
    return { resumed: paused.length, provider: health.provider };
  }
}

module.exports = { Pipeline };
