// Single row in the conversation list. The outer element is a `role="button"`
// div (not a real <button>) so we can nest the per-row overflow-menu button
// inside it without producing invalid HTML.
import { useEffect, useRef, useState } from 'react';
import { parseTimestamp } from '../../utils/phone';
import { translations } from '../../i18n';
import SwipeableRow from '../ui/SwipeableRow';
import Avatar from '../ui/Avatar';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Icons ──────────────────────────────────────────────────────────────────

const PhoneArrowIcon = ({ className = 'w-4 h-4' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M15 3h6m0 0v6m0-6L14 10" />
  </svg>
);

const TrashIcon = ({ className = 'w-4 h-4' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

// ─── Component ──────────────────────────────────────────────────────────────

export default function ConversationItem({
  conversation,
  lead,
  voiceDevice,
  selected,
  onClick,
  onDelete,
}) {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;
  const { name, phone, lastMessage, lastMessageDir, timestamp, unread } = conversation;
  const hasUnread = unread > 0;

  // CRM enrichment — derive everything the row knows from the lead overlay.
  const category   = lead?.category || 'Lead';
  const hasAIDraft = !!(lead?.follow_up_text && lead.status === 'New');

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);

  // Close the dropdown on outside click or Escape (unchanged from previous version).
  useEffect(() => {
    if (!menuOpen) return;
    function handleOutside(e) {
      if (
        menuRef.current && !menuRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) setMenuOpen(false);
    }
    function handleEsc(e) { if (e.key === 'Escape') setMenuOpen(false); }
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

  // Swipe-right callback — only enabled when we have a voice device that
  // can actually make calls. Otherwise the swipe is a no-op (still scrolls
  // visually but doesn't trigger anything misleading).
  const canCall = !!(voiceDevice?.makeCall && voiceDevice?.status !== 'connected' && voiceDevice?.status !== 'dialing');
  const handleSwipeCall = () => {
    if (!canCall) return;
    voiceDevice.makeCall(phone);
  };

  return (
    <SwipeableRow
      disabled={selected}
      leftAction={canCall ? {
        icon: <PhoneArrowIcon />,
        label: t.inboxSwipeCall || 'Call',
        color: 'bg-status-new',
        onTrigger: handleSwipeCall,
      } : undefined}
      rightAction={{
        icon: <TrashIcon />,
        label: t.inboxSwipeDelete || 'Delete',
        color: 'bg-status-urgent',
        onTrigger: () => onDelete?.(conversation),
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleRowKey}
        className={`
          relative w-full text-left px-4 py-3 flex items-start gap-3
          transition-colors duration-100 outline-none cursor-pointer
          ${selected
            ? 'bg-ink-800'
            : hasUnread
              ? 'bg-ink-800/40 hover:bg-ink-800/60 active:bg-ink-800'
              : 'hover:bg-ink-800/40 active:bg-ink-800/60'
          }
        `}
      >
        {/* Unread accent rail — left edge. The 2px ink-50 bar is THE
             visual signal that this conversation has new content. Combined
             with the bolded name and subtle row tint above, it's hard to
             miss in a scan. */}
        {hasUnread && !selected && (
          <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-ink-50" aria-hidden="true" />
        )}

        {/* Avatar — tinted by the matched lead's category when we have one */}
        <Avatar name={name || phone} category={category} size="md" />

        {/* Content */}
        <div className="flex-1 min-w-0 pr-7">
          <div className="flex items-baseline justify-between gap-2 mb-0.5">
            <span className={`text-sm leading-snug truncate
              ${hasUnread ? 'font-bold text-ink-50' : selected ? 'font-semibold text-ink-50' : 'font-medium text-ink-100'}`}>
              {name || phone}
            </span>
            <span className="shrink-0 text-[11px] text-ink-400 leading-none tabular-nums">
              {formatTimestamp(timestamp)}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className={`text-xs truncate leading-snug
              ${hasUnread ? 'text-ink-200 font-medium' : 'text-ink-400'}`}>
              {lastMessageDir === 'outbound' && (
                <span className="text-ink-500 mr-0.5">↑</span>
              )}
              {lastMessage}
            </p>
            <div className="flex items-center gap-1.5 shrink-0">
              {/* AI draft chip — only shown when a follow-up text is queued
                   on the matching lead AND the lead is still New (i.e. the
                   suggested reply hasn't been used yet). */}
              {hasAIDraft && !hasUnread && (
                <span
                  className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-status-vendor/12 text-status-vendor ring-1 ring-status-vendor/25 whitespace-nowrap"
                  title={t.inboxAIDraftTooltip || 'AI reply ready'}
                >
                  ✨ {t.inboxAIDraft || 'Draft'}
                </span>
              )}
              {hasUnread && (
                <span className="shrink-0 min-w-[18px] h-[18px] px-1 bg-ink-50 text-white rounded-full text-[10px] font-bold flex items-center justify-center leading-none tabular-nums">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Overflow menu trigger — pr-7 above prevents overlap with the
             rightmost timestamp/preview. Hover-revealed on desktop, always
             visible (small) on mobile — mobile users also have swipe-delete. */}
        <button
          ref={triggerRef}
          type="button"
          onClick={handleMenuClick}
          aria-label={t.inboxConvOptions || 'Conversation options'}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="absolute top-2.5 right-2 w-6 h-6 rounded-md flex items-center justify-center text-ink-400 hover:text-ink-100 hover:bg-black/[0.04] focus:outline-none focus:ring-2 focus:ring-ink-50 transition-colors"
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
            className="absolute top-9 right-2 z-30 glass rounded-xl shadow-card py-1 w-44 animate-slide-up"
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={handleDeleteClick}
              className="w-full text-left px-3.5 py-2 text-sm text-status-urgent hover:bg-status-urgent/10 focus:bg-status-urgent/10 focus:outline-none transition-colors"
            >
              {t.inboxDeleteConv || 'Delete conversation'}
            </button>
          </div>
        )}
      </div>
    </SwipeableRow>
  );
}
