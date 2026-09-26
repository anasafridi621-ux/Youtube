'use strict';
/**
 * database/ingest-db.js
 * ---------------------------------------------------------------------------
 * Durable persistence for the bulk-ingest queue.
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync). That is the *same SQLite
 * engine and on-disk file format* the legacy AgentTube app used via the
 * `sqlite3` package, but it needs no native compilation, which makes the
 * system deployable to Render/Railway without build tooling.
 *
 * Every state transition is written here, so the queue survives app, PC and
 * server restarts. Nothing about queue position or video state lives only in
 * process memory.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

const DDL = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // ------------------------------------------------------------- queue rows
  `CREATE TABLE IF NOT EXISTS ingest_videos (
     id                     TEXT PRIMARY KEY,
     filename               TEXT NOT NULL,
     original_name          TEXT NOT NULL,
     local_path             TEXT,
     tmp_path               TEXT,
     file_size              INTEGER,
     duration_seconds       REAL,
     width                  INTEGER,
     height                 INTEGER,
     video_codec            TEXT,
     audio_codec            TEXT,
     container              TEXT,
     sha256                 TEXT,
     queue_position         INTEGER,
     drive_file_id          TEXT,
     uploaded_at            TEXT,
     status                 TEXT NOT NULL DEFAULT 'queued',
     ai_status              TEXT NOT NULL DEFAULT 'pending',
     ai_provider            TEXT,
     ai_model               TEXT,
     ai_error               TEXT,
     ai_round               INTEGER NOT NULL DEFAULT 0,
     ai_attempts            INTEGER NOT NULL DEFAULT 0,
     ai_paused_at           TEXT,
     thumbnail_status       TEXT NOT NULL DEFAULT 'pending',
     thumbnail_path         TEXT,
     thumbnail_source       TEXT,
     thumbnail_error        TEXT,
     youtube_status         TEXT NOT NULL DEFAULT 'pending',
     youtube_video_id       TEXT,
     youtube_url            TEXT,
     youtube_error          TEXT,
     youtube_http_status    INTEGER,
     youtube_operation      TEXT,
     youtube_retry_count    INTEGER NOT NULL DEFAULT 0,
     youtube_uncertain      INTEGER NOT NULL DEFAULT 0,
     scheduled_at_et        TEXT,
     scheduled_at_utc       TEXT,
     slot_date_et           TEXT,
     slot_index             INTEGER,
     slot_time_et           TEXT,
     publish_at             TEXT,
     title                  TEXT,
     description            TEXT,
     tags                   TEXT,
     hashtags               TEXT,
     category_id            TEXT,
     made_for_kids          INTEGER,
     contains_synthetic     INTEGER,
     synthetic_confidence   TEXT,
     analysis_json          TEXT,
     cleanup_status         TEXT NOT NULL DEFAULT 'pending',
     cleanup_eligible_at    TEXT,
     cleanup_error          TEXT,
     cleanup_attempts       INTEGER NOT NULL DEFAULT 0,
     local_deleted_at       TEXT,
     drive_deleted_at       TEXT,
     created_at             TEXT NOT NULL,
     updated_at             TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_ingest_status   ON ingest_videos(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ingest_position ON ingest_videos(queue_position)`,
  `CREATE INDEX IF NOT EXISTS idx_ingest_youtube  ON ingest_videos(youtube_status, youtube_video_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ingest_cleanup  ON ingest_videos(cleanup_status, cleanup_eligible_at)`,

  // --------------------------------------------------- slot assignments
  `CREATE TABLE IF NOT EXISTS slot_assignments (
     id                 TEXT PRIMARY KEY,
     video_id           TEXT NOT NULL,
     slot_date_et       TEXT NOT NULL,
     slot_index         INTEGER NOT NULL,
     slot_time_et       TEXT NOT NULL,
     slot_time_utc      TEXT NOT NULL,
     status             TEXT NOT NULL DEFAULT 'planned',
     youtube_video_id   TEXT,
     created_at         TEXT NOT NULL,
     updated_at         TEXT NOT NULL,
     UNIQUE(slot_date_et, slot_index)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_slots_video ON slot_assignments(video_id)`,

  // --------------------------------------------------- provider audit log
  `CREATE TABLE IF NOT EXISTS provider_attempts (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     video_id     TEXT,
     stage        TEXT NOT NULL,
     provider     TEXT NOT NULL,
     model        TEXT,
     status       TEXT NOT NULL,
     http_status  INTEGER,
     error_code   TEXT,
     error        TEXT,
     duration_ms  INTEGER,
     created_at   TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_attempts_video ON provider_attempts(video_id, stage)`,

  // ------------------------------------------------------- cleanup ledger
  `CREATE TABLE IF NOT EXISTS cleanup_tasks (
     id            TEXT PRIMARY KEY,
     video_id      TEXT NOT NULL,
     local_path    TEXT,
     drive_file_id TEXT,
     eligible_at   TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'pending',
     local_result  TEXT,
     drive_result  TEXT,
     error         TEXT,
     attempts      INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   )`,

  // --------------------------------------------------------- job checkpoints
  // One row per (video, stage). Artifacts are re-validated against disk before
  // being reused after a crash, so an interrupted job resumes instead of
  // repeating expensive provider work.
  `CREATE TABLE IF NOT EXISTS ingest_checkpoints (
     video_id   TEXT NOT NULL,
     stage      TEXT NOT NULL,
     state      TEXT NOT NULL DEFAULT 'done',
     artifact   TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (video_id, stage)
   )`,

  // ------------------------------------------------------- settings / kv
  `CREATE TABLE IF NOT EXISTS settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`
];

function nowIso() {
  return new Date().toISOString();
}

/** Columns of ingest_videos that callers may patch. */
const PATCHABLE = new Set([
  'local_path', 'tmp_path', 'file_size', 'duration_seconds', 'width', 'height',
  'video_codec', 'audio_codec', 'container', 'sha256', 'queue_position',
  'drive_file_id',
  'status', 'ai_status', 'ai_provider', 'ai_model', 'ai_error', 'ai_round',
  'ai_attempts', 'ai_paused_at', 'thumbnail_status', 'thumbnail_path',
  'thumbnail_source', 'thumbnail_error', 'youtube_status', 'youtube_video_id',
  'youtube_url', 'youtube_error', 'youtube_http_status', 'youtube_operation',
  'youtube_retry_count', 'youtube_uncertain', 'scheduled_at_et',
  'scheduled_at_utc', 'slot_date_et', 'slot_index', 'slot_time_et',
  'publish_at', 'title', 'description', 'tags', 'hashtags', 'category_id',
  'made_for_kids', 'contains_synthetic', 'synthetic_confidence',
  'analysis_json', 'cleanup_status', 'cleanup_eligible_at', 'cleanup_error',
  'cleanup_attempts', 'local_deleted_at', 'drive_deleted_at'
]);

class IngestDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    for (const stmt of DDL) this.db.exec(stmt);
    this.setSetting('schema_version', String(SCHEMA_VERSION));
  }

  /* ------------------------------------------------------------- helpers */

  all(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  get(sql, params = []) {
    return this.db.prepare(sql).get(...params);
  }

  run(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {
        /* already rolled back */
      }
      throw err;
    }
  }

  setSetting(key, value) {
    this.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, String(value), nowIso()]
    );
  }

  getSetting(key, fallback = null) {
    const row = this.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : fallback;
  }

  /* --------------------------------------------------------------- video CRUD */

  createVideo(row) {
    this.run(
      `INSERT INTO ingest_videos (
         id, filename, original_name, local_path, tmp_path, file_size,
         queue_position, uploaded_at, status, ai_status, thumbnail_status,
         youtube_status, cleanup_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'pending', 'pending', 'pending', 'pending', ?, ?)`,
      [
        row.id,
        row.filename,
        row.original_name,
        row.local_path || null,
        row.tmp_path || null,
        row.file_size || 0,
        row.queue_position || null,
        row.uploaded_at || nowIso(),
        nowIso(),
        nowIso()
      ]
    );
    return this.getVideo(row.id);
  }

  getVideo(id) {
    return this.get('SELECT * FROM ingest_videos WHERE id = ?', [id]);
  }

  updateVideo(id, patch) {
    const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k));
    if (!keys.length) return this.getVideo(id);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const params = keys.map((k) => patch[k]);
    params.push(nowIso(), id);
    this.run(`UPDATE ingest_videos SET ${sets}, updated_at = ? WHERE id = ?`, params);
    return this.getVideo(id);
  }

  /* --------------------------------------------------------------- queries */

  listVideos(filter = {}) {
    const where = [];
    const params = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.youtubeStatus) {
      where.push('youtube_status = ?');
      params.push(filter.youtubeStatus);
    }
    if (filter.statusIn) {
      where.push(`status IN (${filter.statusIn.map(() => '?').join(',')})`);
      params.push(...filter.statusIn);
    }
    if (filter.notStatusIn) {
      where.push(`status NOT IN (${filter.notStatusIn.map(() => '?').join(',')})`);
      params.push(...filter.notStatusIn);
    }
    const sql = `SELECT * FROM ingest_videos ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY COALESCE(queue_position, 999999999), created_at ASC`;
    return this.all(sql, params);
  }

  /** The not-yet-consumed queue, oldest first. */
  queuedVideos() {
    return this.all(
      `SELECT * FROM ingest_videos
       WHERE status = 'queued'
       ORDER BY COALESCE(queue_position, 999999999), created_at ASC`
    );
  }

  /** Videos currently inside the active (today + buffer) processing set. */
  activeVideos() {
    return this.all(
      `SELECT * FROM ingest_videos
       WHERE status IN ('analyzing','processing','ready','uploading','scheduled','published')
       ORDER BY COALESCE(queue_position, 999999999), created_at ASC`
    );
  }

  countByStatus() {
    const rows = this.all('SELECT status, COUNT(*) AS n FROM ingest_videos GROUP BY status');
    const out = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  countByYoutubeStatus() {
    const rows = this.all('SELECT youtube_status, COUNT(*) AS n FROM ingest_videos GROUP BY youtube_status');
    const out = {};
    for (const r of rows) out[r.youtube_status] = r.n;
    return out;
  }

  nextQueuePosition() {
    const row = this.get('SELECT MAX(queue_position) AS m FROM ingest_videos');
    return (row && row.m ? row.m : 0) + 1;
  }

  totalQueued() {
    const row = this.get(`SELECT COUNT(*) AS n FROM ingest_videos WHERE status = 'queued'`);
    return row ? row.n : 0;
  }

  findByYoutubeId(youtubeId) {
    if (!youtubeId) return null;
    return this.get('SELECT * FROM ingest_videos WHERE youtube_video_id = ?', [youtubeId]);
  }

  /* ------------------------------------------------------------ checkpoints */

  saveCheckpoint(videoId, stage, state, artifact) {
    this.run(
      `INSERT INTO ingest_checkpoints (video_id, stage, state, artifact, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(video_id, stage) DO UPDATE SET
         state = excluded.state, artifact = excluded.artifact, updated_at = excluded.updated_at`,
      [videoId, stage, state, artifact ? JSON.stringify(artifact) : null, nowIso()]
    );
  }

  getCheckpoint(videoId, stage) {
    const row = this.get('SELECT * FROM ingest_checkpoints WHERE video_id = ? AND stage = ?', [videoId, stage]);
    if (!row) return null;
    let artifact = null;
    if (row.artifact) {
      try {
        artifact = JSON.parse(row.artifact);
      } catch (_) {
        artifact = null;
      }
    }
    return { videoId, stage, state: row.state, artifact, updatedAt: row.updated_at };
  }

  clearCheckpoint(videoId, stage) {
    this.run('DELETE FROM ingest_checkpoints WHERE video_id = ? AND stage = ?', [videoId, stage]);
  }

  /**
   * Reset the pipeline for a video so its next run regenerates everything.
   *
   * The YouTube video id is PRESERVED when the previous upload outcome was
   * uncertain, so reconciliation can still find the video YouTube already has
   * instead of uploading it a second time.
   */
  resetVideo(videoId) {
    const v = this.getVideo(videoId);
    const uncertain = Boolean(v && v.youtube_uncertain);
    this.run('DELETE FROM ingest_checkpoints WHERE video_id = ?', [videoId]);
    const patch = {
      status: 'queued',
      ai_status: 'pending',
      ai_error: null,
      ai_round: 0,
      ai_attempts: 0,
      ai_paused_at: null,
      ai_provider: null,
      ai_model: null,
      thumbnail_status: 'pending',
      thumbnail_error: null,
      thumbnail_source: null,
      youtube_status: 'pending',
      youtube_error: null,
      youtube_http_status: null,
      youtube_operation: null,
      youtube_retry_count: 0,
      youtube_uncertain: 0,
      cleanup_error: null
    };
    if (!uncertain) {
      patch.youtube_video_id = null;
      patch.youtube_url = null;
    }
    return this.updateVideo(videoId, patch);
  }

  /* --------------------------------------------------------------- slots */

  assignSlot(videoId, slot) {
    const id = `${slot.dateKey}#${slot.index}#${videoId}`;
    this.run(
      `INSERT INTO slot_assignments (id, video_id, slot_date_et, slot_index, slot_time_et, slot_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = 'planned', youtube_video_id = NULL, updated_at = excluded.updated_at`,
      [id, videoId, slot.dateKey, slot.index, slot.wall, slot.utcIso, nowIso(), nowIso()]
    );
    this.updateVideo(videoId, {
      slot_date_et: slot.dateKey,
      slot_index: slot.index,
      slot_time_et: slot.wall,
      scheduled_at_utc: slot.utcIso,
      publish_at: slot.utcIso
    });
    return id;
  }

  /** Slot keys already taken, as a Set of "dateKey#index". */
  takenSlotKeys() {
    const rows = this.all(
      `SELECT slot_date_et, slot_index FROM slot_assignments
       WHERE status IN ('planned','uploaded','confirmed')`
    );
    return new Set(rows.map((r) => `${r.slot_date_et}#${r.slot_index}`));
  }

  markSlotUploaded(slotDateEt, slotIndex, youtubeVideoId) {
    const row = this.get('SELECT id FROM slot_assignments WHERE slot_date_et = ? AND slot_index = ?', [slotDateEt, slotIndex]);
    if (!row) return;
    this.run(
      `UPDATE slot_assignments SET status = 'uploaded', youtube_video_id = ?, updated_at = ? WHERE id = ?`,
      [youtubeVideoId, nowIso(), row.id]
    );
  }

  releaseSlot(videoId) {
    this.run(`UPDATE slot_assignments SET status = 'released', updated_at = ? WHERE video_id = ? AND status = 'planned'`, [nowIso(), videoId]);
    this.updateVideo(videoId, { slot_date_et: null, slot_index: null, slot_time_et: null, scheduled_at_utc: null, publish_at: null });
  }

  slotsForDate(dateKey) {
    return this.all('SELECT * FROM slot_assignments WHERE slot_date_et = ? ORDER BY slot_index ASC', [dateKey]);
  }

  /* ---------------------------------------------------- provider attempts */

  logAttempt(entry) {
    this.run(
      `INSERT INTO provider_attempts
         (video_id, stage, provider, model, status, http_status, error_code, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.videoId || null,
        entry.stage,
        entry.provider,
        entry.model || null,
        entry.status,
        entry.httpStatus || null,
        entry.errorCode || null,
        entry.error ? String(entry.error).slice(0, 2000) : null,
        entry.durationMs || null,
        nowIso()
      ]
    );
  }

  attemptsFor(videoId, stage) {
    return this.all(
      'SELECT * FROM provider_attempts WHERE video_id = ? AND stage = ? ORDER BY id ASC',
      [videoId, stage]
    );
  }

  /* ------------------------------------------------------------- cleanup */

  createCleanupTask(task) {
    this.run(
      `INSERT INTO cleanup_tasks (id, video_id, local_path, drive_file_id, eligible_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         local_path = excluded.local_path, drive_file_id = excluded.drive_file_id,
         eligible_at = excluded.eligible_at, status = 'pending', updated_at = excluded.updated_at`,
      [task.id, task.videoId, task.localPath || null, task.driveFileId || null, task.eligibleAt, nowIso(), nowIso()]
    );
    return task.id;
  }

  updateCleanupTask(id, patch) {
    const keys = Object.keys(patch).filter((k) => ['status', 'local_result', 'drive_result', 'error', 'attempts'].includes(k));
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const params = keys.map((k) => patch[k]);
    params.push(nowIso(), id);
    this.run(`UPDATE cleanup_tasks SET ${sets}, updated_at = ? WHERE id = ?`, params);
  }

  dueCleanupTasks(now) {
    return this.all(
      `SELECT * FROM cleanup_tasks WHERE status = 'pending' AND eligible_at <= ? ORDER BY eligible_at ASC LIMIT 50`,
      [now.toISOString()]
    );
  }

  cleanupTaskForVideo(videoId) {
    return this.get('SELECT * FROM cleanup_tasks WHERE video_id = ? ORDER BY created_at DESC', [videoId]);
  }

  pendingCleanupCount() {
    const row = this.get(`SELECT COUNT(*) AS n FROM cleanup_tasks WHERE status = 'pending'`);
    return row ? row.n : 0;
  }

  failedCleanupCount() {
    const row = this.get(`SELECT COUNT(*) AS n FROM cleanup_tasks WHERE status = 'failed'`);
    return row ? row.n : 0;
  }

  /* ---------------------------------------------------------- statistics */

  storageSummary() {
    const row = this.get(
      `SELECT COUNT(*) AS total_files,
              COALESCE(SUM(file_size), 0) AS total_bytes,
              COALESCE(SUM(CASE WHEN local_deleted_at IS NULL THEN file_size ELSE 0 END), 0) AS local_bytes
       FROM ingest_videos`
    );
    return row || { total_files: 0, total_bytes: 0, local_bytes: 0 };
  }

  close() {
    try {
      this.db.close();
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { IngestDatabase, SCHEMA_VERSION, DDL };
