'use strict';
/**
 * routes/api.js
 * ---------------------------------------------------------------------------
 * The complete HTTP API. Every endpoint that exists is defined here - nothing
 * is invented and nothing is a stub that pretends to work.
 *
 * Authentication model:
 *   - Everything except /healthz, /api/auth/* and the static login page
 *     requires a valid owner session cookie.
 *   - The owner allowlist comes from OWNER_EMAIL. No public sign-up exists.
 *
 * Bulk upload model:
 *   - One HTTP request per file, raw body streamed straight to disk. This is
 *     what makes 1,000-file batches from a phone practical (per-file progress,
 *     resumable at the app level, no giant multipart bodies in memory).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function buildApi(ctx) {
  const {
    config, log, db, queue, pipeline, storage, youtube, drive,
    metadataAi, thumbnail, media, ownerAuth, googleAuth, cleanupWorker, trends
  } = ctx;

  const router = express.Router();

  /* ------------------------------------------------------------- middleware */

  function requireOwner(req, res, next) {
    const session = ownerAuth.fromCookieHeader(req.headers.cookie);
    if (!session) {
      return res.status(401).json({ error: 'authentication_required' });
    }
    req.session = session;
    next();
  }

  /* ------------------------------------------------------------------ health */

  // Deliberately unauthenticated: it is used by Render/Railway health checks.
  router.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      service: 'youtube-bulk-scheduler',
      timezone: config.timezone.zone,
      now: new Date().toISOString()
    });
  });

  /* --------------------------------------------------------------------- auth */

  router.get('/auth/config', (req, res) => {
    res.json({
      googleConfigured: googleAuth.configured(),
      ownerConfigured: ownerAuth.ownerCount() > 0,
      scopes: config.google.scopes,
      redirectUri: config.youtube.redirectUri
    });
  });

  router.get('/auth/google/start', (req, res) => {
    if (!googleAuth.configured()) {
      return res.status(503).json({ error: 'google_oauth_not_configured' });
    }
    const state = ownerAuth.newState();
    // Short-lived, single-use state stored server-side only.
    db.setSetting(`oauth_state:${state}`, String(Date.now() + 10 * 60 * 1000));
    res.redirect(googleAuth.authUrl(state));
  });

  router.get('/auth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      return res.redirect(`/?auth_error=${encodeURIComponent(String(error))}`);
    }
    const stored = db.getSetting(`oauth_state:${state || ''}`);
    if (!state || !stored || Number(stored) < Date.now()) {
      return res.status(400).send('Invalid or expired OAuth state. Please start again.');
    }
    db.run('DELETE FROM settings WHERE key = ?', [`oauth_state:${state}`]);

    try {
      const info = await googleAuth.exchangeCode(String(code));

      if (!ownerAuth.isOwner(info.email)) {
        // Never reveal which addresses are allowed.
        log.warn?.('auth: rejected a non-owner Google sign-in', { emailKnown: Boolean(info.email) });
        return res.redirect('/?auth_error=not_authorized');
      }

      const token = ownerAuth.issueSession(info);
      res.setHeader('Set-Cookie', ownerAuth.cookieHeader(token));
      res.redirect('/');
    } catch (err) {
      log.error?.('auth: callback failed', { error: String(err && err.message).slice(0, 300) });
      res.redirect('/?auth_error=exchange_failed');
    }
  });

  router.get('/auth/session', (req, res) => {
    const session = ownerAuth.fromCookieHeader(req.headers.cookie);
    if (!session) return res.status(401).json({ error: 'authentication_required' });
    res.json({
      authenticated: true,
      subject: session.sub,
      name: session.name,
      picture: session.picture,
      expiresAt: new Date(session.exp).toISOString()
    });
  });

  router.post('/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', ownerAuth.clearCookieHeader());
    res.json({ ok: true });
  });

  /* -------------------------------------------------------------- dashboard */

  router.get('/dashboard', requireOwner, (req, res) => {
    const now = new Date();
    const q = queue.dashboard(now);

    // AI provider status is only computed on demand (it may be slow).
    res.json({
      ...q,
      youtube: {
        connected: googleAuth.hasUsableTokens(),
        channel: pipeline.channel || null,
        insertsToday: youtube.insertCountToday(),
        softCap: config.youtube.dailyInsertSoftCap
      },
      cleanup: cleanupWorker.status()
    });
  });

  router.get('/dashboard/providers', requireOwner, (req, res) => {
    res.json({
      metadata: metadataAi.status(),
      thumbnail: thumbnail.status(),
      trends: trends.status()
    });
  });

  router.get('/dashboard/storage', requireOwner, async (req, res) => {
    try {
      res.json(await storage.summary(db));
    } catch (err) {
      res.status(500).json({ error: String(err && err.message).slice(0, 300) });
    }
  });

  router.get('/dashboard/videos', requireOwner, (req, res) => {
    const { status, youtubeStatus, limit } = req.query;
    const filter = {};
    if (status) filter.status = String(status);
    if (youtubeStatus) filter.youtubeStatus = String(youtubeStatus);
    let rows = db.listVideos(filter);
    if (limit) rows = rows.slice(0, parseInt(String(limit), 10) || 100);
    res.json({ count: rows.length, videos: rows.map(dbSafeVideo) });
  });

  router.get('/dashboard/videos/:id', requireOwner, (req, res) => {
    const v = db.getVideo(req.params.id);
    if (!v) return res.status(404).json({ error: 'not_found' });
    const attempts = db.attemptsFor(v.id, 'metadata').concat(db.attemptsFor(v.id, 'thumbnail'));
    res.json({ video: dbSafeVideo(v), attempts });
  });

  /* ---------------------------------------------------------- bulk ingest */

  /**
   * Raw-body upload. Headers:
   *   x-filename      original name (used for the stored name)
   *   x-file-size     expected size in bytes
   *   x-sha256        optional, enables duplicate suppression
   */
  router.post('/ingest', requireOwner, (req, res) => {
    const original = String(req.headers['x-filename'] || '').trim();
    const declaredSize = parseInt(String(req.headers['x-file-size'] || '0'), 10) || 0;
    const sha = String(req.headers['x-sha256'] || '').trim() || null;

    if (!original) return res.status(400).json({ error: 'missing_filename' });
    if (!/\.mp4$/i.test(original)) return res.status(400).json({ error: 'only_mp4_files_are_accepted' });
    if (declaredSize <= 0) return res.status(400).json({ error: 'missing_file_size' });
    if (declaredSize > config.storage.maxUploadBytes) {
      return res.status(413).json({ error: 'file_too_large' });
    }

    // Path-traversal defence: reduce the client-supplied name to a safe token.
    const safeName = safeFilename(original);
    const id = `ing_${crypto.randomUUID()}`;
    const dest = path.join(config.storage.uploadsDir, `${id}__${safeName}`);
    storage.ensureDirs();

    let received = 0;
    const out = fs.createWriteStream(dest);
    let aborted = false;

    const cleanupTmp = () => {
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch (_) {
        /* ignore */
      }
    };

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > config.storage.maxUploadBytes && !aborted) {
        aborted = true;
        cleanupTmp();
        out.destroy();
        if (!res.headersSent) res.status(413).json({ error: 'file_too_large' });
        req.destroy();
      }
    });

    req.on('aborted', () => {
      aborted = true;
      cleanupTmp();
      out.destroy();
    });

    req.on('error', () => {
      aborted = true;
      cleanupTmp();
      out.destroy();
      if (!res.headersSent) res.status(400).json({ error: 'upload_stream_error' });
    });

    out.on('error', (err) => {
      aborted = true;
      cleanupTmp();
      if (!res.headersSent) res.status(500).json({ error: 'write_failed', detail: String(err.message).slice(0, 200) });
    });

    out.on('finish', () => {
      if (aborted) return;
      if (received !== declaredSize) {
        cleanupTmp();
        if (!res.headersSent) {
          res.status(400).json({ error: 'size_mismatch', received, declaredSize });
        }
        return;
      }

      // Duplicate suppression (same content already ingested and not consumed).
      if (sha) {
        const existing = storage.findByHash(sha, db);
        if (existing && existing.status !== 'scheduled') {
          cleanupTmp();
          return res.status(409).json({
            error: 'duplicate_source',
            existingId: existing.id,
            message: 'This exact file is already in the queue.'
          });
        }
      }

      try {
        const row = db.createVideo({
          id,
          filename: `${id}__${safeName}`,
          original_name: original,
          local_path: dest,
          file_size: received,
          sha256: sha,
          queue_position: db.nextQueuePosition()
        });

        const top = queue.topUp();
        log.info?.('ingest: video queued', {
          videoId: id,
          filename: original,
          bytes: received,
          assignedSlots: top.assigned.length
        });

        res.status(201).json({
          ok: true,
          video: dbSafeVideo(row),
          assigned: top.assigned,
          queueTotal: db.totalQueued()
        });
      } catch (err) {
        cleanupTmp();
        if (!res.headersSent) {
          res.status(500).json({ error: 'queue_insert_failed', detail: String(err && err.message).slice(0, 300) });
        }
      }
    });

    req.pipe(out);
  });

  /* ----------------------------------------------------------- queue control */

  router.post('/queue/topup', requireOwner, (req, res) => {
    const out = queue.topUp();
    res.json(out);
  });

  router.post('/queue/retry/:id', requireOwner, (req, res) => {
    const out = queue.retry(req.params.id);
    res.status(out.ok ? 200 : 404).json(out);
  });

  router.post('/queue/retry-failed', requireOwner, (req, res) => {
    const failed = db.all(
      `SELECT id FROM ingest_videos WHERE status = 'failed' OR youtube_status = 'failed'`
    );
    let ok = 0;
    for (const r of failed) {
      if (queue.retry(r.id).ok) ok += 1;
    }
    res.json({ retried: ok });
  });

  router.post('/queue/clear-failed', requireOwner, (req, res) => {
    res.json(queue.clearFailed());
  });

  /* -------------------------------------------------------------- worker */

  router.post('/worker/run', requireOwner, async (req, res) => {
    if (pipeline.busy) return res.status(409).json({ error: 'worker_already_running' });
    try {
      const out = await pipeline.runOnce();
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: String(err && err.message).slice(0, 300) });
    }
  });

  router.get('/worker/status', requireOwner, (req, res) => {
    res.json({
      running: pipeline.busy,
      current: pipeline.current(),
      concurrency: config.worker.concurrency
    });
  });

  router.post('/worker/reconcile', requireOwner, async (req, res) => {
    try {
      res.json(await pipeline.reconcileInterrupted());
    } catch (err) {
      res.status(500).json({ error: String(err && err.message).slice(0, 300) });
    }
  });

  router.post('/worker/resume-paused', requireOwner, async (req, res) => {
    try {
      res.json(await pipeline.resumePaused());
    } catch (err) {
      res.status(500).json({ error: String(err && err.message).slice(0, 300) });
    }
  });

  /* ------------------------------------------------------------- cleanup */

  router.post('/cleanup/run', requireOwner, async (req, res) => {
    try {
      res.json(await cleanupWorker.runOnce());
    } catch (err) {
      res.status(500).json({ error: String(err && err.message).slice(0, 300) });
    }
  });

  router.get('/cleanup/status', requireOwner, (req, res) => {
    res.json(cleanupWorker.status());
  });

  /* ------------------------------------------------------------ youtube */

  router.get('/youtube/status', requireOwner, async (req, res) => {
    let channel = pipeline.channel;
    if (!channel) {
      try {
        channel = await youtube.getMyChannel();
        pipeline.channel = channel;
      } catch (err) {
        channel = null;
      }
    }
    res.json({
      connected: googleAuth.hasUsableTokens(),
      scopes: googleAuth.safeStatus().scopes,
      channel: channel
        ? {
          id: channel.id,
          title: channel.title,
          madeForKids: channel.madeForKids,
          selfDeclaredMadeForKids: channel.selfDeclaredMadeForKids,
          uploadsPlaylistId: channel.uploadsPlaylistId
        }
        : null,
      insertsToday: youtube.insertCountToday(),
      dailyInsertSoftCap: config.youtube.dailyInsertSoftCap,
      madeForKidsDefault: config.youtube.madeForKids,
      syntheticMediaDisclosure: config.youtube.syntheticMedia
    });
  });

  /** Read-only confirmation that a video really exists on YouTube. */
  router.get('/youtube/videos/:id', requireOwner, async (req, res) => {
    try {
      const info = await youtube.confirmUpload(req.params.id);
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: String(err && err.message).slice(0, 300) });
    }
  });

  /* -------------------------------------------------------------- storage */

  router.get('/storage/summary', requireOwner, async (req, res) => {
    try {
      res.json(await storage.summary(db));
    } catch (err) {
      res.status(500).json({ error: String(err && err.message).slice(0, 300) });
    }
  });

  /* ------------------------------------------------------------- settings */

  router.get('/settings', requireOwner, (req, res) => {
    res.json({
      timezone: config.timezone.zone,
      displayTimezones: config.timezone.displayZones,
      videosPerDay: config.schedule.effectiveVideosPerDay,
      slotTimes: config.schedule.effectiveSlots.map((s) => `${String(s.h).padStart(2, '0')}:${String(s.m).padStart(2, '0')}`),
      deleteAfterYouTube: config.storage.deleteAfterYouTube,
      deleteDelayHours: Math.min(config.storage.deleteDelayHours, config.storage.deleteMaxHours),
      driveEnabled: drive.enabled,
      maxUploadBytes: config.storage.maxUploadBytes,
      syntheticMediaDisclosure: config.youtube.syntheticMedia
    });
  });

  /* ---------------------------------------------------- path-safe assets */

  /**
   * Serve a derived asset (thumbnail / frame) by id. The path is looked up in
   * the database and then confined to the derived directory, so no request
   * can escape the data folder.
   */
  router.get('/assets/:id/:kind', requireOwner, (req, res) => {
    const v = db.getVideo(req.params.id);
    if (!v) return res.status(404).json({ error: 'not_found' });

    const candidates = {
      thumbnail: v.thumbnail_path,
      local: v.local_path
    };
    const wanted = candidates[req.params.kind];
    if (!wanted) return res.status(404).json({ error: 'no_asset' });

    const safe = storage.safeLocalPath(wanted, [config.storage.derivedDir, config.storage.uploadsDir]);
    if (!safe || !fs.existsSync(safe)) return res.status(403).json({ error: 'path_not_allowed' });

    if (req.params.kind === 'thumbnail') {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=60');
    }
    fs.createReadStream(safe).pipe(res);
  });

  return router;
};

/** Reduce a client-supplied filename to a safe, unique-ish token. */
function safeFilename(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .slice(-80) || 'video.mp4';
}

/** Never leak token paths or internal filesystem layout to the browser. */
function dbSafeVideo(v) {
  return {
    id: v.id,
    filename: v.original_name,
    status: v.status,
    queuePosition: v.queue_position,
    fileSize: v.file_size,
    durationSeconds: v.duration_seconds,
    width: v.width,
    height: v.height,
    videoCodec: v.video_codec,
    audioCodec: v.audio_codec,
    container: v.container,
    uploadedAt: v.uploaded_at,
    aiStatus: v.ai_status,
    aiProvider: v.ai_provider,
    aiModel: v.ai_model,
    aiError: v.ai_error,
    aiAttempts: v.ai_attempts,
    aiPausedAt: v.ai_paused_at,
    thumbnailStatus: v.thumbnail_status,
    thumbnailSource: v.thumbnail_source,
    thumbnailError: v.thumbnail_error,
    youtubeStatus: v.youtube_status,
    youtubeVideoId: v.youtube_video_id,
    youtubeUrl: v.youtube_url,
    youtubeError: v.youtube_error,
    youtubeHttpStatus: v.youtube_http_status,
    youtubeOperation: v.youtube_operation,
    youtubeRetryCount: v.youtube_retry_count,
    youtubeUncertain: Boolean(v.youtube_uncertain),
    slotDateEt: v.slot_date_et,
    slotIndex: v.slot_index,
    slotTimeEt: v.slot_time_et,
    scheduledAtUtc: v.scheduled_at_utc,
    title: v.title,
    description: v.description,
    tags: v.tags,
    hashtags: v.hashtags,
    categoryId: v.category_id,
    madeForKids: v.made_for_kids,
    containsSynthetic: v.contains_synthetic,
    syntheticConfidence: v.synthetic_confidence,
    driveFileId: v.drive_file_id ? true : false,
    cleanupStatus: v.cleanup_status,
    cleanupEligibleAt: v.cleanup_eligible_at,
    cleanupError: v.cleanup_error,
    localDeletedAt: v.local_deleted_at,
    driveDeletedAt: v.drive_deleted_at,
    createdAt: v.created_at,
    updatedAt: v.updated_at
  };
}

module.exports.dbSafeVideo = dbSafeVideo;
module.exports.safeFilename = safeFilename;
