import { useState, useRef, useEffect } from 'react';
import { translations } from '../../i18n';

const ACCEPTED_MIME = 'image/jpeg,image/jpg,image/png,image/gif,image/webp';
const MAX_FILES = 5;

// Stable id per attachment so React keys + preview lookups don't depend on
// array index. crypto.randomUUID is available in modern browsers; fallback
// for older webviews.
function makeAttachmentId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function MessageInput({ onSend, placeholder = 'Message…', disabled = false }) {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;

  const [value, setValue] = useState('');

  // Each attachment is { id, file, url }. URL is created once when attached
  // (handleFileChange) and revoked only on explicit remove / send / unmount.
  // No useEffect derives URLs from a File[] — that pattern was regenerating
  // URLs whenever the attachments reference changed and made the first
  // thumbnail flicker every time another file was added.
  const [attachments, setAttachments] = useState([]);
  const [previewId,   setPreviewId]   = useState(null);

  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Auto-resize textarea up to ~5 lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);

  // Mirror attachments into a ref so the unmount cleanup revokes any
  // still-alive URLs without re-running on every attachments change.
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => {
    attachmentsRef.current.forEach(a => URL.revokeObjectURL(a.url));
  }, []);

  const handleSend = () => {
    const text = value.trim();
    if ((!text && attachments.length === 0) || disabled) return;
    // Parent expects File[]. Revoke URLs now since the in-thread component
    // doesn't unmount on send — sending clears state but the component stays
    // mounted for the next message.
    onSend(text, attachments.map(a => a.file));
    attachments.forEach(a => URL.revokeObjectURL(a.url));
    setValue('');
    setAttachments([]);
    setPreviewId(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileChange = (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    if (picked.length === 0) return;
    setAttachments(prev => {
      const room     = Math.max(0, MAX_FILES - prev.length);
      const accepted = picked.slice(0, room);
      const newOnes  = accepted.map(file => ({
        id:   makeAttachmentId(),
        file,
        url:  URL.createObjectURL(file),
      }));
      return [...prev, ...newOnes];
    });
  };

  const removeAttachment = (id, e) => {
    if (e) e.stopPropagation();
    setAttachments(prev => {
      const target = prev.find(a => a.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter(a => a.id !== id);
    });
    setPreviewId(prev => (prev === id ? null : prev));
  };

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div className="shrink-0 border-t border-gray-100 bg-white px-4 py-3">

      {/* Image thumbnail strip — tap image to preview, tap X badge to remove.
          Atomic attachment objects ({id, file, url}) so URLs never regenerate
          across re-renders and React keys remain stable when items are
          removed. */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-2 pt-1">
          {attachments.map(att => (
            <div key={att.id} className="relative w-16 h-16 shrink-0">
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

      {/* Full-size attachment preview overlay — looked up by id, never index */}
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

      <div className="flex items-end gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus-within:ring-1 focus-within:ring-blue-400 focus-within:border-blue-400 transition-colors">

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_MIME}
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        {/* Paperclip / attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || attachments.length >= MAX_FILES}
          aria-label="Attach image"
          className={`
            shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors
            ${disabled || attachments.length >= MAX_FILES
              ? 'text-gray-300 cursor-not-allowed'
              : 'text-gray-400 hover:text-blue-500 hover:bg-gray-100'}
          `}
        >
          {/* Paperclip icon */}
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400 resize-none outline-none leading-relaxed py-0.5 min-h-[22px] max-h-[140px]"
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          aria-label="Send message"
          className={`
            shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-150
            ${canSend
              ? 'bg-blue-600 hover:bg-blue-700 active:scale-95 text-white'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'}
          `}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <p className="mt-1.5 text-[10px] text-gray-400 text-right">
        {t.inboxEnterToSend}
      </p>
    </div>
  );
}
