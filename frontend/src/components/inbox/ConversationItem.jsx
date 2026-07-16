// Single row in the conversation list. The outer element is a `role="button"`
// div (not a real <button>) so we can nest the per-row overflow-menu button
// inside it without producing invalid HTML.
//
// Figma spec (Message row): Fill 342 × 46 Hug · gap 16 · avatar 32×32 vivid
// disc with white initials · name 17 bold · time "5 min" 15 gray · preview
// 15 gray · unread badge 20×20, 1px #065F46 border on #ECFDF3, green count.
import { useEffect, useRef, useState } from 'react';
import { parseTimestamp } from '../../utils/phone';
import { translations } from '../../i18n';
import SwipeableRow from '../ui/SwipeableRow';

// ─── Helpers ────────────────────────────────────────────────────────────────

// Comp shows "5 min" style relative times on rows.
function formatTimestamp(iso) {
  if (!iso) return '';
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;
  const date = parseTimestamp(iso);
  const now = new Date();
  const diffMins = Math.floor((now - date) / 60000);
  if (diffMins < 1)  return t.timeJustNow;
  if (diffMins < 60) return `${diffMins} min`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yestStart  = new Date(todayStart); yestStart.setDate(todayStart.getDate() - 1);
  if (date >= yestStart) return t.timeYesterday;
  return date.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric' });
}

// Vivid identity disc — same palette + hash as the Voicemail avatars so a
// caller keeps one color across surfaces.
const AVATAR_COLORS = ['#F79009', '#2E90FA', '#12B76A', '#7A5AF8', '#0D9488', '#F04438', '#DD2590'];

function initialsOf(name, phone) {
  const src = (name && name !== phone ? name : '').trim();
  if (!src) return (phone || '?').replace(/\D/g, '').slice(-2) || '?';
  const parts = src.split(/\s+/);
  return (parts.length === 1
    ? parts[0].charAt(0)
    : parts[0].charAt(0) + parts[parts.length - 1].charAt(0)
  ).toUpperCase();
}

function HashAvatar({ name, phone }) {
  const key = (name && name !== phone ? name : phone) || '?';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return (
    <div
      className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-[13px] font-semibold"
      style={{ backgroundColor: AVATAR_COLORS[hash % AVATAR_COLORS.length] }}
      aria-hidden="true"
    >
      {initialsOf(name, phone)}
    </div>
  );
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
  const { name, phone, lastMessage, timestamp, unread } = conversation;
  const hasUnread = unread > 0;

  // AI-draft indicator — a queued suggested reply on the matching New lead.
  const hasAIDraft = !!(lead?.follow_up_text && lead.status === 'New');

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);

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
          relative w-full text-left pl-2.5 pr-2 py-[9px] flex items-center gap-4
          transition-colors duration-100 outline-none cursor-pointer
          ${selected ? 'bg-[#F3F4F6]' : 'active:bg-[#F7F8F9]'}
        `}
      >
        <HashAvatar name={name} phone={phone} />

        {/* Content — two stacked lines per the comp */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            {/* Figma: name is Body/Medium/Medium — 16px, weight 500, 24px
                 line box (NOT bold; the earlier bold read was wrong). */}
            <span className="text-[16px] leading-6 font-medium text-[#101828] truncate">
              {name || phone}
            </span>
            <span className="shrink-0 text-[15px] text-[#667085] leading-none tabular-nums pr-6">
              {formatTimestamp(timestamp)}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 mt-1">
            <p className="text-[15px] truncate leading-snug text-[#667085]">
              {lastMessage}
            </p>
            <div className="flex items-center gap-1.5 shrink-0">
              {hasAIDraft && !hasUnread && (
                <span
                  className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-[#ECFDF3] text-[#065F46] border border-[#065F46]/30 whitespace-nowrap"
                  title={t.inboxAIDraftTooltip || 'AI reply ready'}
                >
                  {t.inboxAIDraft || 'Draft'}
                </span>
              )}
              {/* Unread badge — Figma: 20×20, radius-full, 1px #065F46 border
                   on #ECFDF3, green count */}
              {hasUnread && (
                <span className="shrink-0 w-5 h-5 bg-[#ECFDF3] border border-[#065F46] text-[#065F46] rounded-full text-[12px] font-semibold flex items-center justify-center leading-none tabular-nums">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Overflow menu trigger — sits to the right of the time, per comp */}
        <button
          ref={triggerRef}
          type="button"
          onClick={handleMenuClick}
          aria-label={t.inboxConvOptions || 'Conversation options'}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="absolute top-2 right-0.5 w-6 h-6 rounded-md flex items-center justify-center text-[#98A2B3] hover:text-[#344054] focus:outline-none focus:ring-2 focus:ring-[#065F46]/40 transition-colors"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
          </svg>
        </button>

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
