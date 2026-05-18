import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getEmails, getGmailStatus, disconnectGmail, sendEmail, patchEmail, softDeleteEmail, searchContacts, BACKEND_URL } from '../api';
import { useInvalidate } from '../refreshBus';
import { translations } from '../i18n';
import { parseTimestamp } from '../utils/phone';
import SwipeableRow from './ui/SwipeableRow';
import GroupedListSection from './ui/GroupedListSection';
import FloatingActionButton from './ui/FloatingActionButton';
import EmptyState from './ui/EmptyState';
import Avatar from './ui/Avatar';

function getT() {
  const lang = localStorage.getItem('language') || 'en';
  return translations[lang] || translations.en;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocale() {
  const lang = localStorage.getItem('language') || 'en';
  return lang === 'es' ? 'es-MX' : 'en-US';
}

function formatTime(iso) {
  if (!iso) return '';
  const locale = getLocale();
  const date = new Date(iso);
  const now   = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return date >= todayStart
    ? date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function formatFullDate(iso) {
  if (!iso) return '';
  const locale = getLocale();
  return new Date(iso).toLocaleString(locale, {
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

// ── (Removed local EmptyState — replaced by the shared ui/EmptyState primitive
//      to keep the empty-state design consistent across Calls / Inbox / Email.)

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
// Built on the shared SwipeableRow primitive: swipe LEFT to delete, swipe
// RIGHT to toggle read. Desktop reveals the same three actions (read/archive/
// delete) as inline hover buttons since there's no swipe affordance on mouse.

function SwipeableEmailRow({ email, isSelected, onClick, onDelete, onToggleRead, onArchive }) {
  const t           = getT();
  const flags       = parseEmailFlags(email);
  const isUnread    = flags.isUnread && !flags.isSent;
  const isOutbound  = flags.isSent;
  const rawAddress  = (isOutbound ? email.to_address : email.from_address) || '';
  // Contact-first: prefer server-resolved contact name, fall back to RFC 2822 display name
  const displayName = email.contact_name
    || extractDisplayName(rawAddress)
    || (isOutbound ? 'Unknown recipient' : 'Unknown sender');

  // Attachment count — peek inside attachments_json so we can show a paperclip
  // hint on the list row without having to open the email first.
  const attachmentCount = (() => {
    try { return (JSON.parse(email.attachments_json || '[]') || []).length; }
    catch { return 0; }
  })();

  return (
    <SwipeableRow
      disabled={isSelected}
      leftAction={{
        icon: <CheckCircleIcon className="w-5 h-5" />,
        label: isUnread ? t.emailMarkRead : t.emailMarkUnread,
        color: 'bg-accent-500',
        onTrigger: () => onToggleRead(email),
      }}
      rightAction={{
        icon: <TrashIcon className="w-5 h-5" />,
        label: t.emailDelete,
        color: 'bg-status-urgent',
        onTrigger: () => onDelete(email),
      }}
    >
      <div
        className={`group relative flex items-start gap-3 px-4 py-3.5 cursor-pointer select-none transition-colors
          ${isSelected
            ? 'bg-ink-800'
            : isUnread
              ? 'bg-ink-800/40 hover:bg-ink-800/60 active:bg-ink-800'
              : 'bg-ink-900 hover:bg-ink-800/40 active:bg-ink-800/60'
          }`}
        onClick={onClick}
      >
        {/* Unread accent rail — left edge, near-black bar.
             Same visual language as the Inbox unread treatment so unread
             "feels" consistent across screens. */}
        {isUnread && !isSelected && (
          <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-ink-50" aria-hidden="true" />
        )}

        {/* Avatar — sender's name + direction-coded tint */}
        <Avatar
          name={displayName}
          category={isOutbound ? 'Existing Customer' : 'Lead'}
          size="md"
        />

        {/* Text */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-sm truncate leading-tight
              ${isUnread ? 'font-bold text-ink-50' : isSelected ? 'font-semibold text-ink-50' : 'font-medium text-ink-100'}`}>
              {displayName}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {flags.isStarred && (
                <span className="text-status-scheduled text-xs leading-none">★</span>
              )}
              <span className="text-[11px] text-ink-400 tabular-nums whitespace-nowrap leading-tight">
                {formatTime(email.created_at)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            {isOutbound && (
              <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-status-customer/12 text-status-customer ring-1 ring-status-customer/25 leading-none">
                {t.emailSent}
              </span>
            )}
            {flags.isTrash && (
              <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-status-urgent/12 text-status-urgent ring-1 ring-status-urgent/25 leading-none">
                {t.emailTrash}
              </span>
            )}
            {email.subject && (
              <p className={`text-xs truncate leading-snug
                ${isUnread ? 'font-semibold text-ink-100' : 'text-ink-400'}`}>
                {email.subject}
              </p>
            )}
            {attachmentCount > 0 && (
              <span className="shrink-0 flex items-center gap-0.5 text-[10px] text-ink-400 tabular-nums">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                {attachmentCount}
              </span>
            )}
          </div>

          {email.body_preview && (
            <p className="text-[11px] text-ink-400 mt-0.5 line-clamp-1 leading-snug">
              {email.body_preview}
            </p>
          )}
        </div>

        {/* Desktop hover actions — visible on hover only (touch devices use swipe). */}
        <div className="hidden md:group-hover:flex items-center gap-0.5 shrink-0 ml-1 -mr-1">
          <button
            onClick={e => { e.stopPropagation(); onToggleRead(email); }}
            className="p-1.5 rounded-lg hover:bg-black/[0.04] text-ink-400 hover:text-accent-600 transition-colors"
            title={isUnread ? t.emailMarkRead : t.emailMarkUnread}
          >
            <CheckCircleIcon className="w-4 h-4" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onArchive(email); }}
            className="p-1.5 rounded-lg hover:bg-black/[0.04] text-ink-400 hover:text-ink-100 transition-colors"
          >
            <ArchiveIcon className="w-4 h-4" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(email); }}
            className="p-1.5 rounded-lg hover:bg-status-urgent/10 text-ink-400 hover:text-status-urgent transition-colors"
            title={t.emailDelete}
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </SwipeableRow>
  );
}

// ── Date bucketing for grouped sections ──────────────────────────────────────
// Matches the buckets used in Inbox + Calls so all three screens speak the
// same "Today / Yesterday / This week / Earlier" vocabulary.

const EMAIL_BUCKET_ORDER = ['Today', 'Yesterday', 'This week', 'Earlier'];

function emailBucket(iso, t) {
  if (!iso) return t.timeOlder || 'Earlier';
  const date = parseTimestamp(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yestStart  = new Date(todayStart); yestStart.setDate(todayStart.getDate() - 1);
  const weekStart  = new Date(todayStart); weekStart.setDate(todayStart.getDate() - 7);
  if (date >= todayStart) return t.timeToday;
  if (date >= yestStart)  return t.timeYesterday;
  if (date >= weekStart)  return t.timeThisWeek || 'This week';
  return t.timeOlder || 'Earlier';
}

function bucketEmails(emails, t) {
  const englishOf = {
    [t.timeToday]:     'Today',
    [t.timeYesterday]: 'Yesterday',
    [t.timeThisWeek || 'This week']: 'This week',
    [t.timeOlder    || 'Earlier']:   'Earlier',
  };
  const map = new Map();
  for (const e of emails) {
    const label = emailBucket(e.created_at, t);
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(e);
  }
  const ordered = [];
  for (const en of EMAIL_BUCKET_ORDER) {
    for (const [label, items] of map.entries()) {
      if (englishOf[label] === en) ordered.push({ label, items });
    }
  }
  return ordered;
}

// ── Email detail panel ────────────────────────────────────────────────────────

function EmailDetailPanel({ email, onBack, onDelete, onToggleRead, onArchive }) {
  const t          = getT();
  const flags      = parseEmailFlags(email);
  const isOutbound = flags.isSent;
  const isUnread   = flags.isUnread && !isOutbound;
  const from       = email.from_address || (isOutbound ? 'You' : '');
  const to         = email.to_address || '';

  return (
    <div className="flex flex-col h-full bg-ink-900">
      {/* Panel header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-700 shrink-0">
        {/* Back button — mobile only */}
        <button
          onClick={onBack}
          className="md:hidden flex items-center gap-1 text-ink-100 hover:text-ink-50 text-sm font-medium -ml-1 mr-1"
          aria-label="Back to inbox"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {t.emailBackToInbox}
        </button>

        {/* Subject */}
        <h2 className="flex-1 text-sm font-semibold text-ink-50 truncate min-w-0">
          {email.subject || t.emailNoSubject}
        </h2>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => onToggleRead(email)}
            className="p-2 rounded-lg hover:bg-black/[0.04] text-ink-400 hover:text-accent-600 transition-colors"
            title={isUnread ? t.emailMarkRead : t.emailMarkUnread}
          >
            <CheckCircleIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => onArchive(email)}
            className="p-2 rounded-lg hover:bg-black/[0.04] text-ink-400 hover:text-ink-100 transition-colors"
            title={t.emailArchive}
          >
            <ArchiveIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => onDelete(email)}
            className="p-2 rounded-lg hover:bg-status-urgent/10 text-ink-400 hover:text-status-urgent transition-colors"
            title={t.emailDelete}
          >
            <TrashIcon className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Email metadata */}
      <div className="px-5 py-4 border-b border-ink-800 shrink-0 space-y-1.5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0 flex-1">
            <div className="flex gap-1.5 text-sm">
              <span className="text-ink-400 shrink-0 w-8">{t.emailFrom}</span>
              <span className="text-ink-100 truncate font-medium">{from || '—'}</span>
            </div>
            <div className="flex gap-1.5 text-sm">
              <span className="text-ink-400 shrink-0 w-8">{t.emailTo}</span>
              <span className="text-ink-100 truncate">{to || '—'}</span>
            </div>
            {email.subject && (
              <div className="flex gap-1.5 text-sm">
                <span className="text-ink-400 shrink-0 w-8">{t.emailRe}</span>
                <span className="text-ink-100 truncate">{email.subject}</span>
              </div>
            )}
          </div>
          <span className="text-xs text-ink-400 whitespace-nowrap shrink-0 mt-0.5">
            {formatFullDate(email.created_at)}
          </span>
        </div>

        {/* Direction + state badges */}
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
          <span className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full
            ${isOutbound ? 'bg-status-customer/12 text-status-customer ring-1 ring-status-customer/25' : 'bg-accent-100 text-accent-700 ring-1 ring-accent-200/60'}`}>
            {isOutbound ? t.emailSentBadge : t.emailReceivedBadge}
          </span>
          {isUnread && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-ink-50 text-white">
              {t.emailUnread}
            </span>
          )}
          {flags.isStarred && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-status-scheduled/12 text-status-scheduled ring-1 ring-status-scheduled/25">
              {t.emailStarred}
            </span>
          )}
          {flags.isImportant && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-status-scheduled/15 text-status-scheduled ring-1 ring-status-scheduled/30">
              {t.emailImportant}
            </span>
          )}
          {flags.isTrash && (
            <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-status-urgent/12 text-status-urgent ring-1 ring-status-urgent/25">
              {t.emailTrash}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-5 pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-6 space-y-4">
        {email.body_preview ? (
          <p className="text-sm text-ink-200 whitespace-pre-wrap leading-relaxed">
            {email.body_preview}
          </p>
        ) : (
          <p className="text-sm text-ink-400 italic">{t.emailNoPreview}</p>
        )}

        {/* Attachments */}
        {(() => {
          let atts = [];
          try { atts = JSON.parse(email.attachments_json || '[]'); } catch {}
          if (atts.length === 0) return null;
          return (
            <div className="border-t border-ink-800 pt-4">
              <p className="text-[11px] font-semibold text-ink-400 uppercase tracking-wider mb-2">
                {t.emailAttachments} ({atts.length})
              </p>
              <div className="space-y-1.5">
                {atts.map((att, i) => (
                  <div key={i} className="flex items-center gap-2.5 bg-ink-800 ring-1 ring-ink-700 rounded-lg px-3 py-2">
                    <svg className="w-4 h-4 text-ink-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                    <span className="text-xs text-ink-200 truncate flex-1">{att.filename}</span>
                    {att.size != null && (
                      <span className="text-[11px] text-ink-400 shrink-0">{formatBytes(att.size)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ── Email settings modal ──────────────────────────────────────────────────────

function EmailSettingsModal({ gmailStatus, onClose, onDisconnect, disconnecting }) {
  const t = getT();
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
          <h2 className="text-base font-semibold text-gray-900">{t.emailSettings}</h2>
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
            {t.emailConnectedAccount}
          </p>

          {gmailStatus.connected ? (
            <div className="flex items-center justify-between gap-3 py-1">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                  <GoogleLogo size={18} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{gmailStatus.email}</p>
                  <p className="text-xs text-green-500 font-medium mt-0.5">{t.emailConnectedStatus}</p>
                </div>
              </div>
              <button
                onClick={onDisconnect}
                disabled={disconnecting}
                className="shrink-0 text-xs font-medium text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
              >
                {disconnecting ? t.emailDisconnecting : t.emailDisconnect}
              </button>
            </div>
          ) : gmailStatus.enabled ? (
            <div className="py-1">
              <p className="text-sm text-gray-500 mb-3">{t.emailGmailNotConnected}</p>
              <a
                // /auth/google is requireAuth-protected. Top-level navigations
                // (especially on Capacitor Android + iOS Safari ITP + any
                // external-tab open) don't always carry the SameSite=None
                // session cookie, so we ALSO append the localStorage session
                // token as ?token= — requireAuth already accepts that as a
                // fallback. The backend strips the token before redirecting
                // to Google and sets Referrer-Policy: no-referrer so the
                // token never leaks through the Referer header.
                href={(() => {
                  const token = typeof localStorage !== 'undefined'
                    ? localStorage.getItem('plumbline_token')
                    : null;
                  const base = `${BACKEND_URL}/auth/google`;
                  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
                })()}
                className="flex items-center justify-center gap-2.5 w-full border border-gray-200 hover:border-gray-300 rounded-xl py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
              >
                <GoogleLogo size={16} />
                {t.emailConnectGmail}
              </a>
            </div>
          ) : (
            <div className="py-2 space-y-2">
              <div className="flex items-center gap-2.5 w-full border border-gray-100 bg-gray-50 rounded-xl py-3 px-4">
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                  <GoogleLogo size={16} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-500">{t.emailGmailComingSoon}</p>
                  <p className="text-xs text-gray-400 mt-0.5 leading-snug">
                    {t.emailGmailComingSoonBody}
                  </p>
                </div>
              </div>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                {t.emailGmailTestReady}
              </p>
            </div>
          )}
        </div>

        {/* Sync info */}
        <div className="px-5 py-4 border-t border-gray-50 bg-gray-50/50">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">{t.emailSyncTitle}</p>
          <p className="text-xs text-gray-500 leading-relaxed">
            {t.emailSyncBody}
          </p>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full bg-gray-100 hover:bg-gray-200 text-sm font-medium text-gray-700 rounded-xl py-2.5 transition-colors"
          >
            {t.done}
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
  const t = getT();
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
        placeholder={t.emailRecipientPH}
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
                  {(contact.name || contact.email || '?')[0].toUpperCase()}
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

// Allowed MIME types mirroring the backend whitelist
const ALLOWED_ATTACH_TYPES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
]);

function formatBytes(bytes) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ComposeModal({ onClose, onSent }) {
  const t = getT();
  // toQuery  — text currently in the input field (clears on contact selection)
  // toEmail  — actual email address for sending (set on autocomplete selection, null for raw input)
  // toName   — display name of the selected contact (null when raw input)
  const [toQuery,     setToQuery]     = useState('');
  const [toEmail,     setToEmail]     = useState(null);
  const [toName,      setToName]      = useState(null);
  const [subject,     setSubject]     = useState('');
  const [body,        setBody]        = useState('');
  const [attachments, setAttachments] = useState([]); // File[]
  const [sending,     setSending]     = useState(false);
  const [error,       setError]       = useState(null);
  const fileInputRef = useRef(null);

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

  function handleFilePick(e) {
    const files = Array.from(e.target.files || []);
    const valid = files.filter(f => ALLOWED_ATTACH_TYPES.has(f.type));
    const rejected = files.length - valid.length;
    if (rejected > 0) setError(`${rejected} ${t.emailAttachmentSkipped}`);
    setAttachments(prev => {
      const merged = [...prev, ...valid];
      if (merged.length > 5) {
        setError(t.emailMaxAttachments);
        return merged.slice(0, 5);
      }
      return merged;
    });
    // Reset so the same file can be re-added after removal
    e.target.value = '';
  }

  function removeAttachment(idx) {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleSend() {
    if (!recipientEmail || !body.trim()) {
      setError(t.emailToRequired);
      return;
    }
    // For raw freeform input (no contact selected), enforce valid email format.
    if (!toEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      setError(t.emailInvalidAddress);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendEmail({ to: recipientEmail, subject: subject.trim(), body: body.trim(), attachments });
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
          <p className="text-sm font-semibold text-gray-900">{t.emailNewEmail}</p>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">

          {/* ── To ── */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t.emailToLabel}</label>

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
            <label className="block text-xs text-gray-500 mb-1">{t.emailSubjectLabel}</label>
            <input
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder={t.emailSubjectPH}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400 placeholder:text-gray-400"
            />
          </div>

          {/* ── Message ── */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t.emailMessageLabel}</label>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder={t.emailMessagePH}
              rows={6}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-violet-400 placeholder:text-gray-400"
            />
          </div>

          {/* ── Attachments list ── */}
          {attachments.length > 0 && (
            <div className="space-y-1.5">
              {attachments.map((file, idx) => (
                <div key={idx} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-1.5">
                  <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  <span className="text-xs text-gray-700 truncate flex-1">{file.name}</span>
                  <span className="text-[11px] text-gray-400 shrink-0">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(idx)}
                    className="text-gray-300 hover:text-red-400 transition-colors shrink-0"
                    aria-label="Remove attachment"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv"
          className="hidden"
          onChange={handleFilePick}
        />

        <div className="flex items-center justify-between px-5 pb-5 pt-1">
          <div className="flex items-center gap-3">
            <p className="text-[11px] text-gray-400">{t.emailCmdEnter}</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= 5}
              className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Attach file (max 5, 10 MB each)"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
              {t.emailAttach}
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2 transition-colors"
            >
              {t.emailCancel}
            </button>
            <button
              onClick={handleSend}
              disabled={sending}
              className="text-sm font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg px-5 py-2 transition-colors"
            >
              {sending ? t.emailSending : t.emailSend}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Gmail error banner ────────────────────────────────────────────────────────
// Shown when the OAuth callback returns a gmail_error param.
// Persists until dismissed — more visible than a toast for beta users.

const GMAIL_ERROR_COPY = {
  access_restricted: {
    title: 'Gmail access is currently limited during beta testing.',
    body:  'Contact your administrator to enable Gmail access for your Google account.',
  },
  oauth_disabled: {
    title: 'Gmail connection is not available yet.',
    body:  'We\'re finishing Google verification before enabling Gmail sync for testers.',
  },
  not_configured: {
    title: 'Gmail is not configured on this server.',
    body:  'Contact your administrator to set up Gmail integration.',
  },
  oauth_cancelled: {
    title: 'Gmail connection was cancelled.',
    body:  'You can try connecting again from Email Settings.',
  },
  oauth_error: {
    title: 'Gmail connection could not be completed.',
    body:  'Contact your administrator if this keeps happening.',
  },
};

function GmailErrorBanner({ code, onDismiss }) {
  const copy = GMAIL_ERROR_COPY[code] || GMAIL_ERROR_COPY.oauth_error;
  return (
    <div className="mx-4 mb-3 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 shrink-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          {/* Warning icon */}
          <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-800 leading-snug">{copy.title}</p>
            <p className="text-[11px] text-amber-700 mt-0.5 leading-relaxed">{copy.body}</p>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 text-amber-400 hover:text-amber-600 transition-colors mt-0.5"
          aria-label="Dismiss"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EmailPage() {
  const t = getT();
  const [emails,        setEmails]        = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [activeMailbox, setActiveMailbox] = useState('all'); // 'all' | 'inbox' | 'sent' | 'trash'
  const [gmailStatus,   setGmailStatus]   = useState({ connected: false, email: null, enabled: false });
  const [gmailError,    setGmailError]    = useState(null); // error code string | null
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [composeOpen,   setComposeOpen]   = useState(false);
  const [settingsOpen,  setSettingsOpen]  = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [toast,         setToast]         = useState(null); // { message, type }
  const invalidate = useInvalidate();

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
      .catch(err => {
        console.error('[EmailPage] Fetch failed:', err);
        // ── Desync fix: detect "token expired / unauthorized" responses and
        // immediately flip gmailStatus.connected to false. Without this, a
        // tab that was opened a day ago could happily show the previously-
        // synced inbox while every fetch silently 401s, leaving the UI in
        // an impossible state ("Connected" badge while every action fails).
        //
        // The signal can come either as err.status (modern fetch wrapper)
        // or embedded in err.message (older shapes). We accept both.
        const looksAuthExpired =
          err.status === 401 ||
          err.code === 'gmail_token_expired' ||
          /401|unauth|expired|invalid[_ ]grant|reauthen/i.test(err.message || '');
        if (looksAuthExpired) {
          setGmailStatus(s => ({ ...s, connected: false }));
        }
        setEmails([]);
      })
      .finally(() => setLoading(false));
  }, []); // stable — reads mailbox via ref

  // Re-fetch whenever the active mailbox tab changes
  useEffect(() => {
    setLoading(true);
    setSelectedEmail(null);
    fetchEmails();
  }, [activeMailbox, fetchEmails]);

  // ── Gmail status ───────────────────────────────────────────────────────────
  // Runs on mount AND every time the tab becomes visible again. Without the
  // visibility listener, a token that expires while the tab is backgrounded
  // never gets re-checked — the UI stays on stale `connected = true` until
  // a full reload. Now we re-verify on every return.
  useEffect(() => {
    let cancelled = false;

    function refresh() {
      getGmailStatus()
        .then(s => { if (!cancelled) setGmailStatus(s); })
        .catch(() => {});
    }
    refresh();

    function onVisibility() {
      // Only refresh when the tab returns to the foreground — going hidden
      // doesn't tell us anything new.
      if (document.visibilityState === 'visible') refresh();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // ── Post-OAuth redirect detection ──────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.get('gmail_connected') === '1') {
      window.history.replaceState({}, '', window.location.pathname);
      setGmailError(null); // clear any previous error
      showToast(t.emailGmailConnectedToast, 'info');
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
      const errCode = params.get('gmail_error');
      window.history.replaceState({}, '', window.location.pathname);
      // Show as a persistent in-page banner (not a disappearing toast) so beta
      // users understand this is intentional and know what to do next.
      setGmailError(errCode);
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
      showToast(t.emailGmailDisconnected);
    } catch (err) {
      showToast(t.emailFailedDisconnect + err.message, 'error');
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
      // The bottom-nav email badge comes from getCounts polled every 30s.
      // Without this invalidate, opening an unread email would update the
      // row instantly but the badge would stay stale for up to 30 seconds.
      invalidate('counts');
    } catch {
      // Revert on failure
      setEmails(prev => prev.map(e => e.id === email.id ? { ...e, is_read: email.is_read } : e));
      showToast(t.emailFailedUpdate, 'error');
    }
  }

  async function handleDelete(email) {
    // Optimistic remove
    const wasUnread = email.is_read === 0 && email.direction !== 'outbound';
    setEmails(prev => prev.filter(e => e.id !== email.id));
    if (selectedEmail?.id === email.id) setSelectedEmail(null);
    showToast(t.emailDeletedToast);
    try {
      await softDeleteEmail(email.id);
      // Refresh the bottom-nav badge if we just removed an unread inbound —
      // the counts query (counts.js) filters out is_deleted=1.
      if (wasUnread) invalidate('counts');
    } catch {
      fetchEmails(); // Re-fetch on failure to restore
      showToast(t.emailFailedDelete, 'error');
    }
  }

  async function handleArchive(email) {
    // Optimistic remove from inbox view
    const wasUnread = email.is_read === 0 && email.direction !== 'outbound';
    setEmails(prev => prev.filter(e => e.id !== email.id));
    if (selectedEmail?.id === email.id) setSelectedEmail(null);
    showToast(t.emailArchivedToast);
    try {
      await patchEmail(email.id, { is_archived: 1 });
      // Same as delete — archived emails are excluded from the counts query.
      if (wasUnread) invalidate('counts');
    } catch {
      fetchEmails();
      showToast(t.emailFailedArchive, 'error');
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

  // Date-bucketed groups — memoize so the bucketing only re-runs on email
  // list changes, not every keystroke. Empty `emails` returns an empty array.
  const emailGroups = useMemo(() => bucketEmails(emails, t), [emails, t]);

  return (
    <div className="flex h-full overflow-hidden bg-ink-950">

      {/* ── Left pane: email list ─────────────────────────────────────────── */}
      <div className={`
        flex flex-col
        w-full md:w-[360px] lg:w-[400px] md:flex shrink-0
        ${showDetail ? 'hidden md:flex' : 'flex'}
        md:border-r md:border-ink-700
      `}>

        {/* List header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 shrink-0">
          <h1 className="text-xl font-bold text-ink-50 tracking-tight">{t.emailTitle}</h1>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-lg hover:bg-black/[0.04] text-ink-400 hover:text-ink-50 transition-colors"
              aria-label="Email settings"
            >
              <GearIcon className="w-5 h-5" />
            </button>
            {/* Desktop compose button — mobile uses the FAB below. */}
            {gmailStatus.connected && (
              <button
                onClick={() => setComposeOpen(true)}
                className="hidden md:inline-flex items-center gap-1.5 text-sm font-semibold bg-ink-50 hover:bg-ink-100 text-white rounded-full px-4 py-1.5 transition-colors active:scale-[0.97]"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                {t.emailCompose}
              </button>
            )}
          </div>
        </div>

        {/* Gmail error banner — shown after a failed OAuth redirect */}
        {gmailError && (
          <GmailErrorBanner code={gmailError} onDismiss={() => setGmailError(null)} />
        )}

        {/* Gmail connection state strip — one consolidated surface, not three.
             When connected: a quiet account-email row. When disconnected and
             enabled for the user: an amber call-to-connect. When disabled
             (beta gate): a coming-soon strip. */}
        {!gmailStatus.connected && gmailStatus.enabled && (
          <div className="mx-4 mb-3 flex items-center justify-between gap-2 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
              <p className="text-xs text-amber-700 font-medium truncate">{t.emailGmailNotConnectedStrip}</p>
            </div>
            <a
              href={`${BACKEND_URL}/auth/google`}
              className="shrink-0 flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-900 bg-white border border-amber-200 rounded-lg px-2.5 py-1 transition-colors"
            >
              <GoogleLogo size={12} />
              {t.emailConnectButton}
            </a>
          </div>
        )}
        {!gmailStatus.connected && !gmailStatus.enabled && (
          <div className="mx-4 mb-3 bg-ink-800 ring-1 ring-ink-700 rounded-xl px-3 py-3 shrink-0">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-ink-500 shrink-0" />
              <p className="text-xs font-semibold text-ink-300">{t.emailGmailComingSoonStrip}</p>
            </div>
            <p className="text-[11px] text-ink-400 leading-relaxed">
              {t.emailGmailComingSoonStrip2}
            </p>
          </div>
        )}
        {gmailStatus.connected && (
          <div className="mx-4 mb-3 flex items-center gap-2 shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-status-new shadow-[0_0_6px_rgba(22,163,74,0.5)] shrink-0" />
            <p className="text-xs text-ink-400 truncate">{gmailStatus.email}</p>
          </div>
        )}

        {/* Mailbox tabs — segmented control matching the Calls page */}
        <div className="mx-4 mb-3 bg-ink-800 rounded-full p-1 flex items-center shrink-0">
          {[
            { key: 'all',   label: t.emailTabAll },
            { key: 'inbox', label: t.emailTabInbox },
            { key: 'sent',  label: t.emailTabSent },
            { key: 'trash', label: t.emailTabTrash },
          ].map(tab => {
            const isActive = activeMailbox === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveMailbox(tab.key)}
                className={`flex-1 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-all duration-150
                  ${isActive
                    ? 'bg-ink-50 text-white shadow-sm'
                    : 'text-ink-400 hover:text-ink-100'
                  }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Email list (scrollable) */}
        <div className="flex-1 overflow-y-auto pb-[calc(96px+env(safe-area-inset-bottom))] md:pb-4">
          {loading ? (
            <div className="space-y-6 px-4 pt-2">
              {[3, 2].map((n, gi) => (
                <div key={gi}>
                  <div className="flex items-center gap-3 mb-2 px-1 animate-pulse">
                    <div className="h-2.5 w-14 bg-ink-700 rounded-full" />
                    <div className="flex-1 h-px bg-ink-700" />
                    <div className="h-2.5 w-4 bg-ink-700 rounded-full" />
                  </div>
                  <div className="bg-ink-900 rounded-2xl ring-1 ring-ink-700 overflow-hidden">
                    {Array.from({ length: n }).map((_, i) => (
                      <div key={i}>
                        {i > 0 && <div className="h-px bg-ink-800 mx-4" />}
                        <SkeletonRow />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : emails.length === 0 ? (
            <EmptyState
              icon={<EnvelopeIcon className="w-5 h-5" />}
              title={t.emailNoEmails}
              subtitle={gmailStatus.connected ? t.emailConnectHint : t.emailNotConnected}
            />
          ) : (
            <div className="space-y-6 px-4 pt-2">
              {emailGroups.map(group => (
                <GroupedListSection
                  key={group.label}
                  label={group.label}
                  count={group.items.length}
                >
                  {group.items.map(email => (
                    <SwipeableEmailRow
                      key={email?.id ?? email?.gmail_message_id}
                      email={email}
                      isSelected={selectedEmail?.id === email.id}
                      onClick={() => handleSelectEmail(email)}
                      onDelete={handleDelete}
                      onToggleRead={handleToggleRead}
                      onArchive={handleArchive}
                    />
                  ))}
                </GroupedListSection>
              ))}
            </div>
          )}
        </div>

        {/* Floating Compose — mobile only. Hidden when Gmail isn't connected
             because a compose action wouldn't be able to send. Also hidden
             when a detail panel is showing on mobile (the back action takes
             precedence visually). */}
        {gmailStatus.connected && !showDetail && (
          <FloatingActionButton
            onClick={() => setComposeOpen(true)}
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            }
            label={t.emailCompose}
            ariaLabel={t.emailCompose}
          />
        )}
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
          <div className="hidden md:flex flex-1 items-center justify-center bg-ink-950">
            <div className="text-center">
              <div className="w-12 h-12 rounded-2xl bg-ink-900 ring-1 ring-ink-700 shadow-card flex items-center justify-center mx-auto mb-3">
                <EnvelopeIcon className="w-6 h-6 text-ink-400" />
              </div>
              <p className="text-sm font-semibold text-ink-100">{t.emailSelectPrompt}</p>
              <p className="text-xs text-ink-400 mt-1">{t.emailSelectHint}</p>
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
            showToast(t.emailSentToast, 'success');
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
