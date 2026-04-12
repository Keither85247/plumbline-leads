import { useState, useRef, useEffect } from 'react';

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
  const [phone,           setPhone]           = useState('');
  const [message,         setMessage]         = useState('');
  const [attachments,     setAttachments]     = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const phoneRef       = useRef(null);
  const messageRef     = useRef(null);
  const fileInputRef   = useRef(null);
  const dropdownRef    = useRef(null);

  // Auto-focus the To field on open
  useEffect(() => { phoneRef.current?.focus(); }, []);

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

  // ── Actions ────────────────────────────────────────────────────────────────
  function handleSend() {
    const p = phone.trim();
    const m = message.trim();
    if (!p || (!m && attachments.length === 0)) return;
    onSend(p, m, attachments);
    onClose();
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { handleSend(); }
  }

  function handleSelectSuggestion(conv) {
    setPhone(conv.phone);
    setShowSuggestions(false);
    // Move focus to message field after selection
    setTimeout(() => messageRef.current?.focus(), 0);
  }

  function handleFileChange(e) {
    const picked = Array.from(e.target.files || []);
    setAttachments(prev => [...prev, ...picked].slice(0, MAX_FILES));
    e.target.value = '';
  }

  function removeAttachment(i) {
    setAttachments(prev => prev.filter((_, idx) => idx !== i));
  }

  const canSend = phone.trim().length > 0 && (message.trim().length > 0 || attachments.length > 0);

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
          <h3 className="text-sm font-semibold text-gray-900">New message</h3>
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
          <label className="block text-xs text-gray-500 mb-1.5">To</label>
          <input
            ref={phoneRef}
            type="tel"
            value={phone}
            onChange={e => { setPhone(e.target.value); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            placeholder="Name or phone number"
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-400"
          />

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

        {/* ── Attachment preview strip ─────────────────────────────────────── */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((file, i) => {
              const url = URL.createObjectURL(file);
              return (
                <div
                  key={i}
                  className="relative group w-14 h-14 rounded-lg overflow-hidden border border-gray-200 bg-gray-100 shrink-0"
                >
                  <img
                    src={url}
                    alt={file.name}
                    className="w-full h-full object-cover"
                    onLoad={() => URL.revokeObjectURL(url)}
                  />
                  <button
                    onClick={() => removeAttachment(i)}
                    aria-label="Remove attachment"
                    className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity text-white text-xl leading-none"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Message textarea + attach button ─────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs text-gray-500">Message</label>

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
              Attach photo
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
            placeholder={attachments.length > 0 ? 'Add a caption… (optional)' : 'Type a message…'}
            rows={3}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-400"
          />
          <p className="text-[11px] text-gray-400 mt-1">⌘ + Enter to send</p>
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="text-sm px-4 py-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="text-sm px-5 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
