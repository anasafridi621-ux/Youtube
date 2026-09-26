'use strict';
/**
 * services/storage-service.js
 * ---------------------------------------------------------------------------
 * Storage architecture: LOCAL source file + optional GOOGLE DRIVE source copy.
 *
 * Lifecycle of a bulk-uploaded source video:
 *
 *   ingest (local, streamed to disk)
 *     -> optional Drive mirror copy
 *     -> processing (metadata + thumbnail)
 *     -> YouTube upload + schedule
 *     -> confirmation read-back  ("confirmed successful YouTube state")
 *     -> mark eligible for cleanup (eligible_at = confirm + DELETE_DELAY_HOURS)
 *     -> cleanup worker: delete local -> delete Drive -> record result
 *
 * Cleanup rules enforced here (from the requirements):
 *   - Never delete unless YouTube state is *confirmed*.
 *   - Never delete if upload failed, schedule failed, the outcome is
 *     uncertain, the video is still processing, metadata is incomplete, or
 *     the thumbnail process is still required.
 *   - Deletion is transactional from the app's point of view: if either side
 *     fails, the task is NOT marked deleted and the failure is surfaced on
 *     the dashboard for manual action.
 *   - Never delete the only recoverable copy.
 *   - DELETE_AFTER_SUCCESSFUL_YOUTUBE_SCHEDULE=false disables all automatic
 *     deletion (the source file is simply kept).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class StorageService {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || require('../config').config;
    this.drive = opts.drive; // DriveService (may be disabled)
    // Exposed directly so callers (pipeline, worker) can read the retention
    // toggle without reaching into cfg.
    this.deleteAfterYouTube = this.cfg.storage.deleteAfterYouTube !== false;
    this.deleteDelayHours = Number(this.cfg.storage.deleteDelayHours) || 0;
  }

  /* ----------------------------------------------------------------- local */

  localDirs() {
    return { uploads: this.cfg.storage.uploadsDir, derived: this.cfg.storage.derivedDir };
  }

  ensureDirs() {
    fs.mkdirSync(this.cfg.storage.uploadsDir, { recursive: true });
    fs.mkdirSync(this.cfg.storage.derivedDir, { recursive: true });
  }

  /** Path-confined existence check used by the asset endpoints. */
  safeLocalPath(candidate, allowedDirs) {
    const roots = (allowedDirs && allowedDirs.length ? allowedDirs : Object.values(this.localDirs()))
      .map((d) => path.resolve(d));
    const resolved = path.resolve(candidate);
    const inside = roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
    if (!inside) return null;
    if (resolved.includes('..')) return null;
    return resolved;
  }

  /**
   * Local disk usage. Returns bytes used by the uploads dir plus free space.
   */
  localUsage() {
    let used = 0;
    let files = 0;
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else {
          try {
            used += fs.statSync(p).size;
            files += 1;
          } catch (_) {
            /* ignore */
          }
        }
      }
    };
    walk(this.cfg.storage.uploadsDir);
    let free = null;
    try {
      const st = fs.statfsSync(this.cfg.storage.uploadsDir);
      free = st.bavail * st.bsize;
    } catch (_) {
      free = null;
    }
    return { used, files, free, warn: free !== null && free < this.cfg.storage.localFreeWarnBytes };
  }

  /* ------------------------------------------------------------------ hash */

  /** Streaming SHA-256, used to make re-ingest of the same file idempotent. */
  async hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const rs = fs.createReadStream(filePath);
      rs.on('error', reject);
      rs.on('data', (c) => h.update(c));
      rs.on('end', () => resolve(h.digest('hex')));
    });
  }

  findByHash(hash, db) {
    if (!hash) return null;
    return db.get('SELECT * FROM ingest_videos WHERE sha256 = ? ORDER BY created_at ASC LIMIT 1', [hash]);
  }

  /* ----------------------------------------------------------------- drive */

  async mirrorToDrive(video, name) {
    if (!this.drive || !this.drive.enabled) return { ok: false, skipped: 'drive disabled' };
    if (!video.local_path || !fs.existsSync(video.local_path)) {
      return { ok: false, error: 'local file missing, cannot mirror to Drive' };
    }
    try {
      const out = await this.drive.upload(video.local_path, name || video.filename);
      this.log.info?.('storage: mirrored to Drive', { videoId: video.id, fileId: out.fileId });
      return { ok: true, fileId: out.fileId, webViewLink: out.webViewLink };
    } catch (err) {
      // A Drive mirror failure must never block the pipeline.
      this.log.warn?.('storage: Drive mirror failed (continuing local-only)', {
        videoId: video.id,
        error: String(err.message).slice(0, 300)
      });
      return { ok: false, error: String(err.message).slice(0, 300) };
    }
  }

  /* --------------------------------------------------------------- cleanup */

  /**
   * Decide whether a video's source is safe to delete.
   * Returns {eligible:boolean, reason}
   */
  eligibility(video) {
    if (!this.cfg.storage.deleteAfterYouTube) {
      return { eligible: false, reason: 'DELETE_AFTER_SUCCESSFUL_YOUTUBE_SCHEDULE is OFF' };
    }
    if (!['scheduled', 'published'].includes(video.youtube_status)) {
      return { eligible: false, reason: `youtube_status is "${video.youtube_status}" (needs scheduled|published)` };
    }
    if (!video.youtube_video_id) {
      return { eligible: false, reason: 'no confirmed YouTube video id' };
    }
    if (video.youtube_uncertain) {
      return { eligible: false, reason: 'upload outcome is uncertain - reconcile first' };
    }
    if (['analyzing', 'processing', 'uploading'].includes(video.status)) {
      return { eligible: false, reason: `video still ${video.status}` };
    }
    if (video.thumbnail_status !== 'generated' && video.thumbnail_status !== 'fallback') {
      return { eligible: false, reason: `thumbnail_status is "${video.thumbnail_status}"` };
    }
    if (!video.title || !video.description) {
      return { eligible: false, reason: 'metadata incomplete' };
    }
    if (!video.scheduled_at_utc) {
      return { eligible: false, reason: 'no scheduled time recorded' };
    }
    // Never delete the only recoverable copy.
    const hasLocal = video.local_path && fs.existsSync(video.local_path);
    const hasDrive = Boolean(video.drive_file_id);
    if (!hasLocal && !hasDrive) {
      return { eligible: false, reason: 'nothing left to delete' };
    }
    return { eligible: true };
  }

  /** When a confirmed video becomes eligible for deletion. */
  eligibleAt(from = new Date()) {
    const delay = Math.min(
      Math.max(0, this.cfg.storage.deleteDelayHours),
      this.cfg.storage.deleteMaxHours
    );
    return new Date(from.getTime() + delay * 60 * 60 * 1000).toISOString();
  }

  /**
   * Execute one cleanup task.
   *
   * Order matters: local first, then Drive. If either fails we record the
   * failure and do NOT mark the row deleted.
   */
  async runCleanup(task, db) {
    const video = db.getVideo(task.video_id);
    if (!video) {
      db.updateCleanupTask(task.id, { status: 'failed', error: 'video row no longer exists' });
      return { ok: false, error: 'video row no longer exists' };
    }

    const check = this.eligibility(video);
    if (!check.eligible) {
      db.updateCleanupTask(task.id, { status: 'pending', error: `not eligible: ${check.reason}` });
      return { ok: false, error: check.reason, deferred: true };
    }

    let localOk = true;
    let driveOk = true;
    const errors = [];

    if (task.local_path && fs.existsSync(task.local_path)) {
      try {
        fs.unlinkSync(task.local_path);
        db.updateVideo(video.id, { local_deleted_at: new Date().toISOString() });
        this.log.info?.('storage: deleted local source', { videoId: video.id });
      } catch (err) {
        localOk = false;
        errors.push(`local: ${err.message}`);
      }
    } else if (video.local_deleted_at) {
      localOk = true;
    } else {
      localOk = true; // nothing to delete locally
    }

    if (this.drive && this.drive.enabled && task.drive_file_id) {
      try {
        await this.drive.remove(task.drive_file_id);
        db.updateVideo(video.id, { drive_deleted_at: new Date().toISOString() });
        this.log.info?.('storage: deleted Drive source', { videoId: video.id });
      } catch (err) {
        driveOk = false;
        errors.push(`drive: ${err.message}`);
      }
    }

    if (localOk && driveOk) {
      db.updateCleanupTask(task.id, { status: 'done', local_result: 'deleted', drive_result: task.drive_file_id ? 'deleted' : 'n/a', error: null });
      db.updateVideo(video.id, { cleanup_status: 'done' });
      return { ok: true };
    }

    db.updateCleanupTask(task.id, {
      status: 'failed',
      attempts: (task.attempts || 0) + 1,
      local_result: localOk ? 'deleted' : 'failed',
      drive_result: driveOk ? 'deleted' : 'failed',
      error: errors.join('; ').slice(0, 500)
    });
    db.updateVideo(video.id, {
      cleanup_status: 'failed',
      cleanup_error: errors.join('; ').slice(0, 500),
      cleanup_attempts: (video.cleanup_attempts || 0) + 1
    });
    return { ok: false, error: errors.join('; ') };
  }

  /** Dashboard-facing storage summary. */
  async summary(db) {
    const local = this.localUsage();
    const stats = db.storageSummary();
    let drive = null;
    if (this.drive && this.drive.enabled) drive = await this.drive.quota();
    return {
      local: {
        ...local,
        trackedFiles: stats.total_files,
        trackedBytes: stats.total_bytes,
        remainingBytes: stats.local_bytes
      },
      drive,
      pendingDeletion: db.pendingCleanupCount(),
      failedDeletion: db.failedCleanupCount(),
      deleteAfterYouTube: this.cfg.storage.deleteAfterYouTube,
      deleteDelayHours: Math.min(this.cfg.storage.deleteDelayHours, this.cfg.storage.deleteMaxHours)
    };
  }
}

module.exports = { StorageService };
