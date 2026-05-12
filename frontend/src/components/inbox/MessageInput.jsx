import { useState, useRef, useEffect } from 'react';
import { translations } from '../../i18n';

const ACCEPTED_MIME = 'image/jpeg,image/jpg,image/png,image/gif,image/webp';
const MAX_FILES = 5;

export default function MessageInput({ onSend, placeholder = 'Message…', disabled = false }) {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;

  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState([]); // File[]
  const [previewIdx, setPreviewIdx] = useState(null);
  const [attachmentUrls, setAttachmentUrls] = useState([]);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Auto-resize textarea up to ~5 lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);

  // One stable blob URL per attached File; revoke on attachment change /
  // unmount so we never leak object URLs.
  useEffect(() => {
    const urls = attachments.map(f => URL.createObjectURL(f));
    setAttachmentUrls(urls);
    return () => { urls.forEach(u => URL.revokeObjectURL(u)); };
  }, [attachments]);

  const handleSend = () => {
    const text = value.trim();
    if ((!text && attachments.length === 0) || disabled) return;
    onSend(text, attachments);
    setValue('');
    setAttachments([]);
    setPreviewIdx(null);
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
    setAttachments(prev => {
      const combined = [...prev, ...picked];
      return combined.slice(0, MAX_FILES); // cap at 5
    });
    // Reset file input so the same file can be picked again later
    e.target.value = '';
  };

  const removeAttachment = (index, e) => {
    // Always called from the explicit X badge — stopPropagation prevents the
    // thumbnail's tap-to-preview from also firing.
    if (e) e.stopPropagation();
    setAttachments(prev => prev.filter((_, i) => i !== index));
    // Keep the preview aligned with the new list
    setPreviewIdx(prev => {
      if (prev === null) return null;
      if (prev === index) return null;
      if (prev > index)   return prev - 1;
      return prev;
    });
  };

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div className="shrink-0 border-t border-gray-100 bg-white px-4 py-3">

      {/* Image thumbnail strip — tap image to preview, tap X badge to remove.
          The previous design overlaid an invisible full-cover remove button
          on the image, which on mobile (no hover) silently deleted any
          attachment the user only meant to look at. */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-2 pt-1">
          {attachments.map((file, i) => (
            <div key={i} className="relative w-16 h-16 shrink-0">
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

      {/* Full-size attachment preview overlay */}
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
            className="absolute right-4 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20 transition-colors focus:outline-none focus:ring-2 focus:ring-white/40"
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
