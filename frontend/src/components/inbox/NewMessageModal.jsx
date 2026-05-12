import { useState, useRef, useEffect } from 'react';
import { translations } from '../../i18n';
import { normalizePhone } from '../../utils/phone';

const ACCEPTED_MIME = 'image/jpeg,image/jpg,image/png,image/gif,image/webp';
const MAX_FILES = 5;

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
  const [attachments,     setAttachments]     = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Picked from the autocomplete dropdown. Cleared the moment the user edits
  // the field so we never claim a contact selection that doesn't match what's
  // currently in the input.
  const [selectedContact,  setSelectedContact]  = useState(null);
  // `true` after the field loses focus or the user attempts to send — gates
  // when the inline validation error is shown so it doesn't flash on the
  // very first keystroke.
  const [recipientTouched, setRecipientTouched] = useState(false);
  // Index of the attachment currently shown in the full-size preview overlay;
  // null when no preview is open.
  const [previewIdx,       setPreviewIdx]       = useState(null);
  // Stable per-file blob URLs. Created in an effect so each File has exactly
  // one URL for its lifetime in this modal, and so URLs are revoked when the
  // attachment list changes (or the modal unmounts). Render-time
  // createObjectURL + onLoad revoke is unsafe — re-renders create new URLs
  // and break the preview overlay that needs the URL to stay alive.
  const [attachmentUrls,   setAttachmentUrls]   = useState([]);

  const phoneRef       = useRef(null);
  const messageRef     = useRef(null);
  const fileInputRef   = useRef(null);
  const dropdownRef    = useRef(null);

  // Auto-focus the To field on open
  useEffect(() => { phoneRef.current?.focus(); }, []);

  // Create one stable blob URL per attached File. Revoke on cleanup so we
  // don't leak object URLs when attachments change or the modal closes.
  useEffect(() => {
    const urls = attachments.map(file => URL.createObjectURL(file));
    setAttachmentUrls(urls);
    return () => { urls.forEach(u => URL.revokeObjectURL(u)); };
  }, [attachments]);

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
  // A recipient is valid if EITHER the user selected a contact from the
  // dropdown OR their typed text normalizes to a 10-digit US number.
  // normalizePhone() already accepts formatted variants like "(203) 555-1212"
  // and 11-digit "+1..." input — both collapse to the same 10-digit string.
  const typedDigits = normalizePhone(phone);
  const isValidTypedPhone = typedDigits.length === 10;
  const resolvedPhone = selectedContact?.phone || (isValidTypedPhone ? typedDigits : null);
  const hasValidRecipient = !!resolvedPhone;

  // Inline error: shown only after the user has interacted past the field
  // (blurred it or attempted to send) so it doesn't fire mid-keystroke.
  const showRecipientError = recipientTouched && phone.trim().length > 0 && !hasValidRecipient;

  // ── Actions ────────────────────────────────────────────────────────────────
  function handleSend() {
    if (!hasValidRecipient) {
      // Surface the validation error if the user clicks Send without a valid
      // recipient. Send button is disabled in this case, but the keyboard
      // shortcut (Cmd/Ctrl+Enter) can still trigger this path.
      setRecipientTouched(true);
      return;
    }
    const m = message.trim();
    if (!m && attachments.length === 0) return;
    onSend(resolvedPhone, m, attachments);
    onClose();
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
    setAttachments(prev => [...prev, ...picked].slice(0, MAX_FILES));
    e.target.value = '';
  }

  function removeAttachment(i, e) {
    // Always called from the explicit X badge — stopPropagation prevents the
    // thumbnail click handler (which opens the preview) from also firing.
    if (e) e.stopPropagation();
    setAttachments(prev => prev.filter((_, idx) => idx !== i));
    // Keep the open preview aligned with the new attachment list:
    //   • removed the one being previewed → close preview
    //   • removed one before it → shift the index down so the same image stays open
    setPreviewIdx(prev => {
      if (prev === null) return null;
      if (prev === i)   return null;
      if (prev > i)     return prev - 1;
      return prev;
    });
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

          {/* Inline validation error — shown only after the user has finished
              interacting with the field, never mid-keystroke. */}
          {showRecipientError && (
            <p className="mt-1 text-[11px] text-red-500 leading-snug">
              {t.inboxRecipientInvalid || 'Select a contact or enter a valid phone number.'}
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
            {attachments.map((file, i) => (
              <div key={i} className="relative w-16 h-16 shrink-0">
                {/* Image, tap-to-preview */}
                <button
                  type="button"
                  onClick={() => setPreviewIdx(i)}
                  aria-label={`Preview ${file.name}`}
                  className="block w-full h-full rounded-lg overflow-hidden border border-gray-200 bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  {attachmentUrls[i] && (
                    <img
                      src={attachmentUrls[i]}
                      alt={file.name}
                      className="w-full h-full object-cover"
                    />
                  )}
                </button>
                {/* Remove badge — always visible, top-right, explicit only */}
                <button
                  type="button"
                  onClick={e => removeAttachment(i, e)}
                  aria-label={`Remove ${file.name}`}
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

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="text-sm px-4 py-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            {t.inboxCancel}
          </button>
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="text-sm px-5 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {t.inboxSend}
          </button>
        </div>

        {/* ── Full-size attachment preview overlay ─────────────────────────────
            Rendered INSIDE the inner modal div so the surrounding
            stopPropagation prevents backdrop taps from also dismissing the
            New Message modal. Tap the backdrop or the X to close. Tap the
            image itself does nothing — stopPropagation on the <img> click
            keeps the preview open while the user looks. */}
        {previewIdx !== null && attachmentUrls[previewIdx] && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Attachment preview"
            className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-4"
            onClick={() => setPreviewIdx(null)}
            onKeyDown={e => { if (e.key === 'Escape') setPreviewIdx(null); }}
          >
            <button
              type="button"
              onClick={() => setPreviewIdx(null)}
              aria-label="Close preview"
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors focus:outline-none focus:ring-2 focus:ring-white/40"
              style={{ top: 'calc(env(safe-area-inset-top) + 1rem)' }}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <img
              src={attachmentUrls[previewIdx]}
              alt={attachments[previewIdx]?.name || 'Attachment'}
              onClick={e => e.stopPropagation()}
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl select-none"
              draggable={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}
