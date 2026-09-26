'use strict';
/**
 * services/media-service.js
 * ---------------------------------------------------------------------------
 * Local MP4 inspection + frame extraction.
 *
 * The uploaded MP4 is the source of truth for everything downstream. Nothing
 * is re-encoded here: ffprobe reads the container, ffmpeg pulls individual
 * frames out as still images. Source quality is preserved because we never
 * write a new video file.
 *
 * Binary resolution order (first hit wins):
 *   1. FFMPEG_PATH / FFPROBE_PATH env overrides
 *   2. system `ffmpeg` / `ffprobe` on PATH
 *   3. `ffmpeg-static` npm package
 *   4. `@ffmpeg-installer/<platform>` npm package (bundled static build)
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFileP = promisify(execFile);

/** `require()` a module, returning null instead of throwing. */
function tryRequire(name) {
  try {
    return require(name);
  } catch (_) {
    return null;
  }
}

/**
 * Platform binary packages. Each one contains a real ffmpeg/ffprobe executable
 * but no JS entry point, so we resolve the binary through its package.json and
 * join the sibling file. npm's `os`/`cpu` fields mean only the matching one is
 * ever installed, which keeps the bundle small on every platform.
 */
const BINARY_PKGS = {
  ffmpeg: [
    '@ffmpeg-installer/linux-x64',
    '@ffmpeg-installer/linux-arm64',
    '@ffmpeg-installer/darwin-x64',
    '@ffmpeg-installer/darwin-arm64',
    '@ffmpeg-installer/win32-x64'
  ],
  ffprobe: [
    '@ffprobe-installer/linux-x64',
    '@ffprobe-installer/linux-arm64',
    '@ffprobe-installer/darwin-x64',
    '@ffprobe-installer/darwin-arm64',
    '@ffprobe-installer/win32-x64'
  ]
};

/** Locate the executable shipped inside an @ffmpeg-installer style package. */
function binaryFromPkg(pkgName, exeName) {
  let pkgJson;
  try {
    pkgJson = require.resolve(`${pkgName}/package.json`);
  } catch (_) {
    return null;
  }
  const dir = path.dirname(pkgJson);
  const isWin = process.platform === 'win32';
  const direct = path.join(dir, isWin ? `${exeName}.exe` : exeName);
  if (fs.existsSync(direct)) return direct;
  // Some builds nest under bin/.
  const nested = path.join(dir, 'bin', isWin ? `${exeName}.exe` : exeName);
  if (fs.existsSync(nested)) return nested;
  return null;
}

function candidatesFor(exeName) {
  const out = [];

  // 1. Explicit operator override always wins.
  const envName = exeName === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  if (process.env[envName]) out.push(process.env[envName]);
  const legacy = exeName === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN';
  if (process.env[legacy]) out.push(process.env[legacy]);

  // 2. System binary on PATH.
  out.push(exeName);

  // 3. Bundled npm binaries (cross-platform, no system install needed).
  for (const pkg of BINARY_PKGS[exeName]) {
    const found = binaryFromPkg(pkg, exeName);
    if (found) out.push(found);
  }

  // 4. ffmpeg-static ships a path string directly.
  const staticPath = exeName === 'ffmpeg' ? tryRequire('ffmpeg-static') : tryRequire('ffprobe-static');
  if (typeof staticPath === 'string') out.push(staticPath);

  return out.filter(Boolean);
}

async function resolveBinaries() {
  const pick = async (exeName) => {
    for (const c of candidatesFor(exeName)) {
      try {
        await execFileP(c, ['-version'], { timeout: 15000, maxBuffer: 1024 * 1024 });
        return c;
      } catch (_) {
        /* try next candidate */
      }
    }
    return null;
  };

  return {
    ffmpegCandidates: candidatesFor('ffmpeg'),
    ffprobeCandidates: candidatesFor('ffprobe'),
    pick
  };
}

class MediaService {
  constructor(logger = console) {
    this.log = logger;
    this._bin = null;
    this._resolved = false;
  }

  /** Resolve and cache the binaries. Returns {ffmpeg, ffprobe} (either may be null). */
  async binaries() {
    if (this._resolved) return this._bin;
    const { pick } = await resolveBinaries();
    const ffmpeg = await pick('ffmpeg');
    const ffprobe = await pick('ffprobe');
    this._bin = { ffmpeg, ffprobe };
    this._resolved = true;
    if (!ffmpeg) this.log.warn?.('media-service: no ffmpeg binary found; frame extraction will be unavailable');
    return this._bin;
  }

  available() {
    return Boolean(this._bin && this._bin.ffmpeg);
  }

  /**
   * Probe a video file. Never throws: returns `{ok:false,reason}` so the
   * pipeline can mark the row instead of crashing.
   */
  async probe(filePath) {
    const { ffprobe } = await this.binaries();
    if (!ffprobe) return { ok: false, reason: 'ffprobe binary not available' };
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'file does not exist' };

    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];
    let out;
    try {
      const res = await execFileP(ffprobe, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      out = res.stdout;
    } catch (err) {
      return { ok: false, reason: `ffprobe failed: ${String(err.message).slice(0, 300)}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (err) {
      return { ok: false, reason: `ffprobe returned unparseable JSON: ${String(err.message).slice(0, 200)}` };
    }

    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const format = parsed.format || {};
    const duration = Number(format.duration || (video && video.duration) || 0);

    if (!video) return { ok: false, reason: 'no video stream found (not a valid MP4)' };
    if (!duration || duration <= 0) return { ok: false, reason: 'could not determine duration' };

    const container = String(format.format_name || '').includes('mp4') ? 'mp4' : (format.format_name || 'unknown');

    return {
      ok: true,
      duration,
      width: Number(video.width || 0),
      height: Number(video.height || 0),
      videoCodec: video.codec_name || null,
      audioCodec: audio ? audio.codec_name || null : null,
      container,
      bitRate: Number(format.bit_rate || 0),
      sizeBytes: Number(format.size || 0)
    };
  }

  /**
   * Validate that an uploaded file is really a usable MP4.
   * @returns {Promise<{ok:boolean, reason?:string, info?:object}>}
   */
  async validateMp4(filePath) {
    const info = await this.probe(filePath);
    if (!info.ok) return { ok: false, reason: info.reason };

    // Must have a video stream (already checked) and a sane duration.
    if (info.duration < 0.5) return { ok: false, reason: `duration too short (${info.duration}s)` };
    if (info.width < 64 || info.height < 64) return { ok: false, reason: `resolution too small (${info.width}x${info.height})` };
    if (!/mp4|mov|m4v/i.test(info.container)) {
      return { ok: false, reason: `unsupported container "${info.container}" (expected MP4)` };
    }
    return { ok: true, info };
  }

  /**
   * Extract frames at evenly spaced points across the video.
   * Frames are written to `outDir` as JPEG and returned in chronological order.
   *
   * @param {string} filePath
   * @param {string} outDir
   * @param {number} count
   * @param {{width?:number, quality?:number, scaleMode?:string}} opts
   */
  async extractFrames(filePath, outDir, count = 4, opts = {}) {
    const { ffmpeg } = await this.binaries();
    if (!ffmpeg) throw new Error('ffmpeg binary not available');

    const width = opts.width || 512;
    const quality = opts.quality || 75;
    const info = await this.probe(filePath);
    const duration = info.ok ? info.duration : 0;

    fs.mkdirSync(outDir, { recursive: true });
    const stamp = Date.now();
    const outputs = [];

    for (let i = 0; i < count; i += 1) {
      // Evenly spaced, never at 0s (often a fade-in / black frame).
      const t = duration > 1 ? ((i + 0.5) / count) * duration : 0;
      const out = path.join(outDir, `frame_${i}_${stamp}.jpg`);
      const args = [
        '-ss', t.toFixed(3),
        '-i', filePath,
        '-frames:v', '1',
        '-vf', `scale=${width}:-2`,
        '-q:v', String(Math.max(1, Math.min(31, Math.round((100 - quality) / 3.3)))),
        '-y', out
      ];
      try {
        await execFileP(ffmpeg, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
        if (fs.existsSync(out) && fs.statSync(out).size > 0) outputs.push(out);
      } catch (err) {
        this.log.warn?.('media-service: frame extraction failed', { at: t, error: String(err.message).slice(0, 200) });
      }
    }

    if (!outputs.length) throw new Error('frame extraction produced no images');
    return outputs;
  }

  /**
   * Pick the "visually most suitable" frame for a thumbnail.
   *
   * Real, local heuristic (no API cost): extract a handful of candidate frames
   * and score each with sharp's per-channel statistics. We favour frames that
   * are bright, high-contrast and colourful - the opposite of a black
   * fade-in or a title-card hold.
   */
  async bestFrameForThumbnail(filePath, outDir) {
    const { ffmpeg } = await this.binaries();
    if (!ffmpeg) throw new Error('ffmpeg binary not available');

    const info = await this.probe(filePath);
    if (!info.ok) throw new Error(`cannot pick a thumbnail frame: ${info.reason}`);
    const duration = info.duration;

    fs.mkdirSync(outDir, { recursive: true });
    const stamp = Date.now();
    const candidates = 6;
    const paths = [];

    for (let i = 0; i < candidates; i += 1) {
      const t = ((i + 0.5) / candidates) * duration;
      const out = path.join(outDir, `cand_${i}_${stamp}.jpg`);
      const args = [
        '-ss', t.toFixed(3),
        '-i', filePath,
        '-frames:v', '1',
        '-q:v', '2',
        '-y', out
      ];
      try {
        await execFileP(ffmpeg, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
        if (fs.existsSync(out) && fs.statSync(out).size > 0) paths.push({ path: out, at: t });
      } catch (_) {
        /* skip this candidate */
      }
    }

    if (!paths.length) throw new Error('no candidate frames could be extracted');

    const sharp = require('sharp');
    let best = null;
    for (const c of paths) {
      try {
        const stats = await sharp(c.path).stats();
        // stdev = local contrast; channels mean = brightness; entropy proxy.
        const mean = (stats.channels.reduce((a, ch) => a + ch.mean, 0) / stats.channels.length) / 255;
        const contrast = (stats.channels.reduce((a, ch) => a + ch.stdev, 0) / stats.channels.length) / 128;
        // Penalise very dark frames (fade-ins) and very bright frames (blowouts).
        const brightnessPenalty = Math.abs(mean - 0.55) * 1.6;
        const score = contrast * 1.0 + mean * 0.4 - brightnessPenalty;
        if (!best || score > best.score) best = { ...c, score, stats };
      } catch (_) {
        /* skip unreadable candidate */
      }
    }

    // Clean up the losers.
    for (const c of paths) {
      if (best && c.path !== best.path) {
        try {
          fs.unlinkSync(c.path);
        } catch (_) {
          /* ignore */
        }
      }
    }
    if (!best) throw new Error('no readable candidate frames');
    return { path: best.path, atSeconds: best.at, score: best.score };
  }

  /**
   * Render a JPEG thumbnail from an existing still, resized/cropped to the
   * YouTube-recommended 1280x720 (16:9). Pure local `sharp` work.
   */
  async normalizeThumbnail(srcPath, destPath, width, height) {
    const sharp = require('sharp');
    await sharp(srcPath)
      .resize(width, height, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(destPath);
    return destPath;
  }
}

module.exports = { MediaService, resolveBinaries };
