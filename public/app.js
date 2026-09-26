'use strict';
/**
 * public/app.js
 * ---------------------------------------------------------------------------
 * Dashboard client.
 *
 * SECURITY: this file contains no keys, no secrets, no tokens. It talks to the
 * same-origin API using the HttpOnly session cookie the server set. Nothing is
 * written to any browser-side storage mechanism.
 */

/* ------------------------------------------------------------- tiny helpers */

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers || {}) }
  });
  if (res.status === 401) {
    showLogin('Your session expired. Please sign in again.');
    throw new Error('unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bytes(n) {
  if (!n && n !== 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function clockIn(utcIso, zone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: true
    }).format(new Date(utcIso));
  } catch (_) {
    return utcIso;
  }
}

function dateIn(utcIso, zone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(utcIso));
  } catch (_) {
    return String(utcIso).slice(0, 10);
  }
}

/* ------------------------------------------------------------------- views */

function showLogin(msg) {
  $('login-view').classList.remove('hidden');
  $('app-view').classList.add('hidden');
  const e = $('login-error');
  if (msg) { e.textContent = msg; e.classList.remove('hidden'); }
}

function showApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
}

/* ------------------------------------------------------------------- clock */

let TZ = 'America/New_York';
let DISPLAY = ['America/New_York', 'Asia/Kolkata'];

function tickClock() {
  const now = new Date();
  const parts = DISPLAY.map((z) => {
    try {
      const s = new Intl.DateTimeFormat('en-US', {
        timeZone: z, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: true
      }).format(now);
      return `${s} ${z === 'America/New_York' ? 'ET' : z === 'Asia/Kolkata' ? 'IST' : z}`;
    } catch (_) { return null; }
  }).filter(Boolean);
  $('clock').textContent = parts.join('  |  ');
}

/* ------------------------------------------------------------- auth / boot */

async function boot() {
  try {
    const cfg = await api('/auth/config');
    if (!cfg.googleConfigured) {
      $('login-error').textContent = 'Google OAuth is not configured on the server.';
      $('login-error').classList.remove('hidden');
    }
  } catch (_) { /* ignore */ }

  let session = null;
  try {
    session = await api('/auth/session');
  } catch (_) {
    session = null;
  }

  if (session && session.authenticated) {
    showApp();
    await init();
  } else {
    const params = new URLSearchParams(location.search);
    const authError = params.get('auth_error');
    showLogin(
      authError === 'not_authorized'
        ? 'That Google account is not the authorized owner of this system.'
        : authError
          ? `Sign-in failed: ${authError}`
          : null
    );
  }
}

async function init() {
  $('login-btn').addEventListener('click', () => { location.href = '/api/auth/google/start'; });
  $('logout-btn').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  });

  setupUpload();
  setupFailedControls();

  tickClock();
  setInterval(tickClock, 20000);

  await refresh();
  setInterval(refresh, 10000);
}

/* ------------------------------------------------------------ bulk upload */

let uploading = 0;

function setupUpload() {
  const dz = $('dropzone');
  const input = $('file-input');

  dz.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    input.click();
  });
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });

  input.addEventListener('change', () => {
    if (input.files && input.files.length) uploadFiles(Array.from(input.files));
    input.value = '';
  });

  // Drag & drop. Works with folders dropped from a desktop file manager too.
  let depth = 0;
  dz.addEventListener('dragenter', (e) => { e.preventDefault(); depth += 1; dz.classList.add('dragover'); });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', (e) => { e.preventDefault(); depth -= 1; if (depth <= 0) dz.classList.remove('dragover'); });
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    dz.classList.remove('dragover');

    const items = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (!items.length) return;

    // Support dropped folders by walking webkitGetAsEntry when available.
    const files = [];
    const entries = [];
    if (e.dataTransfer.items) {
      for (const it of Array.from(e.dataTransfer.items)) {
        const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
      }
    }
    if (entries.length) {
      await Promise.all(entries.map((en) => walkEntry(en, files)));
    } else {
      files.push(...items);
    }
    const mp4s = files.filter((f) => /\.mp4$/i.test(f.name));
    if (!mp4s.length) {
      alert('No .mp4 files were found in what you dropped.');
      return;
    }
    uploadFiles(mp4s);
  });

  // Stop the browser from navigating away when a file is missed.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function walkEntry(entry, out, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 6) return resolve();
    if (entry.isFile) {
      entry.file((f) => { out.push(f); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => reader.readEntries(async (ents) => {
        if (!ents.length) return resolve();
        await Promise.all(ents.map((en) => walkEntry(en, out, depth + 1)));
        readBatch();
      }, () => resolve());
      readBatch();
    } else {
      resolve();
    }
  });
}

function uploadRow(file) {
  const wrap = document.createElement('div');
  wrap.className = 'upload-row';
  wrap.innerHTML = `<span class="name">${esc(file.name)}</span><span class="state">waiting</span>`;
  $('upload-progress').appendChild(wrap);
  return wrap;
}

/**
 * Upload one file with an XHR so we get real progress, then repeat.
 * Sequential by design: a phone browser cannot open 1,000 sockets, and the
 * queue is durable, so ordering and reliability matter more than throughput.
 */
async function uploadFiles(files) {
  $('upload-summary').textContent = `Uploading 0 / ${files.length}`;
  let done = 0;

  for (const file of files) {
    const row = uploadRow(file);
    const state = row.querySelector('.state');
    try {
      state.textContent = 'hashing';
      const sha = await sha256(file);

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/ingest');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('x-filename', file.name);
        xhr.setRequestHeader('x-file-size', String(file.size));
        xhr.setRequestHeader('x-sha256', sha);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            state.textContent = `${Math.round((e.loaded / e.total) * 100)}%`;
          }
        };
        xhr.onload = () => {
          if (xhr.status === 201 || xhr.status === 200) {
            row.classList.add('done');
            state.textContent = 'queued';
            resolve();
          } else if (xhr.status === 409) {
            row.classList.add('done');
            state.textContent = 'duplicate - skipped';
            resolve();
          } else {
            row.classList.add('fail');
            let msg = `HTTP ${xhr.status}`;
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) { /* ignore */ }
            state.textContent = msg;
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => { row.classList.add('fail'); state.textContent = 'network error'; reject(new Error('network')); };
        xhr.send(file);
      });
    } catch (err) {
      // Keep going: one bad file must not abort a 1,000-file batch.
      row.classList.add('fail');
      if (!state.textContent || state.textContent === 'waiting') state.textContent = String(err.message || 'failed');
    }
    done += 1;
    $('upload-summary').textContent = `Uploading ${done} / ${files.length}`;
  }

  $('upload-summary').textContent = `${files.length} file(s) processed`;
  setTimeout(() => { $('upload-summary').textContent = ''; }, 6000);
  await refresh();
}

async function sha256(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- refresh */

async function refresh() {
  try {
    const [dash, settings, storage, yt] = await Promise.all([
      api('/dashboard'),
      api('/settings'),
      api('/storage/summary'),
      api('/youtube/status')
    ]);

    TZ = dash.timezone || TZ;
    renderHeader(dash);
    renderSlots(dash);
    renderQueue(dash);
    renderProcessing(dash);
    renderFailed(dash);
    renderStorage(storage);
    renderYouTube(yt);
    renderFooter(settings);

    const prov = await api('/dashboard/providers');
    renderProviders(prov, dash);
  } catch (err) {
    if (String(err.message) !== 'unauthorized') {
      const b = $('config-error');
      b.textContent = `Refresh failed: ${err.message}`;
      b.classList.remove('hidden');
    }
  }
}

function renderHeader(d) {
  $('today-count').textContent = `${d.today.filled} / ${d.today.target}`;
  $('today-count').className = `pill ${d.today.filled >= d.today.target ? 'ok' : 'warn'}`;
  $('buffer-count').textContent = `${d.tomorrowBuffer.ready} / ${d.tomorrowBuffer.target}`;
  $('buffer-count').className = `pill ${d.tomorrowBuffer.complete ? 'ok' : 'warn'}`;
  $('queue-count').textContent = d.queueEmpty ? 'QUEUE EMPTY' : `${d.queue.total} waiting`;
  $('queue-count').className = `pill ${d.queueEmpty ? 'bad' : ''}`;
}

function slotRow(s, zone) {
  const li = document.createElement('li');
  const cls = s.video ? 'filled' : (s.passed ? 'passed' : 'empty');
  li.className = `slot ${cls}`;
  const et = clockIn(s.timeUtc, zone);
  const ist = DISPLAY.includes('Asia/Kolkata') ? clockIn(s.timeUtc, 'Asia/Kolkata') : null;
  const v = s.video;
  const statusText = v
    ? `${v.title ? esc(v.title) : esc(v.filename)}`
    : (s.passed ? 'slot passed' : 'open');
  const sub = v
    ? `${esc(v.status)}${v.aiProvider ? ' &middot; ' + esc(v.aiProvider) : ''}${v.thumbnailSource ? ' &middot; thumb:' + esc(v.thumbnailSource) : ''}`
    : '';
  li.innerHTML = `
    <span class="time">${et} ET${ist ? `<small>${ist} IST</small>` : ''}</span>
    <span class="who">${statusText}<span class="t">${sub}</span></span>`;
  return li;
}

function renderSlots(d) {
  const t = $('today-slots');
  const b = $('buffer-slots');
  t.innerHTML = '';
  b.innerHTML = '';
  for (const s of d.today.slots) t.appendChild(slotRow(s, d.timezone));
  for (const s of d.tomorrowBuffer.slots) b.appendChild(slotRow(s, d.timezone));
}

function renderQueue(d) {
  const el = $('queue-body');
  if (d.queueEmpty) {
    el.innerHTML = '<p class="muted small">QUEUE EMPTY &mdash; upload videos to resume scheduling. Nothing is fabricated.</p>';
    return;
  }
  const rows = d.queue.items.slice(0, 20).map((v) => `
    <div class="upload-row">
      <span class="muted small">#${v.queuePosition}</span>
      <span class="name">${esc(v.filename)}</span>
      <span class="state">${bytes(v.fileSize)}</span>
    </div>`).join('');
  el.innerHTML = rows + (d.queue.total > 20
    ? `<p class="muted small">+ ${d.queue.total - 20} more in queue</p>`
    : '');
}

function renderProcessing(d) {
  const el = $('processing-body');
  $('processing-count').textContent = d.processing.length ? `${d.processing.length} active` : 'idle';
  if (!d.processing.length) {
    el.innerHTML = 'Idle.';
    return;
  }
  el.innerHTML = d.processing.map((v) => `
    <div class="upload-row">
      <span class="spinner"></span>
      <span class="name">${esc(v.filename)}</span>
      <span class="state">${esc(v.status)}${v.aiProvider ? ' &middot; ' + esc(v.aiProvider) : ''}</span>
    </div>`).join('');
}

function setupFailedControls() {
  $('retry-all').addEventListener('click', async () => {
    $('retry-all').disabled = true;
    try {
      const out = await api('/queue/retry-failed', { method: 'POST' });
      alert(`Re-queued ${out.retried} failed video(s).`);
    } catch (err) {
      alert(`Retry failed: ${err.message}`);
    } finally {
      $('retry-all').disabled = false;
      await refresh();
    }
  });

  $('clear-failed').addEventListener('click', async () => {
    if (!confirm('Remove failed rows from the queue? Source files on disk are kept.')) return;
    try {
      const out = await api('/queue/clear-failed', { method: 'POST' });
      alert(`Cleared ${out.cleared} row(s).`);
    } catch (err) {
      alert(`Clear failed: ${err.message}`);
    } finally {
      await refresh();
    }
  });
}

function renderFailed(d) {
  const el = $('failed-body');
  if (!d.failed.length && !(d.paused && d.paused.length)) {
    el.innerHTML = 'No failures.';
    return;
  }

  const failHtml = d.failed.map((f) => `
    <div class="fail-row">
      <div class="body">
        <div>${esc(f.filename)}</div>
        <div class="reason">${esc(f.reason)}</div>
        <div class="meta">
          ${f.operation ? esc(f.operation) : ''}${f.httpStatus ? ` &middot; HTTP ${f.httpStatus}` : ''}
          &middot; retries: ${f.retryCount}
          ${f.uncertain ? ' &middot; <strong>YouTube outcome uncertain - will be reconciled</strong>' : ''}
          &middot; ${esc(String(f.updatedAt || '').replace('T', ' ').slice(0, 19))}
        </div>
      </div>
      <button class="btn small" onclick="retryOne('${esc(f.id)}')">Retry</button>
    </div>`).join('');

  const pausedHtml = (d.paused || []).map((p) => `
    <div class="fail-row">
      <div class="body">
        <div>${esc(p.filename)}</div>
        <div class="reason">PAUSED &mdash; ${esc(p.reason || 'AI providers unavailable')}</div>
        <div class="meta">Resumes automatically when a provider becomes available.</div>
      </div>
    </div>`).join('');

  el.innerHTML = failHtml + pausedHtml;
}

window.retryOne = async function (id) {
  try {
    await api(`/queue/retry/${encodeURIComponent(id)}`, { method: 'POST' });
  } catch (err) {
    alert(`Retry failed: ${err.message}`);
  } finally {
    await refresh();
  }
};

function renderStorage(s) {
  const el = $('storage-body');
  el.innerHTML = `
    <div class="row"><span>Local used</span><span>${bytes(s.local.used)} (${s.local.files} files)</span></div>
    <div class="row"><span>Local free</span><span>${s.local.free == null ? 'unknown' : bytes(s.local.free)}</span></div>
    <div class="row"><span>Tracked source bytes</span><span>${bytes(s.local.trackedBytes)}</span></div>
    <div class="row"><span>Google Drive</span><span>${s.drive ? (s.drive.limit ? `${bytes(s.drive.usage)} / ${bytes(s.drive.limit)}` : bytes(s.drive.usage)) : 'disabled'}</span></div>
    <div class="row"><span>Pending deletion</span><span>${s.pendingDeletion}</span></div>
    <div class="row"><span>Deletion failures</span><span class="${s.failedDeletion ? 'error' : ''}">${s.failedDeletion}</span></div>
    <div class="row"><span>Delete after confirmed schedule</span><span>${s.deleteAfterYouTube ? `ON (after ${s.deleteDelayHours}h)` : 'OFF'}</span></div>`;
}

function renderYouTube(y) {
  $('yt-dot').className = `dot ${y.connected ? 'ok' : 'bad'}`;
  const el = $('youtube-body');
  el.innerHTML = `
    <div class="row"><span>Connection</span><span class="${y.connected ? '' : 'error'}">${y.connected ? 'connected' : 'not connected'}</span></div>
    <div class="row"><span>Channel</span><span>${y.channel ? esc(y.channel.title || y.channel.id) : '-'}</span></div>
    <div class="row"><span>Made for Kids</span><span>${y.channel ? String(y.channel.madeForKids) : '-'}</span></div>
    <div class="row"><span>Uploads today</span><span>${y.insertsToday}${y.dailyInsertSoftCap ? ` / ${y.dailyInsertSoftCap} (soft cap)` : ''}</span></div>
    <div class="row"><span>Synthetic media disclosure</span><span>${esc(y.syntheticMediaDisclosure)}</span></div>`;
}

function renderProviders(p, dash) {
  const el = $('providers-body');
  const rows = [];

  for (const m of p.metadata) {
    rows.push(`
      <div class="provider">
        <span class="label">${esc(m.label)}</span>
        <span class="model">${esc(m.model || '')}</span>
        <span class="st ${m.usable ? 'ok' : (m.configured ? 'bad' : 'off')}">${m.usable ? 'ready' : (m.configured ? 'rejected' : 'not set')}</span>
      </div>`);
  }

  const t = p.thumbnail;
  rows.push(`
    <div class="provider">
      <span class="label">Thumbnail AI</span>
      <span class="model">${esc(t.provider)}${t.model ? ' / ' + esc(t.model) : ''} &middot; fallback: ${esc(t.fallback)}</span>
      <span class="st ${t.configured ? 'ok' : 'off'}">${t.configured ? 'ready' : 'frame fallback'}</span>
    </div>`);

  rows.push(`
    <div class="provider">
      <span class="label">Trend research</span>
      <span class="model">${esc(p.trends.note || '')}</span>
      <span class="st ${p.trends.enabled ? 'ok' : 'off'}">${p.trends.enabled ? 'on' : 'off'}</span>
    </div>`);

  el.innerHTML = rows.join('');

  const pausedEl = $('paused-body');
  if (dash.paused && dash.paused.length) {
    pausedEl.innerHTML = `<strong>${dash.paused.length} video(s) paused:</strong> all metadata AI providers failed. Processing resumes automatically when one becomes available.`;
    pausedEl.classList.add('error');
  } else {
    pausedEl.innerHTML = '';
    pausedEl.classList.remove('error');
  }
}

function renderFooter(s) {
  $('tz-label').textContent = s.timezone;
  $('slot-label').textContent = s.slotTimes.join(', ') + ' ET';
  $('delete-label').textContent = s.deleteAfterYouTube ? `ON (${s.deleteDelayHours}h)` : 'OFF';
}

/* -------------------------------------------------------------------- boot */

boot();
