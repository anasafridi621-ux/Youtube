'use strict';
/**
 * services/metadata-ai-service.js
 * ---------------------------------------------------------------------------
 * The four-model content/metadata AI chain, in strict deterministic order:
 *
 *     1. Gemini            (GEMINI_API_KEY, GEMINI_MODEL)
 *     2. OpenRouter #1     (OPENROUTER_API_KEY_1, OPENROUTER_MODEL_1)
 *     3. OpenRouter #2     (OPENROUTER_API_KEY_2, OPENROUTER_MODEL_2)
 *     4. OpenRouter #3     (OPENROUTER_API_KEY_3, OPENROUTER_MODEL_3)
 *
 * Rules enforced here (from the product requirements):
 *   - Strict *sequential* fallback. On failure of one provider the next
 *     configured provider is tried. Never parallel, never random.
 *   - All three OpenRouter models must be free models. OPENROUTER_FREE_ONLY
 *     (default true) rejects any configured slug that is not a free model, so
 *     a paid model can never be selected implicitly.
 *   - No model is ever hard-coded in application logic: names come from env.
 *   - If all four fail, `generate()` returns `{ok:false}` with the full
 *     attempt ledger. The caller parks the video as `paused` and surfaces
 *     video id / failed provider / reason / all attempts / timestamp / retry
 *     info. It never silently skips.
 *   - Metadata is produced from the *actual video* (frames + ffprobe facts),
 *     not from the filename.
 */

const { config, isLikelyFreeModel } = require('../config');
const { redact } = require('./logger');

const CATEGORY_IDS = {
  film: '1', animation: '1',
  autos: '2', vehicles: '2',
  music: '10',
  pets: '15', animals: '15',
  sports: '17',
  travel: '19', events: '19',
  gaming: '20',
  people: '22', blogs: '22',
  comedy: '23',
  entertainment: '24',
  news: '25', politics: '25',
  howto: '26', style: '26',
  education: '27', science: '27', technology: '28',
  nonprofit: '29', activism: '29'
};

/** Structured, retryable-free classification of a provider failure. */
function classifyError(err) {
  const status = Number(err && (err.status || err.statusCode || (err.response && err.response.status))) || 0;
  const raw = String((err && (err.message || err.error)) || err || 'unknown error');
  const msg = raw.toLowerCase();

  let code = 'unknown';
  if (status === 401 || status === 403) code = 'auth_or_forbidden';
  else if (status === 404) code = 'model_unavailable';
  else if (status === 408 || /timeout|timed out|etimedout/.test(msg)) code = 'timeout';
  else if (status === 429 || /rate limit|too many requests|quota|resource_exhausted/.test(msg)) code = 'rate_limited_or_quota';
  else if (status >= 500) code = 'provider_outage';
  else if (/econnreset|econnrefused|enotfound|socket hang up|network/.test(msg)) code = 'network';
  else if (/json|parse|empty response|no text|candidate/.test(msg)) code = 'invalid_response';
  else if (status === 400) code = 'bad_request';

  const retryable = ['timeout', 'rate_limited_or_quota', 'provider_outage', 'network', 'invalid_response', 'unknown'].includes(code);
  return { code, status, message: redact(raw).slice(0, 500), retryable };
}

class MetadataAiService {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || config;
    this._openaiClients = new Map();
    this._gemini = null;
  }

  /* ------------------------------------------------------------ providers */

  /** Ordered list of usable metadata providers. Never includes a paid model. */
  providers() {
    const list = [];
    const ai = this.cfg.ai;

    if (ai.gemini.apiKey) {
      list.push({
        id: 'gemini',
        label: 'Gemini',
        model: ai.gemini.model,
        kind: 'gemini'
      });
    }

    for (const fb of ai.fallbacks) {
      if (!fb.apiKey || !fb.model) {
        if (fb.apiKey || fb.model) {
          this.log.debug?.('metadata-ai: skipping incomplete OpenRouter fallback', { index: fb.index });
        }
        continue;
      }
      if (ai.openrouter.freeOnly && !isLikelyFreeModel(fb.model)) {
        // Refuse to silently promote a paid model. This is the whole point.
        this.log.warn?.('metadata-ai: refusing non-free OpenRouter model (OPENROUTER_FREE_ONLY=true)', {
          index: fb.index,
          model: fb.model
        });
        continue;
      }
      list.push({
        id: `openrouter_${fb.index}`,
        label: `OpenRouter #${fb.index}`,
        model: fb.model,
        kind: 'openrouter',
        index: fb.index
      });
    }
    return list;
  }

  /** Human readable status of every configured provider for the dashboard. */
  status() {
    const ai = this.cfg.ai;
    const out = [];
    out.push({
      id: 'gemini',
      label: 'Gemini (primary)',
      model: ai.gemini.model,
      configured: Boolean(ai.gemini.apiKey),
      usable: Boolean(ai.gemini.apiKey),
      note: ai.gemini.apiKey ? null : 'GEMINI_API_KEY not set'
    });
    for (const fb of ai.fallbacks) {
      const configured = Boolean(fb.apiKey && fb.model);
      const rejected = configured && ai.openrouter.freeOnly && !isLikelyFreeModel(fb.model);
      out.push({
        id: `openrouter_${fb.index}`,
        label: `OpenRouter #${fb.index}`,
        model: fb.model || null,
        configured,
        usable: configured && !rejected,
        note: !fb.apiKey
          ? `OPENROUTER_API_KEY_${fb.index} not set`
          : !fb.model
            ? `OPENROUTER_MODEL_${fb.index} not set`
            : rejected
              ? 'model is not a free model and OPENROUTER_FREE_ONLY=true'
              : null
      });
    }
    return out;
  }

  /* --------------------------------------------------------------- clients */

  _geminiClient() {
    if (this._gemini) return this._gemini;
    const { GoogleGenAI } = require('@google/genai');
    this._gemini = new GoogleGenAI({ apiKey: this.cfg.ai.gemini.apiKey });
    return this._gemini;
  }

  _openaiClient(index) {
    if (this._openaiClients.has(index)) return this._openaiClients.get(index);
    const OpenAI = require('openai');
    const fb = this.cfg.ai.fallbacks.find((f) => f.index === index);
    const client = new OpenAI({
      apiKey: fb.apiKey,
      baseURL: this.cfg.ai.openrouter.baseUrl,
      timeout: this.cfg.ai.openrouter.timeoutMs,
      maxRetries: this.cfg.ai.openrouter.maxRetries,
      defaultHeaders: {
        'HTTP-Referer': this.cfg.app.url,
        'X-Title': this.cfg.app.name
      }
    });
    this._openaiClients.set(index, client);
    return client;
  }

  /* ------------------------------------------------------------ prompting */

  /**
   * Build the video-understanding prompt.
   * `analysis` carries ffprobe facts + a *locally computed* visual brief, so
   * the model is grounding its answer in the real file rather than a filename.
   */
  buildPrompt({ analysis, trendNotes }) {
    const facts = {
      durationSeconds: analysis.durationSeconds,
      resolution: `${analysis.width}x${analysis.height}`,
      hasAudio: Boolean(analysis.hasAudio),
      visualBrief: analysis.visualBrief || null,
      sourceFilename: analysis.filename
    };

    const trendBlock = trendNotes && trendNotes.length
      ? `\nOptional discoverability vocabulary observed from live search data (use ONLY as wording hints; never claim anything is "trending" and never use a term that is not supported by the video):\n- ${trendNotes.join('\n- ')}\n`
      : '\nNo live trend data is available. Use strong content-based SEO only. Do not invent trending claims.\n';

    return {
      system: [
        'You are a YouTube metadata specialist for a US-targeted children\'s cartoon channel.',
        'You are given real evidence extracted from the actual video file: probe facts, a visual brief, and sampled frames.',
        'You must NEVER rely on the filename when the visual evidence disagrees with it.',
        '',
        'Hard content rules:',
        '- Accurate: the title must describe what actually happens in the video.',
        '- Child-appropriate: no adult language, no scary or misleading claims, no violence framing.',
        '- No keyword stuffing, no irrelevant tags, no spammy hashtag walls.',
        '- No deceptive titles, no fake urgency, no false claims about what is inside.',
        '- Tags: 8-15 genuinely relevant terms. Hashtags: at most 3.',
        '- Description: 2 short paragraphs, plain language a parent would find helpful.',
        '',
        'Return ONLY a JSON object, no markdown fences, no commentary.',
        'Schema:',
        '{',
        '  "title": string (max 90 chars, one final title),',
        '  "description": string,',
        '  "tags": string[],',
        '  "hashtags": string[],',
        '  "topic": string,',
        '  "categoryId": string (numeric YouTube category id),',
        '  "audience": "kids" | "family" | "general",',
        '  "madeForKids": boolean,',
        '  "appearsAIGenerated": boolean,',
        '  "syntheticConfidence": "low" | "medium" | "high",',
        '  "thumbnailDirection": string (what a good thumbnail for THIS video should show),',
        '  "evidence": string[] (what you actually saw that supports the title),',
        '  "confidence": number (0-1)',
        '}'
      ].join('\n'),
      user: [
        'VIDEO EVIDENCE (from the actual file):',
        JSON.stringify(facts, null, 2),
        trendBlock,
        'Produce the metadata JSON now.'
      ].join('\n')
    };
  }

  /* --------------------------------------------------------------- calling */

  async _callGemini(provider, { system, user, images }) {
    const client = this._geminiClient();
    const parts = [];
    for (const img of images || []) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
    parts.push({ text: `${system}\n\n${user}` });

    const res = await client.models.generateContent({
      model: provider.model,
      contents: [{ role: 'user', parts }],
      config: {
        temperature: this.cfg.ai.temperature,
        maxOutputTokens: this.cfg.ai.maxOutputTokens,
        responseMimeType: 'application/json'
      }
    });

    const text = res && res.text ? res.text() : null;
    if (!text || !String(text).trim()) {
      const err = new Error('Gemini returned an empty response');
      err.status = 502;
      throw err;
    }
    return String(text);
  }

  async _callOpenRouter(provider, { system, user, images }) {
    const client = this._openaiClient(provider.index);

    const content = [{ type: 'text', text: `${system}\n\n${user}` }];
    if (this.cfg.ai.sendFrames) {
      for (const img of images || []) {
        content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
      }
    }

    const res = await client.chat.completions.create({
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content }
      ],
      temperature: this.cfg.ai.temperature,
      max_tokens: this.cfg.ai.maxOutputTokens
    });

    const choice = res && res.choices && res.choices[0];
    const text = choice && choice.message && choice.message.content;
    if (!text || !String(text).trim()) {
      const err = new Error('OpenRouter returned an empty response');
      err.status = 502;
      throw err;
    }
    return String(text);
  }

  /* ------------------------------------------------------------ parsing */

  parseJson(text) {
    let t = String(text).trim();
    // Strip markdown fences if the model added them anyway.
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('response contained no JSON object');
    }
    const parsed = JSON.parse(t.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') throw new Error('response JSON was not an object');
    return parsed;
  }

  /** Normalise + child-safety-screen the model output. */
  normalize(raw, analysis, cfg = config) {
    const problems = [];
    const yt = (cfg && cfg.youtube) || {};
    const title = String(raw.title || '').replace(/\s+/g, ' ').trim();
    const description = String(raw.description || '').trim();
    const tags = (Array.isArray(raw.tags) ? raw.tags : [])
      .map((t) => String(t).toLowerCase().trim())
      .filter(Boolean);
    const hashtags = (Array.isArray(raw.hashtags) ? raw.hashtags : [])
      .map((h) => String(h).trim())
      .filter(Boolean);

    if (!title) problems.push('empty title');
    if (title.length > 100) problems.push('title longer than 100 characters');
    if (!description) problems.push('empty description');
    if (tags.length < 3) problems.push('fewer than 3 tags');
    if (hashtags.length > 3) problems.push('more than 3 hashtags');

    // Child-safety screen: block anything that reads as clickbait / adult /
    // misleading before it can reach YouTube.
    const BANNED = [
      /\b(sexy|nsfw|18\+|adults?\s+only|explicit|nude|naked|drugs?|weapon|kill|murder|gore|bloody)\b/i,
      /\b(you won'?t believe|shocking|gone wrong|must see|instantly|100% real|free money|click here now)\b/i,
      /\b(#+\s*){5,}/,
      /\b(best|#1|number one|top)\b.*\b(ever|in the world|guaranteed)\b/i
    ];
    const haystack = `${title} ${description} ${tags.join(' ')} ${hashtags.join(' ')}`;
    for (const re of BANNED) {
      if (re.test(haystack)) {
        problems.push('child-safety screen rejected the metadata');
        break;
      }
    }

    const hashtagClean = hashtags.slice(0, 3).map((h) => (h.startsWith('#') ? h : `#${h.replace(/^#+/, '')}`));

    const categoryId = CATEGORY_IDS[String(raw.categoryId || '').toLowerCase()] || String(raw.categoryId || yt.categoryId || '24');
    const channelMadeForKids = yt.madeForKids === null || yt.madeForKids === undefined ? true : yt.madeForKids;
    const madeForKids = raw.madeForKids === undefined ? channelMadeForKids : Boolean(raw.madeForKids);

    // Synthetic media disclosure: never blindly hard-coded.
    let containsSynthetic;
    let syntheticConfidence = String(raw.syntheticConfidence || 'low').toLowerCase();
    if (yt.syntheticMedia === 'true') {
      containsSynthetic = true;
      syntheticConfidence = 'operator-forced';
    } else if (yt.syntheticMedia === 'false') {
      containsSynthetic = false;
      syntheticConfidence = 'operator-forced';
    } else {
      containsSynthetic = raw.appearsAIGenerated === true;
      if (containsSynthetic && !['low', 'medium', 'high'].includes(syntheticConfidence)) syntheticConfidence = 'medium';
    }

    return {
      title,
      description,
      tags: Array.from(new Set(tags)).slice(0, 15),
      hashtags: hashtagClean,
      topic: String(raw.topic || '').trim() || null,
      categoryId,
      madeForKids,
      containsSynthetic,
      syntheticConfidence,
      thumbnailDirection: String(raw.thumbnailDirection || '').trim() || null,
      evidence: Array.isArray(raw.evidence) ? raw.evidence.map((e) => String(e)).slice(0, 8) : [],
      confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : null,
      problems
    };
  }

  /**
   * Main entry point. Walks the chain strictly in order.
   *
   * @returns {Promise<{ok:true, metadata, provider, model, attempts} |
   *                  {ok:false, reason, attempts, providers}>}
   */
  async generate({ video, analysis, trendNotes, onAttempt }) {
    const providers = this.providers();
    const attempts = [];
    const prompt = this.buildPrompt({ analysis, trendNotes });

    if (!providers.length) {
      return {
        ok: false,
        reason: 'no_metadata_provider_configured',
        providers: [],
        attempts: [],
        message: 'No metadata AI provider is configured. Set GEMINI_API_KEY and/or OPENROUTER_API_KEY_n + OPENROUTER_MODEL_n.'
      };
    }

    // Load the analysis frames once, reuse across the whole chain.
    let images = [];
    if (this.cfg.ai.sendFrames) {
      try {
        const sharp = require('sharp');
        const frames = Array.isArray(analysis.framePaths) ? analysis.framePaths : [];
        images = await Promise.all(
          frames.slice(0, this.cfg.ai.analysisFrames).map(async (p) => {
            const buf = await sharp(p)
              .resize({ width: this.cfg.ai.analysisFrameWidth, withoutEnlargement: true })
              .jpeg({ quality: this.cfg.ai.analysisJpegQuality })
              .toBuffer();
            return { base64: buf.toString('base64'), mimeType: 'image/jpeg', path: p };
          })
        );
      } catch (err) {
        this.log.warn?.('metadata-ai: could not prepare frames, falling back to text-only', {
          error: String(err.message).slice(0, 200)
        });
        images = [];
      }
    }

    for (const provider of providers) {
      const started = Date.now();
      try {
        this.log.info?.('metadata-ai: trying provider', {
          videoId: video.id,
          provider: provider.id,
          model: provider.model,
          frames: images.length
        });

        const rawText = provider.kind === 'gemini'
          ? await this._callGemini(provider, { ...prompt, images })
          : await this._callOpenRouter(provider, { ...prompt, images });

        const parsed = this.parseJson(rawText);
        const metadata = this.normalize(parsed, analysis, this.cfg);

        const attempt = {
          videoId: video.id,
          stage: 'metadata',
          provider: provider.id,
          model: provider.model,
          status: metadata.problems.length ? 'rejected' : 'success',
          durationMs: Date.now() - started,
          error: metadata.problems.length ? metadata.problems.join('; ') : null
        };
        attempts.push(attempt);
        if (onAttempt) onAttempt(attempt);

        if (metadata.problems.length) {
          this.log.warn?.('metadata-ai: provider returned unusable metadata', {
            videoId: video.id,
            provider: provider.id,
            problems: metadata.problems
          });
          continue; // fall through to the next provider
        }

        return { ok: true, metadata, provider: provider.id, model: provider.model, attempts };
      } catch (err) {
        const info = classifyError(err);
        const attempt = {
          videoId: video.id,
          stage: 'metadata',
          provider: provider.id,
          model: provider.model,
          status: 'failed',
          httpStatus: info.status,
          errorCode: info.code,
          error: info.message,
          durationMs: Date.now() - started
        };
        attempts.push(attempt);
        if (onAttempt) onAttempt(attempt);

        this.log.warn?.('metadata-ai: provider failed, falling through', {
          videoId: video.id,
          provider: provider.id,
          code: info.code,
          status: info.status,
          retryable: info.retryable
        });
        // Strict sequential fallback: try the next configured provider.
      }
    }

    return {
      ok: false,
      reason: 'all_metadata_providers_failed',
      providers,
      attempts,
      message: `All ${providers.length} metadata AI providers failed for video ${video.id}.`
    };
  }

  /**
   * Cheap liveness probe used to un-pause a paused pipeline.
   * Returns the first provider that answers, or null.
   */
  async healthProbe() {
    const providers = this.providers();
    for (const p of providers) {
      const started = Date.now();
      try {
        const text = p.kind === 'gemini'
          ? await this._callGemini(p, { system: 'Reply with the single word OK.', user: 'ping', images: [] })
          : await this._callOpenRouter(p, { system: 'Reply with the single word OK.', user: 'ping', images: [] });
        if (text && /ok/i.test(String(text).trim())) {
          return { provider: p.id, model: p.model, latencyMs: Date.now() - started };
        }
      } catch (_) {
        /* try next */
      }
    }
    return null;
  }
}

module.exports = { MetadataAiService, classifyError, CATEGORY_IDS };
