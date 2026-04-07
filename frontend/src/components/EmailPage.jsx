import { useState, useEffect, useCallback, useRef } from 'react';
import { getEmails, getGmailStatus, disconnectGmail, sendEmail, patchEmail, softDeleteEmail, searchContacts } from '../api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now   = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return date >= todayStart
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatFullDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function extractDisplayName(address) {
  if (!address) return '';
  // "John Smith <john@example.com>" → "John Smith"
  const match = address.match(/^(.+?)\s*<[^>]+>/);
  return match ? match[1].trim() : address.trim();
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const EnvelopeIcon = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
);

const TrashIcon = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const ArchiveIcon = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
  </svg>
);

const CheckCircleIcon = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const GearIcon = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const GoogleLogo = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-start gap-3 px-4 py-3.5 animate-pulse">
      <div className="w-8 h-8 rounded-lg bg-gray-100 shrink-0 mt-0.5" />
      <div className="flex-1 space-y-2 pt-0.5">
        <div className="flex items-center justify-between">
          <div className="h-3 w-28 bg-gray-100 rounded-full" />
          <div className="h-2.5 w-10 bg-gray-100 rounded-full" />
        </div>
        <div className="h-2.5 w-40 bg-gray-100 rounded-full" />
        <div className="h-2.5 w-32 bg-gray-100 rounded-full" />
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ connected }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20 px-6">
      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mb-3">
        <EnvelopeIcon className="w-5 h-5 text-gray-300" />
      </div>
      <p className="text-sm font-medium text-gray-500">No emails yet</p>
      <p className="text-xs text-gray-400 mt-1">
        {connected ? 'Sent and received emails will appear here' : 'Connect Gmail to sync your emails'}
      </p>
    </div>
  );
}

// ── Label/mailbox flag normalization ─────────────────────────────────────────
// Converts raw `labels_json` (stored by the Gmail sync) into a clean set of
// boolean flags the UI can use without parsing JSON strings everywhere.
//
// Fallback for rows that pre-date label storage:
//   - isSent/isReceived derived from `direction` (reliable for all rows)
//   - isUnread derived from `is_read` (also reliable for all rows)
//   - isTrash/isSpam derived from the `mailbox` column
//   - isStarred / isImportant default to false (no data available)

function parseEmailFlags(email) {
  let labels = [];
  try { labels = JSON.parse(email.labels_json || '[]'); } catch {}
  const hasLabels = labels.length > 0;

  return {
    // Direction — `direction` column is the single source of truth for sent vs received
    isSent:      email.direction === 'outbound',
    isReceived:  email.direction === 'inbound',

    // Unread — `is_read` is set at insert time from the UNREAD label
    isUnread:    email.is_read === 0,

    // Mailbox location
    isInbox:     hasLabels ? labels.includes('INBOX') : email.direction === 'inbound',
    isTrash:     hasLabels ? labels.includes('TRASH') : email.mailbox === 'trash',
    isSpam:      hasLabels ? labels.includes('SPAM')  : email.mailbox === 'spam',

    // Additional Gmail states — only meaningful when labels were captured
    isStarred:   labels.includes('STARRED'),
    isImportant: labels.includes('IMPORTANT'),

    // Raw label array for future use
    labels,
  };
}

// ── Swipeable email row ───────────────────────────────────────────────────────
// Mobile: swipe left → delete, swipe right → mark read/unread.
// Desktop: hover reveals action icon buttons.

function SwipeableEmailRow({ email, isSelected, onClick, onDelete, onToggleRead, onArchive }) {
  const rowRef      = useRef(null);
  const touchStartX = useRef(null);
  const THRESHOLD   = 70;

  function handleTouchStart(e) {
    touchStartX.current = e.touches[0].clientX;
    if (rowRef.current) rowRef.current.style.transition = 'none';
  }

  function handleTouchMove(e) {
    if (touchStartX.current === null) return;
    const delta   = e.touches[0].clientX - touchStartX.current;
    const clamped = Math.max(-THRESHOLD * 1.4, Math.min(THRESHOLD * 1.4, delta));
    if (rowRef.current) rowRef.current.style.transform = `translateX(${clamped}px)`;
  }

  function handleTouchEnd() {
    if (!rowRef.current) { touchStartX.current = null; return; }
    const transform = rowRef.current.style.transform || 'translateX(0px)';
    const match     = transform.match(/translateX\((-?[\d.]+)px\)/);
    const offset    = match ? parseFloat(match[1]) : 0;

    rowRef.current.style.transition = 'transform 0.2s ease';
    rowRef.current.style.transform  = 'translateX(0px)';

    if      (offset < -THRESHOLD) onDelete(email);
    else if (offset >  THRESHOLD) onToggleRead(email);

    touchStartX.current = null;
  }

  const flags      = parseEmailFlags(email);
  const isUnread   = flags.isUnread && !flags.isSent;
  const isOutbound = flags.isSent;
  const rawAddress = (isOutbound ? email.to_address : email.from_address) || '';
  // Contact-first: prefer server-resolved contact name, fall back to RFC 2822 display name
  const displayName = email.contact_name
    || extractDisplayName(rawAddress)
    || (isOutbound ? 'Unknown recipient' : 'Unknown sender');

  return (
    <div className="relative overflow-hidden group">
      {/* Left action bg — mark read (revealed when row slides right) */}
      <div className="absolute inset-0 bg-blue-500 flex items-center pl-5 z-0">
        <CheckCircleIcon className="w-5 h-5 text-white" />
        <span className="text-xs text-white font-medium ml-2">{isUnread ? 'Mark read' : 'Mark unread'}</span>
      </div>
      {/* Right action bg — delete (revealed when row slides left) */}
      <div className="absolute inset-0 bg-red-500 flex items-center justify-end pr-5 z-0">
        <span className="text-xs text-white font-medium mr-2">Delete</span>
        <TrashIcon className="w-5 h-5 text-white" />
      </div>

      {/* Row content (slides above the action backgrounds) */}
      <div
        ref={rowRef}
        className={`relative z-10 flex items-start gap-3 px-4 py-3.5 cursor-pointer select-none
          ${isSelected ? 'bg-violet-50' : 'bg-white active:bg-gray-50'}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={onClick}
      >
        {/* Unread dot */}
        {isUnread && (
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-violet-500" />
        )}

        {/* Icon avatar — sky tones for sent, violet for received */}
        <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center mt-0.5
          ${isSelected
            ? (isOutbound ? 'bg-sky-100'    : 'bg-violet-100')
            : (isOutbound ? 'bg-sky-50'     : isUnread ? 'bg-violet-100' : 'bg-violet-50')
          }`}>
          <EnvelopeIcon className={`w-4 h-4
            ${isSelected
              ? (isOutbound ? 'text-sky-600'  : 'text-violet-600')
              : (isOutbound ? 'text-sky-500'  : isUnread ? 'text-violet-500' : 'text-violet-400')
            }`} />
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-sm truncate leading-tight
              ${isUnread ? 'font-bold text-gray-900' : isSelected ? 'font-semibold text-violet-700' : 'font-medium text-gray-700'}`}>
              {displayName}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {flags.isStarred && (
                <span className="text-amber-400 text-xs leading-none">★</span>
              )}
              <span className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap leading-tight">
                {formatTime(email.created_at)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            {isOutbound && (
              <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-500 leading-none">
                Sent
              </span>
            )}
            {flags.isTrash && (
              <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-400 leading-none">
                Trash
              </span>
            )}
            {email.subject && (
              <p className={`text-xs truncate leading-snug
                ${isUnread ? 'font-semibold text-gray-800' : 'text-gray-500'}`}>
                {email.subject}
              </p>
            )}
          </div>

          {email.body_preview && (
            <p className="text-[11px] text-gray-400 mt-0.5 line-clamp-1 leading-snug">
              {email.body_preview}
            </p>
          )}
        </div>

        {/* Desktop hover actions (hidden on touch devices via group-hover) */}
        <div className="hidden group-hover:flex items-center gap-0.5 shrink-0 ml-1 -mr-1">
          <button
            onClick={e => { e.stopPropagation(); onToggleRead(email); }}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-blue-500 transition-colors"
            title={isUnread ? 'Mark as read' : 'Mark as unread'}
          >
            <CheckCircleIcon className="w-4 h-4" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onArchive(email); }}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-gray-600 transition-colors"
            title="Archive"
          >
            <ArchiveIcon className="w-4 h-4" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(email); }}
            className="p-1.5 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors"
            title="Delete"
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Email detail panel ────────────────────────────────────────────────────────

function EmailDetailPanel({ email, onBack, onDelete, onToggleRead, onArchive }) {
  const flags      = parseEmailFlags(email);
  const isOutbound = flags.isSent;
  const isUnread   = flags.isUnread && !isOutbound;
  const from       = email.from_address || (isOutbound ? 'You' : '');
  const to         = email.to_address || '';

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Panel header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 shrink-0">
        {/* Back button — mobile only */}
        <button
          onClick={onBack}
          className="md:hidden flex items-center gap-1 text-violet-600 text-sm font-medium -ml-1 mr-1"
          aria-label="Back to inbox"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Inbox
        </button>

        {/* Subject */}
        <h2 className="flex-1 text-sm font-semibold text-gray-900 truncate min-w-0">
          {email.subject || '(no subject)'}
        </h2>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => onToggleRead(email)}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-blue-500 transition-colors"
            title={isUnread ? 'Mark as read' : 'Mark as unread'}
          >
            <CheckCircleIcon className="w-4.5 h-4.5 w-5 h-5" />
          </button>
          <button
            onClick={() => onArchive(email)}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            title="Archive"
          >
            <ArchiveIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => onDelete(email)}
            className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
            title="Delete"
          >
            <TrashIcon className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Email metadata */}
      <div className="px-5 py-4 border-b border-gray-50 shrink-0 space-y-1.5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0 flex-1">
            <div className="flex gap-1.5 text-sm">
              <span className="text-gray-400 shrink-0 w-8">From</span>
              <span className="text-gray-800 truncate font-medium">{from || '—'}</span>
            </div>
            <div className="flex gap-1.5 text-sm">
              <span className="text-gray-400 shrink-0 w-8">To</span>
              <span className="text-gray-800 truncate">{to || '—'}</span>
            </div>
            {email.subject && (
              <div className="flex gap-1.5 text-sm">
                <span className="text-gray-400 shrink-0 w-8">Re</span>
                <span className="text-gray-800 truncate">{email.subject}</span>
              </div>
            )}
          </div>
          <span className="text-xs text-gray-400 whitespace-nowrap shrink-0 mt-0.5">
            {formatFullDate(email.created_at)}
          </span>
        </div>

        {/* Direction + state badges */}
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
          <span className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full
            ${isOutbound ? 'bg-sky-50 text-sky-600' : 'bg-blue-50 text-blue-600'}`}>
            {isOutbound ? '↑ Sent' : '↓ Received'}
          </span>
          {isUnread && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-violet-500 text-white">
              Unread
            </span>
          )}
          {flags.isStarred && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-500">
              ★ Starred
            </span>
          )}
          {flags.isImportant && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-orange-50 text-orange-500">
              Important
            </span>
          )}
          {flags.isTrash && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-400">
              Trash
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-5 pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-6">
        {email.body_preview ? (
          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
            {email.body_preview}
          </p>
        ) : (
          <p className="text-sm text-gray-400 italic">No preview available for this email.</p>
        )}
      </div>
    </div>
  );
}

// ── Email settings modal ──────────────────────────────────────────────────────

function EmailSettingsModal({ gmailStatus, onClose, onDisconnect, disconnecting }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md mx-0 sm:mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3.5 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Email Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Connected account */}
        <div className="px-5 py-4">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Connected Account
          </p>

          {gmailStatus.connected ? (
            <div className="flex items-center justify-between gap-3 py-1">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                  <GoogleLogo size={18} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{gmailStatus.email}</p>
                  <p className="text-xs text-green-500 font-medium mt-0.5">Connected</p>
                </div>
              </div>
              <button
                onClick={onDisconnect}
                disabled={disconnecting}
                className="shrink-0 text-xs font-medium text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          ) : (
            <div className="py-1">
              <p className="text-sm text-gray-500 mb-3">No Gmail account connected.</p>
              <a
                href="/auth/google"
                className="flex items-center justify-center gap-2.5 w-full border border-gray-200 hover:border-gray-300 rounded-xl py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
              >
                <GoogleLogo size={16} />
                Connect Gmail Account
              </a>
            </div>
          )}
        </div>

        {/* Sync info */}
        <div className="px-5 py-4 border-t border-gray-50 bg-gray-50/50">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Sync</p>
          <p className="text-xs text-gray-500 leading-relaxed">
            Emails are checked every minute when Gmail is connected.
            The last 30 days of inbox and sent mail are imported on first connect.
          </p>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full bg-gray-100 hover:bg-gray-200 text-sm font-medium text-gray-700 rounded-xl py-2.5 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Recipient autocomplete input ──────────────────────────────────────────────
// Standalone component used inside ComposeModal for the "To" field.
// Searches contacts by name and email as the user types (160 ms debounce).
// Keyboard: ↑↓ to navigate, Enter to select, Escape to close.

function RecipientInput({ query, onQueryChange, onSelect, autoFocus }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open,        setOpen]        = useState(false);
  const [activeIdx,   setActiveIdx]   = useState(-1);
  const inputRef    = useRef(null);
  const listRef     = useRef(null);
  const debounceRef = useRef(null);

  // Debounced contact search
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchContacts(q);
        setSuggestions(results);
        setOpen(results.length > 0);
        setActiveIdx(-1);
      } catch {
        setSuggestions([]);
        setOpen(false);
      }
    }, 160);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // Close on click/pointer outside the input + dropdown
  useEffect(() => {
    function onPointerDown(e) {
      if (
        !inputRef.current?.contains(e.target) &&
        !listRef.current?.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  function commit(contact) {
    onSelect(contact);
    setOpen(false);
    setSuggestions([]);
    setActiveIdx(-1);
  }

  function handleKeyDown(e) {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      commit(suggestions[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        autoFocus={autoFocus}
        autoComplete="off"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Name or email address"
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400 placeholder:text-gray-400"
      />

      {open && suggestions.length > 0 && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden"
        >
          {suggestions.map((contact, idx) => (
            <button
              key={contact.phone || contact.email}
              type="button"
              role="option"
              aria-selected={idx === activeIdx}
              // onPointerDown prevents the input from blurring before onClick fires
              onPointerDown={e => { e.preventDefault(); commit(contact); }}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors
                ${idx === activeIdx ? 'bg-violet-50' : 'hover:bg-gray-50'}
                ${idx > 0 ? 'border-t border-gray-50' : ''}`}
            >
              {/* Initial avatar */}
              <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center shrink-0">
                <span className="text-[11px] font-bold text-violet-600 select-none">
                  {(contact.name || contact.email)[0].toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800 truncate leading-snug">
                  {contact.name}
                </p>
                {/* Show email on second line only when name differs */}
                {contact.name !== contact.email && (
                  <p className="text-xs text-gray-400 truncate leading-snug mt-0.5">
                    {contact.email}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Compose modal ─────────────────────────────────────────────────────────────

function ComposeModal({ onClose, onSent }) {
  // toQuery  — text currently in the input field (clears on contact selection)
  // toEmail  — actual email address for sending (set on autocomplete selection, null for raw input)
  // toName   — display name of the selected contact (null when raw input)
  const [toQuery,  setToQuery]  = useState('');
  const [toEmail,  setToEmail]  = useState(null);
  const [toName,   setToName]   = useState(null);
  const [subject,  setSubject]  = useState('');
  const [body,     setBody]     = useState('');
  const [sending,  setSending]  = useState(false);
  const [error,    setError]    = useState(null);

  // The address that will actually be used when sending.
  // Prefer the contact-selected email; fall back to raw typed input.
  const recipientEmail = toEmail ?? toQuery.trim();

  function handleSelect({ email, name }) {
    setToEmail(email);
    setToName(name !== email ? name : null); // suppress name if it's just the email again
    setToQuery('');
  }

  function handleClear() {
    setToEmail(null);
    setToName(null);
    setToQuery('');
  }

  async function handleSend() {
    if (!recipientEmail || !body.trim()) {
      setError('To and Message are required.');
      return;
    }
    // For raw freeform input (no contact selected), enforce valid email format.
    if (!toEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      setError('Please enter a valid email address.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendEmail({ to: recipientEmail, subject: subject.trim(), body: body.trim() });
      onSent();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSend();
    if (e.key === 'Escape') onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg mx-0 sm:mx-4 flex flex-col"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-900">New Email</p>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">

          {/* ── To ── */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>

            {toEmail ? (
              // ── Contact chip (contact was selected from autocomplete) ──
              <div className="flex items-center gap-2.5 border border-violet-200 bg-violet-50 rounded-lg px-3 py-2 min-h-[38px]">
                <div className="flex-1 min-w-0">
                  {toName && (
                    <p className="text-sm font-medium text-gray-900 truncate leading-snug">{toName}</p>
                  )}
                  <p className={`truncate leading-snug ${toName ? 'text-xs text-gray-400 mt-0.5' : 'text-sm font-medium text-gray-900'}`}>
                    {toEmail}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleClear}
                  className="shrink-0 text-violet-400 hover:text-violet-600 transition-colors"
                  aria-label="Remove recipient"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ) : (
              // ── Search input with autocomplete dropdown ──
              <RecipientInput
                query={toQuery}
                onQueryChange={setToQuery}
                onSelect={handleSelect}
                autoFocus
              />
            )}
          </div>

          {/* ── Subject ── */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="(optional)"
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400 placeholder:text-gray-400"
            />
          </div>

          {/* ── Message ── */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Message</label>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Write your message…"
              rows={6}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-violet-400 placeholder:text-gray-400"
            />
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex items-center justify-between px-5 pb-5 pt-1">
          <p className="text-[11px] text-gray-400">⌘+Enter to send</p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSend}
              disabled={sending}
              className="text-sm font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg px-5 py-2 transition-colors"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EmailPage() {
  const [emails,        setEmails]        = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [activeMailbox, setActiveMailbox] = useState('all'); // 'all' | 'inbox' | 'sent' | 'trash'
  const [gmailStatus,   setGmailStatus]   = useState({ connected: false, email: null });
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [composeOpen,   setComposeOpen]   = useState(false);
  const [settingsOpen,  setSettingsOpen]  = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [toast,         setToast]         = useState(null); // { message, type }

  // ── Fetch email list ───────────────────────────────────────────────────────
  // `fetchEmails` is the stable callback used both by the main effect and by
  // post-OAuth polling timers. It always reads the *current* activeMailbox via
  // the ref so the timers don't close over a stale value.
  const activeMailboxRef = useRef(activeMailbox);
  useEffect(() => { activeMailboxRef.current = activeMailbox; }, [activeMailbox]);

  const fetchEmails = useCallback(() => {
    const filter = activeMailboxRef.current === 'all' ? null : activeMailboxRef.current;
    getEmails(filter)
      .then(data => setEmails(Array.isArray(data) ? data : []))
      .catch(err => { console.error('[EmailPage] Fetch failed:', err); setEmails([]); })
      .finally(() => setLoading(false));
  }, []); // stable — reads mailbox via ref

  // Re-fetch whenever the active mailbox tab changes
  useEffect(() => {
    setLoading(true);
    setSelectedEmail(null);
    fetchEmails();
  }, [activeMailbox, fetchEmails]);

  // ── Gmail status ───────────────────────────────────────────────────────────
  useEffect(() => {
    getGmailStatus()
      .then(setGmailStatus)
      .catch(() => {});
  }, []);

  // ── Post-OAuth redirect detection ──────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.get('gmail_connected') === '1') {
      window.history.replaceState({}, '', window.location.pathname);
      showToast('Gmail connected! Importing recent emails…', 'info');
      // Refresh status and open settings automatically
      getGmailStatus().then(s => { setGmailStatus(s); setSettingsOpen(true); }).catch(() => {});
      // Staggered re-fetches as the server-side backfill completes
      const timers = [
        setTimeout(() => fetchEmails(), 3_000),
        setTimeout(() => fetchEmails(), 7_000),
        setTimeout(() => fetchEmails(), 13_000),
      ];
      return () => timers.forEach(clearTimeout);
    }

    if (params.get('gmail_error')) {
      window.history.replaceState({}, '', window.location.pathname);
      showToast('Gmail connection failed. Please try again.', 'error');
    }
  }, [fetchEmails]);

  // ── Toast ──────────────────────────────────────────────────────────────────
  function showToast(message, type = 'info') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectGmail();
      setGmailStatus({ connected: false, email: null });
      showToast('Gmail disconnected.');
    } catch (err) {
      showToast('Failed to disconnect: ' + err.message, 'error');
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleToggleRead(email) {
    const newRead = email.is_read === 0 ? 1 : 0;
    // Optimistic update
    setEmails(prev => prev.map(e => e.id === email.id ? { ...e, is_read: newRead } : e));
    if (selectedEmail?.id === email.id) setSelectedEmail(s => s && { ...s, is_read: newRead });
    try {
      await patchEmail(email.id, { is_read: newRead });
    } catch {
      // Revert on failure
      setEmails(prev => prev.map(e => e.id === email.id ? { ...e, is_read: email.is_read } : e));
      showToast('Failed to update.', 'error');
    }
  }

  async function handleDelete(email) {
    // Optimistic remove
    setEmails(prev => prev.filter(e => e.id !== email.id));
    if (selectedEmail?.id === email.id) setSelectedEmail(null);
    showToast('Email deleted.');
    try {
      await softDeleteEmail(email.id);
    } catch {
      fetchEmails(); // Re-fetch on failure to restore
      showToast('Failed to delete email.', 'error');
    }
  }

  async function handleArchive(email) {
    // Optimistic remove from inbox view
    setEmails(prev => prev.filter(e => e.id !== email.id));
    if (selectedEmail?.id === email.id) setSelectedEmail(null);
    showToast('Email archived.');
    try {
      await patchEmail(email.id, { is_archived: 1 });
    } catch {
      fetchEmails();
      showToast('Failed to archive email.', 'error');
    }
  }

  function handleSelectEmail(email) {
    setSelectedEmail(email);
    // Auto-mark inbound email as read when opened
    if (email.is_read === 0 && email.direction !== 'outbound') {
      handleToggleRead(email);
    }
  }

  // Whether to show detail panel (mobile: switches views; desktop: shows right pane)
  const showDetail = selectedEmail !== null;

  return (
    <div className="flex h-full overflow-hidden bg-gray-50">

      {/* ── Left pane: email list ─────────────────────────────────────────── */}
      <div className={`
        flex flex-col bg-white border-r border-gray-100
        w-full md:w-[320px] lg:w-[360px] md:flex shrink-0
        ${showDetail ? 'hidden md:flex' : 'flex'}
      `}>

        {/* List header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 shrink-0">
          <h1 className="text-xl font-bold text-gray-900">Email</h1>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
              aria-label="Email settings"
            >
              <GearIcon className="w-5 h-5" />
            </button>
            {gmailStatus.connected && (
              <button
                onClick={() => setComposeOpen(true)}
                className="flex items-center gap-1.5 text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg px-3 py-1.5 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Compose
              </button>
            )}
          </div>
        </div>

        {/* Gmail status strip */}
        {!gmailStatus.connected && (
          <div className="mx-4 mb-3 flex items-center justify-between gap-2 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
              <p className="text-xs text-amber-700 font-medium truncate">Gmail not connected</p>
            </div>
            <a
              href="/auth/google"
              className="shrink-0 flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-900 bg-white border border-amber-200 rounded-lg px-2.5 py-1 transition-colors"
            >
              <GoogleLogo size={12} />
              Connect
            </a>
          </div>
        )}
        {gmailStatus.connected && (
          <div className="mx-4 mb-3 flex items-center gap-2 shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            <p className="text-xs text-gray-400 truncate">{gmailStatus.email}</p>
          </div>
        )}

        {/* Mailbox tabs */}
        <div className="flex items-center gap-0.5 px-4 pb-2 shrink-0 border-b border-gray-100">
          {[
            { key: 'all',   label: 'All' },
            { key: 'inbox', label: 'Inbox' },
            { key: 'sent',  label: 'Sent' },
            { key: 'trash', label: 'Trash' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveMailbox(tab.key)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors
                ${activeMailbox === tab.key
                  ? 'bg-violet-100 text-violet-700'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Email list (scrollable) */}
        <div className="flex-1 overflow-y-auto pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0">
          {loading ? (
            <div>
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i}>
                  {i > 1 && <div className="h-px bg-gray-50 mx-4" />}
                  <SkeletonRow />
                </div>
              ))}
            </div>
          ) : emails.length === 0 ? (
            <EmptyState connected={gmailStatus.connected} />
          ) : (
            <div>
              {emails.map((email, idx) => (
                <div key={email?.id ?? email?.gmail_message_id ?? idx}>
                  {idx > 0 && <div className="h-px bg-gray-50 mx-4" />}
                  <SwipeableEmailRow
                    email={email}
                    isSelected={selectedEmail?.id === email.id}
                    onClick={() => handleSelectEmail(email)}
                    onDelete={handleDelete}
                    onToggleRead={handleToggleRead}
                    onArchive={handleArchive}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Right pane: detail / placeholder ─────────────────────────────── */}
      <div className={`flex-1 flex flex-col overflow-hidden ${showDetail ? 'flex' : 'hidden md:flex'}`}>
        {selectedEmail ? (
          <EmailDetailPanel
            email={selectedEmail}
            onBack={() => setSelectedEmail(null)}
            onDelete={handleDelete}
            onToggleRead={handleToggleRead}
            onArchive={handleArchive}
          />
        ) : (
          /* Desktop: nothing selected placeholder */
          <div className="hidden md:flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
                <EnvelopeIcon className="w-6 h-6 text-gray-300" />
              </div>
              <p className="text-sm font-medium text-gray-400">Select an email to read</p>
              <p className="text-xs text-gray-300 mt-1">Your emails appear on the left</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {settingsOpen && (
        <EmailSettingsModal
          gmailStatus={gmailStatus}
          onClose={() => setSettingsOpen(false)}
          onDisconnect={async () => {
            await handleDisconnect();
            setSettingsOpen(false);
          }}
          disconnecting={disconnecting}
        />
      )}

      {composeOpen && (
        <ComposeModal
          onClose={() => setComposeOpen(false)}
          onSent={() => {
            showToast('Email sent!', 'success');
            fetchEmails();
          }}
        />
      )}

      {/* ── Toast ─────────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`
          fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-50
          px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium text-white
          transition-opacity
          ${toast.type === 'success' ? 'bg-green-600' : toast.type === 'error' ? 'bg-red-500' : 'bg-gray-800'}
        `}>
          {toast.message}
        </div>
      )}
    </div>
  );
}
