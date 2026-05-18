import { useState, useRef, useEffect } from 'react';
import { updateLeadStatus, archiveLead, unarchiveLead, deleteLead, translateText, sendMessage } from '../api';
import { useInvalidate } from '../refreshBus';
import { normalizePhone, parseTimestamp } from '../utils/phone';
import PhoneActionSheet from './PhoneActionSheet';
import { translations } from '../i18n';

// Status pill colors — dark-surface variants. Each pill is a chip on the
// ink-800 card surface, so we use saturated text on a translucent matching
// background ring for crisp contrast without competing with the card.
const STATUS_COLORS = {
  New:       'bg-status-new/15        text-status-new       ring-1 ring-status-new/30',
  Contacted: 'bg-status-contacted/15  text-status-contacted ring-1 ring-status-contacted/30',
  Qualified: 'bg-status-customer/15   text-status-customer  ring-1 ring-status-customer/30',
  Closed:    'bg-ink-700              text-ink-300          ring-1 ring-ink-600',
};

// Left-edge status indicator color — a vertical bar inside the card.
// Communicates lead state at a glance during fast scanning.
const STATUS_EDGE = {
  New:       'bg-status-new',
  Contacted: 'bg-status-contacted',
  Qualified: 'bg-status-customer',
  Closed:    'bg-ink-600',
};

// Category chip colors — secondary semantic axis (Lead vs Vendor vs ...)
const CATEGORY_CHIP = {
  'Lead':              'bg-accent-500/12    text-accent-300    ring-accent-400/25',
  'Existing Customer': 'bg-status-customer/12 text-status-customer ring-status-customer/25',
  'Vendor':            'bg-status-vendor/12 text-status-vendor  ring-status-vendor/25',
  'Spam':              'bg-status-urgent/12 text-status-urgent  ring-status-urgent/25',
  'Other':             'bg-ink-700          text-ink-300        ring-ink-600',
};

const STATUSES = ['New', 'Contacted', 'Qualified', 'Closed'];

function getAgeLabel(createdAt, t) {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return t.timeJustNow;
  if (minutes < 60) return `${minutes}${t.timeOldM}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${t.timeOldH}`;
  const days = Math.floor(hours / 24);
  return `${days}${t.timeOldD}`;
}

function getUrgency(createdAt, status) {
  if (status !== 'New') return null;
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const hours = diffMs / 3600000;
  if (hours >= 24) return 'overdue';
  if (hours >= 2) return 'warning';
  return null;
}

// ── Tag system ────────────────────────────────────────────────────────────────
//
// formatLeadTags() is the single transformation point between raw AI key_points
// and what the contractor sees. Never pass raw AI text directly to the Tag UI.
//
// Priority order: problem → location → urgency → other context

// Maps a keyword pattern in the job-type value to a concise label.
// First match wins. Pair with an action suffix determined separately.
const JOB_TYPE_PATTERNS = [
  [/water heater/i,                'Water heater'],
  [/oil burner|oil boiler/i,       'Oil burner'],
  [/boiler/i,                      'Boiler'],
  [/furnace/i,                     'Furnace'],
  [/hvac|air.cond|cooling|heat pump/i, 'HVAC'],
  [/burst pipe|broken pipe/i,      'Burst pipe'],
  [/pipe|plumb|leak/i,             'Plumbing'],
  [/drain|clog|sewer|backup/i,     'Drain/clog'],
  [/faucet/i,                      'Faucet'],
  [/sink/i,                        'Sink'],
  [/toilet/i,                      'Toilet'],
  [/shower|tub|bathtub/i,          'Shower/tub'],
  [/smoke.detect|carbon.monox/i,   'Smoke detectors'],
  [/electrical|wir|panel|outlet/i, 'Electrical'],
  [/roof|gutter|shingle/i,         'Roofing'],
  [/window/i,                      'Windows'],
  [/floor|tile|hardwood/i,         'Flooring'],
  [/remodel|renovation|bathroom|kitchen/i, 'Remodeling'],
  [/paint/i,                       'Painting'],
  [/landscap|lawn|tree/i,          'Landscaping'],
  [/appliance|dishwasher|washer|dryer/i, 'Appliance'],
];

function condenseJobType(value) {
  for (const [pattern, label] of JOB_TYPE_PATTERNS) {
    if (pattern.test(value)) {
      const isReplacement = /replac|new unit|install/i.test(value);
      const isRepair      = /repair|fix|broken|burst|fail|not working/i.test(value);
      if (isReplacement) return `${label} replacement`;
      if (isRepair)      return `${label} repair`;
      return label; // service call / unclear action
    }
  }
  // No pattern match — take the first 5 words rather than truncating mid-word
  const words = value.trim().split(/\s+/);
  return words.length > 5 ? words.slice(0, 5).join(' ') + '…' : value;
}

function condensePreference(value) {
  // Strip common filler openers so we get to the useful part fast
  return value
    .replace(/^(a contractor|contractor|someone)\s+(who|that)\s+/i, '')
    .replace(/^(looking for|prefers?|wants?)\s+/i, '')
    .replace(/^(a|an|the)\s+/i, '');
}

function isUrgentValue(value) {
  return /urgent|immediate|prompt|critical|asap|emergency|frustrat|worse|serious|right away/i.test(value);
}

// Returns an ordered array of { icon, value } tag objects ready to render.
function formatLeadTags(lead) {
  if (!lead.key_points || lead.key_points.length === 0) return [];

  let problemTag  = null;
  let locationTag = null;
  let urgencyTag  = null;
  const otherTags = [];

  for (const point of lead.key_points) {
    const colonIdx = point.indexOf(':');

    // No "Label: value" structure — treat as freeform context
    if (colonIdx === -1) {
      const condensed = condensePreference(point.trim());
      otherTags.push({ icon: '💬', value: condensed });
      continue;
    }

    const label = point.slice(0, colonIdx).trim().toLowerCase();
    const value = point.slice(colonIdx + 1).trim();

    if (label === 'job location' || label === 'location') {
      // Prefer city/town over state. For "City, ST" or "Street, City, ST" the
      // last segment is the state code — skip it and take the segment before it.
      const parts = value.split(',').map(p => p.trim()).filter(Boolean);
      const last  = parts[parts.length - 1] ?? '';
      const isStateCode = /^[A-Z]{2}$/.test(last);
      const city  = (isStateCode && parts.length >= 2)
        ? parts[parts.length - 2]   // "Norwalk, CT" → "Norwalk"
        : last;                      // "17 Main St, Norwalk" → "Norwalk"
      locationTag = { icon: '📍', value: city };

    } else if (label === 'type of work' || label === 'service' || label === 'service requested') {
      problemTag = { icon: '🔧', value: condenseJobType(value) };

    } else if (label.includes('urgency')) {
      urgencyTag = { icon: '⚡', value: isUrgentValue(value) ? 'Urgent' : 'Follow up' };

    } else if (label.includes('customer prefer') || label.includes('preference')) {
      otherTags.push({ icon: '💬', value: condensePreference(value) });
    }
    // Silently drop labels we don't recognise — avoids noise
  }

  // problem first → location → urgency → any other context pills
  return [
    problemTag  && { ...problemTag,  variant: 'problem'  },
    locationTag && { ...locationTag, variant: 'location' },
    urgencyTag  && { ...urgencyTag,  variant: 'urgency'  },
    ...otherTags.map(t => ({ ...t, variant: 'other' })),
  ].filter(Boolean);
}

// Variant styles create a clear visual hierarchy on the dark ink-900 card:
//   problem  — solid ink-700, lifted text  → most prominent
//   urgency  — amber tint, ringed border  → alert signal
//   location — ink-800 with soft text     → secondary
//   other    — ink-800 with soft text     → lowest prominence
const TAG_VARIANT_STYLES = {
  problem:  'bg-ink-700/80          text-ink-100         font-medium ring-1 ring-inset ring-ink-600/60',
  location: 'bg-ink-800/80          text-ink-300                     ring-1 ring-inset ring-ink-700/60',
  urgency:  'bg-status-scheduled/15 text-status-scheduled font-medium ring-1 ring-inset ring-status-scheduled/30',
  other:    'bg-ink-800/80          text-ink-300                     ring-1 ring-inset ring-ink-700/60',
};

function Tag({ icon, text, variant = 'other' }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${TAG_VARIANT_STYLES[variant]}`}>
      {icon && <span className="shrink-0 leading-none">{icon}</span>}
      <span>{text}</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function LeadCard({ lead, onLeadUpdated, onLeadRemoved, contractorName, onContactClick, isArchived = false, language = 'en', replyTranslation = false }) {
  const t = translations[language] || translations.en;
  const invalidate = useInvalidate();
  const [updating, setUpdating] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [editingFollowUp, setEditingFollowUp] = useState(false);
  const [followUpDraft, setFollowUpDraft] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionSheetPhone, setActionSheetPhone] = useState(null);
  // Translation state
  const [translatedText, setTranslatedText] = useState(null);
  const [showingTranslation, setShowingTranslation] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const menuRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const baseFollowUp = contractorName
    ? (lead.follow_up_text || '').replace(/\[Your Name\]/g, contractorName)
    : lead.follow_up_text;

  const displayedFollowUp = followUpDraft !== null ? followUpDraft : baseFollowUp;

  const handleEditClick = () => {
    if (followUpDraft === null) setFollowUpDraft(baseFollowUp);
    setEditingFollowUp(true);
    // Clear translation — user is editing the source text
    setTranslatedText(null);
    setShowingTranslation(false);
  };

  const handleTranslate = async () => {
    const targetLang = language === 'es' ? 'en' : 'es';
    setIsTranslating(true);
    try {
      const { translated } = await translateText(displayedFollowUp, targetLang);
      setTranslatedText(translated);
      setShowingTranslation(true);
    } catch (err) {
      console.error('Translation failed:', err);
    } finally {
      setIsTranslating(false);
    }
  };

  const [isSending, setIsSending] = useState(false);
  const [hasSent, setHasSent] = useState(false);

  const handleSend = async () => {
    const to = lead.callback_number || lead.phone_number;
    const text = showingTranslation ? translatedText : displayedFollowUp;
    if (!to) { alert('No phone number available for this lead.'); return; }
    if (!text?.trim()) { alert('Follow-up text is empty.'); return; }
    setIsSending(true);
    try {
      await sendMessage(to, text.trim());
      setHasSent(true);   // lock button before alert so it can't be tapped again
      alert('Message sent!');
    } catch (err) {
      alert(`Failed to send: ${err.message}`);
    } finally {
      setIsSending(false);
    }
  };

  const handleStatusChange = async (e) => {
    const newStatus = e.target.value;
    setUpdating(true);
    try {
      const updated = await updateLeadStatus(lead.id, newStatus);
      onLeadUpdated(updated);
    } catch (err) {
      console.error('Status update failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const handleArchive = async () => {
    setMenuOpen(false);
    setUpdating(true);
    try {
      await archiveLead(lead.id);
      // Optimistic local update: parent removes the row from whichever list
      // is currently rendering this card (active leads OR archived).
      onLeadRemoved(lead.id);
      // Invalidate the leads bus key so any other surface that depends on
      // the active-leads list (e.g. App.jsx's master leads state) refetches.
      invalidate('leads');
    } catch (err) {
      console.error('Archive failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const handleUnarchive = async () => {
    setMenuOpen(false);
    setUpdating(true);
    try {
      await unarchiveLead(lead.id);
      onLeadRemoved(lead.id);
      // The unarchived lead now belongs back in App's master `leads` state.
      // Invalidating triggers fetchLeads — the row reappears in the
      // category sub-tab without waiting for the 30s heartbeat poll.
      invalidate('leads');
    } catch (err) {
      console.error('Unarchive failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    if (!window.confirm(t.leadDeleteConfirm)) return;
    setUpdating(true);
    try {
      await deleteLead(lead.id);
      onLeadRemoved(lead.id);
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const formattedDate = parseTimestamp(lead.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  const ageLabel = getAgeLabel(lead.created_at, t);
  const urgency = getUrgency(lead.created_at, lead.status);
  const rawText = lead.raw_text || lead.transcript;
  const category = lead.category || 'Lead';
  const primaryPhone = lead.callback_number || lead.phone_number;
  const showCallerIdSecondary = lead.callback_number && lead.phone_number && lead.callback_number !== lead.phone_number;

  // Status edge color — left vertical bar for instant scanability.
  // Overdue overrides status so urgency wins at-a-glance even if a lead
  // is technically still "New".
  const edgeColor = !isArchived && urgency === 'overdue'
    ? 'bg-status-urgent'
    : (STATUS_EDGE[lead.status] || STATUS_EDGE.New);

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl
        bg-ink-900 ring-1 ring-ink-800/80
        shadow-card hover:shadow-card-hover
        transition-all duration-200 ease-out
        ${lead.status === 'New' && !isArchived ? 'ring-status-new/20' : ''}`}
    >
      {/* Status edge — vertical accent rail. Wider when overdue for urgency. */}
      <div
        className={`absolute left-0 top-0 bottom-0 ${edgeColor}
          ${!isArchived && urgency === 'overdue' ? 'w-1.5' : 'w-1'}`}
        aria-hidden="true"
      />

      {/* Card body with extra left padding to clear the status edge */}
      <div className="pl-4 pr-3 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {/* ── Title row — bold name + quiet category chip ─────────────── */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => onContactClick && onContactClick(normalizePhone(lead.callback_number || lead.phone_number))}
                className="font-semibold text-base text-ink-50 truncate hover:text-accent-300 transition-colors text-left tracking-tight"
              >
                {lead.contact_name}
                {lead.company_name && (
                  <span className="text-ink-400 font-normal"> · {lead.company_name}</span>
                )}
              </button>
              <span className={`text-[10px] font-semibold tracking-wider uppercase rounded-md px-1.5 py-0.5 shrink-0
                ring-1 ${CATEGORY_CHIP[category] || CATEGORY_CHIP.Other}`}>
                {category}
              </span>
              {/* "NEW" attention badge — glow-pulses to draw the eye */}
              {lead.status === 'New' && !isArchived && (
                <span className="text-[10px] font-bold tracking-wider uppercase rounded-md px-1.5 py-0.5
                                 bg-status-new text-ink-950 animate-pulse-glow">
                  NEW
                </span>
              )}
            </div>

            {/* ── Phone row — interactive, accent color ───────────────────── */}
            {primaryPhone && (
              <button
                onClick={() => setActionSheetPhone(primaryPhone)}
                className="mt-0.5 text-sm font-medium text-accent-300 hover:text-accent-200 cursor-pointer transition-colors text-left tabular-nums"
              >
                {primaryPhone}
              </button>
            )}
            {showCallerIdSecondary && (
              <p className="text-[11px] text-ink-500 mt-0.5">
                {t.leadCalledFrom} <span className="tabular-nums">{lead.phone_number}</span>
              </p>
            )}

            {/* ── Metadata row — timestamps + urgency + message count ─────── */}
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <span className="text-[11px] text-ink-500 tabular-nums">{ageLabel}</span>
              <span className="text-ink-700">•</span>
              <span className="text-[11px] text-ink-500">{formattedDate}</span>

              {urgency === 'overdue' && (
                <span className="text-[10px] font-semibold tracking-wide uppercase
                                 text-status-urgent bg-status-urgent/12 rounded-md px-1.5 py-0.5
                                 ring-1 ring-status-urgent/30">
                  {t.leadOverdue}
                </span>
              )}
              {urgency === 'warning' && (
                <span className="text-[10px] font-semibold tracking-wide uppercase
                                 text-status-scheduled bg-status-scheduled/12 rounded-md px-1.5 py-0.5
                                 ring-1 ring-status-scheduled/30">
                  {t.leadNeedsFollowup}
                </span>
              )}
              {lead.message_count > 0 && (
                <span className="text-[10px] font-semibold tracking-wide uppercase
                                 text-status-customer bg-status-customer/12 rounded-md px-1.5 py-0.5
                                 ring-1 ring-status-customer/30 tabular-nums">
                  {lead.message_count} {lead.message_count === 1 ? t.leadText : t.leadTexts}
                </span>
              )}
            </div>
          </div>

          {/* ── Right side — status select + kebab menu ───────────────────── */}
          <div className="flex items-center gap-1 shrink-0">
            {!isArchived && (
              <select
                value={lead.status}
                onChange={handleStatusChange}
                disabled={updating}
                className={`text-[11px] font-semibold tracking-wide rounded-full pl-2.5 pr-7 py-1
                            cursor-pointer border-0 appearance-none bg-no-repeat
                            focus:outline-none focus:ring-2 focus:ring-accent-400 disabled:cursor-wait
                            ${STATUS_COLORS[lead.status] || STATUS_COLORS['New']}`}
                style={{
                  backgroundImage: `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' stroke='currentColor' stroke-width='2.5' viewBox='0 0 24 24'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`,
                  backgroundPosition: 'right 0.5rem center',
                  backgroundSize: '0.75rem',
                }}
              >
                {STATUSES.map(s => <option key={s} value={s} className="bg-ink-800 text-ink-50">{s}</option>)}
              </select>
            )}

            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen(o => !o)}
                disabled={updating}
                className="p-1.5 rounded-lg text-ink-400 hover:text-ink-200 hover:bg-white/[0.06] transition-colors disabled:cursor-wait"
                aria-label="More options"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                </svg>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-9 z-20 glass rounded-xl shadow-card py-1 min-w-[140px] animate-slide-up">
                  {isArchived ? (
                    <button
                      onClick={handleUnarchive}
                      className="w-full text-left px-3.5 py-2 text-sm text-ink-100 hover:bg-white/[0.06] transition-colors"
                    >
                      {t.leadUnarchive}
                    </button>
                  ) : (
                    <button
                      onClick={handleArchive}
                      className="w-full text-left px-3.5 py-2 text-sm text-ink-100 hover:bg-white/[0.06] transition-colors"
                    >
                      {t.leadArchive}
                    </button>
                  )}
                  <button
                    onClick={handleDelete}
                    className="w-full text-left px-3.5 py-2 text-sm text-status-urgent hover:bg-status-urgent/10 transition-colors"
                  >
                    {t.leadDelete}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

      {lead.summary && (
        <p
          className={`text-sm text-ink-200 mt-2.5 leading-relaxed cursor-pointer ${!descExpanded ? 'line-clamp-2' : ''}`}
          onClick={() => setDescExpanded(v => !v)}
        >
          {lead.summary}
        </p>
      )}
      {lead.key_points && lead.key_points.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {formatLeadTags(lead).map((tag, i) => (
            <Tag key={i} icon={tag.icon} text={tag.value} variant={tag.variant} />
          ))}
        </div>
      )}
      {baseFollowUp && !isArchived && (
        <div className="mt-3 pt-3 border-t border-ink-800/80">
          <div className="rounded-xl bg-ink-800/60 ring-1 ring-ink-700/60 px-3 py-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold tracking-wide uppercase text-ink-400">{t.leadSuggestedFollowup}</p>
                {!editingFollowUp
                  ? <button onClick={handleEditClick} className="text-[11px] text-ink-400 hover:text-ink-200 transition-colors">{t.leadFollowupEdit}</button>
                  : <button onClick={() => setEditingFollowUp(false)} className="text-[11px] text-accent-300 hover:text-accent-200 transition-colors">{t.leadFollowupDone}</button>
                }
              </div>
              <button
                onClick={handleSend}
                disabled={isSending || hasSent}
                className={`text-[11px] font-semibold tracking-wide transition-colors ${
                  hasSent
                    ? 'text-ink-500 cursor-not-allowed'
                    : 'text-accent-300 hover:text-accent-200 disabled:opacity-50'
                }`}
              >
                {hasSent ? t.leadSent : isSending ? t.leadSending : t.leadSend}
              </button>
            </div>
            {editingFollowUp ? (
              <textarea
                value={displayedFollowUp}
                onChange={e => setFollowUpDraft(e.target.value)}
                rows={3}
                className="w-full text-xs text-ink-100 border border-ink-700 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 resize-none bg-ink-900"
              />
            ) : (
              <p className="text-xs text-ink-200 leading-relaxed">
                {showingTranslation && translatedText ? translatedText : displayedFollowUp}
              </p>
            )}

            {/* Translation controls — only visible when feature is enabled */}
            {replyTranslation && !editingFollowUp && (
              <div className="mt-2 pt-2 border-t border-ink-700/60 flex items-center gap-3">
                {!translatedText ? (
                  <button
                    onClick={handleTranslate}
                    disabled={isTranslating}
                    className="text-xs text-status-vendor hover:text-violet-300 font-medium transition-colors disabled:opacity-50"
                  >
                    {isTranslating ? t.translating : t.translateTo}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => setShowingTranslation(p => !p)}
                      className="text-xs text-status-vendor hover:text-violet-300 font-medium transition-colors"
                    >
                      {showingTranslation ? t.showOriginal : t.showTranslation}
                    </button>
                    <span className="text-ink-600 text-xs">·</span>
                    <button
                      onClick={handleTranslate}
                      disabled={isTranslating}
                      className="text-xs text-ink-400 hover:text-ink-200 transition-colors disabled:opacity-50"
                    >
                      {isTranslating ? t.translating : t.leadRetranslate}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {rawText && (
        <div className="mt-2 border-t border-ink-800/80 pt-2">
          <button onClick={() => setShowRaw(p => !p)} className="text-xs text-ink-400 hover:text-ink-200 transition-colors">
            {showRaw ? t.leadHideOriginal : t.leadViewOriginal}
          </button>
          {showRaw && <p className="mt-2 text-xs text-ink-400 leading-relaxed whitespace-pre-wrap">{rawText}</p>}
        </div>
      )}
      </div>

      {actionSheetPhone && (
        <PhoneActionSheet
          phone={actionSheetPhone}
          onViewHistory={() => onContactClick && onContactClick(normalizePhone(actionSheetPhone))}
          onClose={() => setActionSheetPhone(null)}
        />
      )}
    </div>
  );
}
