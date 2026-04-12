import { useState, useRef, useEffect } from 'react';

const ACCEPTED_MIME = 'image/jpeg,image/jpg,image/png,image/gif,image/webp';
const MAX_FILES = 5;

export default function MessageInput({ onSend, placeholder = 'Message…', disabled = false }) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState([]); // File[]
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Auto-resize textarea up to ~5 lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);

  const handleSend = () => {
    const text = value.trim();
    if ((!text && attachments.length === 0) || disabled) return;
    onSend(text, attachments);
    setValue('');
    setAttachments([]);
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

  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div className="shrink-0 border-t border-gray-100 bg-white px-4 py-3">

      {/* Image preview strip */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((file, i) => {
            const url = URL.createObjectURL(file);
            return (
              <div key={i} className="relative group w-16 h-16 rounded-lg overflow-hidden border border-gray-200 bg-gray-100 shrink-0">
                <img
                  src={url}
                  alt={file.name}
                  className="w-full h-full object-cover"
                  onLoad={() => URL.revokeObjectURL(url)}
                />
                <button
                  onClick={() => removeAttachment(i)}
                  aria-label="Remove attachment"
                  className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity text-white text-lg leading-none"
                >
                  ×
                </button>
              </div>
            );
          })}
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
        Enter to send · Shift+Enter for new line
      </p>
    </div>
  );
}
