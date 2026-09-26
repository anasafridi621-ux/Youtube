'use strict';
/**
 * services/owner-auth-service.js
 * ---------------------------------------------------------------------------
 * Single-owner authentication.
 *
 *   - No public multi-user SaaS, no registration, no public dashboard.
 *   - The authorized owner account(s) come from OWNER_EMAIL (env only, never
 *     hard-coded, never rendered to the browser).
 *   - Google Sign-In is the only identity provider, reusing the SAME OAuth
 *     client and consent screen as YouTube/Drive. There is no password store.
 *   - On success we issue our own signed session cookie:
 *        HttpOnly; SameSite=Lax; Secure in production; Path=/
 *     Nothing about the session, and certainly no token, ever reaches
 *     localStorage or any client-side storage.
 *
 * The cookie value is `base64url(payload).base64url(hmac)`, so it is
 * tamper-evident and stateless. Sessions survive a restart as long as
 * ENCRYPTION_KEY is stable; without it a random per-process key is used and
 * existing sessions are invalidated (which is warned about at boot).
 */

const crypto = require('crypto');

const COOKIE_VERSION = 1;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

class OwnerAuthService {
  constructor(opts = {}) {
    this.cfg = opts.config || require('../config').config;
    this.log = opts.logger || console;
    this._key = null;
  }

  /** Stable HMAC key from ENCRYPTION_KEY, or a random per-process fallback. */
  key() {
    if (this._key) return this._key;
    if (this.cfg.auth.encryptionKey) {
      this._key = crypto.createHash('sha256').update(this.cfg.auth.encryptionKey).digest();
    } else {
      this._key = crypto.randomBytes(32);
    }
    return this._key;
  }

  isOwner(email) {
    if (!email) return false;
    const e = String(email).trim().toLowerCase();
    return this.cfg.auth.ownerEmails.includes(e);
  }

  /** Number of allow-listed owners. Never returns the addresses themselves. */
  ownerCount() {
    return this.cfg.auth.ownerEmails.length;
  }

  /* ------------------------------------------------------------- sessions */

  sign(payload) {
    const body = b64url(JSON.stringify({ v: COOKIE_VERSION, ...payload }));
    const sig = crypto.createHmac('sha256', this.key()).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  verify(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expected = crypto.createHmac('sha256', this.key()).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (_) {
      return null;
    }
    if (!payload || payload.v !== COOKIE_VERSION) return null;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  }

  issueSession({ email, name, picture }) {
    const ttlMs = this.cfg.auth.sessionTtlHours * 60 * 60 * 1000;
    return this.sign({
      sub: crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 16),
      name: name || null,
      picture: picture || null,
      iat: Date.now(),
      exp: Date.now() + ttlMs
    });
  }

  cookieHeader(token) {
    const parts = [
      `${this.cfg.auth.cookieName}=${token}`,
      'Path=/',
      'HttpOnly',
      `SameSite=Lax`,
      `Max-Age=${this.cfg.auth.sessionTtlHours * 3600}`
    ];
    if (this.cfg.auth.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookieHeader() {
    const parts = [
      `${this.cfg.auth.cookieName}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0'
    ];
    if (this.cfg.auth.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  /** Parse the session out of a Cookie header. */
  fromCookieHeader(header) {
    if (!header) return null;
    const prefix = `${this.cfg.auth.cookieName}=`;
    for (const chunk of String(header).split(';')) {
      const c = chunk.trim();
      if (c.startsWith(prefix)) {
        return this.verify(c.slice(prefix.length));
      }
    }
    return null;
  }

  /** Random single-use state parameter for the OAuth round trip. */
  newState() {
    return crypto.randomBytes(16).toString('hex');
  }
}

module.exports = { OwnerAuthService };
