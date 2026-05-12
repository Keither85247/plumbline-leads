// Single row in the conversation list sidebar.
//
// The outer element is a `role="button"` div (not a real <button>) so we can
// nest the per-row overflow-menu button inside it. Nesting interactive
// elements inside a <button> is invalid HTML and breaks on some browsers /
// screen readers.
import { useEffect, useRef, useState } from 'react';
import { parseTimestamp } from '../../utils/phone';
import { translations } from '../../i18n';

function formatTimestamp(iso) {
  if (!iso) return '';
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;
  const date = parseTimestamp(iso);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1)  return t.timeJustNow;
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yestStart  = new Date(todayStart); yestStart.setDate(todayStart.getDate() - 1);
  if (date >= yestStart) return t.timeYesterday;
  if (diffHours < 24 * 7) {
    return date.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { weekday: 'short' });
  }
  return date.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric' });
}

export default function ConversationItem({ conversation, selected, onClick, onDelete }) {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;
  const { name, phone, lastMessage, lastMessageDir, timestamp, unread } = conversation;
  const hasUnread = unread > 0;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);

  // Close the dropdown when the user taps outside it or presses Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function handleOutside(e) {
      if (
        menuRef.current && !menuRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) setMenuOpen(false);
    }
    function handleEsc(e) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [menuOpen]);

  function handleRowKey(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  function handleMenuClick(e) {
    e.stopPropagation();
    setMenuOpen(o => !o);
  }

  function handleDeleteClick(e) {
    e.stopPropagation();
    setMenuOpen(false);
    onDelete?.(conversation);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleRowKey}
      className={`
        relative w-full text-left px-4 py-3 flex items-start gap-3
        transition-colors duration-100 border-l-2 outline-none cursor-pointer
        ${selected
          ? 'bg-gray-50 border-blue-500'
          : 'border-transparent hover:bg-gray-50/70 active:bg-gray-100'}
      `}
    >
      {/* Avatar */}
      <div className={`
        shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold
        ${selected ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}
      `}>
        {name?.charAt(0).toUpperCase() || '?'}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pr-7">
        <div className="flex items-baseline justify-between gap-2 mb-0.5">
          <span className={`text-sm leading-snug truncate ${hasUnread ? 'font-semibold text-gray-900' : 'font-medium text-gray-800'}`}>
            {name || phone}
          </span>
          <span className="shrink-0 text-[11px] text-gray-400 leading-none">{formatTimestamp(timestamp)}</span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className={`text-xs truncate leading-snug ${hasUnread ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>
            {lastMessageDir === 'outbound' && <span className="text-gray-300 mr-0.5">↑</span>}
            {lastMessage}
          </p>
          {hasUnread && (
            <span className="shrink-0 min-w-[18px] h-[18px] px-1 bg-blue-600 text-white rounded-full text-[10px] font-semibold flex items-center justify-center leading-none">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </div>
      </div>

      {/* Overflow menu trigger — always visible, top-right. The wrapper above
          has pr-7 so this never overlaps the timestamp/preview text. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleMenuClick}
        aria-label={t.inboxConvOptions || 'Conversation options'}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="absolute top-2.5 right-2 w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute top-9 right-2 z-30 bg-white rounded-lg shadow-lg border border-gray-200 py-1 w-44"
          onClick={e => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleDeleteClick}
            className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none transition-colors"
          >
            {t.inboxDeleteConv || 'Delete conversation'}
          </button>
        </div>
      )}
    </div>
  );
}
