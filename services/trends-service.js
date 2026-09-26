'use strict';
/**
 * services/trends-service.js
 * ---------------------------------------------------------------------------
 * OPTIONAL, additive discoverability research.
 *
 * This is deliberately NOT a "what should I make" engine. The videos already
 * exist; nothing here decides what to create. It only supplies wording
 * vocabulary that may improve title packaging, search terminology, keyword and
 * hashtag selection.
 *
 * Hard rules:
 *   - Disabled by default (TRENDS_ENABLED=false).
 *   - Never claims anything is "trending" without real evidence.
 *   - If no live data is available it returns [] and the pipeline falls back
 *     to strong content-based SEO. It never invents terms.
 */

const axios = require('axios');

class TrendsService {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || require('../config').config;
  }

  get enabled() {
    return Boolean(this.cfg.trends.enabled && this.cfg.trends.provider && this.cfg.trends.provider !== 'none');
  }

  status() {
    return {
      enabled: this.enabled,
      provider: this.cfg.trends.provider,
      note: this.enabled
        ? 'used only to improve discoverability wording, never to decide what to create'
        : 'disabled - strong content-based SEO is used instead'
    };
  }

  /**
   * Return a short list of vocabulary hints for an analysis, or [].
   * Any failure is swallowed by the caller, so this can never block a video.
   */
  async notesFor(analysis) {
    if (!this.enabled) return [];
    try {
      if (this.cfg.trends.provider === 'google-trends') {
        return await this._googleTrends(analysis);
      }
      return [];
    } catch (err) {
      this.log.warn?.('trends: lookup failed', { error: String(err && err.message).slice(0, 200) });
      return [];
    }
  }

  /**
   * Google Trends related queries via the public widget endpoint.
   * Returns only terms that actually came back from the API. No inference,
   * no "trending" claims.
   */
  async _googleTrends(analysis) {
    const topic = (analysis && analysis.filename) || '';
    const seed = topic.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
    if (!seed) return [];

    const explore = {
      comparisonItem: [{ keyword: seed, geo: 'US', time: 'now 7-d' }],
      category: 0,
      property: ''
    };

    const res = await axios.get('https://trends.google.com/trends/api/explore', {
      params: { hl: 'en-US', tz: '0', req: JSON.stringify(explore) },
      timeout: this.cfg.trends.timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const widget = JSON.parse(String(res.data).replace(/^\)\]\}',\s*/, ''));
    const related = (widget.widgets || []).find((w) => w.id === 'RELATED_QUERIES');
    if (!related) return [];

    const r2 = await axios.get(`https://trends.google.com/trends/api/widgetdata/relatedsearches`, {
      params: {
        hl: 'en-US',
        tz: '0',
        req: JSON.stringify(related.request),
        token: related.token
      },
      timeout: this.cfg.trends.timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const parsed = JSON.parse(String(r2.data).replace(/^\)\]\}',\s*/, ''));
    const lists = parsed.default || {};
    const ranked = (lists.rankedList || []).flatMap((l) => l.rankedKeyword || []);
    return ranked.slice(0, 8).map((r) => r.query).filter(Boolean);
  }
}

module.exports = { TrendsService };
