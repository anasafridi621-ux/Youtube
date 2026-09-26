'use strict';
/**
 * services/logger.js
 * ---------------------------------------------------------------------------
 * Structured logging. Redaction is applied *before* anything is persisted, so
 * API keys, OAuth secrets and refresh tokens can never reach a log file or the
 * database through this path.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const REDACT_LEVEL = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z\-_]{20,}/g,                     // Google API keys
  /sk-or-v1-[0-9A-Za-z\-_]{16,}/g,                // OpenRouter keys
  /sk-[0-9A-Za-z\-_]{20,}/g,                      // OpenAI-style keys
  /ya29\.[0-9A-Za-z\-_]{10,}/g,                   // Google access tokens
  /1\/\/[0-9A-Za-z\-_]{20,}/g,                    // Google refresh tokens
  /GOCSPX-[0-9A-Za-z\-_]{10,}/g,                  // Google OAuth client secrets
  /(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*["']?[^\s"',}]{8,}/gi
];

/** Replace anything that looks like a credential with a redaction marker. */
function redact(value) {
  if (value === null || value === undefined) return value;
  let s = typeof value === 'string' ? value : safeStringify(value);
  for (const re of SECRET_PATTERNS) s = s.replace(re, (m) => {
    if (/redacted/i.test(m)) return m;
    const head = m.slice(0, 6);
    return `${head}...[REDACTED]`;
  });
  return s;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

class Logger {
  constructor(context = 'app', opts = {}) {
    this.context = context;
    this.dir = opts.dir || path.join(process.cwd(), 'logs');
    this.stream = null;
    this.fileEnabled = opts.file !== false;
  }

  _file() {
    if (!this.fileEnabled) return null;
    if (this.stream) return this.stream;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(this.dir, 'app.log'), { flags: 'a' });
      return this.stream;
    } catch (_) {
      this.fileEnabled = false;
      return null;
    }
  }

  _emit(level, message, meta) {
    if (LEVELS[level] > REDACT_LEVEL) return;
    const line = safeStringify({
      ts: new Date().toISOString(),
      level,
      ctx: this.context,
      msg: redact(message),
      ...(meta ? { meta: redact(meta) } : {})
    });
    const stream = this._file();
    if (stream) stream.write(`${line}\n`);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  error(message, meta) { this._emit('error', message, meta); }
  warn(message, meta) { this._emit('warn', message, meta); }
  info(message, meta) { this._emit('info', message, meta); }
  debug(message, meta) { this._emit('debug', message, meta); }

  child(context) {
    return new Logger(`${this.context}:${context}`, { dir: this.dir, file: this.fileEnabled });
  }
}

module.exports = { Logger, redact, LEVELS };
