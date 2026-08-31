import { useState } from 'react';
import { canOpenAppSettings, isNativeAndroid, openAppSettings } from '../utils/appSettings';

// The ONE microphone-permission warning, rendered globally by App.jsx when
// voiceDevice.micBlocked is true. Replaces the raw Twilio 31401 /
// PermissionDeniedError text that used to appear twice (generic failure
// toast + dialer status line).
//
//   • Android native → primary "Open Settings" (App Info page via the
//     AppSettings bridge) + "Try Again" + "Not now"
//   • Browser → concise address-bar guidance replaces Open Settings;
//     "Try Again" (which re-prompts where the browser allows it) + "Not now"
//
// Sits in the same top slot as the other voice toasts: clear of the dial
// pad, inside the safe area, max-w-sm with wrapping buttons so nothing
// overflows on narrow screens.
export default function MicPermissionCard({ voiceDevice, t }) {
  const [retrying, setRetrying] = useState(false);
  // Three variants:
  //   new APK  → Open Settings button (plugin present)
  //   old APK  → no settings button, no browser hint (a Capacitor WebView
  //              has no address bar) — body copy still points to settings
  //   browser  → address-bar hint replaces the button
  const showOpenSettings = canOpenAppSettings();
  const showBrowserHint = !isNativeAndroid() && !showOpenSettings;

  async function handleTryAgain() {
    if (retrying) return;
    setRetrying(true);
    try {
      // The timeout only re-enables the button — if getUserMedia is still
      // pending behind a long-lived OS prompt, its eventual grant still
      // resolves retryMicPermission and clears the card.
      await Promise.race([
        voiceDevice.retryMicPermission(),
        new Promise(resolve => setTimeout(resolve, 15000)),
      ]);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      className="fixed inset-x-0 z-50 flex justify-center px-4 pointer-events-none"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 64px)' }}
    >
      <div
        role="alert"
        className="w-full max-w-sm bg-white border border-[#E5E7EB] rounded-2xl shadow-lg p-4 pointer-events-auto"
      >
        <div className="flex items-start gap-3">
          {/* Muted-mic glyph on an amber disc — a warning, not an error */}
          <div className="shrink-0 w-9 h-9 rounded-full bg-[#FEF0C7] flex items-center justify-center" aria-hidden="true">
            <svg className="w-[18px] h-[18px] text-[#B54708]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 9.4V5a3 3 0 00-5.7-1.3M9 9v3a3 3 0 005.12 2.12M17 12a5 5 0 01-.44 2.05M12 17a5 5 0 01-5-5v-1m5 6v3m-3 0h6M3 3l18 18" />
            </svg>
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-semibold text-[#101828] leading-5">
              {t.callsMicTitle}
            </p>
            <p className="mt-1 text-[13px] leading-5 text-[#475467]">
              {t.callsMicBody}
            </p>
            {showBrowserHint && (
              <p className="mt-1 text-[13px] leading-5 text-[#475467]">
                {t.callsMicBrowserHint}
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {showOpenSettings && (
                <button
                  type="button"
                  onClick={openAppSettings}
                  className="text-[13px] font-semibold px-3.5 py-2 rounded-full bg-[#065F46] text-white active:scale-[0.97] transition-transform"
                >
                  {t.callsMicOpenSettings}
                </button>
              )}
              <button
                type="button"
                onClick={handleTryAgain}
                disabled={retrying}
                className="text-[13px] font-semibold px-3.5 py-2 rounded-full border border-[#D0D5DD] text-[#344054] bg-white disabled:opacity-60 active:scale-[0.97] transition-transform"
              >
                {t.callsMicTryAgain}
              </button>
              <button
                type="button"
                onClick={voiceDevice.dismissMicWarning}
                className="text-[13px] font-medium px-2 py-2 text-[#667085]"
              >
                {t.callsMicNotNow}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
