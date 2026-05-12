import { useState, useRef, useEffect } from 'react';
import { translations } from '../../i18n';
import { normalizePhone, isUsCaPhone } from '../../utils/phone';

const ACCEPTED_MIME = 'image/jpeg,image/jpg,image/png,image/gif,image/webp';
const MAX_FILES = 5;

// Stable id per attachment so React keys + preview lookups don't depend on
// array index. crypto.randomUUID is available in all modern browsers and on
// recent Capacitor webviews; Date+Math is a safe fallback.
function makeAttachmentId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatPhoneDisplay(num) {
  if (!num) return '';
  const d = num.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return num;
}

/**
 * NewMessageModal — compose a new SMS/MMS to any phone number.
 *
 * Props:
 *   onSend(phone, text, files[])  called when the user hits Send
 *   onClose()                     called to dismiss
 *   conversations[]               used for To-field autocomplete
 */
export default function NewMessageModal({ onSend, onClose, conversations = [] }) {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;

  const [phone,           setPhone]           = useState('');
  const [message,         setMessage]         = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Each attachment is { id, file, url } where `url` is a blob URL created
  // ONCE when the file is attached (in handleFileChange) and revoked only
  // when that attachment is explicitly removed or the modal unmounts. This
  // decouples URL lifecycle from React's render cycle — typing in the phone
  // or message fields cannot regenerate URLs or remount thumbnails. The
  // previous shape (parallel File[] + string[] derived in a useEffect) caused
  // visible flicker because adding a second file revoked-and-recreated the
  // first file's URL through the effect.
  const [attachments,     setAttachments]     = useState([]);

  // Picked from the autocomplete dropdown. Cleared the moment the user edits
  // the field so we never claim a contact selection that doesn't match what's
  // currently in the input.
  const [selectedContact,  setSelectedContact]  = useState(null);
  // `true` after the field loses focus or the user attempts to send — gates
  // when the inline validation error is shown so it doesn't flash on the
  // very first keystroke.
  const [recipientTouched, setRecipientTouched] = useState(false);
  // Id of the attachment currently shown in the preview overlay; null when
  // no preview is open. Id-keyed instead of index so removing one attachment
  // never re-aims the preview at the wrong image.
  const [previewId,        setPreviewId]        = useState(null);
  // Inline send-error state. Set when the backend rejects the message (e.g.
  // INTERNATIONAL_SMS_DISABLED). Cleared on any subsequent edit so the user
  // can fix the input and retry without dismissing a modal.
  const [sendError,        setSendError]        = useState(null);
  const [sending,          setSending]          = useState(false);

  const phoneRef       = useRef(null);
  const messageRef     = useRef(null);
  const fileInputRef   = useRef(null);
  const dropdownRef    = useRef(null);

  // Auto-focus the To field on open
  useEffect(() => { phoneRef.current?.focus(); }, []);

  // Mirror current attachments into a ref so the unmount cleanup can revoke
  // every blob URL that's still alive without taking a dep on `attachments`
  // (which would defeat the whole stability guarantee).
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => {
    attachmentsRef.current.forEach(a => URL.revokeObjectURL(a.url));
  }, []);

  // Close suggestion dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        phoneRef.current    && !phoneRef.current.contains(e.target)
      ) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ── Autocomplete suggestions ───────────────────────────────────────────────
  // Empty query → show 8 most recent. Non-empty → filter by name or phone digits.
  const suggestions = (() => {
    const q = phone.trim().toLowerCase();
    if (!q) return conversations.slice(0, 8);
    const qDigits = q.replace(/\D/g, '');
    return conversations
      .filter(c =>
        c.name?.toLowerCase().includes(q) ||
        (qDigits && c.phone?.replace(/\D/g, '').includes(qDigits))
      )
      .slice(0, 8);
  })();

  // ── Recipient resolution + validation ──────────────────────────────────────
  // The candidate phone string we'd send to — either the selected contact's
  // raw phone or the typed text. We use this string (NOT a coerced 10-digit
  // form) when validating so an international contact like "+44 ..." is
  // recognised as international and rejected up front instead of being
  // silently normalised into a fake US number.
  const candidatePhone = selectedContact?.phone ?? phone;
  const isUsCa = isUsCaPhone(candidatePhone);
  const typedDigits = normalizePhone(candidatePhone);
  // Only resolve a phone when it's US/Canada — backend won't accept anything
  // else for non-owner accounts, so we shouldn't even attempt the send.
  const resolvedPhone = isUsCa ? typedDigits : null;
  const hasValidRecipient = !!resolvedPhone;

  // Distinguish "user typed something that looks international" from "blank
  // or too-short" so the inline error can be specific.
  const looksInternational = (() => {
    if (!candidatePhone) return false;
    const trimmed = String(candidatePhone).trim();
    if (!trimmed) return false;
    if (isUsCa) return false;
    // Explicit + prefix that isn't +1
    if (trimmed.startsWith('+') && !/^\+1[\s\d]/.test(trimmed)) return true;
    // Long-but-not-NANP digit sequence (e.g. 12-digit UK without +)
    const digits = trimmed.replace(/\D/g, '');
    return digits.length >= 11 && !(digits.length === 11 && digits.startsWith('1'));
  })();

  // Inline error: shown only after the user has interacted past the field
  // (blurred it or attempted to send) so it doesn't fire mid-keystroke.
  const showRecipientError = recipientTouched && phone.trim().length > 0 && !hasValidRecipient;

  // ── Actions ────────────────────────────────────────────────────────────────
  async function handleSend() {
    if (!hasValidRecipient) {
      // Surface the validation error if the user clicks Send without a valid
      // recipient. Send button is disabled in this case, but the keyboard
      // shortcut (Cmd/Ctrl+Enter) can still trigger this path.
      setRecipientTouched(true);
      return;
    }
    const m = message.trim();
    if (!m && attachments.length === 0) return;

    setSending(true);
    setSendError(null);
    try {
      // Parent expects File[] for FormData uploading. Strip our wrapper objects.
      // We AWAIT onSend so we know if the send actually succeeded — only then
      // do we close the modal. The previous code called onClose() synchronously
      // and lost the compose state if the send threw afterwards.
      await onSend(resolvedPhone, m, attachments.map(a => a.file));
      onClose();
    } catch (err) {
      // Map known backend codes to inline, actionable messages. Anything else
      // falls back to the raw error — still shown inline, not as an alert.
      const friendly =
        err?.code === 'INTERNATIONAL_SMS_DISABLED'
          ? 'International messaging is currently supported only for US and Canada numbers.'
          : (err?.message || 'Failed to send message. Please try again.');
      setSendError(friendly);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { handleSend(); }
  }

  function handleRecipientChange(e) {
    setPhone(e.target.value);
    setShowSuggestions(true);
    // The instant the user edits the field, any prior contact selection is
    // no longer trustworthy — clear it so validation goes back to "is this a
    // valid raw phone number?" rather than honouring a stale selection.
    if (selectedContact) setSelectedContact(null);
    // Any edit clears the last server-side send error so the user can retry.
    if (sendError) setSendError(null);
  }

  function handleSelectSuggestion(conv) {
    setPhone(conv.phone);
    setSelectedContact(conv);
    setShowSuggestions(false);
    setRecipientTouched(true);
    // Move focus to message field after selection
    setTimeout(() => messageRef.current?.focus(), 0);
  }

  function handleFileChange(e) {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    if (picked.length === 0) return;
    setAttachments(prev => {
      const room     = Math.max(0, MAX_FILES - prev.length);
      const accepted = picked.slice(0, room);
      // URL is created once, here. It lives on the attachment object for the
      // rest of its lifecycle. No effect will ever regenerate it.
      const newOnes  = accepted.map(file => ({
        id:   makeAttachmentId(),
        file,
        url:  URL.createObjectURL(file),
      }));
      return [...prev, ...newOnes];
    });
  }

  function removeAttachment(id, e) {
    // Always called from the explicit X badge — stopPropagation prevents the
    // thumbnail's tap-to-preview handler from also firing.
    if (e) e.stopPropagation();
    setAttachments(prev => {
      const target = prev.find(a => a.id === id);
      if (target) URL.revokeObjectURL(target.url); // revoke ONLY this URL
      return prev.filter(a => a.id !== id);
    });
    setPreviewId(prev => (prev === id ? null : prev));
  }

  const canSend = hasValidRecipient && (message.trim().length > 0 || attachments.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-white w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl shadow-2xl px-5 pt-5 pb-6 sm:pb-5 flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">{t.inboxNewMessage}</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── To field with autocomplete ───────────────────────────────────── */}
        <div className="relative">
          <label className="block text-xs text-gray-500 mb-1.5">{t.inboxToLabel}</label>
          <input
            ref={phoneRef}
            // Plain text input — the field accepts BOTH contact names and raw
            // phone numbers, so we cannot use type="tel" / inputMode="numeric"
            // (those open a numeric-only keypad on mobile and block letters).
            // The autocomplete dropdown below filters by name OR phone digits.
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="words"
            spellCheck={false}
            value={phone}
            onChange={handleRecipientChange}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setRecipientTouched(true)}
            placeholder={t.inboxToNamePH}
            className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 placeholder:text-gray-400 ${
              showRecipientError
                ? 'border-red-300 focus:ring-red-400'
                : 'border-gray-200 focus:ring-blue-400'
            }`}
          />

          {/* Inline validation error. International numbers get a
              specific message; everything else (blank, too short, gibberish)
              falls through to the generic prompt. */}
          {showRecipientError && (
            <p className="mt-1 text-[11px] text-red-500 leading-snug">
              {looksInternational
                ? (t.inboxIntlSmsDisabled || 'International messaging is currently supported only for US and Canada numbers.')
                : (t.inboxRecipientInvalid  || 'Select a contact or enter a valid phone number.')}
            </p>
          )}

          {/* Suggestions dropdown */}
          {showSuggestions && suggestions.length > 0 && (
            <ul
              ref={dropdownRef}
              className="absolute z-20 top-full mt-1 left-0 right-0 bg-white border border-gray-200 rounded-xl shadow-lg max-h-52 overflow-y-auto"
            >
              {suggestions.map(conv => (
                <li key={conv.id}>
                  <button
                    type="button"
                    // onMouseDown prevents the input blur from firing before the click registers
                    onMouseDown={e => { e.preventDefault(); handleSelectSuggestion(conv); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                      <span className="text-[10px] font-semibold text-blue-700">
                        {conv.name?.charAt(0).toUpperCase() || '?'}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate leading-tight">
                        {conv.name !== conv.phone ? conv.name : formatPhoneDisplay(conv.phone)}
                      </p>
                      {conv.name !== conv.phone && (
                        <p className="text-[11px] text-gray-400 leading-tight">
                          {formatPhoneDisplay(conv.phone)}
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Attachment thumbnail strip ──────────────────────────────────────
            Two completely separate interactions per thumbnail:
              • tap the IMAGE              → opens preview overlay
              • tap the X badge (top-right) → removes the attachment
            The X badge sits outside the thumbnail's clip area and has
            stopPropagation on its click, so it can never trigger the preview
            and the preview tap can never trigger a remove. Previous design
            put an invisible full-cover remove button over the image, which
            on mobile (no hover) silently removed attachments the user only
            intended to look at. */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-3 pt-1">
            {attachments.map(att => (
              // Key by stable id, not index — index keys would cause React to
              // re-associate <img> elements when an attachment is removed,
              // possibly remounting and reloading sibling thumbnails.
              <div key={att.id} className="relative w-16 h-16 shrink-0">
                {/* Image, tap-to-preview */}
                <button
                  type="button"
                  onClick={() => setPreviewId(att.id)}
                  aria-label={`Preview ${att.file.name}`}
                  className="block w-full h-full rounded-lg overflow-hidden border border-gray-200 bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <img
                    src={att.url}
                    alt={att.file.name}
                    className="w-full h-full object-cover"
                  />
                </button>
                {/* Remove badge — always visible, top-right, explicit only */}
                <button
                  type="button"
                  onClick={e => removeAttachment(att.id, e)}
                  aria-label={`Remove ${att.file.name}`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-900 text-white shadow-md flex items-center justify-center hover:bg-black focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Message textarea + attach button ─────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs text-gray-500">{t.inboxMessageLabel}</label>

            {/* Paperclip / attach button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_FILES}
              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition-colors ${
                attachments.length >= MAX_FILES
                  ? 'text-gray-300 cursor-not-allowed'
                  : 'text-gray-400 hover:text-blue-500 hover:bg-gray-100'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
              {t.inboxAttachPhoto}
            </button>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_MIME}
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          <textarea
            ref={messageRef}
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder={attachments.length > 0 ? t.inboxCaptionPH : t.inboxTypePH}
            rows={3}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-400"
          />
          <p className="text-[11px] text-gray-400 mt-1">{t.inboxCmdEnter}</p>
        </div>

        {/* Server-side send error — non-destructive inline banner. Compose
            state is fully preserved; user can edit and retry directly. */}
        {sendError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[12px] leading-snug text-red-600">
            {sendError}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={sending}
            className="text-sm px-4 py-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t.inboxCancel}
          </button>
          <button
            onClick={handleSend}
            disabled={!canSend || sending}
            className="text-sm px-5 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? (t.inboxSending || 'Sending…') : t.inboxSend}
          </button>
        </div>

        {/* ── Full-size attachment preview overlay ─────────────────────────────
            Looked up by stable id (not array index) so removing an
            attachment can never silently re-aim the preview at the wrong
            image. Rendered INSIDE the inner modal div so the surrounding
            stopPropagation prevents backdrop taps from also dismissing the
            New Message modal. */}
        {(() => {
          const previewAtt = previewId
            ? attachments.find(a => a.id === previewId)
            : null;
          if (!previewAtt) return null;
          return (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Attachment preview"
              className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-4"
              onClick={() => setPreviewId(null)}
              onKeyDown={e => { if (e.key === 'Escape') setPreviewId(null); }}
            >
              <button
                type="button"
                onClick={() => setPreviewId(null)}
                aria-label="Close preview"
                className="absolute right-4 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors focus:outline-none focus:ring-2 focus:ring-white/40"
                style={{ top: 'calc(env(safe-area-inset-top) + 1rem)' }}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <img
                src={previewAtt.url}
                alt={previewAtt.file.name}
                onClick={e => e.stopPropagation()}
                className="max-w-full max-h-full object-contain rounded-lg shadow-2xl select-none"
                draggable={false}
              />
            </div>
          );
        })()}
      </div>
    </div>
  );
}
