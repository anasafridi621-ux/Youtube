# AgentTube / Lumen — Complete Technical Audit

**Audited repo:** `anasafridi621-ux/Youtube` (branch `arena/01a0d938-youtube`, base commit `0d7eaf9`)
**App version:** `package.json` → `2.10.0`, product name "Lumen" (README title: "AgentTube")
**Audit date:** 2026-09-25
**Scope:** Read-only inspection of every source file. No code was changed, nothing committed or pushed.

---

## 0. FILE INVENTORY (what actually exists)

| Path | Lines | Role |
|---|---|---|
| `index.js` | 1,861 | Express server, agent wiring, generation jobs, all `/api/*` routes, approval gate |
| `database/db.js` | 2,924 | SQLite schema + every query method |
| `test.js` | 3,480 | 46-test self-contained suite (no test framework; plain node asserts) |
| `walkthrough.js` | 579 | Guided setup wizard (`npm run walkthrough`) |
| `setup.js` | 354 | Legacy setup wizard (writes `.env`) |
| `modern-auth.js` | 263 | Loopback YouTube OAuth flow (used by walkthrough) |
| `oauth-server.js` | 150 | **Orphan** — not `require`d anywhere in the repo |
| `schedules/daily-automation.js` | 678 | All cron jobs |
| `agents/content-strategy-agent.js` | 724 | Research + topic selection + editorial plan |
| `agents/script-writer-agent.js` | 783 | Script generation (AI + template) |
| `agents/thumbnail-designer-agent.js` | 387 | Thumbnails via `sharp` (gradient + text overlay), A/B variants |
| `agents/seo-optimizer-agent.js` | 623 | Title/description/tags/hashtags/chapters |
| `agents/production-management-agent.js` | 737 | TTS + visuals + captions + FFmpeg assembly + scene manifest |
| `agents/publishing-scheduling-agent.js` | 732 | YouTube upload, schedule, queue, captions, thumbnail |
| `agents/analytics-optimization-agent.js` | 857 | YouTube Analytics + retention + outcomes |
| `utils/ai-text-service.js` | 185 | **The** text-provider abstraction (OpenAI-compatible + Gemini) |
| `utils/ai-video-generator.js` | 987 | TTS, images, slideshow render, mux, simulation fallbacks |
| `utils/video-providers.js` | 460 | Seedance / MiniMax / Google Omni / Kling / Wan / Slideshow providers |
| `utils/media-generation-service.js` | 242 | Scene planning, async task polling, task persistence, resume |
| `utils/scene-repair-service.js` | 695 | Durable scene manifest, per-scene repair, rebuild |
| `utils/shorts-repurposing-service.js` | 381 | 9:16 Short drafts from approved long-form |
| `utils/channel-learning-engine.js` | 542 | 24h/7d snapshots, baselines, recommendations, ROI |
| `utils/scene-retention-engine.js` | 258 | Retention curve → per-scene mapping |
| `utils/growth-experiment-service.js` | 473 | Controlled title/thumbnail A/B with z-test guardrails |
| `utils/audience-engagement-service.js` | 582 | Comment sync, analysis, reply drafts, audience ideas |
| `utils/autonomous-channel-operator.js` | 247 | The operator run loop |
| `utils/operator-service.js` | 179 | Quality gate (`runQualityChecks`) + notifications |
| `utils/production-readiness-service.js` | 293 | Live preflight probes |
| `utils/generation-recovery-service.js` | 130 | Stage checkpoints + retries |
| `utils/provenance-service.js` | 154 | Factual claims / sources / waivers |
| `utils/discoverability-service.js` | 117 | DarkzSEO orchestration |
| `utils/discoverability-adapters/darkzseo.js` | 255 | Bundled JS auditor + optional external Python adapter |
| `utils/credential-manager.js` | 722 | Credentials/tokens load/save, OAuth, setup wizard |
| `utils/activation-metrics.js` | 98 | Local "first real video" milestones |
| `utils/anonymous-telemetry.js` | 108 | Opt-in-only milestone pings |
| `dashboard/index.html`, `app.js`, `styles.css`, `enhance.js` | ~1,900 + HTML/CSS | Single-page dashboard |
| `docs/superpowers/**` | 2 files | Design + plan docs for the Engagement studio |
| `reports/growth/**` | 6 files | Historical growth snapshots (docs, not code) |

---

## 1. COMPLETE SYSTEM OVERVIEW

### What the app is

A **self-hosted Node.js/Express application** ("Lumen") that runs one YouTube channel semi-autonomously. It is **not** a cloud service — it runs on your machine, stores everything in a local SQLite file and a local `data/` folder, and talks to external AI providers and the YouTube APIs over HTTPS.

### The actual end-to-end workflow

```
STARTUP
  index.js:initialize()
    ├─ Database()                → creates data/youtube_automation.db + 30 tables
    ├─ markInterruptedJobs()     → any queued/running job becomes 'interrupted'
    ├─ GenerationRecoveryService, OperatorService, ProvenanceService,
    │  DiscoverabilityService, AutonomousChannelOperator, ActivationMetrics,
    │  AnonymousTelemetry
    ├─ CredentialManager.validateAll()
    │     └─ FAIL → "setup mode": dashboard only, generation + publishing disabled
    │     └─ PASS → initialize 7 agents, print capability check, setupAPI(),
    │                start DailyAutomation scheduler
    └─ app.listen(PORT || 3456)
```

**Generation run** (`POST /generate` → `startGenerationJob` → `runGenerationJob` → `generateContent`):

| # | Stage | Where | What happens |
|---|---|---|---|
| 1 | **Research / Strategy** | `agents/content-strategy-agent.js` → `generateContentStrategy()` | Calls `fetchYouTubeTrends()` (`youtube.videos.list` `chart=mostPopular`, `regionCode` from `YOUTUBE_REGION`) + `analyzeCompetitors()` (`COMPETITOR_CHANNELS`). Then AI planner (`generateContentStrategyWithAI`) produces `{topic, angle, targetAudience, contentType, keywords, estimatedViews, bestPublishTime}`. If no AI provider → **template fallback** (keyword extraction, `predictViews` heuristic, hardcoded "next weekday 2 PM"). |
| 2 | **Topic selection** | same file, `selectOptimalTopic()` | Ranks `trendingTopics` by score. With no YouTube creds the list is empty → evergreen fallback list. |
| 3 | **Script** | `agents/script-writer-agent.js` → `generateScript()` | AI mode: one prompt → JSON `{title, hook, sections[], cta, claims[]}`. Fallback mode: **fully hardcoded templates** (`generateProblemSection`, `generateListItems`, …) with random counts. `claims[]` feeds provenance. |
| 4 | **Thumbnail** | `agents/thumbnail-designer-agent.js` | `generateConcept()` picks from 5 hardcoded style tables → `sharp` draws an SVG **gradient** → `sharp` composites a **text overlay SVG** → resize/JPEG. **No AI image model is used here.** |
| 4b | (Production re-generates an AI thumbnail) | `production-management-agent.js` → `processThumbnail()` → `AIVideoGenerator.generateThumbnail()` | Tries OpenAI `gpt-image-2` / Gemini image; falls back to the Sharp gradient. |
| 5 | **SEO** | `agents/seo-optimizer-agent.js` → `optimize()` | AI title/description/tags, else template description with **literal placeholder text** (`[Your Channel URL]`, `[Related Video 1]`). Hashtags/chapters/end-screen are always template-generated. |
| 6 | **Production** | `agents/production-management-agent.js` → `processContent()` | Script → `data/scripts/*.json` + `*_tts.txt`; visuals (5 prompts max, AI images or `.info` placeholders); TTS narration; SRT captions; FFmpeg assembly; scene manifest. |
| 7 | **Quality gate** | `utils/operator-service.js` → `runQualityChecks()` | ~12 checks (title, description, tags, script, thumbnail, video, duplicate topic, video file, narration, brand policy, provenance, discoverability, scene integrity, scene rights). Blocking failures → `needs_attention`. |
| 8 | **Review / approval** | `index.js` → `approveContent()` + dashboard Review Studio | `approval_required` setting defaults `true` → status `needs_review`. Approval requires `factChecked` **and** `rightsConfirmed` in `editorData`, plus quality re-check. |
| 9 | **Scheduling** | `agents/publishing-scheduling-agent.js` → `scheduleContent()` | Refuses simulated video or missing narration. Inserts into `publish_schedule` with `publish_time`. |
| 10 | **Publishing** | `processPublishQueue()` every 15 min, or `publishContent()` | Readiness gate → provenance gate → narration gate → `youtube.videos.insert` → `thumbnails.set` → `captions.insert`. Future-dated uploads use `privacyStatus: private` + `publishAt`. |
| 11 | **Analytics** | `schedules/daily-automation.js` 09:00 → `analytics-optimization-agent.js` | For each video published in the last 30 days, for each due window (`24h`, `7d`): views/impressions/CTR, watch time/AVP/AVD, demographics, traffic sources, devices, subscribers, revenue, engagement, retention curve. |
| 12 | **Learning** | `utils/channel-learning-engine.js` + `scene-retention-engine.js` | Snapshots → median baseline → deltas → dimension recommendations (format/length/hook/title), channel recommendations (CTR/retention), outcome recommendations (pillar/format vs KPI), scene-level retention findings. All land as `learning_recommendations` with status `pending`. |
| 13 | **Feedback into planning** | `content-strategy-agent.js` → `researchAndPlanChannel()` | Reads **only approved** learnings and injects them into the planning prompt. Pending/rejected never influence generation. |

### Implementation status of each stage you listed

| Stage | Status |
|---|---|
| Research | ✅ Implemented (live YouTube API + optional AI planner + template fallback) |
| Strategy | ✅ Implemented |
| Topic selection | ✅ Implemented (fallback = evergreen hardcoded list) |
| Script generation | ✅ Implemented (AI + hardcoded template fallback) |
| Narration / TTS | ✅ Implemented (ElevenLabs / OpenAI / Gemini / Azure stubs) |
| Image / visual generation | ⚠️ Partially — OpenAI/Gemini real; Sharp gradient fallback |
| Video assembly | ✅ Implemented (real FFmpeg MP4) |
| Thumbnail | ⚠️ Partially — deterministic Sharp gradient+text, optional AI image |
| SEO metadata | ✅ Implemented (AI + template with placeholders) |
| Fact / provenance review | ✅ Implemented (evidence desk, blocking) |
| Media-rights review | ✅ Implemented (attestation + per-scene upload rights) |
| Human approval | ✅ Implemented (default ON) |
| Scheduling | ✅ Implemented |
| YouTube publishing | ✅ Implemented (real API) |
| Analytics | ✅ Implemented (real YouTube Analytics API) |
| Audience / comment analysis | ✅ Implemented |
| Retention analysis | ✅ Implemented (scene-aware) |
| Learning / recommendations | ✅ Implemented (approval-gated) |
| Experiments | ✅ Implemented (title/thumbnail A/B with statistics) |
| Future content planning | ✅ Implemented (approved learnings → operator plan) |
| Google Drive / cloud storage | ❌ **Not implemented** |
| Multi-channel | ❌ **Not implemented** (single hardcoded channel) |
| TikTok / Instagram publishing | ❌ **Not implemented** (DB column `platform` is a future hook; `DiscoverabilityService.auditProduction` explicitly throws for non-`youtube`) |
| Playlists | ⚠️ README claims "manages playlists"; **no playlist code exists** |

---

## 2. ALL FEATURES

Legend: **F**ull · **P**artial · **FB** fallback-based · **S**imulated · **D**oc-only

### Core pipeline

| Feature | What it does | File | API/Service | Status | Paid? | Works w/o AI? | Limits |
|---|---|---|---|---|---|---|---|
| YouTube trend research | Fetches 50 most-popular videos for a region | `agents/content-strategy-agent.js:50` | YouTube Data API v3 | F | No (free quota) | No (needs YouTube OAuth) | Returns `[]` on any error; region fixed by env |
| Competitor analysis | Pulls last 20 videos per channel ID, keyword→views | `agents/content-strategy-agent.js:78` | YouTube Data API v3 | F | No | No | `COMPETITOR_CHANNELS` env, comma list; silent skip on error |
| AI content strategy | Topic/angle/audience/keywords/views/publish time | `content-strategy-agent.js:423` | Any OpenAI-compatible or Gemini | FB | Yes | Yes → template | Template uses `Math.random()` heuristics |
| AI editorial plan (operator) | N videos with pillar/angle/rationale/source URLs | `content-strategy-agent.js:333` | Same | FB | Yes | Yes → evergreen fallback | Plan capped 1–5 videos/run |
| Script generation | Title, hook, sections, CTA, `claims[]` | `agents/script-writer-agent.js:97` | Same | FB | Yes | Yes → hardcoded templates | Template text is generic filler |
| TTS narration | Whole-script MP3 | `utils/ai-video-generator.js:62` | ElevenLabs → OpenAI `gpt-4o-mini-tts` → Gemini TTS → **simulate** | FB | ElevenLabs/OpenAI yes; Gemini free tier partly | No — **silent/simulated without a TTS key** | Simulation writes `.info`, blocks approval |
| Azure Speech TTS | Credential prompt + `azureSpeechKey` fields exist | `utils/credential-manager.js:382` | — | **D** | Yes | — | **No `generateAzureTTS` implementation exists** |
| Image generation | Scene/thumbnail images | `utils/ai-video-generator.js:219` | OpenAI `gpt-image-2` / Gemini `gemini-3.1-flash-image` | FB | Yes (Gemini images need paid tier) | Yes → `.info` placeholders → slides render gradient slides | Max 5 images/production |
| Gradient fallback visuals | `sharp` SVG gradient slides | `agents/thumbnail-designer-agent.js` | local `sharp` | F | No | Yes | Not photographic |
| Thumbnail | 1280×720 JPEG gradient + bold text | `agents/thumbnail-designer-agent.js:29` | local `sharp` | F | No | Yes | Composition/effects are `Math.random()` |
| AI thumbnail | `gpt-image-2`/Gemini image | `utils/ai-video-generator.js:886` | as above | FB | Yes | Yes | Only invoked from `processThumbnail` |
| SRT captions | 8-words-per-caption timing from script sections | `production-management-agent.js:456` | none (computed) | F | No | Yes | Timing is estimated, not word-aligned |
| Slideshow video | Playwright screenshots → xfade chain → mux audio | `ai-video-generator.js:469` | Playwright Chromium + FFmpeg | F | No | Yes (needs FFmpeg + Chromium) | **Requires `npx playwright install chromium`** |
| Hybrid AI video | Provider clips + local stills, concat, mux narration | `ai-video-generator.js:390` | Seedance/MiniMax/Google/Kling/Wan | F | **Yes** | Yes → slideshow | Capped by `VIDEO_MAX_GENERATED_SECONDS` (default 60) |
| Scene manifest | Per-scene prompt/timing/asset/narration/cost/revision | `utils/scene-repair-service.js` | SQLite | F | No | Yes | Locked once approved/scheduled |
| Scene repair | Edit, reorder, lock, upload asset, regenerate one scene | `utils/scene-repair-service.js` | providers | F | Regeneration yes | Partially | Blocked after approval/schedule |
| Narration repair | Per-scene TTS regen with cost confirmation | `scene-repair-service.js:263` | TTS providers | F | Yes | No | Requires `confirmCost:true` |
| Intentional silence | Operator override w/ ≥10-char reason + confirmation | `scene-repair-service.js:325` | none | F | No | Yes | Visible & reversible |
| Rebuild final video | New MP4 + scene-aware SRT, keeps `previousPath` | `scene-repair-service.js:530` | FFmpeg | F | No | Yes | Blocked if any scene missing/stale/failed |
| Shorts repurposing | 1–5 9:16 drafts, 3 layouts, burned captions | `utils/shorts-repurposing-service.js` | FFmpeg | F | No | Yes | Source must be approved & fully current |
| Provenance / fact desk | Sources + claims, verified-link rule, waivers | `utils/provenance-service.js` | SQLite | F | No | Yes | Max 50 sources / 100 claims |
| Media-rights gate | Fact-check + rights attestations before approval | `index.js:approveContent` | — | F | No | Yes | — |
| Discoverability preflight | GEO/AIO/AEO content audit | `utils/discoverability-adapters/darkzseo.js` | bundled JS (no Python) | F | No | Yes | Advisory only; non-blocking |
| Production readiness | 7 live probes incl. temp MP4 encode/decode | `utils/production-readiness-service.js` | all | F | optional | Yes | Stale after 24h |
| Quality gate | ~14 checks w/ blocking flags | `utils/operator-service.js` | — | F | No | Yes | — |

### YouTube

| Feature | File | Status | Notes |
|---|---|---|---|
| OAuth (loopback) | `modern-auth.js` | F | 5 scopes, `access_type: offline`, `prompt: consent`, random loopback port, 5-min timeout |
| OAuth (manual code) | `utils/credential-manager.js:91` | F | Legacy copy-paste flow |
| Upload | `publishing-scheduling-agent.js:199` | F | `videos.insert` snippet+status |
| Scheduling | same | F | `publishAt` + forced `private` when future |
| Privacy status | same | F | `private`/`unlisted`/`public`; `DEFAULT_PRIVACY_STATUS` |
| Synthetic-media disclosure | same | F | `containsSyntheticMedia` from provenance/scene flags |
| Thumbnail upload | same `:325` | F | `thumbnails.set`; failure logged, non-fatal |
| Caption upload | same `:393` | F | `captions.insert`; failure logged, non-fatal |
| Publishing queue | same `:418` | F | Every-15-min cron, in-memory + DB |
| Retry / reconciliation | same `:278` | F | Unknown-outcome → `reconciliation_required`, fail-closed |
| Metadata validation | `utils/youtube-metadata-validator.js` | F | Title 100 / desc 5000 / tags 450, control-char strip |
| Comments read | `utils/audience-engagement-service.js` | F | `commentThreads.list` paginated, watermark |
| Comment replies | same | F | `comments.insert`, **approval-gated**, daily cap 50 |
| Analytics | `analytics-optimization-agent.js` | F | `youtubeAnalytics.reports.query` |
| Retention curve | same `:772` | F | `audienceWatchRatio` × `elapsedVideoTimeRatio` |
| Playlists | — | **D** | README claims it; **zero playlist code** |
| Live packaging swap | `publishing-scheduling-agent.js:342` | F | `videos.update` + `thumbnails.set`, title rollback on failure |

### Analytics / learning / growth

| Feature | File | Status |
|---|---|---|
| Views / impressions / CTR (daily) | `analytics-optimization-agent.js:201` | F (real API) |
| Watch time / AVP / AVD | `:219` | F |
| Demographics (age/gender) | `:238` | F |
| Traffic sources | `:269` | F |
| Devices | `:293` | F |
| Subscribers gained/lost | `:316` | F (nullable when unavailable) |
| Estimated revenue / CPM / monetized playbacks | `:316` | F (explicitly `null`, never fake 0) |
| Engagement rate | `:350` | F |
| Performance score 0–100 | `:524` | F (heuristic weights) |
| **Simulated analytics** | `:709` | **S** — random numbers, stored `simulated:1`, excluded from learning |
| 24h / 7d windows | `channel-learning-engine.js:454` | F |
| Median baseline + deltas | `:123`–`:144` | F |
| Dimension recommendations | `:185` | F (min 2 videos/group) |
| Outcome/ROI recommendations | `:254` | F (min 4 snapshots, 2/group) |
| Scene-level retention | `scene-retention-engine.js` | F (needs ≥10 curve points + scenes) |
| Controlled experiments | `growth-experiment-service.js` | F (z ≥ 1.96, retention/traffic guardrails) |
| Audience comment themes | `audience-engagement-service.js` | F w/ AI; **FB** mechanical-only w/o AI |
| Audience-requested ideas | same `:refreshAudienceRecommendations` | F (≥3 identical asks, permalink evidence) |
| Keyword performance table | `db.js:2716` | P — written by scheduler's `updateKeywordPerformance`, which reads `analytics_reports.video_details` (the analytics agent stores `videoDetails` there, so it works, but it's fragile) |
| Local activation milestones | `activation-metrics.js` | F |
| Anonymous telemetry | `anonymous-telemetry.js` | F, **off by default**, HTTPS-only, allowlisted events |

---

## 3. AI AGENTS / MODULES

All 7 agents are constructed in `index.js:initializeAgents()` and each `await agent.initialize()`.

### 3.1 ContentStrategyAgent — `agents/content-strategy-agent.js`
- **Purpose:** research → topic + angle + audience + format + predicted performance; also the operator's editorial planner.
- **Input:** `requestedTopic` (or strategy fields from the operator run).
- **Processing:** `fetchYouTubeTrends()` → `analyzeCompetitors()` → `mergeTrendData()`; then either `generateContentStrategyWithAI()` (prompt with top-10 trends) or `selectOptimalTopic()` + `generateAngle()` + `identifyTargetAudience()` + `selectContentType()` + `predictViews()` + `calculateBestPublishTime()`.
- **Output:** `{topic, angle, targetAudience, contentType, keywords, estimatedViews, bestPublishTime, competitorAnalysis, createdAt}` (AI mode adds `researchSources`, `requestedStyle/Length`, `planRationale`, `contentPillar`, brand voice, constraints).
- **AI:** `AITextService` (any configured provider).
- **Storage:** `content_strategies` table.
- **Consumer:** `ScriptWriterAgent.generateScript(strategy)`.

### 3.2 ScriptWriterAgent — `agents/script-writer-agent.js`
- **Purpose:** write hook → sections → CTA and declare verifiable factual claims.
- **Input:** strategy object.
- **Processing:** `generateScriptWithAI()` returns strict JSON; validated by `normalizeAISections/Hook/CTA/Claims`. Fallback: `generateMainContent()` walks a template structure array (`hook, introduction, problem, solution_steps, …`) and calls hardcoded section generators.
- **Output:** `{title, hook, introduction, mainContent:{sections[],totalDuration}, conclusion, callToAction, duration, tone, pacing, keywords, claims[], fullScript}`.
- **Storage:** `scripts` table + `data/scripts/<ts>_script.json`.
- **Consumer:** Thumbnail, SEO, Production, Provenance (`claims`).

### 3.3 ThumbnailDesignerAgent — `agents/thumbnail-designer-agent.js`
- **Purpose:** produce a 1280×720 thumbnail (+ A/B variants for experiments).
- **Input:** script (uses `script.metadata.strategy.contentType`).
- **Processing:** `generateConcept()` → 5 hardcoded style tables; `createThumbnail()` → `sharp` SVG gradient; `addTextOverlay()` → SVG text with shadow; `optimizeForYouTube()` → 1280×720 JPEG q90, re-compress if >2 MB. `generateABVariants()` makes 3 variants (color swap, alt text, centered).
- **AI:** **none** (fully deterministic). `createPrompt()` builds a text prompt that is **never sent anywhere**.
- **Storage:** `thumbnails` table + `uploads/thumbnails/*`.
- **Consumer:** Production (`processThumbnail`), packaging experiments.

### 3.4 SEOOptimizerAgent — `agents/seo-optimizer-agent.js`
- **Purpose:** title, description, tags, hashtags, chapters, end screen, SEO score.
- **Input:** script + strategy.
- **Processing:** `generateSEOWithAI()` or template `optimizeTitle()` / `generateDescription()` / `generateTags()`; hashtags/chapters/end-screen always template.
- **Output:** `{title, description, tags, hashtags, chapters, endScreen, seoScore, metadata}`.
- **Storage:** `seo_data` table (via `saveSEOData`) — note `saveProductionData`/`saveProductionSnapshot` persist the SEO blob used downstream; `seo_data` rows are written but the production bundle reads from `production_snapshots.seo`.
- **Consumer:** Publishing metadata, discoverability audit.

### 3.5 ProductionManagementAgent — `agents/production-management-agent.js`
- **Purpose:** the media factory.
- **Input:** `{strategy, script, thumbnail, seo, jobId}`.
- **Processing:** see §4.
- **Output:** `productionData` with `assets.{script,thumbnail,audio,video(visualAssets),captions,finalVideo,sceneManifest}` + `timeline` + `status` (`ready` | `simulated`).
- **AI:** TTS + image + video providers.
- **Storage:** `productions`, `production_snapshots`, `production_scenes`, `production_scene_revisions` + files under `data/`.
- **Consumer:** quality gate → review → publishing.

### 3.6 PublishingSchedulingAgent — `agents/publishing-scheduling-agent.js`
- **Purpose:** schedule, upload, reconcile, apply packaging.
- **Input:** `productionData` or `contentId`.
- **Processing:** see §6.
- **Storage:** `publish_schedule`; updates `shorts_clips`.
- **Consumer:** scheduler queue, analytics (via `youtube_id`).

### 3.7 AnalyticsOptimizationAgent — `agents/analytics-optimization-agent.js`
- **Purpose:** pull real performance, score it, derive insights, capture learning + retention snapshots.
- **Input:** `videoId` + `measurementWindow`.
- **Output:** `performanceReport` + `learningSnapshot` + `retentionSnapshot`.
- **Storage:** `analytics_reports`, `performance_snapshots`, `retention_snapshots`, `learning_recommendations`.
- **Consumer:** dashboard, `ChannelLearningEngine`, `GrowthExperimentService`, next operator run (approved only).

### 3.8 Non-agent modules that behave like agents

| Module | Purpose | Input → Output |
|---|---|---|
| `AutonomousChannelOperator` | Runs the whole plan loop with resume/cancel | strategy → `{research, plan}` → per-item generation jobs → `waiting_review`/`completed` |
| `OperatorService` | Quality gate + notifications | production + profile → `{passed, score, blockingFailures, checks[]}` |
| `ChannelLearningEngine` | Evidence → recommendations | performanceReport → snapshots + recommendations |
| `SceneRetentionEngine` | Curve → scene verdicts | retention points + scenes → snapshot + recommendation |
| `GrowthExperimentService` | Bounded A/B | productionId → experiment/arms/samples → verdict |
| `AudienceEngagementService` | Comment intelligence | youtubeId → comments/insights/drafts/ideas |
| `ProvenanceService` | Claim/source ledger | script claims → provenance record |
| `DiscoverabilityService` | GEO/AIO/AEO audit | production → audit + findings |
| `ProductionReadinessService` | Preflight | options → readiness run |
| `GenerationRecoveryService` | Checkpoint/retry | jobId + stage + producer → artifact |
| `SceneRepairService` | Scene-level editing | productionId + sceneId → updated scene / rebuilt MP4 |
| `ShortsRepurposingService` | Vertical cuts | productionId → clips / MP4 |
| `AITextService` | Text provider | prompt → text |
| `AIVideoGenerator` | TTS + images + assembly | script/assets/audio → files |
| `MediaGenerationService` | AI video clips | scene plan → MP4 clips + task records |
| `CredentialManager` | Secrets + OAuth | — |
| `ActivationMetrics` / `AnonymousTelemetry` | Milestones | — |

---

## 4. VIDEO GENERATION PIPELINE (exact)

### 4.1 Where each thing is generated

| Artifact | Function | File:line |
|---|---|---|
| Script JSON + TTS text | `processScript()` | `agents/production-management-agent.js:139` |
| Visual prompts (≤5) | `createVisualPromptsFromScript()` | `:661` |
| Images | `AIVideoGenerator.generateVisualAssets()` → `generateImage()` → `generateOpenAIImage()` / `generateGeminiImage()` | `utils/ai-video-generator.js:194/219/233/252` |
| Narration | `generateAudioNarration()` → `AIVideoGenerator.generateTTSAudio()` | `production-management-agent.js:414` / `ai-video-generator.js:62` |
| SRT captions | `generateCaptions()` → `createSRTCaptions()` | `production-management-agent.js:449/462` |
| Final MP4 | `assembleVideo()` → `AIVideoGenerator.generateVideo()` | `production-management-agent.js:565` / `ai-video-generator.js:325` |
| Scene manifest | `SceneRepairService.initializeProduction()` | `production-management-agent.js:98` |

### 4.2 Providers supported

**Video (scene clips)** — `utils/video-providers.js`, registry order `seedance, minimax_h3, google_omni, kling, wan, slideshow`:

| id | Model default | Endpoint | Key env | Clip limits |
|---|---|---|---|---|
| `seedance` | `bytedance/seedance-2.5` | Replicate | `REPLICATE_API_TOKEN` / `REPLICATE_API_KEY` | 4–30 s |
| `minimax_h3` | `MiniMax-H3` | `api.minimax.io/v2/video_generation` | `MINIMAX_API_KEY` | 4–15 s |
| `google_omni` | `gemini-omni-flash-preview` | `@google/genai` interactions | `GEMINI_API_KEY` | 3–10 s |
| `kling` | `kling-v3-omni` | `api.klingai.com/v1/videos/*` (JWT HMAC) | `KLING_ACCESS_KEY` + `KLING_SECRET_KEY` | 3–15 s |
| `wan` | `wan2.7-t2v-2026-06-12` (r2v/i2v variants) | DashScope intl | `DASHSCOPE_API_KEY` | 2–15 s |
| `slideshow` | `local-ffmpeg` | Playwright + FFmpeg | none | ∞ |

**TTS:** ElevenLabs (`xi-api-key` + `ELEVENLABS_VOICE_ID`, model `eleven_v3`) → OpenAI `gpt-4o-mini-tts` (voice `coral`) → Gemini (`GEMINI_TTS_MODEL`, voice `Kore`, raw PCM→FFmpeg) → **simulation**.
**Images:** OpenAI `gpt-image-2` (1536×1024) → Gemini `gemini-3.1-flash-image` (16:9, 1K) → **simulation**.
**Text:** OpenAI-compatible (`openai`, `openrouter`, `kimi`, `mimo`, `glm`) or Gemini via `@google/genai`.

> Note: `generateReplicateVideo()` (`wan-video/wan-2.7-i2v`) exists in `ai-video-generator.js` but **is never called** — dead code. The live Replicate path is Seedance in `video-providers.js`.

### 4.3 How scenes are created

Two independent scene systems:

**A. Scene plan for AI video clips** — `MediaGenerationService.buildScenePlan()`:
- Prompts: Hook, one per `mainContent.sections[].title`, Conclusion (CTA **not** included).
- `maxScenes = floor(VIDEO_MAX_GENERATED_SECONDS / clipDuration)` (default 60/8 = 7 scenes).
- Each scene gets `duration = clipDuration`, `firstFrame = visualAssets[index % n]`, empty `referenceImages`.

**B. Durable scene manifest** — `buildInitialSceneManifest()` in `scene-repair-service.js`:
- Blueprints from `scriptScenes()`: Hook, Introduction, **every** section, Conclusion, Call to action.
- `duration = max(2, round((sceneWords / totalWords) * totalDuration, 2))` — **proportional to word count**.
- `assetPath` = generated provider clip if labels match, else `visualAssets[position % n]` image, else `null` → `status: 'missing_asset'`.

### 4.4 How scene timing works

1. Script section durations come from the AI JSON (`duration: 60`) or hardcoded template values (30/45/60/75/90/120 s).
2. `estimateDuration()` = sum(sections) + 5 (hook) + 15 (intro) + 30 (conclusion) + 15 (CTA) → `"M:SS"` string.
3. `calculateScriptDuration()` (slideshow path) = `max(30, ceil(words/150*60))` — a **different, word-count-based** estimate.
4. Scene manifest: proportional word-count split of `estimatedDuration`.
5. Slideshow: `perSlide = max(2, totalDuration / stills.length)`, 0.5 s xfade overlap, offsets `i*(perSlide-fade)`.
6. Hybrid: provider clip durations are fixed; remaining timeline filled with stills at `max(2, remaining/images)`.
7. `-shortest` on the final mux → video truncated to audio length (or vice-versa).

### 4.5 How audio is synchronized

`addAudioToVideo()` (`ai-video-generator.js:815`):
```
ffmpeg -y [-stream_loop -1 -i video] -i audio -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -shortest out.mp4
```
- Video is **not** re-encoded; audio is transcoded to AAC.
- `-shortest` cuts whichever stream is longer.
- Scene-repair path instead **concatenates** per-scene audio with `aresample=48000, apad, atrim=duration=<scene.duration>, asetpts=PTS-STARTPTS` then `concat=n=N:a=1` → `_scene_mix_<ts>.m4a`.
- If audio is unusable and no `allowSilent` → throws `NARRATION_REQUIRED`.
- If paths collide, muxes to `_muxed.mp4` then renames.

### 4.6 How captions are created

Two generators, both **timing-estimated, not ASR**:
- `createSRTCaptions()` — walks hook (5 s) → intro (15 s) → each section (`section.duration`) → conclusion (30 s), splitting text into 8-word chunks with interpolated start/end.
- `SceneRepairService.buildSRT()` — per-scene, 8-word groups, `perGroup = scene.duration / groups`.
- Shorts: `buildCaptions()` — 7-word chunks across the clip duration; the SRT is **burned in** by FFmpeg's `subtitles=` filter with `FontName=Arial, FontSize=18, Outline=3, Alignment=2, MarginV=170`.
- Uploaded to YouTube via `captions.insert` (failure logged, non-fatal).

### 4.7 How FFmpeg is used

`utils/ffmpeg.js` resolves the binary: `FFMPEG_PATH` → `ffmpeg-static` (optional dep) → `ffmpeg` on PATH. `getFFprobePath()` falls back to parsing `Duration:` from `ffmpeg -i` stderr (because ffmpeg-static ships no ffprobe).

Usages:
| Operation | Filter/args |
|---|---|
| Slide stills → video | `-loop 1 -t <perSlide> -framerate 30 -i still` × N + chained `xfade=transition=fade:duration=0.5:offset=<i*(perSlide-0.5)>` + `format=yuv420p` |
| Hybrid timeline | `scale=1920:1080:force_original_aspect_ratio=decrease,pad=…:black,fps=30,format=yuv420p,trim=duration=…,setpts=PTS-STARTPTS` then `concat=n=N:v=1:a=0` |
| Mux audio | `-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -shortest` |
| Gemini PCM → MP3 | `-f s16le -ar 24000 -ac 1 -i x.pcm out.mp3` |
| Scene audio split | `-ss <start> -t <dur> -i audio -vn -c:a libmp3lame out.mp3` |
| Scene audio mix | `aresample=48000,apad,atrim=duration=…,asetpts=PTS-STARTPTS` + `concat=n=N:v=0:a=1` |
| Shorts | `scale/crop/boxblur/overlay` + `subtitles='<srt>':force_style=…` → libx264 crf 21 veryfast +faststart |
| Validity check | `ffmpeg -v error -i file -f null -` |
| Readiness probe | lavfi color + sine → mpeg4/aac, then decode-verify + `ftyp` signature check |

### 4.8 Where the final MP4 is created

```
data/videos/<productionId>_final.mp4                       (first assembly)
data/videos/<productionId>_repair_<timestamp>.mp4          (after Scene Repair rebuild)
data/videos/<productionId>_<provider>_<NN>.mp4             (AI provider scene clips)
data/videos/<productionId>_hybrid_visual.mp4               (temp, deleted)
data/videos/<productionId>_visual.mp4                      (temp slideshow visual, deleted)
data/videos/slides/slide_000.png …                         (temp, deleted)
data/videos/<productionId>_repair_<timestamp>_visual.mp4   (temp, deleted)
data/videos/scenes/<productionId>_<sceneId>_r<N>.mp4
data/shorts/<productionId>/<clipId>.mp4                    (9:16 Shorts)
```
Production agent also pre-creates `data/production`, `data/assets`, `data/videos`, `data/audio`, `data/scripts`, `temp/processing`.

### 4.9 Is the MP4 real or simulated?

**Real** whenever FFmpeg exists and narration is usable. The only "simulation" artifacts are:
- `<final>.mp4.assembly.json` — JSON describing what would have been built (`simulateVideoAssembly`)
- `<audio>.mp3.info` — JSON describing the TTS call (`simulateTTSGeneration`)
- `data/assets/visual_sim_<ts>_<i>.info`
- `uploads/thumbnails/thumbnail_sim_<ts>.info`

`assembleVideo()` explicitly checks `path.extname(producedPath) !== '.mp4'` → treats anything else as simulated. `status` becomes `'simulated'` and `scheduleContent()` refuses it.

### 4.10 Failure behaviour

| Failure | Behaviour |
|---|---|
| **AI provider fails (text)** | `generateContentStrategyWithAI` / `generateScriptWithAI` / `generateSEOWithAI` catch → template fallback; job continues. |
| **Image provider fails** | `generateVisualAssets` catch → `simulateVisualAssets()` `.info` files; slideshow then uses gradient slides. |
| **AI video provider fails** | `generateVideo()` catch → `generateSlideshowVideo()`; if that also fails → `simulateVideoGeneration()` and `lastVideoResult.actualProvider='simulation'`. Task row marked `failed` with `safeModelError()` (redacts `Bearer`, `api_key=`, `token=`). |
| **Narration fails** | `generateAudioNarration()` catch → `simulateAudioGeneration()` writes `.info`; `audio.simulated = true`; `assembleVideo()` **blocks** assembly and returns `simulateVideoAssembly(…, 'Narration is missing')`. |
| **One scene fails (repair)** | Scene → `status:'failed'`, revision recorded with error, `narrationStatus:'failed'`; `rebuild()` refuses while any scene is failed/generating/missing. |
| **FFmpeg missing** | `checkFFmpeg()` false → `generateSlideshowVideo` throws `ffmpegInstallHint()`; capability check prints ✗; no MP4 at all. |
| **Provider times out** | `MediaGenerationService` throws `MEDIA_PROVIDER_TIMEOUT` after `VIDEO_PROVIDER_TIMEOUT_MS` (default 1 h); task marked `failed`; outer catch → slideshow. |
| **Job cancelled** | `updateJobStage` throws `JOB_CANCELLED` between stages; `assertNotCancelled` cancels the remote task if the provider supports it; job → `cancelled`. |
| **Restart mid-run** | `markInterruptedJobs()` flips queued/running → `interrupted`; `POST /api/jobs/:id/resume` continues from the first incomplete checkpoint. |

### 4.11 Can a production be resumed?

**Yes, at two levels.**
1. **Generation job** — `generation_checkpoints` (PK `job_id, stage`) stores the full artifact JSON for `strategy`, `script`, `thumbnail`, `seo`, `production`, `quality_review`. `resumePoint()` returns the first non-completed stage; `resetFrom(stage)` deletes that stage and later ones so you can deliberately regenerate. Completed checkpoints are **validated** before reuse (`validateArtifact` — e.g. `production` requires `assets.finalVideo.path` to still exist on disk); invalid ones are deleted and downstream checkpoints dropped.
2. **Operator run** — `operator_runs.research` / `.plan` / `.generatedJobs` persist, so `resume()` skips research and completed plan items and resumes failed generation jobs.

Not resumable: an individual FFmpeg command (no partial state), and an in-flight provider poll loop beyond the persisted `external_task_id` (which **is** reused: `generateClip` re-polls an existing `media_generation_tasks.external_task_id` instead of resubmitting).

---

## 5. STORAGE

### 5.1 Where everything lives

| Data | Path | Backend | Persistent? |
|---|---|---|---|
| **SQLite DB** | `data/youtube_automation.db` | SQLite (`sqlite3`) | Yes |
| **DB backups** | `data/backup_<epoch>.db` (weekly, Sat 03:00) | file copy | Yes, **never pruned** |
| **Scripts** | `data/scripts/<epoch>_script.json` + `_tts.txt` | filesystem | Yes |
| **Script metadata** | `scripts`, `production_snapshots.script` | SQLite | Yes |
| **Images** | `data/assets/visual_<epoch>_<i>.png` (or `.info`) | filesystem | Yes |
| **Thumbnails** | `uploads/thumbnails/thumbnail*_<epoch>.png/.jpg` (+ `_sim_*.info`) | filesystem | Yes (but `uploads/` is gitignored and cleaned >30 d) |
| **Narration** | `data/audio/<productionId>_narration.mp3` (+ `.info`) | filesystem | Yes |
| **Scene audio** | `data/audio/scenes/<productionId>/<NNN>_r<N>.mp3` | filesystem | Yes |
| **Scene mix** | `data/audio/<productionId>_scene_mix_<epoch>.m4a` | filesystem | Yes |
| **Final video** | `data/videos/<productionId>_final.mp4`, `…_repair_<epoch>.mp4` | filesystem | Yes |
| **Provider clips** | `data/videos/<productionId>_<provider>_<NN>.mp4` | filesystem | Yes |
| **Scene assets (uploads)** | `data/scene-assets/<productionId>/<sceneId>_r<N>.<ext>` | filesystem | Yes |
| **Captions** | `data/captions/<productionId>_captions.srt`, `…_repair_<epoch>.srt` | filesystem | Yes |
| **Shorts** | `data/shorts/<productionId>/<clipId>.mp4` + `.srt` | filesystem | Yes |
| **Scene manifests / revisions** | `production_scenes`, `production_scene_revisions` | SQLite | Yes |
| **Production records** | `productions`, `production_snapshots`, `content_reviews`, `content_provenance` | SQLite | Yes |
| **Publishing info** | `publish_schedule` (incl. `youtube_id`, `youtube_url`, `metadata` JSON with asset paths, privacy, synthetic flag) | SQLite | Yes |
| **Analytics** | `analytics_reports`, `performance_snapshots`, `retention_snapshots`, `learning_recommendations`, `growth_experiments`, `experiment_arms`, `experiment_samples`, `engagement_insights`, `audience_comments`, `reply_drafts`, `keyword_performance` | SQLite | Yes |
| **Jobs / checkpoints / media tasks** | `generation_jobs`, `generation_checkpoints`, `media_generation_tasks` | SQLite | Yes |
| **Credentials** | `config/credentials.json`, `config/tokens.json` | filesystem, **plaintext** | Yes |
| **Logs** | `logs/combined.log`, `logs/error.log`, `logs/<component>.log` | filesystem | Yes |
| **Temp** | `temp/processing/`, `os.tmpdir()/yaa-readiness-*` | filesystem | Deleted (readiness) / cleaned >7 d |
| **Readiness probes** | `os.tmpdir()/yaa-readiness-*` | filesystem | **Deleted after every run** |

### 5.2 What happens to files after YouTube upload?

**Nothing is deleted.** `publishContent()` only flips the schedule row to `published` and records `youtube_id`/`youtube_url`. The MP4, audio, captions, thumbnails, scene manifest and DB rows all stay on disk forever. The only automatic cleanup is:
- `cleanupOldFiles()` in the scheduler → deletes files older than **7 days** in `temp/` and **30 days** in `uploads/` (thumbnails live in `uploads/thumbnails/` — so a thumbnail referenced by a published video can be deleted from disk after 30 days; YouTube keeps its own copy, but local re-publishing/experiment arm reuse would then fail).
- `cleanOldAnalytics()` → deletes `analytics_reports` older than 90 days.
- Readiness temp dirs are removed after each run.

There is **no** Google Drive / S3 / cloud storage integration anywhere.

---

## 6. YOUTUBE INTEGRATION

### 6.1 OAuth

Two flows, both writing the same files:
- **`walkthrough.js` → `modern-auth.js`** (recommended): reads `config/credentials.json`, resolves the redirect URI (env `YOUTUBE_REDIRECT_URI` → configured `redirect_uris`, **skipping** legacy `http://localhost:8080/oauth2callback`), spins a temporary `http` server on the exact host:port, opens the browser, exchanges the code, writes `config/tokens.json`, shuts down. 5-minute timeout.
- **`credential-manager.js`**: manual copy-paste of the auth code.

**Required scopes** (identical in both):
```
https://www.googleapis.com/auth/youtube.upload
https://www.googleapis.com/auth/youtube
https://www.googleapis.com/auth/youtube.readonly
https://www.googleapis.com/auth/yt-analytics.readonly
https://www.googleapis.com/auth/youtube.force-ssl
```
Requested with `access_type: 'offline'` (refresh token) and `prompt: 'consent'`.

**Credentials:** Google Cloud project → enable YouTube Data API v3 → **Desktop app** OAuth client → save JSON as `config/credentials.json`. Both files are gitignored.

**Token handling:** `getYouTubeAuth()` builds a fresh `google.auth.OAuth2` per call and `setCredentials(this.tokens.youtube)`. `googleapis` auto-refreshes in memory, but **the refreshed token is never written back to `config/tokens.json`** — so after a process restart you fall back to the persisted refresh token (works, but the on-disk token can go stale/revoked without notice).

`hasYouTubeScope(scope)` gates comment posting: without `youtube.force-ssl` the Engagement studio runs read-and-draft only.

### 6.2 Upload / scheduling / privacy

`uploadToYouTube()`:
1. `assertValidYouTubeMetadata(metadata.seo)` → throws `INVALID_YOUTUBE_METADATA` on errors (warnings only logged).
2. `futureSchedule = publishTime > now + 60s` (unless `publishNow`).
3. Body: `snippet{title, description, tags, categoryId, defaultLanguage, defaultAudioLanguage}` + `status{privacyStatus: futureSchedule ? 'private' : requested, selfDeclaredMadeForKids: false, containsSyntheticMedia}`; `publishAt` added when future.
4. `scheduleEntry.uploadAttempted = true` is set **after** the stream is successfully opened but **before** the network call — this is what makes the unknown-outcome path reliable.
5. `youtube.videos.insert({part:'snippet,status', media:{body: createReadStream}})`
6. Then `thumbnails.set(videoId, …)` and `captions.insert(…)` — both wrapped in try/catch and **non-fatal**.
7. `getVideoStream()` refuses any non-`.mp4` or missing file ("refusing to upload placeholder").

### 6.3 Queue / retry / reconciliation

- `publish_schedule` rows with `status IN ('scheduled','paused')` are the queue; `getPublishQueue()` orders by `publish_time`.
- `processPublishQueue()` runs every 15 min; publishes entries whose `publishTime <= now`; continues past failures.
- **Duplicate protection:** if `scheduleEntry.youtubeId` exists → `reconcileUploadedVideo()` (verify via `videos.list`) instead of uploading again. Already `published` → returns immediately.
- **Unknown outcome:** if `uploadAttempted` and the error has no status or status ≥ 500 → `status='reconciliation_required'` + `UPLOAD_OUTCOME_UNKNOWN` (409). Further attempts are blocked until reconciliation passes.
- `READINESS_BLOCKED` (409) is swallowed in the queue loop with a warning.
- Provenance gate: `PROVENANCE_BLOCKED` (409) unless `provenance.status` is `verified` or `not_required`.
- Narration gate: `NARRATION_REQUIRED` (409).

### 6.4 Quota handling

**There is no quota accounting.** The only mitigation is the README's advice to reduce posting frequency, a 2-second `sleep` between analytics videos, a 2-second delay between engagement syncs, and the 15-min publish cadence. `videos.insert` costs ~1600 units; a default 10,000/day quota allows ~6 uploads/day.

### 6.5 Automatic vs human-approval

| Automatic | Human approval required |
|---|---|
| Trend/competitor research | Content approval (`approval_required` default `true`) |
| Script/thumbnail/SEO/production | Factual review + media-rights attestation |
| Scheduling of approved content | Publishing when `approval_required=false`? **No** — approval is still needed to reach `scheduled`; only the *scheduler* then uploads without a further click |
| Publishing at `publish_time` (if approved) | Any change to live title/thumbnail (experiment arms, winner adoption) |
| Comment sync + analysis | Every reply draft |
| Analytics collection + snapshotting | Every learning recommendation before it affects planning |
| Experiment metric sampling | Experiment plan approval, start, and winner adoption |
| — | Intentional-silence override (reason ≥10 chars + confirmation) |
| — | Paid scene/video regeneration (`confirmPaid`) |
| — | Paid readiness probes (`includePaidMedia` / `includePaidVideo`) |

---

## 7. AUTONOMOUS CHANNEL OPERATOR

**Files:** `utils/autonomous-channel-operator.js` (loop) + `index.js` (`startGenerationJob`, `resumeGenerationJob`, `waitForGenerationJob`, `queueScheduledContent`) + `agents/content-strategy-agent.js#researchAndPlanChannel`.

```
PUT /api/operator/strategy      → channel_strategies (objective, audience, pillars,
                                  cadencePerWeek, videosPerRun, defaultFormat/Length,
                                  primaryKpi, targetValue, targetWindowDays,
                                  monthlyBudget, outcomeCurrency, constraints, status)
        ↓ status must be 'active'
POST /api/operator/start        → createOperatorRun()  [status=queued]
        ↓
  execute(runId, strategy)
    ├─ stage 'researching'  → researchAndPlanChannel(strategy)
    │      • analyzeTrends()               (YouTube mostPopular + competitors)
    │      • recent topics (last 90 days, from content_strategies)
    │      • approved learnings (listLearningRecommendations status=approved)
    │      • build sourceCatalog (≤30 URLs) + evidence labels
    │      • generateAutonomousPlanWithAI() → normalizeAutonomousPlan()
    │          (source URLs filtered to the catalog; pillars/format/length validated)
    │      • if short → buildFallbackAutonomousPlan() (evergreen)
    ├─ stage 'planning'     → persist research + plan
    ├─ for each plan item (index 0..n-1)
    │      • createContentIdea(status='generating')
    │      • startGenerationJob({topic, style, length, source:'autonomous_operator',
    │                            strategyContext:{angle, rationale, pillar, audience,
    │                            objective, valueProposition, constraints,
    │                            researchSources: only selected URLs}})
    │      • waitForGenerationJob(jobId)  ← blocks until finished
    │      • record {jobId, ideaId, status, productionId, reviewStatus, error}
    │      • resume failed jobs on retry; skip completed ones on resume
    ├─ status = failed | waiting_review | completed_with_issues | completed
    └─ notify(...)
```

**Resume:** `POST /api/operator/runs/:runId/resume` — reuses stored `research` and `plan`, skips items whose job is `completed`, resumes `failed`/`interrupted` jobs. **Cancel:** sets `cancelRequested` on the run and on every live generation job.

**Cadence gate:** the 06:00 scheduler calls `queueScheduledContent()`; if a strategy is `active` it counts completed `autonomous_operator` jobs in the last 7 days and launches an operator run only if below `cadence_per_week` (and at most 1 day since last generation). Otherwise it falls back to the original single-video topic flow.

**Automatic vs mandatory approval:** everything up to a finished MP4 is automatic. The run always ends in `waiting_review` when `approval_required` is true — the operator **never** approves, schedules, or publishes. Publishing still requires the readiness gate, provenance gate, narration gate and (if `approval_required=false`) an explicit approval in the dashboard.

---

## 8. ANALYTICS AND LEARNING

### 8.1 What is collected

From **YouTube Analytics API v2** (`ids: 'channel==MINE'`, `filters: video==<id>`):

| Metric group | Metrics | Window |
|---|---|---|
| Views | `views, impressions, impressionClickThroughRate` by `day` | 24h / 7d / rolling |
| Watch time | `estimatedMinutesWatched, averageViewDuration, averageViewPercentage` | same |
| Retention curve | `audienceWatchRatio, relativeRetentionPerformance, startedWatching, stoppedWatching, totalSegmentImpressions` by `elapsedVideoTimeRatio` | same |
| Demographics | age groups + gender | same |
| Traffic sources | source percentages | same |
| Devices | device types | same |
| Outcomes | `subscribersGained, subscribersLost`; `estimatedRevenue, monetizedPlaybacks, playbackBasedCpm` (with `currency`) | same |
| Engagement | computed from Data API `statistics` (likes + comments)/views | same |
| Content attributes | from `getPublishedContentContext()`: strategy, script, thumbnail concept, production cost from scene records, scene timeline | — |

`measurementPeriod(publishedAt, window)` computes the exact start/end dates for `24h` and `7d`; `getDueMeasurementWindows(video)` decides which are due.

### 8.2 Snapshots

`performance_snapshots` (UNIQUE `video_id, measurement_window`) stores `metrics` (views, impressions, ctr, retention, AVD, watchMinutes/Hours, engagementRate, performanceScore, subscribers gained/lost/net, estimatedRevenue, CPM, RPM, productionCost, netRevenue, roi …), `contentAttributes` (topic, pillar, surface, format, length, hookLength, titleLength, thumbnailStyle, provider, source), `baseline` (channel **median**), `deltas` (% vs baseline), `confidence` (`unverified` when simulated, else high/medium/low from impressions+views), `simulated`.

`retention_snapshots` stores the 100 curve points (with `elapsedSeconds`), per-scene `sceneMetrics`, a `summary`, and `confidence`. Separate `surface` for long_form vs shorts.

### 8.3 How analytics influence content

1. `ChannelLearningEngine.refreshRecommendations()` builds candidates from `buildDimensionRecommendations` (format/length/hook/title, min 2 videos per group and a minimum gap), `buildChannelRecommendations` (CTR < 4% → packaging experiment; AVP < 35% → tighten hooks), `buildOutcomeRecommendations` (pillar/format vs the configured KPI, needs ≥4 snapshots and ≥2 per group and ≥20% relative difference), plus `SceneRetentionEngine` scene findings and `AudienceEngagementService` audience-demand ideas.
2. Each becomes a `learning_recommendations` row, **status `pending`**.
3. `POST /api/learning/recommendations/:id/approve|reject` — only `approved` ones are read by `researchAndPlanChannel()` and injected into the planning prompt as explicit constraints.
4. An approved `packaging` recommendation with `proposedChange.experiment === 'title_thumbnail_variant'` triggers `preparePackagingExperiment()` → 3 title variants + 3 thumbnail variants stored in `editorData`, shown in Review Studio; the operator picks one, and only that combination is handed to the publishing queue.
5. `POST /api/experiments` → controlled A/B on the **live** video; winner adoption requires a separate confirmation and then creates a new approved learning.

**Can it change strategy automatically?** **No.** Every recommendation stays `pending` until a human approves it. There is no code path that edits `channel_strategies` from analytics.

---

## 9. APPROVAL AND SAFETY GATES

| Gate | Enforced in | Blocks |
|---|---|---|
| **Setup mode** | `index.js:initialize` | Everything (503 on `/generate`) |
| **Production readiness** | `ProductionReadinessService.assertReady` + `publishContent` | Automated generation & all publishing when the last run `status==='failed'` |
| **Quality checks** | `OperatorService.runQualityChecks` | Approval when any blocking check fails |
| **Simulated-video protection** | `scheduleContent`, `approveContent`, `getVideoStream`, `ActivationMetrics.validRealVideo` | Scheduling/approval/upload of anything that isn't a real `.mp4` with an `ftyp` signature |
| **Narration validation** | `isNarrationReady`, `assembleVideo`, `addAudioToVideo`, scene rebuild | Assembly, approval, scheduling, publishing |
| **Intentional silence** | `setSilenceOverride` | Requires `confirmed:true` + reason ≥10 chars + `silenceConfirmedAt`; recorded in revision history; reversible |
| **Fact checking / provenance** | `ProvenanceService.build` + `publishContent` | Publishing unless every claim is `supported` (linked to a **verified** source) or `waived` (with a reviewer note). A `supported` claim with no verified source throws. |
| **Media rights** | `approveContent` (`rightsConfirmed`), `replaceAsset` (`RIGHTS_CONFIRMATION_REQUIRED`), scene integrity check | Approval and rebuild |
| **Scene integrity** | `runQualityChecks` `scene_integrity` / `scene_rights` | Approval while any scene is missing/generating/failed/stale/needs_rebuild, or an uploaded asset lacks rights |
| **Human approval** | `approve_required` setting (default `true`), `approveContent` | Scheduling/publishing |
| **Publishing approval** | `POST /publish/:contentId` | 409 unless review_status is `approved` (or a Short is scheduled/uploading) |
| **YouTube metadata validity** | `assertValidYouTubeMetadata` | Upload on errors |
| **Experiment approval** | `GrowthExperimentService.approve/start/adoptWinner` | Live packaging changes; each step needs `confirmed:true` |
| **Reply approval** | `approveReplyDraft` | Posting; needs scope + daily cap |
| **Brand policy** | `runQualityChecks` `brand_policy` | Approval when text matches `bannedTopics` |
| **Discoverability** | `runQualityChecks` `discoverability` | **Non-blocking** (`blocking=false`) — CRITICAL/HIGH findings are advisory |
| **Duplicate topic** | `runQualityChecks` `duplicate_topic` | **Non-blocking** |

---

## 10. AI PROVIDER MATRIX

### Text (script/strategy/SEO/planning/comment analysis)

| Provider | Model(s) | Key env | Free/Paid | Used for | Fallback |
|---|---|---|---|---|---|
| OpenAI | `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna` | `OPENAI_API_KEY` | Paid | strategy, script, SEO, plan, comment analysis | template generators |
| OpenRouter | `openai/gpt-5.6-sol`, `anthropic/claude-fable-5`, `google/gemini-3.7-flash`, `moonshotai/kimi-k3`, `z-ai/glm-5.3` | `OPENROUTER_API_KEY` | Pay per model | same | same |
| Google Gemini | `gemini-3.7-flash`, `gemini-3.1-pro-preview`, `gemini-3.5-flash-lite` | `GEMINI_API_KEY` | Free tiers vary | same | same |
| Kimi (Moonshot) | `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6` | `MOONSHOT_API_KEY` | Paid | same | same |
| MiMo (Xiaomi) | `mimo-v2.5-pro`, `mimo-v2.5` | `MIMO_API_KEY` | Paid | same | same |
| GLM (Zhipu) | `glm-5.3`, `glm-5.2`, `glm-5.1` | `GLM_API_KEY` | Paid | same | same |
| Anthropic Claude | `claude-fable-5` (string only) | — | — | **Only selectable via OpenRouter.** No SDK dependency. | — |
| Ollama / local | — | — | — | **Not implemented** (README mentions it) | — |

Priority in `AITextService._init`: explicit `credentials.aiProvider` → env scan in `PROVIDERS` order (openai, openrouter, kimi, mimo, glm) → Gemini → none.

### Image

| Provider | Model | Key | Free/Paid | Fallback |
|---|---|---|---|---|
| OpenAI | `gpt-image-2` (1536×1024, high) | `OPENAI_API_KEY` | Paid | `.info` placeholder → gradient slides |
| Google Gemini | `gemini-3.1-flash-image` (16:9, 1K) | `GEMINI_API_KEY` | **Paid tier required** | same |
| *(none)* | `sharp` SVG gradient + text | — | Free | — (this is the real default for thumbnails) |

### TTS

| Provider | Model / voice | Key | Free/Paid | Fallback |
|---|---|---|---|---|
| ElevenLabs | `eleven_v3`, `ELEVENLABS_VOICE_ID` | `ELEVENLABS_API_KEY` | Paid | OpenAI TTS |
| OpenAI | `gpt-4o-mini-tts`, voice `coral` | `OPENAI_API_KEY` | Paid | Gemini TTS |
| Google Gemini | `gemini-3.1-flash-tts-preview`, voice `Kore` | `GEMINI_API_KEY` | Free tier partly | **simulation** (`.info`) |
| Azure Speech | — | `AZURE_SPEECH_KEY` | Paid | **Credential prompt only — no implementation** |

### Video

| Provider | Model | Key | Free/Paid | Fallback |
|---|---|---|---|---|
| Seedance 2.5 (Replicate) | `bytedance/seedance-2.5` | `REPLICATE_API_TOKEN` | Paid | slideshow |
| MiniMax H3 | `MiniMax-H3` | `MINIMAX_API_KEY` | Paid | slideshow |
| Google Omni Flash | `gemini-omni-flash-preview` | `GEMINI_API_KEY` | Paid | slideshow |
| Kling 3.0 Omni | `kling-v3-omni` | `KLING_ACCESS_KEY`+`KLING_SECRET_KEY` | Paid | slideshow |
| Alibaba Wan 2.7 | `wan2.7-{t2v,r2v,i2v}-*` | `DASHSCOPE_API_KEY` | Paid | slideshow |
| Local slideshow | Playwright + FFmpeg | — | **Free (default)** | simulation |

`VIDEO_PROVIDER=slideshow` is the DB/env default, so **no paid video request ever happens unless you change it**.

---

## 11. SCHEDULER

`schedules/daily-automation.js`, started from `index.js` (`new DailyAutomation(...).initialize()`), also runnable standalone (`npm run scheduler`). Uses `node-cron` with `{scheduled:false}` then `.start()` on each.

| Task | Cron | What it does |
|---|---|---|
| `daily-content-generation` | `0 6 * * *` | `shouldGenerateContentToday()` → buffer check (`content_buffer_days`, default 3) + frequency/cadence check → `queueScheduledContent()` (operator run if strategy active, else single job) |
| `publish-queue-processing` | `*/15 * * * *` | `publishing.processPublishQueue()` |
| `daily-analytics` | `0 9 * * *` | Videos published in last 30 days × due windows (`24h`, `7d`), 2 s apart |
| `weekly-strategy-review` | `0 8 * * 0` (Sun) | `getRecentAnalytics(7)`, `generateWeeklyInsights`, `optimizeExistingContent`, `updateKeywordPerformance`, `cleanupOldFiles` |
| `daily-optimization` | `0 22 * * *` | `optimizePublishTimes()` on the publishing agent |
| `database-maintenance` | `0 3 * * 6` (Sat) | `db.backup()`, stats, prune `analytics_reports` >90 d |
| `audience-engagement-sync` | `0 */4 * * *` | `engagement.syncDueVideos()` |
| `growth-experiment-refresh` | `30 */4 * * *` | `experiments.refreshDue()` |
| health check | `setInterval` | `performHealthCheck()` (DB, YouTube, FFmpeg, disk) |

**Timezone handling:** cron runs in the **server's local timezone**. `channel_timezone` setting (default `America/Chicago`) is stored and used by the dashboard to *present* schedules (`toLocalInput`), and `channel_profiles.timezone` is seeded from `CHANNEL_TIMEZONE`. **No timezone conversion happens when computing publish times** — `calculatePublishTime()` uses `new Date()` + `setHours(14,0,0,0)` in server-local time.

**Scheduled videos in the DB:** `publish_schedule` row — `id`, `production_id`, `title`, `publish_time` (ISO), `status` (`scheduled|paused|uploading|uploaded|published|failed|reconciliation_required`), `priority`, `metadata` (JSON: seo, thumbnail, video, audio, captions, privacyStatus, containsSyntheticMedia, contentType, sourceProductionId, shortClipId), `youtube_id`, `youtube_url`, `published_at`, `error_message`, `created_at`.

**Rescheduling:** `PATCH /api/content/:id/schedule` → `rescheduleContent()` — must be a future time; blocked while `uploading|uploaded|published|reconciliation_required`; re-adds to the in-memory queue and re-sorts. `DELETE .../schedule` → `deleteScheduledContent()` (deletes the row, keeps the production, resets a linked Short to `rendered`). `POST .../publish-now` → `emergencyPublish()` → `publishContent({publishNow:true})` which uses the **requested** privacy status instead of forcing `private`.

**Pause/resume automation:** `POST /api/automation/pause|resume` toggles `scheduler.isEnabled` and persists `automation_paused` (restored at startup).

---

## 12. DATABASE

**File:** `data/youtube_automation.db` (SQLite, `sqlite3` driver, `CREATE TABLE IF NOT EXISTS` on every boot, plus `ensureColumns` migrations). No migrations framework, no foreign-key enforcement pragma.

| Table | Purpose / key fields | Written by | Read by |
|---|---|---|---|
| `content_strategies` | topic, angle, target_audience, content_type, keywords, estimated_views, best_publish_time, competitor_analysis | ContentStrategyAgent | ScriptWriter, duplicate-topic check, research |
| `scripts` | title, hook, introduction, main_content, conclusion, call_to_action, full_script, duration, tone, pacing, keywords | ScriptWriterAgent | SEO, Production |
| `thumbnails` | path, concept, prompt, dimensions, file_size | ThumbnailDesignerAgent | Production, experiments |
| `seo_data` | title, description, tags, hashtags, chapters, end_screen, seo_score | SEOOptimizerAgent | (mostly superseded by `production_snapshots.seo`) |
| `productions` | status, **assets (JSON)**, **timeline (JSON)**, scheduled_publish_time, priority, estimated_duration | ProductionManagementAgent | everything |
| `publish_schedule` | see §11 | Publishing agent | dashboard, queue, analytics |
| `analytics_reports` | video_id, youtube_id, video_details, analytics_data, thumbnail_metrics, seo_metrics, insights, performance_score/grade | Analytics agent | dashboard, keyword perf |
| `performance_snapshots` | measurement_window, metrics, content_attributes, baseline, deltas, confidence, simulated | ChannelLearningEngine | learning, outcome studio |
| `learning_recommendations` | fingerprint (UNIQUE), category, title, rationale, evidence, proposed_change, confidence, **status** | Learning/Retention/Engagement engines | strategy planner, dashboard |
| `growth_experiments` | production_id, video_id, recommendation_id, status, arm_duration_hours, min_impressions, guardrails, current/winning arm, result | GrowthExperimentService | dashboard |
| `experiment_arms` | arm_index, label, title, thumbnail_path, is_control, status, baseline_metrics, final_metrics, result | GrowthExperimentService | evaluation |
| `experiment_samples` | arm_id, metrics, traffic_sources, captured_at | GrowthExperimentService | evaluation |
| `retention_snapshots` | video_id, production_id, short_clip_id, surface, measurement_window, duration_seconds, **points**, **scene_metrics**, summary, confidence | SceneRetentionEngine | dashboard, API |
| `audience_comments` | comment_id (UNIQUE), video_id, parent, author, text, like/reply counts, flags, analysis_state, replied_by_agent | AudienceEngagementService | analysis, replies |
| `engagement_insights` | video_id (UNIQUE), comment_count, analyzed_count, sentiment, themes, attention_flags, analysis_method | AudienceEngagementService | dashboard |
| `reply_drafts` | comment_id (UNIQUE), draft_text, edited_text, status, posted_comment_id, failure_reason | AudienceEngagementService | dashboard |
| `keyword_performance` | keyword (UNIQUE), total_uses/views, average_views, best_performing_video, performance_score | scheduler | SEO agent |
| `content_history` | title, topic, content_type, publish_date, views, likes, comments, watch_time, ctr, retention_rate, performance_score | *(legacy — nothing writes it in the current flow)* | — |
| `automation_events` | event_type, status, data | scheduler / ActivationMetrics | dashboard |
| `generation_jobs` | topic, style, length, source, status, stage, progress, production_id, title, error, **details**, cancel_requested | index.js | dashboard, recovery |
| `generation_checkpoints` | **PK (job_id, stage)**, status, **artifact**, attempt_count, error | GenerationRecoveryService | resume |
| `media_generation_tasks` | **UNIQUE (job_id, scene_index, provider)**, model, external_task_id, status, request, provider_data, output_path, error | MediaGenerationService | resume/reuse |
| `production_snapshots` | **PK production_id**, strategy/script/thumbnail/seo JSON | index.js | bundle assembly |
| `content_reviews` | **PK production_id**, status, editor_data, quality_checks, review_notes, reviewed_at | index.js | approval, dashboard |
| `content_provenance` | **PK production_id**, sources, claims, contains_synthetic_media, status, summary | ProvenanceService | gates |
| `discoverability_audits` | production_id, platform, mode, engine(+version), schema_version, status, summary | DiscoverabilityService | dashboard |
| `discoverability_findings` | audit_id, rule_id, category, severity, applicability, message, remediation, fingerprint, **review_status/reason** | DiscoverabilityService | dashboard |
| `production_scenes` | **UNIQUE (production_id, position)** + ~35 fields (script_text, prompt, duration, asset_*, narration_*, provider, status, revision, locked, rights_confirmed, costs, provenance_source_ids) | SceneRepairService | quality gate, rebuild |
| `production_scene_revisions` | scene_id, action, before/after state, cost_evidence, error | SceneRepairService | review UI |
| `shorts_clips` | **UNIQUE (production_id, position)** + title/description/tags/source_scene_ids/start_seconds/duration/layout/rationale/status/output_path/captions_path/publish_time/privacy_status/inherited_evidence/schedule_id/youtube_* | ShortsRepurposingService | review UI, publishing |
| `channel_profiles` | channel_name, goal, target_audience, brand_voice, default_style, call_to_action, **banned_topics**, visual_style, timezone | `PUT /api/profile` | quality gate, prompts |
| `content_ideas` | topic, angle, style, status, rationale, scheduled_for | operator / `POST /api/ideas` | dashboard |
| `channel_strategies` | objective, audience, value_proposition, content_pillars, cadence_per_week, videos_per_run, default_format/length, success_metric, primary_kpi, target_value/window, monthly_budget, outcome_currency, constraints, status | `PUT /api/operator/strategy` | operator, scheduler, learning |
| `operator_runs` | strategy_id, status, stage, progress, **research**, **plan**, **generated_jobs**, summary, cancel_requested | AutonomousChannelOperator | dashboard, resume |
| `notifications` | type, level, title, message, data, status | OperatorService | dashboard |
| `readiness_runs` | status, checks (JSON), summary, started_at, completed_at | ProductionReadinessService | gates, dashboard |
| `settings` | key/value/description, ~20 defaults | `PUT /api/settings` | everything |

Notable relationships: `productions` 1—1 `production_snapshots`/`content_reviews`/`content_provenance`; 1—N `production_scenes`, `shorts_clips`, `publish_schedule`; `publish_schedule` 1—1 `shorts_clips` via `metadata.shortClipId`.

---

## 13. API ENDPOINTS (all that exist)

`this.app.use(express.json({limit:'1mb'}))`, `express.static('dashboard')`. `protect = requireAPIKey()` → if `process.env.API_KEY` is set, mutating routes require header `x-api-key`; **if unset, routes are open and a warning is logged at boot**.

| Method | Endpoint | Purpose | Auth | Input | Output |
|---|---|---|---|---|---|
| GET | `/` | Dashboard SPA | no | — | `dashboard/index.html` |
| GET | `/health` | Liveness + setup mode | no | — | `{status, initialized, setupRequired, agents, uptime}` |
| POST | `/generate` | Queue a generation job | **API key** | `{topic?, style?, length?, strategyContext?}` (validated: topic ≤200, style ≤50, length ∈ short/medium/long) | 202 `{success, result: job}` |
| GET | `/analytics` | Recent analytics + learning | no | — | `{totalVideos, averagePerformanceScore, topPerformers, insights, learning}` |
| GET | `/api/outcomes` | Outcome & ROI summary | no | — | `{success, result}` |
| GET | `/schedule` | Upcoming schedule | no | — | array |
| POST | `/publish/:contentId` | Manual publish | **API key** | — | 409 unless approved/scheduled |
| GET | `/api/dashboard` | Whole dashboard payload (17 parallel queries) | no | — | stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation, channelStrategy, operatorRuns, readiness, engagement, experiments, system |
| GET | `/api/jobs/:jobId` | Job + checkpoints + media tasks + `resumeFrom` | no | — | job object |
| POST | `/api/jobs/:jobId/resume` | Resume / regenerate from stage | **API key** | `{stage?}` | 202 job |
| POST | `/api/jobs/:jobId/cancel` | Request cancellation | **API key** | `{reason?}` | updated job |
| GET | `/api/readiness` | Latest readiness summary | no | — | `{status, stale, blockingFailures, checks}` |
| POST | `/api/readiness/run` | Run live probes | **API key** | `{includePaidMedia?, includePaidVideo?}` | run result |
| GET | `/api/content/:productionId` | Full content bundle (+scenes, shorts, provenance, discoverability) | no | — | decorated bundle |
| PATCH | `/api/content/:productionId` | Edit title/description/tags/publishTime/privacyStatus | **API key** | editor fields | bundle |
| GET | `/api/content/:productionId/asset/:kind` | Stream `video`/`thumbnail`/`captions`/`script`/`experiment-thumbnail-N` | no | — | file (video blocked when simulated) |
| POST | `/api/content/:productionId/approve` | Approve + schedule | **API key** | `{title?, description?, tags?, publishTime?, privacyStatus?, factChecked, rightsConfirmed, reviewNotes?}` | `{productionId, reviewStatus, qualityScore, schedule}` |
| POST | `/api/content/:productionId/reject` | Reject | **API key** | — | review |
| POST | `/api/content/:productionId/retry` | Re-run production for a failed/attention item | **API key** | — | new job |
| GET | `/api/content/:productionId/scenes/:sceneId/estimate` | Cost estimate for regeneration | no | `?provider=` | `{paid, provider, generatedSeconds, …}` |
| PATCH | `/api/content/:productionId/scenes/:sceneId` | Edit scene (script/prompt/duration/label/lock/provenance) | **API key** | scene fields | scene |
| POST | `/api/content/:productionId/scenes/reorder` | Reorder timeline | **API key** | `{sceneIds[]}` | scenes |
| POST | `/api/content/:productionId/scenes/:sceneId/regenerate` | Regenerate visual (+narration) | **API key** | `{confirmPaid?, regenerateNarration?, provider?}` | 202 `{scene, estimate}` |
| PUT | `/api/content/:productionId/scenes/:sceneId/asset` | Upload replacement asset | **API key** | raw image/video body (≤100 MB) + `x-file-name`, `x-rights-confirmed`, `x-synthetic-media` | scene |
| POST | `/api/content/:productionId/scenes/:sceneId/narration` | Regenerate narration only | **API key** | `{confirmCost:true}` | 202 scene |
| POST | `/api/content/:productionId/narration/silence` | Toggle intentional silence | **API key** | `{enabled, confirmed, reason}` | result |
| POST | `/api/content/:productionId/scenes/rebuild` | Rebuild final MP4 + SRT | **API key** | — | `{finalVideo, previousVideo, captions, scenes}` |
| GET | `/api/content/:productionId/scenes/:sceneId/asset` | Stream scene asset (path-confined to `data/`) | no | — | file |
| POST | `/api/content/:productionId/shorts/propose` | Create 1–5 Short drafts | **API key** | `{count?, replace?}` | clips |
| PATCH | `/api/content/:productionId/shorts/:clipId` | Edit a draft | **API key** | clip fields | clip |
| POST | `/api/content/:productionId/shorts/:clipId/render` | Render 9:16 MP4 + SRT | **API key** | — | 202 clip |
| POST | `/api/content/:productionId/shorts/:clipId/approve` | Approve + schedule a Short | **API key** | `{confirmed, privacyStatus?, publishTime?}` | clip |
| GET | `/api/content/:productionId/shorts/:clipId/asset/:kind` | Stream Short video/captions (path-confined to `data/shorts/`) | no | — | file |
| PUT | `/api/content/:productionId/provenance` | Save sources/claims/synthetic flag | **API key** | `{sources[], claims[], containsSyntheticMedia}` | provenance |
| POST | `/api/content/:productionId/discoverability/run` | Run discoverability audit | **API key** | `{platform?}` | bundle + audit |
| PATCH | `/api/content/:productionId/schedule` | Reschedule | **API key** | `{publishTime}` | entry |
| POST | `/api/content/:productionId/publish-now` | Immediate publish | **API key** | — | entry |
| DELETE | `/api/content/:productionId/schedule` | Delete schedule (keeps content) | **API key** | — | entry |
| PATCH | `/api/discoverability/findings/:findingId` | Accept/dismiss a finding | **API key** | `{status, reason?}` | finding + audit |
| GET | `/api/experiments` | Experiments + eligible candidates | no | — | summary |
| POST | `/api/experiments` | Create a draft plan | **API key** | `{productionId, armDurationHours?, minImpressions?}` | 201 experiment |
| POST | `/api/experiments/:experimentId/:action` | `approve`/`start`/`refresh`/`adopt`/`cancel` | **API key** | `{confirmed?}` | experiment |
| GET | `/api/retention/:videoId` | Stored retention snapshots | no | — | snapshots |
| POST | `/api/retention/:videoId/refresh` | Re-pull curve from YouTube | **API key** | `{measurementWindow?}` | snapshot |
| GET | `/api/engagement/:videoId` | Comments + insight + drafts | no | — | detail |
| POST | `/api/engagement/:videoId/sync` | Sync comments | **API key** | — | result |
| POST | `/api/engagement/:videoId/draft-replies` | Generate reply drafts | **API key** | — | drafts |
| PATCH | `/api/engagement/replies/:draftId` | Edit/discard a draft | **API key** | `{editedText?}` / `{discard:true}` | draft |
| POST | `/api/engagement/replies/:draftId/approve` | Post a reply | **API key** | `{confirmed:true, editedText?}` | draft |
| PUT | `/api/operator/strategy` | Save channel strategy | **API key** | validated strategy object | strategy |
| POST | `/api/operator/start` | Activate + run | **API key** | — | run |
| POST | `/api/operator/pause` | Pause the operator | **API key** | — | — |
| POST | `/api/operator/runs/:runId/cancel` | Stop a run | **API key** | — | run |
| POST | `/api/operator/runs/:runId/resume` | Resume a run | **API key** | — | run |
| POST | `/api/learning/recommendations/:recommendationId/:action` | `approve` / `reject` | **API key** | — | recommendation |
| POST | `/api/ideas` | Add a content idea | **API key** | `{topic, angle?, style?, …}` | 201 idea |
| PATCH | `/api/ideas/:ideaId` | Update an idea | **API key** | fields | idea |
| POST | `/api/ideas/:ideaId/generate` | Generate a video from an idea | **API key** | `{length?}` | 202 job |
| POST | `/api/automation/:action` | `pause` / `resume` automation | **API key** | — | `{paused}` |
| PUT | `/api/settings` | Update allow-listed settings | **API key** | `approval_required, notification_enabled, channel_timezone, max_daily_posts, content_buffer_days, video_provider, video_generation_mode, video_clip_duration, video_max_generated_seconds` | settings |
| PUT | `/api/profile` | Update channel profile | **API key** | profile fields | profile |
| POST | `/api/notifications/:notificationId/read` | Mark read | **API key** | — | — |

**Not present:** no `/api/auth/*`, no `/api/playlists/*`, no `/api/channels/*`, no webhooks, no `/api/uploads` other than the scene-asset PUT, no GraphQL, no `/api/export`.

---

## 14. DASHBOARD

Single-page app: `dashboard/index.html` + `dashboard/app.js` (1,751 lines) + `dashboard/enhance.js` (motion/command palette/instrumentation) + `dashboard/styles.css`. All state comes from **one** endpoint: `GET /api/dashboard`, polled by `refreshDashboard()`. API key is held in `localStorage` and sent as `x-api-key` (see §16).

| View (`data-view`) | What it shows | Backend |
|---|---|---|
| **Overview** | Stat cards (needs review / scheduled / published / avg score), decision queue, active generation jobs, publishing calendar, activity inbox | `/api/dashboard`, `POST /generate` |
| **Autonomous operator** | Strategy form (objective, audience, pillars, cadence, videos/run, format, length, KPI, target, window, budget, currency, constraints), Activate & run now, Pause, current run progress, Resume run, Stop run, editorial plan with evidence | `PUT /api/operator/strategy`, `POST /api/operator/start|pause`, `POST /api/operator/runs/:id/resume|cancel` |
| **Pipeline** | Every production with status filter (all / needs_review / needs_attention / approved / published), real-vs-simulated badge, next-action button; opens **Review Studio** | `/api/dashboard`, `/api/content/:id` |
| **Review Studio** (dialog) | Video/thumbnail preview, quality checks, packaging variant picker, provenance **Evidence desk** (source + claim editors, verify, waive), synthetic-media control, discoverability panel, **Scene Repair Studio** (edit/reorder/lock/upload/regenerate/rebuild, narration regen, silence override), **Shorts Repurposing Studio**, approve/reject, reschedule / publish-now / delete-schedule | ~20 `/api/content/:id/*` endpoints |
| **Calendar & ideas** | Upcoming releases + idea backlog with add/edit/generate | `/schedule`, `/api/ideas*` |
| **Analytics** | Analyzed videos, performance score, recommended action, **Outcome & ROI Studio** (target progress, evidence coverage, net subscribers, revenue, cost, ROI, breakdowns by pillar/format/provider), **What the agent learned** (baseline grid + recommendations with approve/reject), **Controlled Growth Experiments** (create/approve/start/adopt/cancel), **Scene-aware retention** (curve chart + per-scene signals, refresh curve), top performers, local activation milestones | `/analytics`, `/api/outcomes`, `/api/learning/recommendations/:id/:action`, `/api/experiments*`, `/api/retention/:videoId*` |
| **Engagement** | Posting lock status, themes/sentiment/questions, needs-attention quarantine, draft-reply queue with approve, audience-requested ideas | `/api/engagement/*` |
| **Production readiness** | Latest run, blocking failures, remediation, Run verified check with `includePaidMedia` / `includePaidVideo` toggles | `/api/readiness`, `/api/readiness/run` |
| **Channel setup** | Profile (name, goal, audience, brand voice, default style, CTA, banned topics, visual style, timezone), video provider picker with live availability from `system.videoProviders`, clip duration / max generated seconds / mode | `PUT /api/profile`, `PUT /api/settings` |

Plus: automation pause/resume toggle, notification badge, toasts, command palette, `escapeHTML()` sanitisation on all interpolated values.

---

## 15. ERROR HANDLING AND RECOVERY

| Concern | Mechanism |
|---|---|
| **Retries** | `GenerationRecoveryService`: `GENERATION_STAGE_MAX_ATTEMPTS` (default 2), exponential backoff `GENERATION_RETRY_BASE_MS * 2^(n-1)` (default 1000 ms). Only retryable errors retry: HTTP 408/425/429/5xx or `ECONNRESET/ECONNREFUSED/EPIPE/ETIMEDOUT/ENETUNREACH/EAI_AGAIN`. `JOB_CANCELLED` never retries. |
| **Checkpoints** | `generation_checkpoints` per stage with the full artifact JSON; `media_generation_tasks` per provider scene with `external_task_id` and `provider_data`. |
| **Resume** | `resumePoint()` = first stage whose checkpoint isn't `completed`; `resetFrom(stage)` for intentional regeneration; completed checkpoints are **re-validated** (files must exist) and downstream checkpoints are dropped when one is invalid. Operator runs resume research + plan. |
| **Failed jobs** | Status `failed` + `error` + `details.failedStage`; notification `generation_failure` (Slack/Discord webhook if `NOTIFICATION_WEBHOOK_URL`). Only `failed`/`interrupted` can be resumed (409 otherwise). |
| **Provider timeouts** | `VIDEO_PROVIDER_TIMEOUT_MS` (default 3,600,000 ms) → `MEDIA_PROVIDER_TIMEOUT`; DarkzSEO `DARKZSEO_TIMEOUT_MS` (30 s); axios timeouts 30–120 s; readiness notification webhook 5 s. |
| **Duplicate YouTube uploads** | `youtubeId` present → reconcile instead of upload; `status==='published'` → return early; `uploading`/`reconciliation_required`` → 409 `UPLOAD_OUTCOME_UNKNOWN`. |
| **Missing video IDs** | Upload attempted + error with no status or ≥500 → `reconciliation_required`; `reconcileUploadedVideo()` verifies via `videos.list` and either marks published or keeps the block. |
| **Missing assets** | `validateArtifact` per stage; `isUsableAudioFile`; `pathExists`; `isValidVideo` (size ≥1000 B + `ftyp` at offset 4 + FFmpeg decode); `getVideoStream` refuses non-`.mp4`. Asset endpoints are path-confined to `data/` / `data/shorts/` (403 otherwise). |
| **Interrupted generation** | `markInterruptedJobs()` on boot; `MAX_CONCURRENT_JOBS` (default 1) prevents pile-ups; cancel is cooperative and checked between stages and inside the provider poll loop (including remote cancellation when supported). |
| **Database recovery** | `db.backup()` weekly (file copy to `data/backup_<epoch>.db`). **No WAL/checkpoint tuning, no integrity check, no restore path, and backups are never rotated.** A corrupted DB means manual intervention. |
| **Silent failure risk** | Thumbnail upload and caption upload failures are swallowed (logged only). `analyzeVideoPerformance` failures are caught per-video in the scheduler. `getVideoAnalytics` falls back to `getSimulatedAnalytics()` — random numbers that are then flagged `simulated:1` and excluded from learning. |

---

## 16. SECURITY

### 16.1 API key handling
- AI provider keys: `config/credentials.json` (written by the wizards) **or** environment variables. `AITextService` / `AIVideoGenerator` accept both; env wins for the media generators, `credentials.aiProvider` wins for text.
- **Plaintext at rest.** No encryption, no keychain/secret-manager integration, no `.env` for credentials (the wizards bypass `.env` for AI keys and write JSON).
- Redaction exists in two places: `video-providers.js:safeModelError()` strips `Bearer …`, `api_key=…`, `token=…`; `production-readiness-service.js:safeError()` strips `sk-…`, `AIza…`, `Bearer …`, `access_token=…`. Both are applied before persisting to SQLite/logs.
- `.gitignore` covers `.env*`, `config/credentials.json`, `config/tokens.json`, `*.key`, `*.pem`. `config/credentials.example.json` contains only placeholders — **no real secrets are committed in this repo**.

### 16.2 OAuth token handling
- `config/tokens.json` stores the full token set (including the **refresh token**) in plaintext.
- `getYouTubeAuth()` creates a new OAuth2 client per call from the persisted tokens. `googleapis` refreshes automatically **in memory only** — refreshed tokens are never persisted, so the on-disk copy can become stale/revoked without the app noticing until a 401.
- Loopback server binds to `127.0.0.1`/`localhost`/`::1` on a random port 8000–8999, 5-minute timeout, and only accepts the exact configured path.
- `oauth-server.js` is an unused 150-line Express OAuth helper — dead code, but it also contains a `client_secret` flow; worth deleting.

### 16.3 Authentication / authorisation
- **`API_KEY`** env var: if set, every mutating route requires `x-api-key`. If **not** set, all mutating routes are open and the app logs `API_KEY is not set; mutating API routes are unprotected`. There is no user/session/role model at all.
- No CSRF protection, no rate limiting on the HTTP layer (`GLOBAL_RATE_LIMIT_PER_HOUR` in `.env.example` is **never read** by any code), no HTTPS enforcement, no security headers, no CORS config (defaults to same-origin only, which is fine for the bundled dashboard).
- Dashboard stores the API key in `localStorage` and injects it into `fetch` headers.

### 16.4 Other risks
- `express.raw({type:['image/*','video/*'], limit:'100mb'})` — an unauthenticated-ish (API-key-gated) upload path; buffers are validated with `sharp`/FFmpeg before being written, which is reasonable.
- Path traversal is explicitly guarded on asset endpoints (`path.resolve(...).startsWith(dataRoot + path.sep)`).
- The bundled DarkzSEO adapter spawns Python with `shell:false` and a **whitelisted** child environment (no API keys inherited) — good.
- SQL is parameterised everywhere I inspected (`?` placeholders); the only string-built SQL is fixed table/column names.
- `x-api-key` comparison uses `!==` (not timing-safe) — minor.
- Anonymous telemetry is off by default, requires an HTTPS endpoint, and only sends allowlisted milestone names + version + OS + Node major + random install ID.

---

## 17. CURRENT LIMITATIONS

**Missing entirely**
- Google Drive / S3 / any cloud asset storage.
- Multiple YouTube channels (one `channel_profiles` row with `id='default'`, one OAuth token).
- Playlists (README claims it; no code).
- TikTok / Instagram / Reels publishing (`DiscoverabilityService` throws for non-YouTube; only the `platform` column exists as a future contract).
- Azure Speech TTS (credentials prompted, no `generateAzureTTS`).
- Ollama / arbitrary local models (README mentions them; no code).
- Anthropic SDK (only reachable as an OpenRouter model string).
- `utils/ai-service.js` — the file the README's "Custom AI provider" example tells you to edit **does not exist** (it's `utils/ai-text-service.js`).
- Any HTTP-layer rate limiting, auth beyond a single shared `API_KEY`, or multi-user support.
- Database rotation/restore for `data/backup_*.db` (accumulates forever).
- Subtitle translation / multi-language captions (SRT is hardcoded `language: 'en'`).
- Music/background audio (description says "YouTube Audio Library" but nothing adds audio).
- Timezone-aware scheduling (cron and publish times are server-local).
- Real ASR captions — all SRT timing is estimated from script section durations.

**Weak / fragile**
- `oauth-server.js` is dead code; `generateReplicateVideo()` is dead code.
- `content_history` table is never written.
- `keyword_performance` is fed from `analytics_reports.video_details`, coupling two schemas loosely.
- `cleanupOldFiles()` can delete a thumbnail still referenced by a published production (30-day rule on `uploads/`).
- The `seo_data` table is written but the bundle reads SEO from `production_snapshots`.
- Slideshow rendering needs Playwright's Chromium binary; if it isn't installed the run throws "Executable doesn't exist" (the test suite explicitly tolerates this).
- `getSimulatedAnalytics()` produces plausible-looking random numbers — safe only because `simulated:1` is set and learning excludes it. Any future consumer that forgets the flag would publish fake data.
- Single-process, in-memory `activeJobs` / `publishQueue` / `activeRuns` maps: restarting the server loses in-flight state (mitigated by DB checkpoints, but a mid-FFmpeg job cannot resume).
- `MAX_CONCURRENT_JOBS=1` by default means bulk generation is serial.
- Gemini free-tier text calls frequently return empty bodies; `AITextService` surfaces a clear error but the agent still falls back to templates.

**Hardcoded**
- Publish time default: next day **14:00** server-local.
- TTS voice `coral`, speed 1.0; Gemini voice `Kore`; ElevenLabs model `eleven_v3`.
- Image size 1536×1024 (OpenAI) / 16:9 1K (Gemini); thumbnail 1280×720.
- Resolution 1920×1080, 30 fps, `yuv420p`, 0.5 s crossfade, 8 words per caption.
- Video category `22`, language `en`.
- `DEFAULT_PROVIDER_ORDER = seedance, minimax_h3, google_omni, kling, wan, slideshow`.
- All 5 script templates and all thumbnail style/colour tables.
- `estimatedViews` / `priority` heuristics use `Math.random()`-ish thresholds.

**Provider-dependent**
- No text provider → template scripts and template SEO (with `[Your Channel URL]` placeholders).
- No TTS provider → **silent videos** (blocked from approval unless the operator confirms intentional silence).
- No image provider → gradient slides.
- No FFmpeg → **no MP4 at all**.
- No YouTube OAuth → no upload, no analytics, no trends, no comments (app still runs in "setup mode").

---

## 18. YOUR CUSTOMIZATION POTENTIAL

| Goal | Where to change | Effort |
|---|---|---|
| **YouTube Shorts** | Already built. Tune `utils/shorts-repurposing-service.js`: `LAYOUTS`, `width/height`, `selectWindows()` (window length, count), `videoFilter()` (caption style, layout geometry), `buildCaptions()` (words/chunk). Frontend: `renderShortsStudio()` in `dashboard/app.js`. | Low |
| **US audience** | `YOUTUBE_REGION=US` (already default) in `.env`; `channel_profiles.target_audience` via `PUT /api/profile`; `TARGET_AUDIENCE` env; `channel_strategies.audience` via the operator form. For deeper localisation: `agents/analytics-optimization-agent.js` demographics, `agents/seo-optimizer-agent.js` keyword tables, and `utils/youtube-metadata-validator.js` `defaultLanguage`. | Low |
| **Custom posting schedule** | Best: `PUT /api/settings` → `content_buffer_days`, `max_daily_posts`; and `channel_strategies.cadence_per_week` / `videos_per_run`. For exact clock times edit `schedules/daily-automation.js` cron strings and `ProductionManagementAgent.calculatePublishTime()` (the `setHours(14,0,0,0)` line). For real timezone handling, add a TZ conversion there and in `cron.schedule(..., {timezone})`. | Low–Medium |
| **Bulk video generation** | Raise `MAX_CONCURRENT_JOBS` (env, default 1) and `channel_strategies.videos_per_run` (capped at 5 by `validateChannelStrategy`; raise that cap in `index.js`). Also relax `MAX_CONCURRENT_JOBS` guard in `startGenerationJob` and the 60 s `VIDEO_MAX_GENERATED_SECONDS` budget. Note `AIVideoGenerator` is shared per-agent and `lastVideoResult`/`lastNarrationResult` are **instance state** — concurrent productions on one agent instance would cross-contaminate; you'd need per-job generator instances. | **Medium–High** |
| **Google Drive storage** | Nothing exists. Add an abstraction and call it from `ProductionManagementAgent.assembleVideo()`, `SceneRepairService.rebuild()`, `ShortsRepurposingService.render()`, and after `publishContent()`. Because asset paths are persisted in `productions.assets` and `publish_schedule.metadata`, a remote store needs either a sync-down-on-demand layer or a signed-URL resolver in the asset endpoints. | High |
| **Automatic title/description/hashtags** | `agents/seo-optimizer-agent.js` — replace `optimizeTitle()`, `generateDescription()`, `generateTags()`, `generateHashtags()`, `generateChapters()`. Already AI-capable via `generateSEOWithAI()`; tune that prompt for fully automatic output and drop the `[Your Channel URL]` template placeholders. | Low |
| **Custom AI video providers** | `utils/video-providers.js`: subclass `VideoProvider` (implement `isAvailable`, `createTask`, `getTask`, `cancelTask`, optional `downloadResult`, and declare `capabilities`), then register in `VideoProviderRegistry` and add the id to `DEFAULT_PROVIDER_ORDER` + the allow-list in `PUT /api/settings` (`index.js`) + the dashboard's provider labels. `MediaGenerationService` needs no change. | **Low — this is the cleanest extension point in the repo** |
| **Custom TTS** | `utils/ai-video-generator.js`: add a branch in `generateTTSAudio()` + a `generateXTts()` method, and set `lastNarrationResult` with provider/model/cost evidence. Also add a probe in `production-readiness-service.js:probeNarration` and a credential prompt in `utils/credential-manager.js:setupTTSService`. | Low |
| **Custom thumbnail generation** | Two places: `agents/thumbnail-designer-agent.js` (`generateConcept`/`createThumbnail`/`addTextOverlay`/`generateABVariants`) for the deterministic path, and `utils/ai-video-generator.js:generateThumbnail` for the AI path. Swap `sharp` for an image API or add a template/asset library. | Low |
| **Multiple YouTube channels** | Structural change: `channel_profiles` is a single `id='default'` row, `CredentialManager` holds one `credentials.youtube` + `tokens.youtube`, every agent is constructed once with one credential manager, and `getPublishedContentContext`/`getPublishQueue` assume one channel. You'd need per-channel credential sets, a channel dimension on `channel_strategies`/`productions`/`publish_schedule`, and agent instances keyed by channel. | **High** |
| **Custom dashboard** | Replace `dashboard/index.html` + `app.js` and keep hitting the same REST API (`GET /api/dashboard` alone powers most views). Backend needs no change. Set `API_KEY` and require `x-api-key` if you expose it. | Low (API is stable and documented by usage) |
| **Automatic analytics-based optimization** | Today every recommendation is `pending`. To automate: auto-approve high-confidence recommendations in `utils/channel-learning-engine.js:refreshRecommendations()` (or a new job in `schedules/daily-automation.js`), and let `researchAndPlanChannel()` read them. To auto-apply packaging, extend `GrowthExperimentService.adoptWinner()` to run without `confirmed:true`. **Deliberately gated today** — flip it consciously. | Medium |

---

## 19. DOCUMENTATION vs CODE VERIFICATION

### ✅ IMPLEMENTED (verified in source)
Research/trends/competitors · AI + template strategy · AI + template scripts with claim extraction · AI + template SEO (title/description/tags/hashtags/chapters/end-screen) · deterministic Sharp thumbnails + A/B variants · AI image generation (OpenAI/Gemini) · ElevenLabs/OpenAI/Gemini TTS · 5 AI video providers + local slideshow + hybrid assembly · real FFmpeg MP4 (slideshow, hybrid, scene rebuild, Shorts) · SRT captions (long-form, scene-aware, Shorts with burn-in) · durable scene manifest + scene repair/rebuild · narration fail-closed + intentional-silence override · provenance/evidence desk with verified-source rule and waivers · media-rights attestation + uploaded-asset rights confirmation · quality gate with blocking/non-blocking checks · production readiness preflight with paid opt-ins · generation checkpoints + bounded retries + resume · operator run persistence + resume/cancel · publishing queue + scheduling + reconciliation + metadata validation + thumbnail/caption upload · YouTube Analytics (views/CTR/watch/demographics/traffic/devices/subscribers/revenue/engagement) · audience retention curve · 24h/7d snapshots + baseline/deltas + confidence · learning recommendations with approval gate · scene-level retention mapping · controlled growth experiments with z-test guardrails · audience comment sync/analysis/quarantine/draft replies with daily cap and scope gate · audience-requested idea mining · outcome & ROI studio with explicit "unavailable" (not zero) · DarkzSEO discoverability preflight (bundled, no Python) with accept/dismiss findings · local activation milestones · opt-in anonymous telemetry · cron scheduler (8 tasks) · pause/resume automation · 46-test suite · CI (lint + test) · dashboard with 8 views + Review/Scene/Shorts studios.

### ⚠️ PARTIALLY IMPLEMENTED / FALLBACK
| README claim | Reality |
|---|---|
| "Thumbnail Designer … runs A/B variations" | `generateABVariants()` exists and is used, but only when an approved packaging learning exists; otherwise no variants are made. |
| "Image generation (GPT Image 2)" | Real, but the **thumbnail** the pipeline actually uses is the Sharp gradient unless `processThumbnail`'s AI call succeeds. |
| "Playwright Slideshow" fallback | Implemented, but requires the Playwright Chromium binary — not guaranteed by `npm install` alone for all platforms. |
| "Replicate (Wan 2.7 video)" | `generateReplicateVideo()` is **dead code**; the working Replicate integration is **Seedance 2.5** in `video-providers.js`. |
| "Additional integrations: Anthropic Claude" | Only a model string in `PROVIDERS.openrouter.models`; no SDK. |
| "local models via Ollama" | **No code.** |
| "Azure Speech TTS (optional alternative)" | Credential wizard prompt only; no TTS implementation. |
| "Publishing … manages playlists" | **No playlist code at all.** |
| "Analytics … feeds insights back to strategy" | Only **approved** recommendations feed back, and only into the operator's planning prompt — never into `channel_strategies`. |
| "Retention … scene-aware" | Implemented, but requires ≥10 real curve points **and** a scene manifest; otherwise nothing is stored. |
| "Timezone handling" | `channel_timezone` is stored and displayed only; scheduling math is server-local. |
| "Bulk" generation | Serial by design (`MAX_CONCURRENT_JOBS=1`), `videos_per_run` capped at 5. |
| README "Extending → `utils/ai-service.js`" | That file doesn't exist. |
| README "Custom content types → `agents/content-strategy-agent.js` `contentTypes`" | The content-type templates actually live in `agents/script-writer-agent.js:loadTemplates()`. |

### ❌ DOCUMENTATION ONLY / NOT FOUND
- Playlists management (README "How It Works" table + Publishing agent role).
- Google Drive / cloud storage (not in README either, but a common expectation).
- Multi-channel operation.
- TikTok / Instagram / Reels publishing (DB `platform` column + README "planned" wording only).
- Ollama / local LLM support.
- Anthropic SDK integration.
- Azure Speech TTS.
- HTTP rate limiting (`GLOBAL_RATE_LATENCY_PER_HOUR`, `RETRY_ATTEMPTS`, `RETRY_DELAY`, `DEFAULT_DELAY_BETWEEN_POSTS`, `MAX_FILE_SIZE`, `UPLOAD_PATH`, `ANALYTICS_DB_PATH`, `AUTO_SHORTEN_CONTENT`, `AUTO_ADD_BACKLINKS`, `PRESERVE_FORMATTING`, `AUTO_RESIZE_IMAGES`, `MAX_IMAGE_WIDTH/HEIGHT`, `IMAGE_QUALITY` are all documented in `.env.example` and **never read by any code**).
- `oauth-server.js` (an entire unused file).
- README's `DEFAULT_VIDEO_LENGTH` env fallback in the script prompt — not defined anywhere else.
- "Background music from YouTube Audio Library" — no music is ever added.
- `content_history` table writes.

---

## 20. FINAL ARCHITECTURE DIAGRAM

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  USER (channel owner)                                                        │
│  Browser → http://localhost:3456   (API key in x-api-key header if API_KEY)  │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│  DASHBOARD  (dashboard/index.html + app.js + enhance.js)                     │
│  Overview · Autonomous operator · Pipeline · Calendar & ideas ·              │
│  Analytics (Outcome/ROI, Learning, Experiments, Retention) · Engagement ·    │
│  Production readiness · Channel setup                                        │
│  Review Studio ─┬─ Evidence desk (provenance)                                │
│                 ├─ Scene Repair Studio                                       │
│                 └─ Shorts Repurposing Studio                                 │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  REST  (GET /api/dashboard, ~55 endpoints)
┌───────────────────────────────▼──────────────────────────────────────────────┐
│  EXPRESS SERVER  (index.js)                                                  │
│  startGenerationJob · resumeGenerationJob · approveContent · queueScheduled  │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│  AUTONOMOUS CHANNEL OPERATOR  (utils/autonomous-channel-operator.js)         │
│  research → plan → produce → wait for review   (resume / cancel / persist)   │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼──────────────────────────┬───────────────────┐
        ▼                       ▼                          ▼                   ▼
┌───────────────┐   ┌───────────────────┐   ┌──────────────────────┐  ┌───────────────┐
│ ContentStrategy│  │  ScriptWriter     │   │  ThumbnailDesigner   │  │ SEOOptimizer  │
│ Agent          │─▶│  Agent            │──▶│  Agent (sharp)       │  │ Agent         │
│ YouTube API    │   │  AI / templates   │   │  + A/B variants      │  │ AI / template │
└───────────────┘   └───────────────────┘   └──────────────────────┘  └───────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────────┐
│  PRODUCTION MANAGEMENT AGENT                                                 │
│  script → TTS text · images · narration · SRT · FFmpeg assemble · manifest   │
└──────┬────────────────────┬─────────────────────┬─────────────────────────────┘
       │                    │                     │
       ▼                    ▼                     ▼
┌──────────────┐   ┌────────────────────┐   ┌───────────────────────────────────┐
│ AI PROVIDERS │   │  VIDEO PROVIDERS   │   │  LOCAL RENDER                     │
│ OpenAI       │   │  seedance          │   │  Playwright → stills → xfade      │
│ OpenRouter   │   │  minimax_h3        │   │  FFmpeg concat + AAC mux          │
│ Gemini       │   │  google_omni       │   │  sharp gradients / text           │
│ Kimi/MiMo/GLM│   │  kling             │   │                                   │
│ ElevenLabs   │   │  wan               │   │                                   │
│ (TTS/Image)  │   │  slideshow ← free  │   │                                   │
└──────────────┘   └────────────────────┘   └───────────────────────────────────┘
       │                    │                     │
       └────────────────────┴─────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  STORAGE                                                                     │
│  data/videos/*.mp4 · data/audio/** · data/captions/*.srt · data/scripts/**   │
│  data/assets/* · data/scene-assets/** · data/shorts/** · uploads/thumbnails  │
│  config/credentials.json · config/tokens.json · logs/**                     │
│  SQLite  data/youtube_automation.db  (30 tables)  + data/backup_*.db        │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  REVIEW GATES (fail-closed)                                                  │
│  Setup mode · Production readiness · Quality checks · Simulated-video block  │
│  Narration required · Provenance verified · Media rights · Scene integrity   │
│  YouTube metadata valid · **Human approval (default ON)**                    │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  SCHEDULER  (schedules/daily-automation.js, node-cron)                       │
│  06:00 generate · */15 publish queue · 09:00 analytics · 22:00 optimize      │
│  Sun 08:00 weekly strategy · Sat 03:00 DB backup · */4 comments · */4 tests  │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  YOUTUBE                                                                     │
│  videos.insert (+publishAt, privacy, containsSyntheticMedia)                 │
│  thumbnails.set · captions.insert · commentThreads.list · comments.insert    │
│  youtubeAnalytics.reports.query · videos.list (reconciliation)               │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  ANALYTICS                                                                   │
│  views · impressions · CTR · watch time · AVP/AVD · retention curve          │
│  demographics · traffic · devices · subscribers · revenue · engagement      │
│  → 24h / 7d snapshots → median baseline → deltas → confidence               │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LEARNING                                                                    │
│  ChannelLearningEngine (format/length/hook/title/pillar/outcome)             │
│  SceneRetentionEngine (per-scene drop-off / rewatch / strong-hold)           │
│  AudienceEngagementService (audience-requested ideas)                        │
│  GrowthExperimentService (z-test, guardrails)                                │
│  → learning_recommendations  status = pending  ← NEVER auto-applied          │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  operator approves
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  AUTONOMOUS CHANNEL OPERATOR  (loop closes — approved learnings become       │
│  explicit planning constraints for the next research + editorial plan)       │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## FINAL VERDICT

### A. What this project can do RIGHT NOW
1. Run a complete, real pipeline: research → script → thumbnail → SEO → **real MP4** → captions → review → schedule → **real YouTube upload**.
2. Produce genuine H.264/AAC MP4s locally with **zero paid APIs** (Playwright slideshow + FFmpeg + gradient visuals), and optionally upgrade individual scenes to Seedance / MiniMax / Gemini Omni / Kling / Wan clips in hybrid mode.
3. Fail closed: simulated video, missing/simulated narration, unresolved factual claims, unconfirmed media rights, broken scenes, and failed readiness all block approval and publishing.
4. Checkpoint/resume generation jobs and operator runs across restarts; reconcile ambiguous YouTube uploads instead of duplicating them.
5. Collect real YouTube Analytics (including the retention curve and monetization/subscriber outcomes), build 24h/7d evidence snapshots, and turn them into approval-gated recommendations.
6. Run controlled, statistically-guarded title/thumbnail experiments on live videos.
7. Sync and analyse comments, draft replies (never auto-post), and mine audience-requested topics.
8. Repurpose approved videos into real 9:16 Shorts with burned-in captions.
9. Run a full autonomous operator loop that respects cadence and never bypasses approval gates.
10. Present all of it in a single local dashboard, plus a 46-test suite and CI.

### B. What it cannot do RIGHT NOW
- Upload to more than one channel, or to any platform other than YouTube.
- Store assets in Google Drive / S3 / any cloud.
- Create or manage playlists.
- Generate Azure Speech narration or use Ollama/local LLMs.
- Apply a learning recommendation or a strategy change without a human click.
- Generate videos concurrently by default, or in bulk (serial, ≤5 per run).
- Produce word-accurate captions (no ASR) or multi-language subtitles.
- Add background music or any audio other than narration.
- Schedule in a timezone other than the server's local time.
- Authenticate users, rate-limit requests, or run multi-tenant.

### C. What is simulated / fallback
- **Text:** template strategies, template scripts (hardcoded section prose), template SEO descriptions containing literal `[Your Channel URL]` placeholders.
- **Images:** `.info` JSON placeholders; gradient slides via `sharp`.
- **Thumbnails:** always a deterministic gradient + text overlay unless the AI image call succeeds.
- **Video:** `<final>.mp4.assembly.json` placeholder; `.info` files for audio/visuals/thumbnails.
- **Narration:** `<audio>.mp3.info` placeholder → blocks everything downstream.
- **Analytics:** `getSimulatedAnalytics()` random values — stored with `simulated:1`, excluded from learning, and never eligible for experiments. (`getSimulatedDemographics()` is defined but no longer reachable from the main path.)
- **Comments:** with no AI provider, only mechanical facts are recorded — no themes, drafts, or ideas.
- **Discoverability:** bundled JS auditor is the default; a broken external DarkzSEO silently falls back to it.

### D. What requires paid APIs
OpenAI (text, `gpt-image-2` images, `gpt-4o-mini-tts`) · OpenRouter (pay-per-model) · Kimi / MiMo / GLM · ElevenLabs · Replicate (Seedance) · MiniMax · Kling · Alibaba DashScope · **Gemini AI images** (free text/TTS tiers exist, images need paid). Free options: Gemini text + TTS, local FFmpeg slideshow, `sharp` thumbnails, YouTube Data/Analytics APIs (free quota).

### E. What requires YouTube credentials
A Google Cloud project with YouTube Data API v3 enabled and a **Desktop app** OAuth client saved as `config/credentials.json`, then authorization writing `config/tokens.json`. Scopes: `youtube.upload`, `youtube`, `youtube.readonly`, `yt-analytics.readonly`, `youtube.force-ssl`. Without it: no trends, no competitor research, no upload, no analytics, no retention curve, no comments — the app still runs but in setup mode (dashboard only).

### F. What requires human approval
- Content approval before scheduling/publishing (`approval_required` default `true`).
- The factual-review and media-rights attestations inside approval.
- Any intentional-silence override (reason ≥10 chars + confirmation).
- Any paid scene regeneration (`confirmPaid`) or narration regeneration (`confirmCost`).
- Any paid readiness probe (`includePaidMedia` / `includePaidVideo`).
- Every learning recommendation before it can influence planning.
- Every growth-experiment step: plan approval, start, and winner adoption.
- Every comment reply (plus the `youtube.force-ssl` scope and the daily cap).
- Any edit to a live video's title/thumbnail.

### G. What needs code changes for your customizations
| Customization | Code change needed? |
|---|---|
| Shorts layouts/durations/captions | **No** — tune `utils/shorts-repurposing-service.js` constants |
| US audience / region | **No** — env + profile/strategy fields |
| Custom posting schedule | **Mostly no** — settings + strategy cadence; clock times need `calculatePublishTime()` and cron edits |
| Auto title/description/hashtags | **No** — tune `agents/seo-optimizer-agent.js` (already AI-capable) |
| Custom AI video provider | **No** — subclass `VideoProvider` and register it |
| Custom TTS | **Small** — one branch in `AIVideoGenerator.generateTTSAudio` + a readiness probe |
| Custom thumbnail generation | **No** — swap the `sharp` pipeline in `thumbnail-designer-agent.js` |
| Custom dashboard | **No** — the REST API is sufficient |
| **Bulk generation** | **Yes** — raise caps **and** make `AIVideoGenerator` per-job (its `lastVideoResult`/`lastNarrationResult` are shared instance state) |
| **Google Drive storage** | **Yes** — new storage layer + asset-path resolution + post-upload sync |
| **Multiple channels** | **Yes** — structural: per-channel credentials, channel dimension on strategies/productions/schedule, per-channel agent instances |
| **Automatic analytics-based optimization** | **Yes** — deliberately gated; auto-approve recommendations / auto-adopt experiment winners |

---

**End of audit. No files were modified, no commits were made, and nothing was pushed.**
