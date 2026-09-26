'use strict';
/**
 * services/drive-service.js
 * ---------------------------------------------------------------------------
 * Google Drive as an integrated storage layer for source MP4s.
 *
 * Uses the `drive.file` scope only: the app can see and delete the files IT
 * created, and nothing else in the user's Drive. Broad `drive.readonly` is
 * deliberately NOT requested.
 *
 * All credentials stay server-side. The browser never receives a Drive token.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

class DriveService {
  constructor(opts = {}) {
    this.log = opts.logger || console;
    this.cfg = opts.config || require('../config').config;
    this.auth = opts.auth;
  }

  get enabled() {
    return Boolean(this.cfg.google.drive.enabled);
  }

  get api() {
    return google.drive({ version: 'v3', auth: this.auth.authorizedClient() });
  }

  status() {
    return {
      enabled: this.enabled,
      folderId: this.cfg.google.drive.folderId || null,
      scope: 'https://www.googleapis.com/auth/drive.file',
      note: this.enabled ? null : 'GOOGLE_DRIVE_ENABLED=false (local-only storage)'
    };
  }

  /** Resolve (or validate) the target folder. Returns its id. */
  async ensureFolder(folderId) {
    const id = folderId || this.cfg.google.drive.folderId;
    if (!id) throw new Error('no GOOGLE_DRIVE_FOLDER_ID configured');
    const res = await this.api.files.get({ fileId: id, fields: 'id,name,mimeType', supportsAllDrives: true });
    if (!res.data || res.data.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`Drive id ${id} is not a folder`);
    }
    return res.data.id;
  }

  /** Upload a local file into Drive. Returns {fileId, webViewLink}. */
  async upload(localPath, name, folderId) {
    const target = await this.ensureFolder(folderId);
    const res = await this.api.files.create({
      requestBody: { name, parents: [target], mimeType: 'video/mp4' },
      media: { mimeType: 'video/mp4', body: fs.createReadStream(localPath) },
      fields: 'id,name,size,webViewLink',
      supportsAllDrives: true
    });
    return { fileId: res.data.id, webViewLink: res.data.webViewLink || null, name: res.data.name };
  }

  /** Download a Drive file to a local path. */
  async download(fileId, destPath) {
    const res = await this.api.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      res.data.on('error', reject);
      out.on('finish', resolve);
      out.on('error', reject);
      res.data.pipe(out);
    });
    return destPath;
  }

  /** Permanently delete a Drive file. Throws on failure. */
  async remove(fileId) {
    if (!fileId) return { ok: true, skipped: true };
    await this.api.files.delete({ fileId, supportsAllDrives: true });
    return { ok: true, skipped: false };
  }

  /** Storage quota for the dashboard. */
  async quota() {
    try {
      const res = await this.api.about.get({ fields: 'storageQuota,user' });
      const q = res.data.storageQuota || {};
      return {
        limit: Number(q.limit || 0) || null,
        usage: Number(q.usage || 0) || 0,
        usageInDrive: Number(q.usageInDrive || 0) || 0,
        user: res.data.user ? res.data.user.emailAddress : null
      };
    } catch (err) {
      this.log.warn?.('drive: quota lookup failed', { error: String(err.message).slice(0, 200) });
      return null;
    }
  }
}

module.exports = { DriveService };
