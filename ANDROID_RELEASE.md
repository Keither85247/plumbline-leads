# Plumbline Leads — Android Release Guide

## Architecture overview

The Android app is built with **Capacitor**, which wraps the existing React/Vite
web app in a native Android WebView. All existing UI, API calls, auth, lead
management, SMS, and call logic runs unchanged inside the WebView. Native Android
features (permissions, FCM push, foreground services) are added via Capacitor plugins.

```
Android App (APK / AAB)
└── Capacitor shell (Java/Kotlin)
    └── WebView
        └── React app (same code as web)
            └── Twilio Voice JS SDK (WebRTC)
```

---

## Prerequisites

1. **Android Studio** — https://developer.android.com/studio  
   Download, install, and open it once to let it install the Android SDK.

2. **Java 17** — Android Studio ships with it. If you get a Java error, set
   `JAVA_HOME` to Android Studio's embedded JDK:
   ```
   export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
   ```

3. **Node.js 18+** — already installed.

---

## First-time setup

```bash
cd frontend

# 1. Build the web app
npm run build

# 2. Sync web assets + plugins into the Android project
npx cap sync android

# 3. Open Android Studio
npm run android:open
# or: npx cap open android
```

In Android Studio:
- Wait for Gradle sync to finish (first time takes ~3-5 min)
- Install any SDK components it prompts for

---

## Run in Android emulator

1. In Android Studio → **Device Manager** → create a new virtual device  
   Choose **Pixel 8** (or similar), API **34**, with **Google Play** (important for FCM)

2. Start the emulator

3. Click the green **Run ▶** button in Android Studio  
   — or from terminal:
   ```bash
   cd frontend && npm run android:run
   ```

The app will load and connect to the production backend on Render.

> **Tip:** The emulator needs internet to reach the Render API. If it doesn't load,
> check the emulator's network settings.

---

## Rebuild after code changes

Every time you change the web app:

```bash
cd frontend
npm run android:build
# Then re-run from Android Studio (or `npm run android:run`)
```

---

## Firebase / FCM setup (push notifications on Android)

Push notifications on Android require **Firebase Cloud Messaging (FCM)**.
Without this, push notifications won't arrive when the app is backgrounded.
Inbound call notifications while the app is open still work without Firebase.

### Step 1 — Create a Firebase project

1. Go to https://console.firebase.google.com
2. Create a new project: "Plumbline Leads"
3. Add an **Android** app:
   - Package name: `com.plumblineleads.app`
   - App nickname: Plumbline Leads
4. Download `google-services.json`
5. Place it at: `frontend/android/app/google-services.json`

### Step 2 — Backend service account

1. In Firebase Console → Project Settings → **Service Accounts**
2. Click **Generate new private key** → download the JSON file
3. In Render → your backend service → **Environment** → add:
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON = <paste the entire JSON content as one line>
   ```

### Step 3 — Rebuild

```bash
cd frontend
npm run android:build
```

---

## Build a debug APK (for sideloading / sharing)

In Android Studio:
- **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**
- Output: `android/app/build/outputs/apk/debug/app-debug.apk`

To install on a real device (USB debugging enabled):
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Build a release AAB (for Google Play)

### 1 — Create a signing keystore (one time only)

```bash
keytool -genkey -v \
  -keystore plumbline-release.jks \
  -alias plumbline \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Store `plumbline-release.jks` somewhere safe. **Do not commit it to git.**

### 2 — Configure signing in Android Studio

Open `android/app/build.gradle` and add:

```groovy
android {
    ...
    signingConfigs {
        release {
            storeFile file('/path/to/plumbline-release.jks')
            storePassword 'YOUR_STORE_PASSWORD'
            keyAlias 'plumbline'
            keyPassword 'YOUR_KEY_PASSWORD'
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
        }
    }
}
```

### 3 — Build the AAB

- **Build** → **Generate Signed Bundle / APK** → **Android App Bundle**
- Output: `android/app/build/outputs/bundle/release/app-release.aab`

---

## Google Play Console setup

1. Go to https://play.google.com/console → **Create app**
2. Fill in:
   - App name: **Plumbline Leads**
   - Default language: English
   - App or game: **App**
   - Free or paid: your choice
3. Upload the `.aab` to **Internal testing** track first
4. Complete the required store listing fields:
   - Short description (~80 chars)
   - Full description
   - Screenshots (at least phone screenshots)
   - App icon (512×512 PNG)
   - Feature graphic (1024×500)
5. Content rating questionnaire
6. Data safety form (you collect: name, phone, email; you use microphone)
7. Submit for review (~1-3 days for internal track, faster than production)

---

## What to test on a real Android phone (not emulator)

| Feature | Why emulator isn't enough |
|---|---|
| Microphone / call audio | Emulator mic is simulated |
| FCM push when app is killed | Emulator FCM can be unreliable |
| Ringtone volume on lock screen | Audio routing differs on real hardware |
| Background app behaviour | OEM battery optimization varies |
| Notification tray action | Physical interaction needed |

---

## Known limitations

### ⚠️ Incoming calls fail when app is backgrounded or phone is locked

**Root cause:** The Twilio Voice JS SDK uses WebRTC, which Android kills
when the app goes to background. The WebSocket connection drops, so there is
nothing to ring.

**What works today:**
- App is open/foreground: inbound calls ring normally ✓
- Outbound calls: work in all states ✓
- Push notification arrives: yes (if FCM configured) — tapping it opens the app
- Call connects after opening: yes, if the caller hasn't hung up ✓

**v2 fix (not implemented yet):**
Replace `@twilio/voice-sdk` with the native **Twilio Voice Android SDK** via
a custom Capacitor plugin written in Kotlin. This SDK uses FCM for incoming
call signalling and can ring when the app is fully killed, including full-screen
lock-screen call UI.

Twilio reference: https://www.twilio.com/docs/voice/sdks/android

### ⚠️ iOS not yet implemented

Capacitor supports iOS. Run `npx cap add ios` when ready and follow a similar
process. iOS has stricter background rules — the Twilio Voice iOS SDK (via
CallKit) is the correct solution for reliable incoming calls.

---

## Tester checklist

Run through these on the emulator first, then repeat on a real device.

- [ ] App loads and login screen appears
- [ ] Login with email/password succeeds
- [ ] Lead list loads
- [ ] Add a new lead manually (transcript form)
- [ ] Send an SMS from the app
- [ ] Receive an SMS — message appears in inbox
- [ ] Tap microphone button to initialize voice device
- [ ] Make an outbound call — audio works both ways
- [ ] Receive an inbound call (app open) — ringtone plays, can answer
- [ ] Receive an inbound call (app backgrounded) — push notification arrives, tap to open, call connects
- [ ] Lock the phone mid-call — audio stays connected
- [ ] Deny microphone permission — app shows appropriate error
- [ ] Allow microphone permission via system prompt
- [ ] Poor network: app degrades gracefully, no crash
- [ ] Notification arrives for voicemail — tapping navigates to Calls tab
- [ ] Log out — session cleared

---

## Versioning

Update `frontend/package.json` version before each Play Store release.
Also update `android/app/build.gradle`:

```groovy
defaultConfig {
    versionCode 2      // increment by 1 each release
    versionName "1.1"  // human-readable
}
```

---

## Next steps for production call reliability

1. Set up Firebase and FCM (30 min) → fixes backgrounded push notifications
2. Implement native Twilio Voice Android SDK via Capacitor plugin (3-5 days) →
   fixes backgrounded incoming calls
3. Add CallKit-equivalent for lock screen (Android's ConnectionService API)
4. Submit to Play Store production track after internal + closed testing passes
