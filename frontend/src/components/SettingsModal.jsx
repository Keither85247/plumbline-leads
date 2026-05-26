import { useState, useCallback, useEffect, useRef } from 'react';
import { translations } from '../i18n';
import VoicemailGreetingEditor from './VoicemailGreetingEditor';
import PhoneNumbersAdmin from './PhoneNumbersAdmin';
import TeamAdmin from './TeamAdmin';
import { triggerGmailSync } from '../api';
import BuildInfoPanel from './BuildInfoPanel';

// ── Inline save-result toast ──────────────────────────────────────────────────
function SaveToast({ status, t }) {
  if (!status) return null;
  const ok = status === 'success';
  return (
    <div className={`mx-6 mb-3 flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-sm font-medium ${
      ok
        ? 'bg-green-50 border border-green-200 text-green-700'
        : 'bg-red-50   border border-red-200   text-red-600'
    }`}>
      {ok ? (
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
      )}
      <span>{ok ? t.settingsSaved : t.settingsSaveFailed}</span>
    </div>
  );
}

// ── Discard-changes confirmation overlay ──────────────────────────────────────
function DiscardDialog({ onKeep, onDiscard, t }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-white/95 backdrop-blur-[2px]">
      <div className="px-7 py-6 text-center space-y-4 max-w-[260px]">
        <p className="text-sm font-semibold text-gray-800 leading-snug">
          {t.settingsDiscardTitle}
        </p>
        <p className="text-xs text-gray-500">
          {t.settingsDiscardBody}
        </p>
        <div className="flex flex-col gap-2.5 pt-1">
          <button
            onClick={onDiscard}
            className="w-full py-2.5 text-sm font-semibold bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
          >
            {t.settingsDiscard}
          </button>
          <button
            onClick={onKeep}
            className="w-full py-2.5 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
          >
            {t.settingsKeepEditing}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SettingsModal({
  onClose,
  contractorName,
  businessName,
  onSave,          // async ({ displayName, businessName }) — called only on Done
  language, onLanguageChange,
  replyTranslation, onReplyTranslationChange,
  push,
  isOwner,
  onNavigateAdmin, // () => void — owners only; closes the modal and opens AdminPage
}) {
  const t = translations[language] || translations.en;

  // ── Snapshot originals at mount — never updated while modal is open ─────────
  // Using useRef instead of a second useState so it never triggers re-renders
  // and can never be accidentally overwritten by an effect.
  const originalName     = useRef(contractorName || '');
  const originalBusiness = useRef(businessName   || '');

  // ── Local draft — only propagates to parent on explicit Save ────────────────
  const [draftName,     setDraftName]     = useState(originalName.current);
  const [draftBusiness, setDraftBusiness] = useState(originalBusiness.current);

  // Intentionally NO useEffect syncing props→draft while modal is open.
  // Props only change after a successful save (which immediately closes the
  // modal), so syncing here would overwrite the user's in-progress edits.

  // ── Save state — declared first so handleCloseAttempt can reference it ───────
  const [saving,      setSaving]      = useState(false);
  const [toastStatus, setToastStatus] = useState(null); // null | 'success' | 'error'
  const closeTimer = useRef(null);

  // ── Dirty check ─────────────────────────────────────────────────────────────
  const hasChanges =
    draftName.trim()     !== originalName.current.trim()     ||
    draftBusiness.trim() !== originalBusiness.current.trim();

  // ── Discard-confirmation dialog ──────────────────────────────────────────────
  const [showDiscard, setShowDiscard] = useState(false);

  // Attempt to close: gate on unsaved changes
  const handleCloseAttempt = useCallback(() => {
    if (saving) return; // don't allow close mid-save
    if (hasChanges) {
      setShowDiscard(true);
    } else {
      onClose();
    }
  }, [saving, hasChanges, onClose]);

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setToastStatus(null);
    try {
      await onSave({ displayName: draftName.trim(), businessName: draftBusiness.trim() });
      setToastStatus('success');
      // Close directly — no discard dialog needed after a successful save
      closeTimer.current = setTimeout(onClose, 650);
    } catch {
      setToastStatus('error');
      setSaving(false);
    }
  }, [saving, draftName, draftBusiness, onSave, onClose]);

  // ── Gmail sync ──────────────────────────────────────────────────────────────
  const [syncing,    setSyncing]    = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncError,  setSyncError]  = useState(null);

  const handleGmailSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const result = await triggerGmailSync(60);
      setSyncResult(result);
    } catch (e) {
      setSyncError(e.message);
    } finally {
      setSyncing(false);
    }
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleCloseAttempt}
    >
      <div
        className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 max-h-[90dvh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Discard confirmation — overlays the modal content */}
        {showDiscard && (
          <DiscardDialog
            onKeep={() => setShowDiscard(false)}
            onDiscard={onClose}
            t={t}
          />
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">{t.settings}</h2>
          <button
            onClick={handleCloseAttempt}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form — scrollable */}
        <div className="px-6 py-5 space-y-5 overflow-y-auto">

          {/* Admin entry — owner-only, lives here instead of the bottom nav so
              the public surface stays at six items (the layout budget). Tap
              navigates to the Admin page and closes the modal in one move. */}
          {isOwner && onNavigateAdmin && (
            <button
              type="button"
              onClick={onNavigateAdmin}
              className="w-full flex items-center justify-between gap-3 bg-indigo-50 border border-indigo-100 rounded-lg px-4 py-3 hover:bg-indigo-100 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2a4 4 0 014-4h0a4 4 0 014 4v2M12 11a4 4 0 100-8 4 4 0 000 8zM3 20a9 9 0 0118 0" />
                  </svg>
                </span>
                <div className="min-w-0 text-left">
                  <p className="text-sm font-semibold text-indigo-900 truncate">{t.admin || 'Admin'}</p>
                  <p className="text-[11px] text-indigo-700/70 truncate">Manage users, numbers, demo data</p>
                </div>
              </div>
              <svg className="w-4 h-4 text-indigo-600 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}

          {/* Your Name */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              {t.yourName}
            </label>
            <input
              type="text"
              value={draftName}
              onChange={e => setDraftName(e.target.value)}
              placeholder={t.yourNamePlaceholder}
              className="w-full text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-400 mt-1">{t.yourNameHint}</p>
          </div>

          {/* Business Name */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              {t.businessName}
            </label>
            <input
              type="text"
              value={draftBusiness}
              onChange={e => setDraftBusiness(e.target.value)}
              placeholder={t.businessNamePlaceholder}
              className="w-full text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Reply Translation toggle */}
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {t.enableReplyTranslation}
            </p>
            <button
              onClick={() => onReplyTranslationChange(!replyTranslation)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none ${
                replyTranslation ? 'bg-blue-600' : 'bg-gray-200'
              }`}
              role="switch"
              aria-checked={replyTranslation}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                replyTranslation ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>

          {/* Voicemail Greeting */}
          <VoicemailGreetingEditor t={t} />

          {/* Gmail sync — owner-only */}
          {isOwner && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {t.settingsEmailSync}
              </label>
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-3 space-y-2">
                <p className="text-xs text-gray-500">
                  {t.settingsEmailSyncDesc}
                </p>
                <button
                  onClick={handleGmailSync}
                  disabled={syncing}
                  className="w-full py-2 text-sm font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-60"
                >
                  {syncing ? t.settingsSyncing : t.settingsSyncNow}
                </button>
                {syncResult && (
                  <p className="text-xs text-green-600 font-medium">
                    {t.settingsSyncDone} {syncResult.imported} {t.settingsSyncImported}, {syncResult.skipped} {t.settingsSyncSkipped}
                  </p>
                )}
                {syncError && <p className="text-xs text-red-500">{syncError}</p>}
              </div>
            </div>
          )}

          {/* Tester accounts — owner-only */}
          {isOwner && <TeamAdmin />}

          {/* Phone Numbers — owner-only */}
          {isOwner && <PhoneNumbersAdmin />}

          {/* Push Notifications */}
          {push?.supported && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {t.settingsPushTitle}
              </label>
              <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-gray-700 font-medium">
                    {push.subscribed ? t.settingsPushEnabled : push.permission === 'denied' ? t.settingsPushBlocked : t.settingsPushDisabled}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {push.subscribed
                      ? t.settingsPushDescOn
                      : push.permission === 'denied'
                      ? t.settingsPushDescBlocked
                      : t.settingsPushDescOff}
                  </p>
                  {push.error && <p className="text-xs text-red-500 mt-0.5">{push.error}</p>}
                </div>
                {push.permission !== 'denied' && (
                  <button
                    onClick={push.subscribed ? push.unsubscribe : push.subscribe}
                    disabled={push.subscribing}
                    className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors disabled:opacity-60 ${
                      push.subscribed
                        ? 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700'
                    }`}
                  >
                    {push.subscribing ? t.settingsPushWorking : push.subscribed ? t.settingsPushDisable : t.settingsPushEnable}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Build info — shows which frontend bundle is running. Critical for
              diagnosing "browser shows X, phone shows Y" — the values here
              prove whether the device is on the live Vercel build or a stale
              bundled copy. Tap "Hard Refresh" to bust the WebView cache. */}
          <BuildInfoPanel />

          {/* Language */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              {t.language}
            </label>
            <div className="flex rounded-lg overflow-hidden border border-gray-200">
              <button
                onClick={() => onLanguageChange('en')}
                className={`flex-1 text-sm py-2.5 font-medium transition-colors ${
                  language === 'en' ? 'bg-gray-900 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                English
              </button>
              <button
                onClick={() => onLanguageChange('es')}
                className={`flex-1 text-sm py-2.5 font-medium border-l border-gray-200 transition-colors ${
                  language === 'es' ? 'bg-gray-900 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                Español
              </button>
            </div>
          </div>

        </div>

        {/* Save result toast */}
        <SaveToast status={toastStatus} t={t} />

        {/* Footer */}
        <div className="px-6 pb-5 shrink-0">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold rounded-lg py-2.5 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                {t.settingsSaving}
              </>
            ) : (
              t.done
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
