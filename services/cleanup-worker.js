'use strict';
/**
 * services/cleanup-worker.js
 * ---------------------------------------------------------------------------
 * Background cleanup worker.
 *
 * Runs on a timer, never inline with the upload path, so a shutdown or crash
 * can never leave a source file half-deleted while YouTube state is still
 * uncertain. Each task is only executed once its eligible_at has passed
 * (default 6h after confirmation, hard-capped at 24h).
 *
 * The worker is intentionally dumb: all of the safety logic lives in
 * StorageService.eligibility(), so the rules are testable in isolation.
 */

class CleanupWorker {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || require('../config').config;
    this.db = opts.db;
    this.storage = opts.storage;
    this.timer = null;
    this.running = false;
    this.lastRun = null;
    this.lastResult = null;
  }

  start() {
    if (this.timer) return;
    const interval = Math.max(60 * 1000, this.cfg.worker.cleanupIntervalMs);
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        this.log.error?.('cleanup: sweep failed', { error: String(err && err.message).slice(0, 300) });
      });
    }, interval);
    if (this.timer.unref) this.timer.unref();
    this.log.info?.('cleanup: worker started', { intervalMs: interval });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep. Safe to call concurrently; guards itself. */
  async runOnce() {
    if (this.running) return { skipped: true };
    this.running = true;
    const startedAt = new Date();

    const result = { ranAt: startedAt.toISOString(), due: 0, deleted: 0, failed: 0, deferred: 0, errors: [] };
    try {
      const tasks = this.db.dueCleanupTasks(startedAt);
      result.due = tasks.length;

      for (const task of tasks) {
        try {
          const out = await this.storage.runCleanup(task, this.db);
          if (out.ok) result.deleted += 1;
          else if (out.deferred) result.deferred += 1;
          else {
            result.failed += 1;
            result.errors.push({ videoId: task.video_id, error: out.error });
          }
        } catch (err) {
          result.failed += 1;
          result.errors.push({ videoId: task.video_id, error: String(err && err.message).slice(0, 300) });
          this.db.updateCleanupTask(task.id, {
            status: 'failed',
            attempts: (task.attempts || 0) + 1,
            error: String(err && err.message).slice(0, 500)
          });
        }
      }
    } finally {
      this.running = false;
      this.lastRun = startedAt;
      this.lastResult = result;
    }

    if (result.deleted || result.failed) {
      this.log.info?.('cleanup: sweep complete', {
        due: result.due,
        deleted: result.deleted,
        failed: result.failed,
        deferred: result.deferred
      });
    }
    return result;
  }

  status() {
    return {
      running: this.running,
      lastRun: this.lastRun ? this.lastRun.toISOString() : null,
      lastResult: this.lastResult,
      pending: this.db.pendingCleanupCount(),
      failed: this.db.failedCleanupCount(),
      deleteAfterYouTube: this.cfg.storage.deleteAfterYouTube,
      delayHours: Math.min(this.cfg.storage.deleteDelayHours, this.cfg.storage.deleteMaxHours)
    };
  }
}

module.exports = { CleanupWorker };
