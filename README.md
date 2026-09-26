# YouTube Bulk Scheduler

A **single-owner, self-hosted** system for a US-targeted children's/cartoon
YouTube channel. You create the MP4 videos yourself; this application handles
everything after that.

```
You select 100 / 1,000 MP4 files (desktop or phone)
        |
        v
[ Bulk ingest ]  ->  persistent queue (SQLite, survives restarts)
        |
        v
[ Slot engine ]  ->  America/New_York, 5 slots/day, never a passed slot
        |
        v
[ Active set ]   ->  today's remaining slots + tomorrow's 5-video buffer
                     (normally <= 10 videos touched by any AI provider)
        |
        v
[ Video understanding ]  ffprobe facts + real frames from the MP4
        |
        v
[ Metadata AI ]   Gemini -> OpenRouter Free #1 -> #2 -> #3   (strict fallback)
        |
        v
   TITLE / DESCRIPTION / KEYWORDS / HASHTAGS
        |
        v
[ Thumbnail AI ]  configured image provider
        |  failure / rate-limit / unusable
        v
   best real frame from the MP4 (never a paid call)
        |
        v
[ YouTube ]       resumable videos.insert, private + publishAt (UTC)
        |
        v
[ Confirm ]       videos.list read-back  ->  mark source eligible for cleanup
        |
        v
[ Cleanup worker ]  within 24h: delete local source + Google Drive source
        |
        v
[ Next video enters active processing ]  ->  keep tomorrow's 5-video buffer
```

**It is not a video generator.** It never creates, replaces, narrates or
re-encodes a video. It never spends money without you asking it to.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Local installation](#local-installation)
3. [Environment variables](#environment-variables)
4. [Google Cloud setup](#google-cloud-setup)
5. [YouTube OAuth setup](#youtube-oauth-setup)
6. [Google Drive setup](#google-drive-setup)
7. [Gemini setup](#gemini-setup)
8. [OpenRouter free-model setup](#openrouter-free-model-setup)
9. [Thumbnail provider setup](#thumbnail-provider-setup)
10. [Bulk upload](#bulk-upload)
11. [The 5/day schedule](#the-5day-schedule)
12. [The advance buffer](#the-advance-buffer)
13. [Storage cleanup](#storage-cleanup)
14. [Failure handling](#failure-handling)
15. [Local deployment](#local-deployment)
16. [Render / Railway deployment](#render--railway-deployment)
17. [Retrying failed videos](#retrying-failed-videos)
18. [API reference](#api-reference)
19. [Database schema](#database-schema)
20. [Tests](#tests)
21. [Legacy AgentTube app](#legacy-agenttube-app)
22. [Known limitations](#known-limitations)

---

## What it does

| Stage | What happens | Never happens |
|---|---|---|
| Bulk upload | MP4 files are queued one request at a time, streamed straight to disk | Nothing is sent to an AI provider on upload |
| Queue | Every file gets a durable row with position, status and error state | Nothing is processed in bulk up front |
| Slot assignment | Today's remaining ET slots + tomorrow's 5 | A slot that already passed is never used |
| Video understanding | ffprobe facts + 4 real frames + a local visual brief | The filename is not trusted over the video |
| Metadata | One final title, description, 8–15 tags, up to 3 hashtags, category, Made-for-Kids, synthetic-media flag | No five-option menu, no manual approval step |
| Thumbnail | Configured image model, validated to 1280x720 | No paid API call is made to recover a failure |
| Upload | Resumable `videos.insert`, `privacyStatus: private`, `publishAt` in UTC | The same job is never uploaded twice |
| Confirm | `videos.list` read-back, then the source is marked eligible | Deletion never happens on an uncertain outcome |
| Cleanup | Local file + Drive file deleted, 6–24 h after confirmation | A failed upload is never deleted |

### Safety gates that are always on

- **Child safety screen** — generated metadata is rejected if it contains
  adult language, clickbait phrasing ("you won't believe", "shocking"), a
  hashtag wall, or unsupported superlatives. A rejected result falls through to
  the next AI provider instead of reaching YouTube.
- **Made for Kids** — read live from the channel at startup and honoured.
  Never changed automatically. Override only with `YOUTUBE_MADE_FOR_KIDS`.
- **Synthetic media disclosure** — `auto` (model decides per video and reports
  its confidence), `true`, or `false`. Never silently hard-coded.
- **No fabricated videos** — when the queue is empty the dashboard says
  `QUEUE EMPTY` and scheduling stops.
- **No accidental paid model** — `OPENROUTER_FREE_ONLY=true` (default) rejects
  any configured model that is not free. Nothing is ever defaulted.

---

## Local installation

```bash
# 1. Node 22.5+ (uses the built-in node:sqlite - no native build needed)
node -v

# 2. Clone and install
git clone <your-repo-url>
cd Youtube
npm install

# 3. FFmpeg - needed for video analysis and the thumbnail frame fallback.
#    Auto-detected from PATH, or from the bundled @ffmpeg-installer package.
ffmpeg -version
# If yours lives somewhere unusual:
#   FFMPEG_PATH=/usr/local/bin/ffmpeg
#   FFPROBE_PATH=/usr/local/bin/ffprobe

# 4. Configure
cp .env.example .env
# edit .env - see the next section

# 5. Authorize Google (opens your browser)
npm run auth

# 6. Start
npm start
```

Then open <http://localhost:3000> and sign in with the Google address you put
in `OWNER_EMAIL`.

### `npm run auth` on a headless machine

`scripts/authorize.js` starts a loopback server on `127.0.0.1` (random port,
5-minute timeout), prints an authorization URL, and captures the redirect.
Works over SSH: open the printed URL on any machine where you are signed into
the owner Google account.

Tokens are written to `config/tokens.json` with `0600` permissions. That file
is gitignored and is **never** sent to the browser.

---

## Environment variables

See [`.env.example`](.env.example) for the complete, commented template. The
essentials:

```bash
# --- required to boot ---
OWNER_EMAIL=your-google-address@example.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ENCRYPTION_KEY=...                 # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# --- required to do anything useful ---
GEMINI_API_KEY=...
OPENROUTER_API_KEY_1=...  OPENROUTER_MODEL_1=...:free
OPENROUTER_API_KEY_2=...  OPENROUTER_MODEL_2=...:free
OPENROUTER_API_KEY_3=...  OPENROUTER_MODEL_3=...:free

# --- schedule ---
TIMEZONE=America/New_York
PUBLISH_SLOT_TIMES=08:00,14:00,16:00,18:00,20:00
DAILY_VIDEO_COUNT=5

# --- cleanup ---
DELETE_AFTER_SUCCESSFUL_YOUTUBE_SCHEDULE=true
DELETE_DELAY_HOURS=6
DELETE_MAX_HOURS=24

# --- storage ---
GOOGLE_DRIVE_ENABLED=false
GOOGLE_DRIVE_FOLDER_ID=...
```

The server **refuses to boot** without `OWNER_EMAIL` and the Google OAuth
credentials, and prints exactly what is missing. Everything else degrades
gracefully and is reported on the dashboard.

---

## Google Cloud setup

Your existing project works as-is:

- **Project name:** YouTube Shorts Auto Scheduler
- **Project ID:** `precise-mystery-509108-q1`

APIs that must be enabled (you already have them):

| API | Why |
|---|---|
| YouTube Data API v3 | upload, schedule, confirm |
| Google Drive API | optional source-file mirror + cleanup |
| Identity Toolkit API | Google Sign-In for owner auth |

### Scopes requested

```
https://www.googleapis.com/auth/youtube.upload      # upload + schedule
https://www.googleapis.com/auth/youtube.readonly   # confirm / reconcile / channel
https://www.googleapis.com/auth/drive.file         # ONLY files this app created
openid email profile                                # owner identity
```

`drive.file` is deliberately the narrowest practical Drive scope: the app can
see and delete the files **it** uploaded, and nothing else in your Drive.
`drive.readonly` is **not** requested.

### OAuth client

Create (or reuse) an **OAuth 2.0 Web client**:

- **Authorized JavaScript origins** — the origin of this app, e.g.
  `http://localhost:3000` locally, `https://your-app.onrender.com` on Render.
- **Authorized redirect URIs** — `${APP_URL}/api/auth/google/callback`

> The old project's `youtube.upload` + `drive.file` + `drive.readonly`
> combination is not reused blindly: `drive.readonly` is dropped, and
> `youtube.readonly` is added because this app needs to *confirm* uploads.

---

## YouTube OAuth setup

1. Google Cloud Console → **APIs & Services → OAuth consent screen**.
   - User type: **External** (or Internal if you have Workspace).
   - Add the owner address under **Test users** while the app is in testing.
2. Add the scopes listed above.
3. Create credentials → **OAuth client ID → Web application**.
4. Put the client id and secret in `.env`.
5. `npm run auth` → approve in the browser.

`YOUTUBE_API_KEY` is optional and only needed for unauthenticated read calls.
Uploads always use OAuth.

---

## Google Drive setup

Optional. When enabled, each source MP4 is mirrored into a Drive folder before
anything destructive happens, and deleted from Drive after the YouTube schedule
is confirmed.

```bash
GOOGLE_DRIVE_ENABLED=true
GOOGLE_DRIVE_FOLDER_ID=<id of the target folder>
```

Create a folder in Drive, open it, and copy the id from the URL:

```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

The folder must be owned by (or shared with) the same Google account that
authorizes the app, and that account needs edit access to it.

If `GOOGLE_DRIVE_ENABLED=false`, everything works local-only and the dashboard
shows `Drive: disabled`.

---

## Gemini setup

1. Go to <https://aistudio.google.com/apikey>.
2. Create an API key (free tier is enough).
3. `GEMINI_API_KEY=...`
4. Optionally change the model: `GEMINI_MODEL=gemini-2.5-flash`

Gemini is **first** in the chain. If it is not configured, the chain starts at
OpenRouter #1 and the dashboard says so.

---

## OpenRouter free-model setup

1. Create an account at <https://openrouter.ai>.
2. Add credits **only if you intend to** — the free models need none.
3. Create API keys (one per fallback, or reuse the same key three times).
4. Configure all three:

```bash
OPENROUTER_API_KEY_1=sk-or-v1-...
OPENROUTER_MODEL_1=deepseek/deepseek-chat-v3.1:free

OPENROUTER_API_KEY_2=sk-or-v1-...
OPENROUTER_MODEL_2=qwen/qwen3-coder:free

OPENROUTER_API_KEY_3=sk-or-v1-...
OPENROUTER_MODEL_3=meta-llama/llama-3.3-70b-instruct:free
```

The model slugs above are **examples only**. Nothing is hard-coded: set
whatever free models you like and the chain follows your configuration.

`OPENROUTER_FREE_ONLY=true` (the default) rejects any configured slug that does
not look like a free model, so a paid model can never be selected by accident.
Set it to `false` only if you deliberately want to opt out.

Browse free models: <https://openrouter.ai/models?q=free>

---

## Thumbnail provider setup

A **separate** provider from the four metadata models.

```bash
THUMBNAIL_PROVIDER=openrouter     # openrouter | gemini | pollinations | none
THUMBNAIL_PROVIDER_KEY=sk-or-v1-...
THUMBNAIL_PROVIDER_MODEL=some/free-image-model:free
```

| Provider | Key needed | Notes |
|---|---|---|
| `openrouter` | yes | any free image-capable model |
| `gemini` | yes | an image-capable Gemini model |
| `pollinations` | no | free, no key |
| `none` | no | always uses the video frame fallback |

`THUMBNAIL_FREE_ONLY=true` (default) applies the same free-model guard.

**Fallback rule:** if the provider fails, rate-limits, times out, or returns an
unusable image, the system extracts the best real frame from the MP4 (scored
locally with `sharp` for brightness and contrast), normalises it to 1280x720,
and uploads that. **No paid API call is ever made to recover a thumbnail.**

---

## Bulk upload

The dashboard (`/`) accepts files two ways:

- **Select files** — the file picker, multi-select.
- **Drag and drop** — drop files *or a whole folder* onto the dropzone. Dropped
  folders are walked recursively.

Both work from a desktop browser and a phone browser.

### How the transport works

One HTTP request per file, raw body, streamed straight to disk:

```
POST /api/ingest
Content-Type: application/octet-stream
x-filename: My Cartoon.mp4
x-file-size: 12345678
x-sha256: <hex>
<bytes>
```

This is deliberate: 1,000 concurrent multipart uploads from a phone would be
fragile, and streaming means a 2 GB file never sits in memory. You get per-file
progress and per-file error handling, and one bad file never aborts the batch.

Uploads are sequential by default (`WORKER_CONCURRENCY=1`).

### What is stored per queued video

queue id · filename · local path · file size · duration · width/height · codecs
· container · SHA-256 · queue position · upload time · processing status ·
AI metadata status · thumbnail status · YouTube status · scheduled time (ET +
UTC) · slot date/index · YouTube video id · error state · retry count ·
cleanup state · timestamps.

### Duplicate suppression

If you send `x-sha256` and the same content is already queued (and not yet
scheduled), the request returns `409 duplicate_source` instead of queueing it
twice. The file is removed from disk.

---

## The 5/day schedule

Exactly **5 videos every day**, including weekends. No exceptions.

| # | America/New_York |
|---|---|
| 1 | 08:00 AM |
| 2 | 02:00 PM |
| 3 | 04:00 PM |
| 4 | 06:00 PM |
| 5 | 08:00 PM |

`America/New_York` is the **master** timezone. The engine uses the IANA name
via `Intl.DateTimeFormat`, never a fixed UTC offset, so:

- EST (UTC−5) and EDT (UTC−4) are both handled automatically.
- The spring-forward gap and the fall-back overlap resolve deterministically.
- Month and year boundaries roll correctly.
- Midnight is evaluated in ET, not in the server's local zone.

Example conversions the dashboard also shows (IST, for the operator):

| ET | IST |
|---|---|
| 08:00 | 05:30 PM |
| 02:00 PM | 11:30 PM |
| 04:00 PM | 01:30 AM |
| 06:00 PM | 03:30 AM |
| 08:00 PM | 05:30 AM |

`DISPLAY_TIMEZONES=America/New_York,Asia/Kolkata` controls which zones are
shown. ET always remains authoritative.

### Slot rules

- A slot that starts within `SLOT_LEAD_MINUTES` (default 5) is not filled.
- A slot that has already passed is never used, and any stale planned slot is
  released back to the queue on every sweep.
- A day can never receive a 6th video.

---

## The advance buffer

The system maintains a rolling buffer of **the next day's 5 videos**, whenever
the queue has enough to fill it.

**25 videos uploaded at 07:00 ET:**

```
Videos  1–5   -> today's five slots        (fully prepared now)
Videos  6–10  -> tomorrow's five slots     (fully prepared in advance)
Videos 11–25  -> stay in the queue, NOT AI-processed yet
```

**Upload after 2 of today's slots have passed:**

```
2 videos -> today's 2 remaining slots
5 videos -> tomorrow's advance buffer
rest     -> stay queued
```

Nothing is ever forced into a slot that has passed.

### The cost-control guarantee

At normal operation the active AI-processing set is **at most 10 videos**
(today's remaining + tomorrow's 5). Uploading 1,000 videos does **not** send
1,000 videos to Gemini or OpenRouter — the other 990 stay in the SQLite queue
and are never touched by an AI provider until the buffer rolls forward.

`MAX_ACTIVE_VIDEOS=10` is a hard ceiling so a misconfiguration cannot explode
your API usage.

---

## Storage cleanup

### Lifecycle

```
ingest (local disk)
   -> optional Drive mirror copy
   -> processing (metadata + thumbnail)
   -> YouTube upload + schedule
   -> videos.list confirmation read-back
   -> cleanup_status = 'eligible', cleanup_eligible_at = now + DELETE_DELAY_HOURS
   -> cleanup worker sweeps
   -> delete local  ->  delete Drive  ->  record result
```

### Rules enforced

Deletion happens **only** when all of these are true:

- `youtube_status` is `scheduled` or `published`
- a confirmed `youtube_video_id` exists
- the upload outcome is **not** uncertain
- the video is not still processing
- the thumbnail is `generated` or `fallback`
- title and description are present
- a scheduled time is recorded
- there is still something to delete

Deletion is **skipped** when any of these are true:

- the upload failed
- the schedule failed
- the YouTube confirmation is uncertain
- the video is still processing
- metadata is incomplete
- the thumbnail is still required
- deleting would remove the only recoverable copy

Deletion is **transactional**: local first, then Drive. If either side fails,
the task is marked `failed`, the video is **not** marked deleted, and the
failure is shown on the dashboard.

### The toggle

`DELETE_AFTER_SUCCESSFUL_YOUTUBE_SCHEDULE` (default `true`).

- `true` — delete local + Drive after a confirmed schedule.
- `false` — keep the source files forever; nothing is deleted automatically.

### Timing

- `DELETE_DELAY_HOURS=6` — minimum wait after confirmation, so retries and
  reconciliation can finish safely.
- `DELETE_MAX_HOURS=24` — hard ceiling. The requirement is "within 24 hours",
  and the effective delay is `min(DELETE_DELAY_HOURS, DELETE_MAX_HOURS)`.

The cleanup worker never runs inline with an upload, so a crash can never leave
a file half-deleted while the YouTube state is still unknown.

---

## Failure handling

### AI metadata chain

```
Gemini
  | rate limit / quota / timeout / outage / invalid response / model unavailable
  v
OpenRouter Free #1
  v
OpenRouter Free #2
  v
OpenRouter Free #3
  v
PAUSE
```

If all four fail, the video is parked with `ai_status = 'paused'` and the
dashboard shows:

- the video id
- every provider attempted, in order
- the exact reason each one failed (classified: `rate_limited_or_quota`,
  `timeout`, `provider_outage`, `network`, `invalid_response`, `auth_or_forbidden`,
  `model_unavailable`, `bad_request`)
- the timestamp
- the retry information

Processing is **not** silently skipped, and no paid provider is substituted.
A health probe re-runs every `PROVIDER_HEALTH_MS` (5 min); when a provider
answers again, the paused videos resume automatically.

### Thumbnail

Failure → best real frame from the MP4. Never a paid call.

### YouTube

```
attempt #1
  | fail
  v
show/log the error
  | automatic retry ONCE
  v
retry succeeds -> continue normally
  |
  v
retry fails -> mark FAILED
               store: exact API error, HTTP status, operation, timestamp,
                      retry count, video id, and whether YouTube MAY have
                      received the upload
               -> continue to the next queue item
```

The failed video **stays in the database** with a **Retry** button on the
dashboard. It is never deleted.

A 4xx error that cannot succeed on retry (e.g. `invalidTitle`) does **not**
burn the second attempt. A 5xx/408/429, or a response we never received, is
flagged `youtube_uncertain = 1` — the row is reconciled against
`videos.list` before any re-upload, so the same video is never uploaded twice.

### Crash recovery

On boot, `reconcileInterrupted()` runs:

- any row stuck in `uploading` with a known video id is confirmed against
  YouTube and adopted if it exists;
- otherwise it is returned to the queue with its slot released, so it can never
  land in a slot that has passed.

Stage checkpoints (`ingest_checkpoints`) store completed artifacts, and every
artifact is re-validated on disk before it is reused.

---

## Local deployment

```bash
npm start
```

The queue lives in `data/scheduler.db`. Uploaded sources live in
`data/uploads/`. Derived assets (frames, thumbnails) live in `data/derived/`.
Logs go to `logs/app.log`.

**Honest limitation:** if the PC is off, the worker cannot run, so no new
videos are uploaded or scheduled while it is down. Once a video *is* scheduled
on YouTube, YouTube publishes it at the scheduled time independently of this
application. Missed slots are simply skipped — the system never back-fills.

To keep a local PC running, use `pm2`, `systemd`, or Docker.

### systemd unit

```ini
[Unit]
Description=YouTube Bulk Scheduler
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/youtube-bulk-scheduler
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## Render / Railway deployment

The queue system needs no rewriting — only the URL and storage paths change.

1. Push the repo.
2. Create a **Web Service** (not a static site). Node 22.5+.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add a **Persistent Disk** and point `DATABASE_PATH`, `UPLOAD_DIR` and
   `DERIVED_DIR` at it. Without a disk, the queue is lost on every deploy.
6. Set the environment variables from `.env.example`.
7. Set `APP_URL=https://your-service.onrender.com`.
8. Add that origin and `${APP_URL}/api/auth/google/callback` to the OAuth
   client's authorized origins and redirect URIs.
9. `SECURE_COOKIES=true` (Render/Railway terminate TLS).

`/api/healthz` is public and unauthenticated for platform health checks.

> A powered-off local PC cannot keep uploading. A Render/Railway worker can,
> because it stays online. That is the only operational difference.

---

## Retrying failed videos

### From the dashboard

Every failed row shows the exact reason, the HTTP status, the operation, the
retry count, and — when the outcome was uncertain — a note that YouTube may
have received the upload. Press **Retry**.

### In bulk

- **Retry failed** — re-queues every failed video at the back of the queue.
- **Clear failed** — removes the failed rows. Source files on disk are kept.

### What retry does

1. Releases any slot the video held.
2. Clears its pipeline state (`resetVideo`) — metadata, thumbnail and upload
   are all regenerated.
3. Preserves the YouTube video id **only** if the previous outcome was
   uncertain, so reconciliation can find the video YouTube already has.
4. Puts it at the back of the queue.
5. Re-runs `topUp()` so it re-enters the active window at the next free slot.

---

## API reference

Every endpoint below exists in `routes/api.js`. Nothing here is a stub.

Auth: all routes except `/api/healthz`, `/api/auth/*` and the static login page
require the owner session cookie (`HttpOnly`, `SameSite=Lax`).

| Method | Endpoint | Purpose | Auth | Input | Output |
|---|---|---|---|---|---|
| GET | `/api/healthz` | Liveness probe for the platform | none | – | `{ok, service, timezone, now}` |
| GET | `/api/auth/config` | Is Google OAuth configured? | none | – | `{googleConfigured, ownerConfigured, scopes, redirectUri}` |
| GET | `/api/auth/google/start` | Begin owner sign-in | none | – | 302 to Google |
| GET | `/api/auth/google/callback` | OAuth return | none | `code`, `state` | 302 to `/` |
| GET | `/api/auth/session` | Current session | cookie | – | `{authenticated, subject, name, expiresAt}` |
| POST | `/api/auth/logout` | Clear the session | none | – | `{ok}` |
| GET | `/api/dashboard` | Today / buffer / queue / processing / failed / paused | owner | – | full dashboard payload |
| GET | `/api/dashboard/providers` | Status of all 4 metadata models + thumbnail + trends | owner | – | `{metadata[], thumbnail, trends}` |
| GET | `/api/dashboard/videos` | Queue listing | owner | `?status=&youtubeStatus=&limit=` | `{count, videos[]}` |
| GET | `/api/dashboard/videos/:id` | One video + its provider attempt log | owner | – | `{video, attempts[]}` |
| POST | `/api/ingest` | Upload one MP4 into the queue | owner | raw body + `x-filename`, `x-file-size`, `x-sha256` | `{ok, video, assigned[], queueTotal}` |
| POST | `/api/queue/topup` | Force a buffer top-up | owner | – | `{assigned[], queueEmpty, activeCount}` |
| POST | `/api/queue/retry/:id` | Re-queue one failed video | owner | – | `{ok, videoId}` |
| POST | `/api/queue/retry-failed` | Re-queue every failed video | owner | – | `{retried}` |
| POST | `/api/queue/clear-failed` | Drop failed rows (files kept) | owner | – | `{cleared}` |
| POST | `/api/worker/run` | Run one pipeline pass | owner | – | `{processed, scheduled, failed, paused, details[]}` |
| GET | `/api/worker/status` | Worker state | owner | – | `{running, current, concurrency}` |
| POST | `/api/worker/reconcile` | Resolve crash-ambiguous rows | owner | – | `{resolved, checked}` |
| POST | `/api/worker/resume-paused` | Re-probe providers, un-pause | owner | – | `{resumed, provider}` |
| POST | `/api/cleanup/run` | Run one cleanup sweep | owner | – | `{due, deleted, failed, deferred, errors[]}` |
| GET | `/api/cleanup/status` | Cleanup state | owner | – | `{pending, failed, deleteAfterYouTube, delayHours}` |
| GET | `/api/youtube/status` | Connection, channel, madeForKids, uploads today | owner | – | `{connected, channel, insertsToday, …}` |
| GET | `/api/youtube/videos/:id` | Confirm a video exists on YouTube | owner | – | `{exists, privacyStatus, publishAt, …}` |
| GET | `/api/storage/summary` | Local + Drive usage, pending deletions | owner | – | `{local, drive, pendingDeletion, failedDeletion}` |
| GET | `/api/settings` | Effective schedule/storage config | owner | – | `{timezone, slotTimes, videosPerDay, deleteAfterYouTube, …}` |
| GET | `/api/assets/:id/:kind` | Serve a thumbnail (`kind=thumbnail`) | owner | – | image bytes, or 403/404 |

Responses never contain local filesystem paths, Drive file ids, tokens or keys.

---

## Database schema

SQLite, via Node's built-in `node:sqlite` (same engine and file format as the
legacy app's `sqlite3` package, but no native compilation). Schema lives in
`database/ingest-db.js`.

### `ingest_videos` — the queue

One row per uploaded MP4. The authoritative state of everything.

| Column | Meaning |
|---|---|
| `id` | `ing_<uuid>` primary key |
| `filename` / `original_name` | stored name / name the browser sent |
| `local_path` / `tmp_path` | on-disk source |
| `file_size`, `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `container` | ffprobe facts |
| `sha256` | content hash, used for duplicate suppression |
| `queue_position` | 1-based position in the un-consumed queue |
| `drive_file_id` | id of the Drive copy, written after the local→Drive mirror |
| `uploaded_at` | ingest time |
| `status` | `queued` → `processing` → `analyzing` → `uploading` → `scheduled` / `failed` / `paused` |
| `ai_status` | `pending` / `running` / `done` / `failed` / `paused` |
| `ai_provider`, `ai_model`, `ai_error`, `ai_round`, `ai_attempts`, `ai_paused_at` | which model won, and why others did not |
| `thumbnail_status`, `thumbnail_path`, `thumbnail_source`, `thumbnail_error` | `generated` (AI) or `fallback` (video frame) |
| `youtube_status` | `pending` / `uploading` / `scheduled` / `published` / `failed` |
| `youtube_video_id`, `youtube_url`, `youtube_error`, `youtube_http_status`, `youtube_operation`, `youtube_retry_count`, `youtube_uncertain` | upload outcome and audit trail |
| `slot_date_et`, `slot_index`, `slot_time_et`, `scheduled_at_utc`, `publish_at` | the assigned slot |
| `title`, `description`, `tags`, `hashtags`, `category_id`, `made_for_kids`, `contains_synthetic`, `synthetic_confidence` | generated metadata |
| `analysis_json` | the visual brief sent to the model |
| `cleanup_status`, `cleanup_eligible_at`, `cleanup_error`, `cleanup_attempts`, `local_deleted_at`, `drive_deleted_at` | deletion lifecycle |

### `slot_assignments`

One row per (ET date, slot index). `UNIQUE(slot_date_et, slot_index)` makes it
impossible at the database level for a day to receive a 6th video.

### `provider_attempts`

Append-only audit log of every AI call: video, stage, provider, model, status,
HTTP status, error code, message, duration.

### `cleanup_tasks`

One row per eligible video: local path, Drive file id, eligible-at, per-side
results, attempt count.

### `ingest_checkpoints`

`PRIMARY KEY (video_id, stage)`. Stores completed stage artifacts so a crash
resumes instead of repeating provider work. Artifacts are re-validated against
disk before reuse.

### `settings`

Key/value store (schema version, single-use OAuth state values).

---

## Tests

```bash
npm test              # the new system's unit suite (99 assertions)
npm run test:integration  # end-to-end pipeline suite (16 assertions)
npm run test:legacy    # the original AgentTube suite (unchanged)
npm run lint
```

The unit suite (`tests/run-ingest-tests.js`) has **99 assertions** across 12
suites, with no test framework and no network access. It covers:

| Area | Covered |
|---|---|
| Slot engine | IANA zone vs fixed offset, exact 5 slots, remaining-today, spring-forward gap, fall-back overlap, DST stability, month/year boundaries, midnight, ET+IST display |
| Queue / buffer | 25 uploads → 5+5+15, the 5/day ceiling, partially-used days, passed slots, stale-slot release, QUEUE EMPTY, resume on upload, buffer roll-forward |
| Persistence | DB reopen survives restart, checkpoint artifact re-validation, failed rows retained, retry ordering, clear-failed keeps files |
| AI chain | deterministic order, skipped providers, fall-through on failure, all-four-down pause + full ledger, no-provider refusal, paid-model rejection, unusable-metadata fall-through, error classification, child-safety screen, JSON tolerance |
| Thumbnail | AI success + validation, AI failure → real frame, unusable image rejected, `provider=none` skips AI, paid model rejected, frame scoring |
| MP4 | valid file accepted with real probe facts, non-video rejected, missing file rejected, frame extraction, filename neutralisation |
| YouTube | upload success, `private` + UTC `publishAt`, retry-once, non-retryable not retried, 5xx → uncertain, no slot → refused, missing file → refused, thumbnail failure non-fatal, no 1,600-unit assumption, operator soft cap, tags parsing, reconciliation |
| Storage | eligibility matrix, delete-after OFF, delay + 24 h cap, local+Drive deletion recorded, Drive failure not marked deleted, not-yet-eligible deferred, only-copy protection, path confinement, hashing, usage |
| Security | owner allowlist, list never exposed, signed HttpOnly cookie, tampered cookie rejected, expiry, cookie-only parsing, key rotation invalidates, log redaction, no secrets in browser payload, `.env.example` clean, `.gitignore` coverage, no committed token file, config validation, narrow Drive scope, argv-array subprocess, clean client bundle |
| HTTP | every endpoint, 401 without a session, JSON 404, path traversal, asset confinement |
| Legacy | original files present, legacy entry point intact, no legacy AI/video module required |

---

## Legacy AgentTube app

The original autonomous content-generation application is **untouched** and
still runs:

```bash
npm run legacy           # node index.js
npm run legacy:scheduler # node schedules/daily-automation.js
npm run test:legacy      # node test.js
```

None of its AI video-generation, TTS, narration, script, research, comment,
analytics, experiment or learning code is required by the new workflow. It is
kept only because it is harmless and still useful in its own right. The new
system's dependencies live in `dependencies`; the legacy extras live in
`optionalDependencies` so a failed native build never breaks `npm install`.

---

## Known limitations

1. **A powered-off local PC cannot upload.** Already-scheduled videos still
   publish on time; new uploads wait for the machine to come back.
2. **Missed slots are skipped, never back-filled.** If the app is down at
   08:00 ET, that slot is lost and the next video takes 14:00 ET.
3. **FFmpeg is required** for video analysis and the thumbnail frame fallback.
   Without it, uploads are validated by filename and size only, and thumbnails
   can only come from the AI provider.
4. **Single channel, single owner.** No multi-tenancy, no roles, no team access.
5. **`node:sqlite` is experimental** in Node 22 (stable in 23+). It emits an
   `ExperimentalWarning` at startup; this is expected and harmless.
6. **YouTube quota is not predicted.** No per-call cost is assumed anywhere.
   Uploads are counted and exposed on the dashboard, and
   `YOUTUBE_DAILY_INSERT_SOFT_CAP` is an optional operator-set guard (default
   0 = off). If you hit `quotaExceeded`, the video is marked FAILED with the
   exact API error and stays retryable.
7. **Trend research is off by default.** When enabled it only supplies
   discoverability vocabulary; it never claims anything is trending without
   real data, and never decides what to create.
8. **Sequential uploads by default.** `WORKER_CONCURRENCY` can raise this, but
   1 is the safest for a phone browser and for YouTube rate limits.
9. **`thumbnails.set` requires a verified channel.** If your channel is not
   verified for custom thumbnails, the thumbnail upload is logged and skipped;
   the video is still scheduled.
