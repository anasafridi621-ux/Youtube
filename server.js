'use strict';
/**
 * server.js
 * ---------------------------------------------------------------------------
 * Entry point for the single-owner bulk MP4 ingest -> SEO metadata ->
 * thumbnail -> 5/day US-Eastern YouTube scheduling system.
 *
 * Boot order matters:
 *   1. validate config (report problems, do not crash)
 *   2. open the database
 *   3. reconcile anything a previous crash left ambiguous
 *   4. top up the rolling advance buffer
 *   5. start the worker + cleanup sweeps
 *   6. listen
 *
 * The app is deployable as-is on a local PC and, unchanged, on Render/Railway:
 * there is no local-only code path. What differs is only APP_URL / PORT /
 * DATABASE_PATH, and the fact that a powered-off local PC cannot run the
 * worker (a video already scheduled on YouTube still publishes on time).
 */

require('dotenv').config({ quiet: true });

const express = require('express');
const path = require('path');
const fs = require('fs');

const { config, validate } = require('./config');
const { Logger } = require('./services/logger');
const { IngestDatabase } = require('./database/ingest-db');
const { MediaService } = require('./services/media-service');
const { MetadataAiService } = require('./services/metadata-ai-service');
const { ThumbnailService } = require('./services/thumbnail-service');
const { GoogleAuthService } = require('./services/google-auth-service');
const { YouTubeService } = require('./services/youtube-service');
const { DriveService } = require('./services/drive-service');
const { StorageService } = require('./services/storage-service');
const { QueueEngine } = require('./services/queue-engine');
const { Pipeline } = require('./services/pipeline');
const { CleanupWorker } = require('./services/cleanup-worker');
const { TrendsService } = require('./services/trends-service');
const { OwnerAuthService } = require('./services/owner-auth-service');

const log = new Logger('server', { dir: config.logging.dir });

async function main() {
  /* ------------------------------------------------------------ 1. config */

  const { problems, warnings } = validate(config);
  for (const w of warnings) log.warn(`config: ${w}`);
  for (const p of problems) log.error(`config: ${p}`);

  if (problems.length) {
    log.error('boot: refusing to start with unresolved configuration problems', { problems });
    console.error('\nConfiguration problems (fix these, then restart):');
    for (const p of problems) console.error(`  - ${p}\n`);
    process.exitCode = 1;
    return;
  }

  /* -------------------------------------------------------- 2. dependencies */

  const db = new IngestDatabase(config.database.path);
  const media = new MediaService(log.child('media'));
  const googleAuth = new GoogleAuthService({ logger: log.child('google-auth') });
  const youtube = new YouTubeService({ logger: log.child('youtube'), auth: googleAuth });
  const drive = new DriveService({ logger: log.child('drive'), auth: googleAuth });
  const storage = new StorageService({ logger: log.child('storage'), drive });
  const metadataAi = new MetadataAiService({ logger: log.child('ai') });
  const thumbnail = new ThumbnailService({ logger: log.child('thumbnail'), media });
  const trends = new TrendsService({ logger: log.child('trends') });
  const queue = new QueueEngine({ logger: log.child('queue'), db });
  const pipeline = new Pipeline({
    logger: log.child('pipeline'),
    db,
    queue,
    media,
    metadataAi,
    thumbnail,
    youtube,
    storage,
    trends
  });
  const cleanupWorker = new CleanupWorker({ logger: log.child('cleanup'), db, storage });
  const ownerAuth = new OwnerAuthService({ logger: log.child('auth') });

  storage.ensureDirs();

  const bins = await media.binaries();
  if (!bins.ffmpeg) {
    log.warn('boot: FFmpeg was not found. Install ffmpeg (or set FFMPEG_PATH). Video analysis and the thumbnail frame fallback need it.');
  } else {
    log.info('boot: ffmpeg resolved', { ffmpeg: bins.ffmpeg });
  }

  /* --------------------------------------------------- 3. crash recovery */

  try {
    const rec = await pipeline.reconcileInterrupted();
    if (rec.checked) {
      log.warn('boot: reconciled interrupted jobs from a previous run', rec);
    }
  } catch (err) {
    log.error('boot: reconciliation failed', { error: String(err && err.message).slice(0, 300) });
  }

  /* ------------------------------------------------------ 4. buffer top-up */

  try {
    const top = queue.topUp();
    log.info('boot: advance buffer topped up', {
      assigned: top.assigned.length,
      active: top.activeCount,
      queueEmpty: top.queueEmpty
    });
    if (top.queueEmpty) log.info('boot: queue is empty - upload videos to begin');
  } catch (err) {
    log.error('boot: top-up failed', { error: String(err && err.message).slice(0, 300) });
  }

  /* ------------------------------------------------------------ 5. workers */

  const workerTimer = setInterval(() => {
    if (pipeline.busy) return;
    pipeline.runOnce().catch((err) => {
      log.error('worker: pass failed', { error: String(err && err.message).slice(0, 300) });
    });
  }, Math.max(2000, config.worker.pollIntervalMs));
  if (workerTimer.unref) workerTimer.unref();

  const sweepTimer = setInterval(() => {
    try {
      queue.releaseStaleSlots();
      queue.topUp();
    } catch (err) {
      log.error?.('sweep: failed', { error: String(err && err.message).slice(0, 200) });
    }
  }, Math.max(10000, config.worker.sweepIntervalMs));
  if (sweepTimer.unref) sweepTimer.unref();

  const resumeTimer = setInterval(() => {
    pipeline.resumePaused().catch(() => {});
  }, Math.max(60000, config.worker.providerHealthIntervalMs));
  if (resumeTimer.unref) resumeTimer.unref();

  cleanupWorker.start();

  /* ------------------------------------------------------------- 6. listen */

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Security headers. No CSP frame-ancestors so the preview can embed it.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    }
  }));

  const api = require('./routes/api')({
    config,
    log,
    db,
    queue,
    pipeline,
    storage,
    youtube,
    drive,
    metadataAi,
    thumbnail,
    media,
    ownerAuth,
    googleAuth,
    cleanupWorker,
    trends
  });
  app.use('/api', api);

  // JSON 404 for unknown API routes.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'no_such_endpoint' });
  });

  // Central error handler: never leak a stack trace to the client.
  app.use((err, req, res, _next) => {
    const status = err && err.status ? err.status : 500;
    log.error?.('http: unhandled error', {
      method: req.method,
      url: req.url,
      error: String(err && err.message).slice(0, 300)
    });
    if (res.headersSent) return;
    res.status(status).json({ error: status === 500 ? 'internal_error' : String(err.message).slice(0, 200) });
  });

  const server = app.listen(config.app.port, config.app.host, () => {
    const addr = server.address();
    log.info('boot: listening', {
      url: config.app.url,
      port: addr && addr.port,
      timezone: config.timezone.zone,
      videosPerDay: config.schedule.effectiveVideosPerDay,
      slots: config.schedule.effectiveSlots.map((s) => `${String(s.h).padStart(2, '0')}:${String(s.m).padStart(2, '0')}`).join(', ')
    });
    console.log(`\n  ${config.app.name}`);
    console.log(`  Listening on ${config.app.url}`);
    console.log(`  Master timezone: ${config.timezone.zone} (${config.schedule.effectiveVideosPerDay} videos/day)`);
    console.log(`  Owner sign-in:   ${config.app.url}/login\n`);
  });

  /* --------------------------------------------------------- 7. shutdown */

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutdown: received ${signal}`);
    pipeline.stop();
    cleanupWorker.stop();
    clearInterval(workerTimer);
    clearInterval(sweepTimer);
    clearInterval(resumeTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Hard exit if graceful close hangs.
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error?.('process: unhandled rejection', { reason: String(reason).slice(0, 300) });
  });
  process.on('uncaughtException', (err) => {
    log.error?.('process: uncaught exception', { error: String(err && err.message).slice(0, 300) });
  });

  // Expose for tests / scripts.
  module.exports.app = app;
  module.exports.ctx = { db, queue, pipeline, storage, youtube, drive, metadataAi, thumbnail, media, ownerAuth, googleAuth, cleanupWorker, trends };
}

if (require.main === module) {
  main().catch((err) => {
    log.error('boot: fatal', { error: String(err && err.stack).slice(0, 1000) });
    process.exit(1);
  });
}

module.exports = { main };
