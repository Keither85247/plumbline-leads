import { useState, useRef, useEffect } from 'react';
import { updateLeadStatus, archiveLead, unarchiveLead, deleteLead, translateText, sendMessage } from '../api';
import { useInvalidate } from '../refreshBus';
import { normalizePhone, parseTimestamp } from '../utils/phone';
import PhoneActionSheet from './PhoneActionSheet';
import { translations } from '../i18n';

// ─────────────────────────────────────────────────────────────────────────────
// LeadCard — matches the approved Figma spec.
//
// Card shape:
//   • rounded-3xl (24px), white fill, no border/ring
//   • state-driven drop-shadow glow (NEW → green halo, OVERDUE → red halo,
//     etc.) — replaces the old left-edge status bar
//   • fixed 358px width on a 390px screen (16px gutter each side)
//   • content padding is a single generous inner box (24px) so every row
//     inside breathes — the Figma's most visible signature
//
// Sections top-to-bottom (also matches Figma frame ordering):
//   1. Title row     — name (bold) · status pill (dot + label)  ·  phone (right) · kebab
//   2. Date          — "Apr 26, 2026" (quiet gray)
//   3. Tag pills     — key-point pills in a wrap row
//   4. More-details  — link-styled toggle that reveals the AI summary
//   5. Suggested-    — mint-tinted panel with heading, body, read-more,
//      follow-up       "View original message" link, edit icon disc, and
//                      the green Send pill (primary CTA)
//
// All existing state and handlers are preserved — this file is a
// presentation rewrite only.
// ─────────────────────────────────────────────────────────────────────────────

// Status pill config — the pill sitting inside the card title row. Each
// status maps to a light tinted background + a saturated text/dot color.
// The OVERDUE variant is a synthetic override triggered when a New lead
// crosses the 24h freshness threshold.
const STATUS_PILL = {
  New:       { bg: 'bg-brand-100',     text: 'text-brand-800',      dot: 'bg-brand-500',      label: 'NEW' },
  Contacted: { bg: 'bg-amber-100',     text: 'text-amber-700',      dot: 'bg-amber-500',      label: 'CONTACTED' },
  Qualified: { bg: 'bg-brand-100',     text: 'text-brand-800',      dot: 'bg-brand-500',      label: 'QUALIFIED' },
  Closed:    { bg: 'bg-ink-800',       text: 'text-ink-500',        dot: 'bg-ink-500',        label: 'CLOSED' },
};
const OVERDUE_PILL = { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500', label: 'OVERDUE' };

// Card-glow shadow per status. Keys match the STATUS_PILL keys plus the
// synthetic OVERDUE override. See tailwind.config.js boxShadow.glow-* for
// the underlying Figma spec (0 0 11px 0 <status>@60%).
const STATUS_GLOW = {
  New:       'shadow-glow-new',
  Contacted: 'shadow-glow-contacted',
  Qualified: 'shadow-glow-qualified',
  Closed:    'shadow-glow-closed',
};
const OVERDUE_GLOW = 'shadow-glow-overdue';

const STATUSES = ['New', 'Contacted', 'Qualified', 'Closed'];

// Overdue is a synthetic urgency signal calculated per render. Only New
// leads can be "overdue" (once they're Contacted/Qualified/Closed the
// contractor has already acted).
function getUrgency(createdAt, status) {
  if (status !== 'New') return null;
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const hours = diffMs / 3600000;
  if (hours >= 24) return 'overdue';
  return null;
}

// ── Tag extraction ──────────────────────────────────────────────────────────
// formatLeadTags is unchanged from the previous version — same content, same
// prioritization. The Figma shows the pills as a uniform light-gray style so
// we drop icons and variants at the render step below.
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
      return label;
    }
  }
  const words = value.trim().split(/\s+/);
  return words.length > 5 ? words.slice(0, 5).join(' ') + '…' : value;
}

function condensePreference(value) {
  return value
    .replace(/^(a contractor|contractor|someone)\s+(who|that)\s+/i, '')
    .replace(/^(looking for|prefers?|wants?)\s+/i, '')
    .replace(/^(a|an|the)\s+/i, '');
}

function isUrgentValue(value) {
  return /urgent|immediate|prompt|critical|asap|emergency|frustrat|worse|serious|right away/i.test(value);
}

// Returns a flat array of tag strings for the pill row. Order matches the
// previous priority: problem → location → urgency → other context.
function formatLeadTags(lead) {
  if (!lead.key_points || lead.key_points.length === 0) return [];

  let problemTag  = null;
  let locationTag = null;
  let urgencyTag  = null;
  const otherTags = [];

  for (const point of lead.key_points) {
    const colonIdx = point.indexOf(':');
    if (colonIdx === -1) {
      otherTags.push(condensePreference(point.trim()));
      continue;
    }
    const label = point.slice(0, colonIdx).trim().toLowerCase();
    const value = point.slice(colonIdx + 1).trim();

    if (label === 'job location' || label === 'location') {
      const parts = value.split(',').map(p => p.trim()).filter(Boolean);
      const last  = parts[parts.length - 1] ?? '';
      const isStateCode = /^[A-Z]{2}$/.test(last);
      locationTag = (isStateCode && parts.length >= 2) ? parts[parts.length - 2] : last;
    } else if (label === 'type of work' || label === 'service' || label === 'service requested') {
      problemTag = condenseJobType(value);
    } else if (label.includes('urgency')) {
      urgencyTag = isUrgentValue(value) ? 'Urgent' : 'Follow up';
    } else if (label.includes('customer prefer') || label.includes('preference')) {
      otherTags.push(condensePreference(value));
    }
  }

  return [problemTag, locationTag, urgencyTag, ...otherTags].filter(Boolean);
}

// Uniform light-gray key-point tag pill — matches the Figma "Water Leak"
// treatment exactly (no icons, no variant tinting, single style).
function TagPill({ text }) {
  return (
    <span className="inline-flex items-center px-3 py-1 rounded-full bg-ink-800 text-ink-300 text-xs font-medium whitespace-nowrap">
      {text}
    </span>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────

function KebabIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5"  r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

function ChevronDown({ className = 'w-3.5 h-3.5' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  );
}

function PencilIcon({ className = 'w-4 h-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 11l10-10 4 4-10 10H9v-4z" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function LeadCard({
  lead,
  onLeadUpdated,
  onLeadRemoved,
  contractorName,
  onContactClick,
  isArchived = false,
  language = 'en',
  replyTranslation = false,
}) {
  const t = translations[language] || translations.en;
  const invalidate = useInvalidate();
  const [updating, setUpdating]                 = useState(false);
  const [showRaw, setShowRaw]                   = useState(false);
  const [descExpanded, setDescExpanded]         = useState(false);
  const [readMoreExpanded, setReadMoreExpanded] = useState(false);
  const [editingFollowUp, setEditingFollowUp]   = useState(false);
  const [followUpDraft, setFollowUpDraft]       = useState(null);
  const [menuOpen, setMenuOpen]                 = useState(false);
  const [statusMenuOpen, setStatusMenuOpen]     = useState(false);
  const [actionSheetPhone, setActionSheetPhone] = useState(null);
  // Translation state
  const [translatedText, setTranslatedText]         = useState(null);
  const [showingTranslation, setShowingTranslation] = useState(false);
  const [isTranslating, setIsTranslating]           = useState(false);
  const menuRef = useRef(null);
  const statusRef = useRef(null);

  // Close menus on outside click
  useEffect(() => {
    if (!menuOpen && !statusMenuOpen) return;
    const handler = (e) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
      if (statusMenuOpen && statusRef.current && !statusRef.current.contains(e.target)) setStatusMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen, statusMenuOpen]);

  const baseFollowUp = contractorName
    ? (lead.follow_up_text || '').replace(/\[Your Name\]/g, contractorName)
    : lead.follow_up_text;

  const displayedFollowUp = followUpDraft !== null ? followUpDraft : baseFollowUp;

  const handleEditClick = () => {
    if (followUpDraft === null) setFollowUpDraft(baseFollowUp);
    setEditingFollowUp(true);
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
  const [hasSent, setHasSent]     = useState(false);

  const handleSend = async () => {
    const to = lead.callback_number || lead.phone_number;
    const text = showingTranslation ? translatedText : displayedFollowUp;
    if (!to)          { alert('No phone number available for this lead.'); return; }
    if (!text?.trim()) { alert('Follow-up text is empty.'); return; }
    setIsSending(true);
    try {
      await sendMessage(to, text.trim());
      setHasSent(true);
      alert('Message sent!');
    } catch (err) {
      alert(`Failed to send: ${err.message}`);
    } finally {
      setIsSending(false);
    }
  };

  const handleStatusChange = async (newStatus) => {
    setStatusMenuOpen(false);
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
      onLeadRemoved(lead.id);
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

  // ── Derived render values ────────────────────────────────────────────────
  const formattedDate = parseTimestamp(lead.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  const urgency        = getUrgency(lead.created_at, lead.status);
  const isOverdue      = !isArchived && urgency === 'overdue';
  const rawText        = lead.raw_text || lead.transcript;
  const primaryPhone   = lead.callback_number || lead.phone_number;
  const showCallerIdSecondary = lead.callback_number && lead.phone_number
    && lead.callback_number !== lead.phone_number;

  // Status pill + glow — OVERDUE overrides the underlying status so
  // urgency wins at-a-glance even though the lead is technically still "New".
  const pill = isOverdue ? OVERDUE_PILL : (STATUS_PILL[lead.status] || STATUS_PILL.New);
  const glow = isArchived
    ? ''
    : (isOverdue ? OVERDUE_GLOW : (STATUS_GLOW[lead.status] || STATUS_GLOW.New));

  const tags = formatLeadTags(lead);

  return (
    <div className={`w-full bg-ink-900 rounded-3xl ${glow} transition-shadow duration-200`}>
      {/* Inner content — the Figma has a very generous inner box so every
           row inside gets its own breathing room. 20px matches the visible
           padding in the design. */}
      <div className="px-5 py-5">

        {/* ── 1. Title row ─────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
            <button
              onClick={() => onContactClick && onContactClick(normalizePhone(primaryPhone))}
              className="font-semibold text-[17px] leading-tight text-ink-50 truncate tracking-tight text-left"
            >
              {lead.contact_name}
              {lead.company_name && (
                <span className="text-ink-400 font-normal"> · {lead.company_name}</span>
              )}
            </button>

            {/* Status pill — click to open a small menu that changes status.
                 Preserves the existing status-change workflow but wears the
                 Figma's dot+label pill treatment. */}
            <div className="relative shrink-0" ref={statusRef}>
              <button
                type="button"
                onClick={() => !isArchived && setStatusMenuOpen(o => !o)}
                disabled={updating || isArchived}
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ${pill.bg} ${pill.text}
                            text-[10px] font-semibold uppercase tracking-wider
                            transition-opacity ${!isArchived ? 'cursor-pointer hover:opacity-90' : ''}
                            disabled:opacity-60`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} aria-hidden="true" />
                <span>{pill.label}</span>
              </button>

              {statusMenuOpen && (
                <div className="absolute left-0 top-7 z-20 min-w-[140px] py-1 rounded-xl bg-white
                                shadow-card border border-ink-700">
                  {STATUSES.map(s => (
                    <button
                      key={s}
                      onClick={() => handleStatusChange(s)}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-ink-800 transition-colors
                                  ${lead.status === s ? 'text-ink-50 font-semibold' : 'text-ink-300'}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right side — phone (top) + kebab (top-right) */}
          <div className="flex items-start gap-2 shrink-0">
            {primaryPhone && (
              <button
                onClick={() => setActionSheetPhone(primaryPhone)}
                className="text-[14px] font-medium text-accent-500 hover:text-accent-600 tabular-nums whitespace-nowrap"
              >
                {primaryPhone}
              </button>
            )}

            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen(o => !o)}
                disabled={updating}
                className="text-ink-500 hover:text-ink-100 transition-colors disabled:cursor-wait -mr-1 -mt-1 p-1"
                aria-label="More options"
              >
                <KebabIcon />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-8 z-20 glass rounded-xl shadow-card py-1 min-w-[140px]">
                  {isArchived ? (
                    <button
                      onClick={handleUnarchive}
                      className="w-full text-left px-3.5 py-2 text-sm text-ink-100 hover:bg-black/[0.04] transition-colors"
                    >
                      {t.leadUnarchive}
                    </button>
                  ) : (
                    <button
                      onClick={handleArchive}
                      className="w-full text-left px-3.5 py-2 text-sm text-ink-100 hover:bg-black/[0.04] transition-colors"
                    >
                      {t.leadArchive}
                    </button>
                  )}
                  <button
                    onClick={handleDelete}
                    className="w-full text-left px-3.5 py-2 text-sm text-status-urgent hover:bg-red-50 transition-colors"
                  >
                    {t.leadDelete}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── 2. Date row ─────────────────────────────────────────────── */}
        <p className="mt-1 text-[13px] text-ink-500">
          {formattedDate}
        </p>
        {showCallerIdSecondary && (
          <p className="mt-0.5 text-[11px] text-ink-500">
            {t.leadCalledFrom} <span className="tabular-nums">{lead.phone_number}</span>
          </p>
        )}

        {/* ── 3. Tag pills ─────────────────────────────────────────────── */}
        {tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {tags.map((tag, i) => <TagPill key={i} text={tag} />)}
          </div>
        )}

        {/* ── 4. More details — reveals the AI summary + raw message ──── */}
        {(lead.summary || rawText) && (
          <button
            onClick={() => setDescExpanded(v => !v)}
            className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-accent-500 hover:text-accent-600"
          >
            {t.leadMoreDetails || 'More details'}
            <span className={`transition-transform ${descExpanded ? 'rotate-180' : ''}`}>
              <ChevronDown />
            </span>
          </button>
        )}
        {descExpanded && lead.summary && (
          <p className="mt-2 text-[14px] text-ink-300 leading-relaxed">
            {lead.summary}
          </p>
        )}

        {/* ── 5. Suggested follow-up panel ─────────────────────────────── */}
        {baseFollowUp && !isArchived && (
          <div className="mt-5 rounded-2xl bg-brand-50 px-4 py-4">
            {/* Heading row */}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[14px] font-semibold text-brand-600">
                {t.leadSuggestedFollowup || 'Suggested follow-up'}
              </p>
              {!editingFollowUp ? (
                <button
                  onClick={handleEditClick}
                  className="text-[12px] text-ink-500 hover:text-ink-100 transition-colors"
                >
                  {t.leadFollowupEdit || 'Edit'}
                </button>
              ) : (
                <button
                  onClick={() => setEditingFollowUp(false)}
                  className="text-[12px] text-brand-600 hover:text-brand-700 font-medium transition-colors"
                >
                  {t.leadFollowupDone || 'Done'}
                </button>
              )}
            </div>

            {/* Body */}
            {editingFollowUp ? (
              <textarea
                value={displayedFollowUp}
                onChange={e => setFollowUpDraft(e.target.value)}
                rows={4}
                className="mt-2 w-full text-[13px] text-ink-100 border border-ink-700 rounded-lg px-3 py-2
                           focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none bg-white"
              />
            ) : (
              <p className={`mt-2 text-[13px] text-ink-300 leading-relaxed ${!readMoreExpanded ? 'line-clamp-2' : ''}`}>
                {showingTranslation && translatedText ? translatedText : displayedFollowUp}
                {!readMoreExpanded && (
                  <>
                    {' '}
                    <button
                      onClick={() => setReadMoreExpanded(true)}
                      className="text-brand-600 font-medium hover:text-brand-700"
                    >
                      {t.leadReadMore || 'Read more'}
                    </button>
                  </>
                )}
              </p>
            )}

            {/* Translation controls */}
            {replyTranslation && !editingFollowUp && (
              <div className="mt-2 flex items-center gap-3">
                {!translatedText ? (
                  <button
                    onClick={handleTranslate}
                    disabled={isTranslating}
                    className="text-xs text-status-vendor hover:text-violet-800 font-medium transition-colors disabled:opacity-50"
                  >
                    {isTranslating ? t.translating : t.translateTo}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => setShowingTranslation(p => !p)}
                      className="text-xs text-status-vendor hover:text-violet-800 font-medium transition-colors"
                    >
                      {showingTranslation ? t.showOriginal : t.showTranslation}
                    </button>
                    <span className="text-ink-500 text-xs">·</span>
                    <button
                      onClick={handleTranslate}
                      disabled={isTranslating}
                      className="text-xs text-ink-500 hover:text-ink-100 transition-colors disabled:opacity-50"
                    >
                      {isTranslating ? t.translating : t.leadRetranslate}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Actions row — original message link · edit disc · Send pill */}
            <div className="mt-4 flex items-center justify-between gap-2">
              {rawText ? (
                <button
                  onClick={() => setShowRaw(p => !p)}
                  className="text-[13px] font-medium text-brand-600 hover:text-brand-700 underline underline-offset-2"
                >
                  {showRaw ? (t.leadHideOriginal || 'Hide original message') : (t.leadViewOriginal || 'View original message')}
                </button>
              ) : <span />}

              <div className="flex items-center gap-2 shrink-0">
                {!editingFollowUp && (
                  <button
                    onClick={handleEditClick}
                    className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center hover:bg-brand-200 transition-colors"
                    aria-label={t.leadFollowupEdit || 'Edit'}
                  >
                    <PencilIcon />
                  </button>
                )}
                <button
                  onClick={handleSend}
                  disabled={isSending || hasSent}
                  className={`h-9 px-5 rounded-full text-[14px] font-semibold transition-colors
                              ${hasSent
                                ? 'bg-ink-700 text-ink-400 cursor-not-allowed'
                                : 'bg-brand-800 hover:bg-brand-700 text-white disabled:opacity-50'}`}
                >
                  {hasSent ? t.leadSent : isSending ? t.leadSending : (t.leadSend || 'Send')}
                </button>
              </div>
            </div>

            {/* Raw original message reveal — sits inside the follow-up panel
                 so it's contextually attached to the "View original message"
                 link above. */}
            {showRaw && rawText && (
              <div className="mt-3 pt-3 border-t border-brand-100">
                <p className="text-[12px] text-ink-400 leading-relaxed whitespace-pre-wrap">
                  {rawText}
                </p>
              </div>
            )}
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
