'use strict';
/**
 * config/index.js
 * ---------------------------------------------------------------------------
 * Central, validated configuration for the single-owner bulk MP4 ingest ->
 * SEO metadata -> thumbnail -> YouTube scheduling system.
 *
 * Design rules enforced here:
 *   - No secrets are hard-coded. Everything comes from the environment.
 *   - `validate()` returns a *list of problems* instead of throwing, so the
 *     server can boot and show the operator exactly what is missing.
 *   - No paid AI model is ever selected implicitly. OpenRouter models must be
 *     named explicitly in the environment, and the free-only guard is ON by
 *     default (see OPENROUTER_FREE_ONLY).
 */

const path = require('path');
const fs = require('fs');

function loadEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    require('dotenv').config({ path: envPath, override: false, quiet: true });
  } catch (_) {
    /* dotenv is optional at runtime for tests */
  }
}
loadEnvFile();

const ROOT = process.cwd();

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : String(v).trim();
}

function int(name, fallback) {
  const v = parseInt(str(name, ''), 10);
  return Number.isFinite(v) ? v : fallback;
}

function float(name, fallback) {
  const v = parseFloat(str(name, ''));
  return Number.isFinite(v) ? v : fallback;
}

function bool(name, fallback) {
  const v = str(name, '').toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(v)) return false;
  return fallback;
}

/** Parse "08:00,14:00,16:00,18:00,20:00" -> [{h:8,m:0}, ...] */
function parseSlotTimes(raw, fallback) {
  const source = raw && raw.trim() ? raw : fallback;
  const out = [];
  for (const piece of String(source).split(',')) {
    const m = piece.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) continue;
    out.push({ h, m: min });
  }
  return out;
}

const DEFAULT_SLOT_TIMES = '08:00,14:00,16:00,18:00,20:00';

const config = {
  root: ROOT,

  app: {
    name: str('APP_NAME', 'YouTube Bulk Scheduler'),
    url: str('APP_URL', 'http://localhost:3000'),
    port: int('PORT', 3000),
    host: str('HOST', '0.0.0.0'),
    env: str('NODE_ENV', 'production'),
    isProd: str('NODE_ENV', 'production') === 'production'
  },

  // ------------------------------------------------------------------ auth
  auth: {
    /** Comma separated list of allowed owner e-mail addresses. */
    ownerEmails: str('OWNER_EMAIL', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    sessionTtlHours: int('SESSION_TTL_HOURS', 168), // 7 days
    cookieName: str('SESSION_COOKIE_NAME', 'ybs_session'),
    /** HMAC key used to sign session cookies. Falls back to a per-process key. */
    encryptionKey: str('ENCRYPTION_KEY', ''),
    secureCookies: bool('SECURE_COOKIES', false)
  },

  // --------------------------------------------------------------- database
  database: {
    path: path.resolve(str('DATABASE_PATH', path.join(ROOT, 'data', 'scheduler.db')))
  },

  // --------------------------------------------------------------- storage
  storage: {
    uploadsDir: path.resolve(str('UPLOAD_DIR', path.join(ROOT, 'data', 'uploads'))),
    derivedDir: path.resolve(str('DERIVED_DIR', path.join(ROOT, 'data', 'derived'))),
    driveFolderId: str('GOOGLE_DRIVE_FOLDER_ID', ''),
    /** Delete the local + Drive source after a *confirmed* YouTube schedule. */
    deleteAfterYouTube: bool('DELETE_AFTER_SUCCESSFUL_YOUTUBE_SCHEDULE', true),
    /** Minimum hours between "YouTube confirmed" and actual deletion. */
    deleteDelayHours: int('DELETE_DELAY_HOURS', 6),
    /** Hard ceiling on hours before deletion (requirement: within 24h). */
    deleteMaxHours: int('DELETE_MAX_HOURS', 24),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 4 * 1024 * 1024 * 1024),
    localFreeWarnBytes: int('LOCAL_FREE_WARN_BYTES', 5 * 1024 * 1024 * 1024)
  },

  // ------------------------------------------------------------- timezone
  timezone: {
    /** IANA zone. Authoritative for all scheduling math. */
    zone: str('TIMEZONE', 'America/New_York'),
    displayZones: str('DISPLAY_TIMEZONES', 'America/New_York,Asia/Kolkata')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** Do not schedule into a slot that starts within this many minutes. */
    slotLeadMinutes: int('SLOT_LEAD_MINUTES', 5)
  },

  // ------------------------------------------------------------- scheduling
  schedule: {
    videosPerDay: int('DAILY_VIDEO_COUNT', 5),
    slotTimes: parseSlotTimes(str('PUBLISH_SLOT_TIMES', ''), DEFAULT_SLOT_TIMES),
    advanceBufferDays: int('ADVANCE_BUFFER_DAYS', 1),
    /** Max videos actively AI-processed at once (today + tomorrow buffer). */
    maxActiveVideos: int('MAX_ACTIVE_VIDEOS', 10),
    privacyStatus: str('YOUTUBE_PRIVACY_STATUS', 'private')
  },

  // ------------------------------------------------------------ ai providers
  ai: {
    gemini: {
      apiKey: str('GEMINI_API_KEY', ''),
      model: str('GEMINI_MODEL', 'gemini-2.5-flash')
    },
    openrouter: {
      apiKey: str('OPENROUTER_API_KEY', ''),
      baseUrl: str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
      /** Reject any configured model that is not a free model. */
      freeOnly: bool('OPENROUTER_FREE_ONLY', true),
      timeoutMs: int('OPENROUTER_TIMEOUT_MS', 90000),
      maxRetries: int('OPENROUTER_MAX_RETRIES', 2)
    },
    /** The three OpenRouter fallbacks. Model names come from the env only. */
    fallbacks: [1, 2, 3].map((n) => ({
      index: n,
      apiKey: str(`OPENROUTER_API_KEY_${n}`, ''),
      model: str(`OPENROUTER_MODEL_${n}`, '')
    })),
    timeoutMs: int('AI_TIMEOUT_MS', 90000),
    /** Frames sent to the model for video understanding. Kept small on purpose. */
    analysisFrames: int('ANALYSIS_FRAMES', 4),
    analysisFrameWidth: int('ANALYSIS_FRAME_WIDTH', 512),
    analysisJpegQuality: int('ANALYSIS_JPEG_QUALITY', 72),
    /** Max AI chain rounds before a video is parked as `paused`. */
    maxRounds: int('AI_MAX_ROUNDS', 3),
    /** Bounded backoff between rounds. */
    retryBackoffMs: int('AI_RETRY_BACKOFF_MS', 15000),
    /** Send frames (multimodal). Auto-downgrades to text-only on provider error. */
    sendFrames: bool('AI_SEND_FRAMES', true),
    temperature: float('AI_TEMPERATURE', 0.4),
    maxOutputTokens: int('AI_MAX_OUTPUT_TOKENS', 2048)
  },

  // -------------------------------------------------------------- thumbnail
  thumbnail: {
    /** `openrouter` | `gemini` | `pollinations` | `none` */
    provider: str('THUMBNAIL_PROVIDER', 'none').toLowerCase(),
    apiKey: str('THUMBNAIL_PROVIDER_KEY', ''),
    model: str('THUMBNAIL_PROVIDER_MODEL', ''),
    freeOnly: bool('THUMBNAIL_FREE_ONLY', true),
    width: int('THUMBNAIL_WIDTH', 1280),
    height: int('THUMBNAIL_HEIGHT', 720),
    timeoutMs: int('THUMBNAIL_TIMEOUT_MS', 90000),
    maxRetries: int('THUMBNAIL_MAX_RETRIES', 2)
  },

  // --------------------------------------------------------------- youtube
  youtube: {
    clientId: str('GOOGLE_CLIENT_ID', ''),
    clientSecret: str('GOOGLE_CLIENT_SECRET', ''),
    apiKey: str('YOUTUBE_API_KEY', ''),
    redirectUri: str('GOOGLE_REDIRECT_URI', `${str('APP_URL', 'http://localhost:3000')}/api/auth/google/callback`),
    tokenFile: path.resolve(str('GOOGLE_TOKEN_FILE', path.join(ROOT, 'config', 'tokens.json'))),
    /** true | false | auto (auto asks the model, defaults false when unsure). */
    syntheticMedia: str('SYNTHETIC_MEDIA_DISCLOSURE', 'auto').toLowerCase(),
    /** null = read the channel's live madeForKids value at startup. */
    madeForKids: str('YOUTUBE_MADE_FOR_KIDS', '') === '' ? null : bool('YOUTUBE_MADE_FOR_KIDS', true),
    categoryId: str('YOUTUBE_CATEGORY_ID', '24'), // 24 = Entertainment
    defaultLanguage: str('YOUTUBE_DEFAULT_LANGUAGE', 'en'),
    uploadRetries: int('YOUTUBE_UPLOAD_RETRIES', 1),
    uploadTimeoutMs: int('YOUTUBE_UPLOAD_TIMEOUT_MS', 15 * 60 * 1000),
    /** Optional operator-set guard. 0 = disabled (no hard-coded assumption). */
    dailyInsertSoftCap: int('YOUTUBE_DAILY_INSERT_SOFT_CAP', 0)
  },

  // ----------------------------------------------------------------- google
  google: {
    drive: {
      enabled: bool('GOOGLE_DRIVE_ENABLED', false),
      folderId: str('GOOGLE_DRIVE_FOLDER_ID', '')
    },
    scopes: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/drive.file',
      'openid',
      'email',
      'profile'
    ]
  },

  // ----------------------------------------------------------------- worker
  worker: {
    concurrency: int('WORKER_CONCURRENCY', 1),
    pollIntervalMs: int('WORKER_POLL_MS', 5000),
    /** Minutes between queue top-up sweeps. */
    sweepIntervalMs: int('QUEUE_SWEEP_MS', 60000),
    /** Minutes between cleanup sweeps. */
    cleanupIntervalMs: int('CLEANUP_SWEEP_MS', 15 * 60 * 1000),
    /** How often to re-probe AI provider health while paused. */
    providerHealthIntervalMs: int('PROVIDER_HEALTH_MS', 5 * 60 * 1000)
  },

  // ------------------------------------------------------------------ trend
  // Optional, purely additive discoverability research. Never used to decide
  // *what* to create, and never claims anything is "trending" without data.
  trends: {
    enabled: bool('TRENDS_ENABLED', false),
    provider: str('TRENDS_PROVIDER', 'none').toLowerCase(),
    apiKey: str('TRENDS_API_KEY', ''),
    timeoutMs: int('TRENDS_TIMEOUT_MS', 15000)
  },

  logging: {
    level: str('LOG_LEVEL', 'info'),
    dir: path.resolve(str('LOG_DIR', path.join(ROOT, 'logs')))
  }
};

/** Effective slot list (capped by videosPerDay). */
config.schedule.effectiveSlots = config.schedule.slotTimes.slice(
  0,
  Math.max(1, config.schedule.videosPerDay)
);
config.schedule.effectiveVideosPerDay = config.schedule.effectiveSlots.length;

/**
 * Returns a list of human readable problems. Empty array == ready to run.
 * Deliberately non-fatal: the dashboard shows these to the operator.
 */
function validate(cfg = config) {
  const problems = [];
  const warnings = [];

  if (cfg.auth.ownerEmails.length === 0) {
    problems.push('OWNER_EMAIL is not set. The system is single-owner and refuses to boot without at least one allow-listed owner address.');
  }
  if (!cfg.auth.encryptionKey) {
    warnings.push('ENCRYPTION_KEY is not set. A random per-process key will be used, which means every restart invalidates existing sessions.');
  }
  if (!cfg.youtube.clientId || !cfg.youtube.clientSecret) {
    problems.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. YouTube upload is impossible without OAuth credentials.');
  }
  if (!cfg.ai.gemini.apiKey) {
    warnings.push('GEMINI_API_KEY is not set. The metadata chain will start at OpenRouter fallback #1.');
  }
  const configuredFallbacks = cfg.ai.fallbacks.filter((f) => f.apiKey && f.model);
  // Not a hard problem: the dashboard must stay reachable so the operator can
  // see exactly which provider is missing and fix it.
  if (configuredFallbacks.length === 0 && !cfg.ai.gemini.apiKey) {
    warnings.push('No metadata AI provider is configured. Videos will park as "paused" with the reason shown on the dashboard. Set GEMINI_API_KEY and/or OPENROUTER_API_KEY_n + OPENROUTER_MODEL_n.');
  }
  cfg.ai.fallbacks.forEach((f) => {
    if (f.apiKey && !f.model) {
      warnings.push(`OPENROUTER_API_KEY_${f.index} is set but OPENROUTER_MODEL_${f.index} is empty, so this fallback will be skipped.`);
    }
    if (!f.apiKey && f.model) {
      warnings.push(`OPENROUTER_MODEL_${f.index} is set but OPENROUTER_API_KEY_${f.index} is empty, so this fallback will be skipped.`);
    }
    if (f.apiKey && f.model && cfg.ai.openrouter.freeOnly && !isLikelyFreeModel(f.model)) {
      warnings.push(`OPENROUTER_MODEL_${f.index} ("${f.model}") does not look like a free model. OPENROUTER_FREE_ONLY=true will reject it.`);
    }
  });
  if (cfg.schedule.effectiveVideosPerDay !== 5) {
    warnings.push(`DAILY_VIDEO_COUNT is ${cfg.schedule.videosPerDay} (the product requirement is exactly 5/day).`);
  }
  if (!['true', 'false', 'auto'].includes(cfg.youtube.syntheticMedia)) {
    problems.push('SYNTHETIC_MEDIA_DISCLOSURE must be one of: auto | true | false.');
  }
  if (cfg.storage.deleteAfterYouTube && cfg.storage.deleteDelayHours > cfg.storage.deleteMaxHours) {
    warnings.push('DELETE_DELAY_HOURS is greater than DELETE_MAX_HOURS; the max-hours ceiling will win.');
  }
  if (cfg.storage.deleteAfterYouTube && cfg.storage.deleteMaxHours > 24) {
    warnings.push('DELETE_MAX_HOURS is above 24h, which exceeds the documented "within 24 hours" requirement.');
  }

  return { problems, warnings };
}

/**
 * OpenRouter marks free models with a `:free` suffix on the model slug.
 * This is a *guard*, not a hard block: the operator can disable it.
 */
function isLikelyFreeModel(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  if (m.endsWith(':free')) return true;
  // Known free-tier aliases used by OpenRouter.
  return [
    'auto',
    'openrouter/auto',
    'deepseek/deepseek-chat-v3.1:free',
    'qwen/qwen3-coder:free',
    'meta-llama/llama-3.3-70b-instruct:free'
  ].includes(m);
}

/** True when at least one metadata AI provider is usable right now. */
function hasAnyMetadataProvider(cfg = config) {
  if (cfg.ai.gemini.apiKey) return true;
  return cfg.ai.fallbacks.some((f) => f.apiKey && f.model && (!cfg.ai.openrouter.freeOnly || isLikelyFreeModel(f.model)));
}

/** True when a thumbnail AI provider is usable (frame fallback always works). */
function hasThumbnailProvider(cfg = config) {
  const t = cfg.thumbnail;
  if (t.provider === 'none' || !t.provider) return false;
  if (t.provider === 'pollinations') return true;
  if (!t.apiKey) return false;
  if (t.freeOnly && t.model && !isLikelyFreeModel(t.model)) return false;
  return true;
}

module.exports = { config, validate, isLikelyFreeModel, hasAnyMetadataProvider, hasThumbnailProvider };
