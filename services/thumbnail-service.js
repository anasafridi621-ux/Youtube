'use strict';
/**
 * services/thumbnail-service.js
 * ---------------------------------------------------------------------------
 * Thumbnail generation for each video. This is a SEPARATE provider from the
 * four metadata models and is configured independently through env vars:
 *
 *   THUMBNAIL_PROVIDER        openrouter | gemini | pollinations | none
 *   THUMBNAIL_PROVIDER_KEY
 *   THUMBNAIL_PROVIDER_MODEL
 *
 * Primary flow:
 *   video -> visual context -> image model -> validate -> YouTube thumbnail
 *
 * Fallback (mandatory, never a paid call):
 *   video -> best local frame (sharp contrast/brightness scoring) -> normalize
 *   to 1280x720 -> YouTube thumbnail
 *
 * The fallback exists precisely so a rate-limit or outage never costs money
 * and never blocks the pipeline.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { classifyError } = require('./metadata-ai-service');

class ThumbnailService {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || config;
    this.media = opts.media; // MediaService
  }

  status() {
    const t = this.cfg.thumbnail;
    const configured = Boolean(t.provider && t.provider !== 'none');
    const paidRejected = configured && t.freeOnly && t.model && !isFreeish(t.model);
    return {
      provider: t.provider,
      model: t.model || null,
      configured: configured && !paidRejected,
      note: !configured
        ? 'no thumbnail AI configured - video frame fallback will be used'
        : !t.apiKey && t.provider !== 'pollinations'
          ? 'THUMBNAIL_PROVIDER_KEY not set - video frame fallback will be used'
          : paidRejected
            ? 'model is not a free model and THUMBNAIL_FREE_ONLY=true - video frame fallback will be used'
            : null,
      fallback: 'best local video frame (ffmpeg + sharp)',
      size: `${t.width}x${t.height}`
    };
  }

  /** Build the image prompt from the *video's own* metadata + visual brief. */
  buildPrompt({ video, metadata, analysis }) {
    const subject = (metadata && metadata.thumbnailDirection) || (metadata && metadata.title) || video.filename;
    const topic = (metadata && metadata.topic) || 'children\'s cartoon scene';
    const brief = (analysis && analysis.visualBrief) || '';
    return [
      `Create a bright, high-contrast, kid-safe YouTube thumbnail for a children's cartoon video.`,
      `Subject: ${subject}`,
      `Topic: ${topic}`,
      brief ? `Visual brief from the actual video: ${brief}` : '',
      `Style: colourful, friendly, large readable focal subject, clean background, no text, no logos, no scary elements, 16:9 composition.`,
      `Aspect ratio 16:9.`
    ].filter(Boolean).join('\n');
  }

  /* ------------------------------------------------------------ image AI */

  async _generateWithOpenRouter({ prompt, model, apiKey }) {
    const OpenAI = require('openai');
    const client = new OpenAI({
      apiKey,
      baseURL: this.cfg.ai.openrouter.baseUrl,
      timeout: this.cfg.thumbnail.timeoutMs,
      maxRetries: this.cfg.thumbnail.maxRetries
    });
    const res = await client.images.generate({ model, prompt, n: 1, size: '1280x720' });
    const item = res && res.data && res.data[0];
    if (!item) throw new Error('image model returned no data');
    if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
    if (item.url) return this._download(item.url);
    throw new Error('image model returned neither b64_json nor url');
  }

  async _generateWithGemini({ prompt, model }) {
    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ apiKey: this.cfg.thumbnail.apiKey });
    const res = await client.models.generateImages({
      model,
      prompt,
      config: { numberOfImages: 1, aspectRatio: '16:9' }
    });
    const img = res && res.generatedImages && res.generatedImages[0];
    const bytes = img && img.image && img.image.imageBytes;
    if (!bytes) throw new Error('Gemini image model returned no bytes');
    return Buffer.from(bytes, 'base64');
  }

  async _generateWithPollinations({ prompt, model }) {
    const axios = require('axios');
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${this.cfg.thumbnail.width}&height=${this.cfg.thumbnail.height}&nologo=true&nofeed=true`;
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: this.cfg.thumbnail.timeoutMs
    });
    if (!res.data || res.data.length < 1024) throw new Error('pollinations returned an unusable image');
    return Buffer.from(res.data);
  }

  async _download(url) {
    const axios = require('axios');
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: this.cfg.thumbnail.timeoutMs });
    return Buffer.from(res.data);
  }

  /* --------------------------------------------------------------- public */

  /**
   * Produce a thumbnail for one video.
   *
   * @returns {Promise<{ok:boolean, source:'ai'|'frame'|'none', path?:string, error?:string, attempts:Array}>}
   */
  async generate({ video, metadata, analysis, outDir }) {
    const attempts = [];
    const t = this.cfg.thumbnail;
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, `${video.id}.jpg`);

    const providerUsable = t.provider && t.provider !== 'none'
      && (t.provider === 'pollinations' || Boolean(t.apiKey))
      && !(t.freeOnly && t.model && !isFreeish(t.model));

    if (providerUsable) {
      const prompt = this.buildPrompt({ video, metadata, analysis });
      const started = Date.now();
      try {
        let buf;
        if (t.provider === 'openrouter') {
          if (!t.model) throw new Error('THUMBNAIL_PROVIDER_MODEL is not set');
          buf = await this._generateWithOpenRouter({ prompt, model: t.model, apiKey: t.apiKey });
        } else if (t.provider === 'gemini') {
          if (!t.model) throw new Error('THUMBNAIL_PROVIDER_MODEL is not set');
          buf = await this._generateWithGemini({ prompt, model: t.model });
        } else {
          buf = await this._generateWithPollinations({ prompt, model: t.model });
        }

        const valid = await this._validateImage(buf, dest);
        if (valid.ok) {
          attempts.push({
            videoId: video.id,
            stage: 'thumbnail',
            provider: t.provider,
            model: t.model,
            status: 'success',
            durationMs: Date.now() - started
          });
          return { ok: true, source: 'ai', path: dest, attempts };
        }
        throw new Error(valid.reason);
      } catch (err) {
        const info = classifyError(err);
        attempts.push({
          videoId: video.id,
          stage: 'thumbnail',
          provider: t.provider,
          model: t.model,
          status: 'failed',
          httpStatus: info.status,
          errorCode: info.code,
          error: info.message,
          durationMs: Date.now() - started
        });
        this.log.warn?.('thumbnail: AI provider failed, using video frame fallback', {
          videoId: video.id,
          provider: t.provider,
          code: info.code
        });
        // Deliberately NOT retried with a paid provider. Fall through to frame.
      }
    }

    /* ---------------------------------------------- fallback: real frame */
    if (!this.media) throw new Error('thumbnail fallback requires a MediaService');
    try {
      const frameDir = path.join(outDir, 'frames');
      const best = await this.media.bestFrameForThumbnail(video.local_path || video.tmp_path, frameDir);
      await this.media.normalizeThumbnail(best.path, dest, t.width, t.height);
      try { fs.unlinkSync(best.path); } catch (_) { /* ignore */ }
      attempts.push({
        videoId: video.id,
        stage: 'thumbnail',
        provider: 'video-frame',
        model: 'ffmpeg+sharp',
        status: 'success',
        durationMs: null
      });
      return { ok: true, source: 'frame', path: dest, attempts, frameAtSeconds: best.atSeconds };
    } catch (err) {
      attempts.push({
        videoId: video.id,
        stage: 'thumbnail',
        provider: 'video-frame',
        model: 'ffmpeg+sharp',
        status: 'failed',
        error: String(err.message).slice(0, 400)
      });
      return { ok: false, source: 'none', error: String(err.message).slice(0, 400), attempts };
    }
  }

  /** Validate that the buffer really is a usable, correctly sized image. */
  async _validateImage(buf, dest) {
    try {
      const sharp = require('sharp');
      const img = sharp(buf);
      const meta = await img.metadata();
      if (!meta.width || !meta.height) return { ok: false, reason: 'image has no dimensions' };
      if (meta.width < 640 || meta.height < 360) {
        return { ok: false, reason: `image too small (${meta.width}x${meta.height})` };
      }
      await img
        .resize(this.cfg.thumbnail.width, this.cfg.thumbnail.height, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 92, mozjpeg: true })
        .toFile(dest);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `image validation failed: ${String(err.message).slice(0, 200)}` };
    }
  }
}

function isFreeish(model) {
  if (!model) return true;
  return /:free$/i.test(model) || /pollinations/i.test(model);
}

module.exports = { ThumbnailService };
