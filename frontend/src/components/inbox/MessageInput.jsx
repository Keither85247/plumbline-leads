import { useState, useRef, useEffect } from 'react';

export default function MessageInput({ onSend, placeholder = 'Message…', disabled = false }) {
  const [value, setValue] = useState('');
  const textareaRef = useRef(null);

  // Auto-resize textarea up to ~5 lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);

  const handleSend = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
    // Reset height
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div className="shrink-0 border-t border-gray-100 bg-white px-4 py-3">
      <div className="flex items-end gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus-within:ring-1 focus-within:ring-blue-400 focus-within:border-blue-400 transition-colors">

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
