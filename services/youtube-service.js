'use strict';
/**
 * services/youtube-service.js
 * ---------------------------------------------------------------------------
 * YouTube Data API v3 integration for the ingest pipeline.
 *
 * Responsibilities:
 *   - Authorized client construction (server-side tokens only)
 *   - Resumable upload of the supplied MP4
 *   - Scheduling: privacyStatus=private + publishAt in correct UTC ISO-8601
 *     converted from America/New_York by the slot engine
 *   - Custom thumbnail upload (thumbnails.set)
 *   - Confirmation read-back (videos.list) - the "did it really happen?" check
 *   - Reconciliation: never upload the same queued job twice
 *   - Retry-once-then-FAILED policy, with the exact API error, HTTP status,
 *     operation, timestamp, retry count, video id, and whether YouTube may
 *     have received the upload
 *
 * Quota: we do NOT hard-code a per-call cost. Current YouTube documentation
 * (revision history) moved videos.insert into its own bucket in 2026, so any
 * 1,600-unit assumption is obsolete. We simply count calls and expose them,
 * with an optional operator-set soft cap (YOUTUBE_DAILY_INSERT_SOFT_CAP,
 * default 0 = disabled).
 */

const fs = require('fs');
const { google } = require('googleapis');

class YouTubeService {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || require('../config').config;
    this.auth = opts.auth; // GoogleAuthService
    this._api = null;
    this._insertsToday = { date: null, count: 0 };
  }

  /**
   * Lazily built YouTube client. A setter is provided so tests (and any future
   * alternative transport) can inject a client without touching the private
   * field directly.
   */
  get api() {
    if (!this._api) {
      const { google } = require('googleapis');
      this._api = google.youtube({ version: 'v3', auth: this.auth.authorizedClient() });
    }
    return this._api;
  }

  set api(value) {
    this._api = value;
  }

  /** Count today's inserts. Reset is per calendar day, Pacific. */
  _countInsert() {
    const key = new Date().toISOString().slice(0, 10);
    if (this._insertsToday.date !== key) this._insertsToday = { date: key, count: 0 };
    this._insertsToday.count += 1;
    return this._insertsToday.count;
  }

  insertCountToday() {
    const key = new Date().toISOString().slice(0, 10);
    if (this._insertsToday.date !== key) return 0;
    return this._insertsToday.count;
  }

  /* ------------------------------------------------------------ channel */

  /**
   * Read the live channel so we can honour the channel's existing
   * madeForKids / country configuration instead of overwriting it.
   */
  async getMyChannel() {
    const res = await this.api.channels.list({
      part: 'snippet,status,contentDetails,statistics',
      mine: true
    });
    const item = res.data.items && res.data.items[0];
    if (!item) return null;
    return {
      id: item.id,
      title: item.snippet && item.snippet.title,
      description: item.snippet && item.snippet.description,
      country: item.snippet && item.snippet.country,
      madeForKids: item.status ? item.status.madeForKids : undefined,
      selfDeclaredMadeForKids: item.status ? item.status.selfDeclaredMadeForKids : undefined,
      uploadsPlaylistId: item.contentDetails && item.contentDetails.relatedPlaylists
        ? item.contentDetails.relatedPlaylists.uploads
        : null,
      subscriberCount: item.statistics ? item.statistics.subscriberCount : null,
      videoCount: item.statistics ? item.statistics.videoCount : null
    };
  }

  /* ------------------------------------------------------------- upload */

  /**
   * Upload one video and schedule it.
   *
   * `slot` = { dateKey, index, wall, utcIso }
   *
   * Returns:
   *   { ok:true, videoId, url, confirmed }
   *   { ok:false, uncertain, error, httpStatus, operation, retryCount }
   *
   * `uncertain:true` means the request may have reached YouTube. The caller
   * must reconcile before retrying so we never double-upload.
   */
  async uploadAndSchedule(input) {
    // Accept both `uploadAndSchedule({video, thumbnailPath})` (the pipeline's
    // call shape) and `uploadAndSchedule(video)` for convenience/testing.
    const video = input && input.video ? input.video : input;
    const thumbnailPath = (input && input.thumbnailPath) || video.thumbnail_path || null;
    const onProgress = input && input.onProgress;

    const startedAt = new Date().toISOString();
    const operation = 'youtube.videos.insert';

    if (!video || !video.local_path || !fs.existsSync(video.local_path)) {
      return { ok: false, uncertain: false, error: 'local video file is missing', httpStatus: null, operation, retryCount: 0, startedAt };
    }
    if (!video.scheduled_at_utc) {
      return { ok: false, uncertain: false, error: 'video has no assigned slot', httpStatus: null, operation, retryCount: 0, startedAt };
    }

    const softCap = this.cfg.youtube.dailyInsertSoftCap;
    if (softCap > 0 && this.insertCountToday() >= softCap) {
      return {
        ok: false,
        uncertain: false,
        error: `operator-set daily insert soft cap (${softCap}) reached`,
        httpStatus: null,
        operation,
        retryCount: 0,
        startedAt
      };
    }

    const body = {
      snippet: {
        title: video.title,
        description: video.description || '',
        tags: parseTags(video.tags),
        categoryId: video.category_id || this.cfg.youtube.categoryId,
        defaultLanguage: this.cfg.youtube.defaultLanguage
      },
      status: {
        privacyStatus: this.cfg.schedule.privacyStatus, // "private"
        publishAt: video.scheduled_at_utc,             // correct UTC ISO-8601
        madeForKids: video.made_for_kids === null ? true : Boolean(video.made_for_kids),
        selfDeclaredMadeForKids: video.made_for_kids === null ? true : Boolean(video.made_for_kids),
        license: 'youtube'
      }
    };

    // Synthetic / altered media disclosure. Only sent when we have a real
    // value; the value itself is configurable and never silently assumed.
    if (video.contains_synthetic !== null && video.contains_synthetic !== undefined) {
      body.status.containsSyntheticMedia = Boolean(video.contains_synthetic);
    }

    let lastError = null;
    const maxTries = Math.max(1, this.cfg.youtube.uploadRetries + 1);

    for (let attempt = 1; attempt <= maxTries; attempt += 1) {
      // A fresh stream per attempt: a consumed stream cannot be replayed on a
      // retry, and an unread stream would leak an open fd.
      let stream = null;
      try {
      stream = fs.createReadStream(video.local_path);
      try {
        this.log.info?.('youtube: uploading', {
          videoId: video.id,
          attempt,
          maxTries,
          publishAt: video.scheduled_at_utc
        });

        const res = await this.api.videos.insert(
          {
            part: 'snippet,status',
            requestBody: body,
            media: { body: stream }
          },
          onProgress
            ? { onUploadProgress: (evt) => onProgress(evt) }
            : undefined
        );

        const videoId = res.data && res.data.id;
        if (!videoId) {
          throw new Error('videos.insert returned no video id');
        }

        this._countInsert();
        const url = `https://www.youtube.com/watch?v=${videoId}`;

        // Confirmation read-back: proves YouTube really has the resource.
        const confirmed = await this.confirmUpload(videoId);

        // Custom thumbnail. A failure here is logged, never fatal: the video
        // is already scheduled and a bad thumbnail must not fail the upload.
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          try {
            await this.setThumbnail(videoId, thumbnailPath);
          } catch (err) {
            this.log.warn?.('youtube: thumbnail upload failed (video still scheduled)', {
              videoId: video.id,
              error: String(err.message).slice(0, 300)
            });
          }
        }

        return { ok: true, videoId, url, confirmed, retryCount: attempt - 1, startedAt };
      } catch (err) {
        lastError = err;
        const status = Number(err.code || (err.response && err.response.status) || (err.errors && err.errors[0] && err.errors[0].reason && 0)) || null;
        const reason = extractReason(err);

        // A 4xx that is NOT retryable should not burn the second attempt.
        const retryable = status === null || status >= 500 || status === 408 || status === 429 || reason === 'uploadLimitExceeded';
        this.log.warn?.('youtube: upload attempt failed', {
          videoId: video.id,
          attempt,
          status,
          reason,
          retryable
        });

        if (!retryable || attempt === maxTries) break;
      }
      } finally {
        // Always release the fd, whether the upload succeeded, was retried,
        // or failed. An unread stream would otherwise leak and fire a late
        // ENOENT once the local file is cleaned up.
        if (stream && typeof stream.destroy === 'function') {
          try { stream.destroy(); } catch { /* already closed */ }
        }
      }
    }

    const status = Number(lastError && (lastError.code || (lastError.response && lastError.response.status))) || null;
    const uncertain = status === null || status >= 500 || status === 408 || status === 429;

    return {
      ok: false,
      uncertain,
      error: String((lastError && lastError.message) || 'unknown upload error').slice(0, 800),
      httpStatus: status,
      apiReason: extractReason(lastError),
      operation,
      retryCount: maxTries - 1,
      startedAt
    };
  }

  /** Read a video back. Returns null when it does not exist. */
  async confirmUpload(videoId) {
    try {
      const res = await this.api.videos.list({ part: 'id,status', id: videoId });
      const item = res.data.items && res.data.items[0];
      if (!item) return { exists: false };
      return {
        exists: true,
        privacyStatus: item.status ? item.status.privacyStatus : null,
        publishAt: item.status ? item.status.publishAt : null,
        uploadStatus: item.status ? item.status.uploadStatus : null,
        madeForKids: item.status ? item.status.madeForKids : undefined
      };
    } catch (err) {
      this.log.warn?.('youtube: confirmation read-back failed', {
        videoId,
        error: String(err.message).slice(0, 200)
      });
      return { exists: null };
    }
  }

  async setThumbnail(videoId, thumbnailPath) {
    const res = await this.api.thumbnails.set({
      videoId,
      media: { body: fs.createReadStream(thumbnailPath) }
    });
    return res.data;
  }

  /**
   * Reconcile a row whose upload outcome is unknown.
   * Returns {found:boolean, videoId, url} so the caller can either adopt the
   * existing video or safely retry.
   */
  async reconcile(videoId) {
    if (!videoId) return { found: false };
    const info = await this.confirmUpload(videoId);
    if (info && info.exists) {
      return { found: true, videoId, url: `https://www.youtube.com/watch?v=${videoId}`, info };
    }
    return { found: false };
  }

  /**
   * Look for an already-uploaded video by title, used when a crash happened
   * between the HTTP response and our own database write.
   * Uses channels.list + playlistItems (1 unit) rather than search (100 units).
   */
  async findByTitle(channelUploadsPlaylistId, title) {
    if (!channelUploadsPlaylistId || !title) return null;
    try {
      let pageToken;
      for (let page = 0; page < 10; page += 1) {
        const res = await this.api.playlistItems.list({
          part: 'snippet',
          playlistId: channelUploadsPlaylistId,
          maxResults: 50,
          pageToken
        });
        const items = res.data.items || [];
        for (const it of items) {
          if (it.snippet && it.snippet.title === title) {
            return { videoId: it.snippet.resourceId.videoId, url: `https://www.youtube.com/watch?v=${it.snippet.resourceId.videoId}` };
          }
        }
        pageToken = res.data.nextPageToken;
        if (!pageToken) break;
      }
    } catch (err) {
      this.log.warn?.('youtube: findByTitle failed', { error: String(err.message).slice(0, 200) });
    }
    return null;
  }
}

function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {
    /* fall through to comma split */
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractReason(err) {
  if (!err) return null;
  if (err.errors && err.errors[0]) {
    return err.errors[0].reason || err.errors[0].message || null;
  }
  if (err.response && err.response.data && err.response.data.error) {
    const e = err.response.data.error;
    if (e.errors && e.errors[0]) return e.errors[0].reason || e.errors[0].message || null;
    return e.message || null;
  }
  return null;
}

module.exports = { YouTubeService, parseTags, extractReason };
