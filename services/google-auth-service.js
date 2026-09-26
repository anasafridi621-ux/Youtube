'use strict';
/**
 * services/google-auth-service.js
 * ---------------------------------------------------------------------------
 * Server-side Google OAuth for BOTH purposes, using ONE consent screen:
 *
 *   1. Owner authentication  - the Google ID token's verified e-mail address
 *                              must be in OWNER_EMAIL. Nothing is stored in
 *                              browser storage; we issue our own signed,
 *                              HttpOnly session cookie.
 *   2. YouTube + Drive tokens - the refresh token is persisted server-side in
 *                              config/tokens.json, which is gitignored and is
 *                              NEVER sent to the browser.
 *
 * Scopes are deliberately narrow:
 *   youtube.upload   - required to upload
 *   youtube.readonly- required to reconcile / read the channel
 *   drive.file       - only files this app itself created (NOT drive.readonly,
 *                      which would grant access to the user's whole Drive)
 *   openid/email/profile - owner identity only
 *
 * Loopback is used when the app runs locally; a redirect URI is used when the
 * app runs on Render/Railway. Both are derived from APP_URL, never hard-coded.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const { config } = require('../config');

const SCOPES = config.google.scopes;

class GoogleAuthService {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || config;
    this._client = null;
  }

  /**
   * OAuth2 client. Uses the redirect URI from config so a deployed
   * APP_URL automatically becomes the new origin.
   */
  client() {
    if (this._client) return this._client;
    const { clientId, clientSecret, redirectUri } = this.cfg.youtube;
    this._client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    return this._client;
  }

  /** True when OAuth credentials are present. */
  configured() {
    return Boolean(this.cfg.youtube.clientId && this.cfg.youtube.clientSecret);
  }

  authUrl(state) {
    return this.client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: SCOPES,
      state
    });
  }

  /**
   * Exchange a code for tokens and persist ONLY server-side.
   * @returns {{email, name, picture, hasRefreshToken}}
   */
  async exchangeCode(code) {
    const client = this.client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Identify the owner from the ID token, not from a client-supplied claim.
    let idInfo = null;
    if (tokens.id_token) {
      try {
        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.cfg.youtube.clientId });
        idInfo = ticket.getPayload();
      } catch (err) {
        this.log.warn?.('google-auth: could not verify id_token', { error: String(err.message).slice(0, 200) });
      }
    }

    this.persistTokens(tokens);

    return {
      email: idInfo ? String(idInfo.email || '').toLowerCase() : null,
      name: idInfo ? idInfo.name || null : null,
      picture: idInfo ? idInfo.picture || null : null,
      hasRefreshToken: Boolean(tokens.refresh_token)
    };
  }

  /** Persist tokens to disk with 0600 permissions. Never committed. */
  persistTokens(tokens) {
    const file = this.cfg.youtube.tokenFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });

    let existing = {};
    try {
      if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      existing = {};
    }

    // Preserve a refresh token if Google did not send a new one.
    const merged = {
      ...existing,
      ...tokens,
      refresh_token: tokens.refresh_token || existing.refresh_token || null,
      scope: (tokens.scope || existing.scope || '').split(/\s+/).filter(Boolean),
      saved_at: new Date().toISOString()
    };

    fs.writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {
      /* ignore on platforms without chmod */
    }
    this._client = null; // force a rebuild with the new tokens
  }

  loadTokens() {
    const file = this.cfg.youtube.tokenFile;
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      this.log.warn?.('google-auth: token file unreadable', { error: String(err.message).slice(0, 200) });
      return null;
    }
  }

  hasUsableTokens() {
    const t = this.loadTokens();
    if (!t) return false;
    if (t.refresh_token) return true;
    return Boolean(t.access_token && t.expiry_date && t.expiry_date > Date.now() + 60000);
  }

  /** An authorized OAuth2 client for YouTube / Drive API calls. */
  authorizedClient() {
    const tokens = this.loadTokens();
    const client = this.client();
    if (tokens) client.setCredentials(tokens);
    return client;
  }

  /**
   * Loopback authorization for a headless local PC: opens the browser on the
   * same machine and captures the redirect on 127.0.0.1.
   * Returns the token bundle. Used by `npm run auth`.
   */
  async authorizeViaLoopback() {
    const state = crypto.randomBytes(16).toString('hex');
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

    const loopbackClient = new google.auth.OAuth2(
      this.cfg.youtube.clientId,
      this.cfg.youtube.clientSecret,
      redirectUri
    );

    const authUrl = loopbackClient.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: SCOPES,
      state
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('authorization timed out after 5 minutes'));
      }, 5 * 60 * 1000);

      server.on('request', async (req, res) => {
        try {
          const url = new URL(req.url, `http://127.0.0.1:${port}`);
          if (url.pathname !== '/oauth2callback') {
            res.writeHead(404); res.end('Not found'); return;
          }
          if (url.searchParams.get('state') !== state) {
            res.writeHead(400); res.end('State mismatch'); return;
          }
          const code = url.searchParams.get('code');
          if (!code) {
            res.writeHead(400); res.end('Missing code'); return;
          }
          const { tokens } = await loopbackClient.getToken(code);
          this.persistTokens({ ...tokens, redirect_uris: [redirectUri] });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:sans-serif;padding:2rem"><h2>Authorized.</h2><p>You can close this tab and return to the terminal.</p></body></html>');
          clearTimeout(timer);
          server.close();
          resolve(tokens);
        } catch (err) {
          clearTimeout(timer);
          server.close();
          reject(err);
        }
      });

      this.log.info?.('google-auth: opening browser for authorization', { authUrl });
      // Do not auto-open in a headless environment; print the URL instead.
      console.log(`\nAuthorize this application:\n\n  ${authUrl}\n`);
    });
  }

  /**
   * Revoke and forget stored tokens (used by the dashboard "disconnect").
   */
  async revoke() {
    const tokens = this.loadTokens();
    if (!tokens) return { ok: true };
    try {
      if (tokens.access_token || tokens.refresh_token) {
        await this.client().revokeToken(tokens.access_token || tokens.refresh_token);
      }
    } catch (err) {
      this.log.warn?.('google-auth: revoke failed', { error: String(err.message).slice(0, 200) });
    }
    try {
      fs.unlinkSync(this.cfg.youtube.tokenFile);
    } catch (_) {
      /* ignore */
    }
    this._client = null;
    return { ok: true };
  }

  /** Redacted view for the dashboard. Never contains a secret. */
  safeStatus() {
    const tokens = this.loadTokens();
    if (!tokens) {
      return {
        connected: false,
        configured: this.configured(),
        scopes: SCOPES,
        hasRefreshToken: false,
        tokenSavedAt: null,
        redirectUri: this.cfg.youtube.redirectUri
      };
    }
    return {
      connected: this.hasUsableTokens(),
      configured: this.configured(),
      scopes: tokens.scope && tokens.scope.length ? tokens.scope : SCOPES,
      hasRefreshToken: Boolean(tokens.refresh_token),
      tokenSavedAt: tokens.saved_at || null,
      redirectUri: this.cfg.youtube.redirectUri
    };
  }
}

module.exports = { GoogleAuthService, SCOPES };
