import { useState, useRef, useEffect } from 'react';
import { updateLeadStatus, archiveLead, unarchiveLead, deleteLead, translateText, sendMessage } from '../api';
import { useInvalidate } from '../refreshBus';
import { normalizePhone, parseTimestamp } from '../utils/phone';
import PhoneActionSheet from './PhoneActionSheet';
import { translations } from '../i18n';

// ─────────────────────────────────────────────────────────────────────────────
// LeadCard — implements the approved Figma spec (values read from dev panel).
//
// Confirmed measurements:
//   card     358×hug · radius 24px · fill #FFFFFF · glow 0 0 11px <status>@60%
//   chips    bg #F3F4F6 · border 1px #E5E7EB · radius 40px · h 26px
//   Send     #065F46 (surface/brand_primary_main) · 64×36 · radius full
//   panel    bg #F3F4F6 (same gray as chips/page — NOT mint)
//
// Status variants (all five exist as Figma frames):
//   NEW green · OVERDUE red · CONTACTED orange · QUALIFIED purple ·
//   ARCHIVE gray (no glow)
//
// Text colors:
//   "Suggested follow-up" heading + "Read more"  → blue (link color)
//   "View original message"                       → near-black, underlined
//   "More details"                                → gray, not a link color
// ─────────────────────────────────────────────────────────────────────────────

// Status pill — dot + UPPERCASE label on a soft tinted bg. OVERDUE is a
// synthetic override applied when a New lead crosses the 24h threshold;
// ARCHIVE is applied to any card rendered from the archived list.
const STATUS_PILL = {
  New:       { cls: 'bg-[#ECFDF3] text-[#067647]', dot: 'bg-[#12B76A]', label: 'NEW' },
  Contacted: { cls: 'bg-[#FEF6EE] text-[#B93815]', dot: 'bg-[#EF6820]', label: 'CONTACTED' },
  Qualified: { cls: 'bg-[#F4F3FF] text-[#5925DC]', dot: 'bg-[#7A5AF8]', label: 'QUALIFIED' },
  Closed:    { cls: 'bg-[#F2F4F7] text-[#475467]', dot: 'bg-[#98A2B3]', label: 'CLOSED' },
};
const OVERDUE_PILL = { cls: 'bg-[#FEF3F2] text-[#D92D20]', dot: 'bg-[#F04438]', label: 'OVERDUE' };
const ARCHIVE_PILL = { cls: 'bg-[#F2F4F7] text-[#475467]', dot: 'bg-[#98A2B3]', label: 'ARCHIVE' };

const STATUS_GLOW = {
  New:       'shadow-glow-new',
  Contacted: 'shadow-glow-contacted',
  Qualified: 'shadow-glow-qualified',
  Closed:    '',
};
const OVERDUE_GLOW = 'shadow-glow-overdue';

const STATUSES = ['New', 'Contacted', 'Qualified', 'Closed'];

// Follow-up preview truncation. The Figma shows the body cut mid-word with an
// inline "… Read more" link, which a CSS line-clamp can't do (the link would
// get clipped with the text). Character-based truncation matches the comp.
// 72 chars ≈ two lines at 14px inside the panel's ~294px text column, leaving
// room for the inline "… Read more" on line two (matching the Figma's
// two-line preview exactly).
const FOLLOWUP_PREVIEW_CHARS = 72;

function getUrgency(createdAt, status) {
  if (status !== 'New') return null;
  const diffMs = Date.now() - new Date(createdAt).getTime();
  return diffMs / 3600000 >= 24 ? 'overdue' : null;
}

// ── Key-point → chip extraction (logic unchanged from previous versions) ───
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

// Chip — Figma spec: bg #F3F4F6, 1px #E5E7EB border, radius 40, h 26.
function Chip({ text }) {
  return (
    <span className="inline-flex items-center h-[26px] px-3 rounded-full bg-[#F3F4F6] border border-[#E5E7EB] text-[13px] text-[#344054] whitespace-nowrap">
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

function ChevronDown({ className = 'w-4 h-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  );
}

function PencilIcon({ className = 'w-4 h-4' }) {
  // Clean pen-with-underline glyph (feather "edit-3" shape). The previous
  // hand-rolled path rendered as an unreadable squiggle at 16px.
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 20h9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
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
  const [translatedText, setTranslatedText]         = useState(null);
  const [showingTranslation, setShowingTranslation] = useState(false);
  const [isTranslating, setIsTranslating]           = useState(false);
  const menuRef = useRef(null);
  const statusRef = useRef(null);

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
    if (!to)           { alert('No phone number available for this lead.'); return; }
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

  // ── Derived render values ─────────────────────────────────────────────────
  const formattedDate = parseTimestamp(lead.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  const urgency      = getUrgency(lead.created_at, lead.status);
  const isOverdue    = !isArchived && urgency === 'overdue';
  const rawText      = lead.raw_text || lead.transcript;
  const primaryPhone = lead.callback_number || lead.phone_number;
  const showCallerIdSecondary = lead.callback_number && lead.phone_number
    && lead.callback_number !== lead.phone_number;

  const pill = isArchived
    ? ARCHIVE_PILL
    : isOverdue
      ? OVERDUE_PILL
      : (STATUS_PILL[lead.status] || STATUS_PILL.New);

  // Archived cards get no glow, just a hairline ring so they don't float
  // shapeless on the gray canvas.
  const glow = isArchived
    ? 'ring-1 ring-[#EAECF0]'
    : (isOverdue ? OVERDUE_GLOW : (STATUS_GLOW[lead.status] ?? STATUS_GLOW.New)) || 'ring-1 ring-[#EAECF0]';

  const tags = formatLeadTags(lead);

  // Inline "… Read more" truncation for the follow-up preview.
  const activeFollowUp = showingTranslation && translatedText ? translatedText : displayedFollowUp;
  const needsTruncate  = !readMoreExpanded && (activeFollowUp?.length ?? 0) > FOLLOWUP_PREVIEW_CHARS;
  const previewText    = needsTruncate
    ? activeFollowUp.slice(0, FOLLOWUP_PREVIEW_CHARS).trimEnd() + '…'
    : activeFollowUp;

  return (
    <div className={`w-full bg-white rounded-3xl ${glow} transition-shadow duration-200`}>
      {/* 12px interior padding — Figma: content fills 334px inside the 358px
           card (28px from screen edge = 16 margin + 12 padding). */}
      <div className="px-3 pt-3 pb-3">

        {/* ── Title row: name · status pill · phone · kebab ───────────────
             The name is the only shrinkable element; the fixed elements are
             kept tight (13px phone, compact pill, slim kebab) so the natural
             flex squeeze still leaves ~100px of readable name width even
             with the widest pill (CONTACTED) + a full US phone number. */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onContactClick && onContactClick(normalizePhone(primaryPhone))}
            className="font-bold text-[17px] leading-tight text-[#101828] truncate tracking-tight text-left shrink min-w-0"
          >
            {lead.contact_name}
          </button>

          {/* Status pill — tap to change status (preserves the old select) */}
          <div className="relative shrink-0" ref={statusRef}>
            <button
              type="button"
              onClick={() => !isArchived && setStatusMenuOpen(o => !o)}
              disabled={updating || isArchived}
              className={`inline-flex items-center gap-1 px-2 h-6 rounded-full ${pill.cls}
                          text-[11px] font-semibold tracking-wide uppercase
                          ${!isArchived ? 'cursor-pointer active:opacity-80' : ''} disabled:opacity-70`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} aria-hidden="true" />
              <span>{pill.label}</span>
            </button>

            {statusMenuOpen && (
              <div className="absolute left-0 top-8 z-20 min-w-[150px] py-1 rounded-xl bg-white
                              shadow-card border border-[#EAECF0]">
                {STATUSES.map(s => (
                  <button
                    key={s}
                    onClick={() => handleStatusChange(s)}
                    className={`w-full text-left px-3.5 py-2 text-sm hover:bg-[#F3F4F6] transition-colors
                                ${lead.status === s ? 'text-[#101828] font-semibold' : 'text-[#475467]'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1" />

          {primaryPhone && (
            <button
              onClick={() => setActionSheetPhone(primaryPhone)}
              className="text-[13px] font-medium text-accent-500 tabular-nums whitespace-nowrap shrink-0"
            >
              {primaryPhone}
            </button>
          )}

          <div className="relative shrink-0" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              disabled={updating}
              className="p-0.5 -mr-1 text-[#98A2B3] hover:text-[#344054] transition-colors disabled:cursor-wait"
              aria-label="More options"
            >
              <KebabIcon />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-8 z-20 glass rounded-xl shadow-card py-1 min-w-[140px]">
                {isArchived ? (
                  <button
                    onClick={handleUnarchive}
                    className="w-full text-left px-3.5 py-2 text-sm text-[#101828] hover:bg-black/[0.04] transition-colors"
                  >
                    {t.leadUnarchive}
                  </button>
                ) : (
                  <button
                    onClick={handleArchive}
                    className="w-full text-left px-3.5 py-2 text-sm text-[#101828] hover:bg-black/[0.04] transition-colors"
                  >
                    {t.leadArchive}
                  </button>
                )}
                <button
                  onClick={handleDelete}
                  className="w-full text-left px-3.5 py-2 text-sm text-[#D92D20] hover:bg-[#FEF3F2] transition-colors"
                >
                  {t.leadDelete}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Date ───────────────────────────────────────────────────────── */}
        <p className="mt-1 text-[14px] text-[#667085]">{formattedDate}</p>

        {/* ── Key-point chips — 4px gap per Figma chips row ─────────────── */}
        {tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {tags.map((tag, i) => <Chip key={i} text={tag} />)}
          </div>
        )}

        {/* ── More details — quiet gray toggle, reveals summary + metadata ─ */}
        {(lead.summary || showCallerIdSecondary || lead.message_count > 0 || lead.company_name) && (
          <>
            {/* Figma "Frame 4": 97×18, 6px side padding (text sits 6px right
                 of the chips), 4px gap to the chevron, 8px above. */}
            <button
              onClick={() => setDescExpanded(v => !v)}
              className="mt-2 inline-flex items-center gap-1 h-[18px] px-1.5 text-[14px] leading-none text-[#475467] font-medium"
            >
              {t.leadMoreDetails || 'More details'}
              <span className={`transition-transform text-[#667085] ${descExpanded ? 'rotate-180' : ''}`}>
                <ChevronDown className="w-3.5 h-3.5" />
              </span>
            </button>
            {descExpanded && (
              <div className="mt-2.5 space-y-1.5">
                {lead.summary && (
                  <p className="text-[14px] text-[#475467] leading-relaxed">{lead.summary}</p>
                )}
                {lead.company_name && (
                  <p className="text-[13px] text-[#667085]">{lead.company_name}</p>
                )}
                {showCallerIdSecondary && (
                  <p className="text-[13px] text-[#667085]">
                    {t.leadCalledFrom} <span className="tabular-nums">{lead.phone_number}</span>
                  </p>
                )}
                {lead.message_count > 0 && (
                  <p className="text-[13px] text-[#667085] tabular-nums">
                    {lead.message_count} {lead.message_count === 1 ? t.leadText : t.leadTexts}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Suggested follow-up panel — gray bg, blue heading ─────────── */}
        {baseFollowUp && !isArchived && (
          <div className="mt-3 rounded-xl bg-[#F3F4F6] px-3.5 pt-3 pb-3.5">
            {/* Heading row is 22px tall with a 4px gap to the body (Figma
                 "Note Header" = Hug 22px, marker "4" between). */}
            <p className="text-[15px] leading-[22px] font-medium text-accent-500">
              {t.leadSuggestedFollowup || 'Suggested follow-up'}
            </p>

            {editingFollowUp ? (
              <textarea
                value={displayedFollowUp}
                onChange={e => setFollowUpDraft(e.target.value)}
                rows={4}
                className="mt-2 w-full text-[14px] text-[#101828] border border-[#D0D5DD] rounded-xl px-3 py-2.5
                           focus:outline-none focus:ring-2 focus:ring-accent-500 resize-none bg-white"
              />
            ) : (
              <p className="mt-1 text-[14px] text-[#475467] leading-[1.45]">
                {previewText}
                {needsTruncate && (
                  <>
                    {' '}
                    <button
                      onClick={() => setReadMoreExpanded(true)}
                      className="text-accent-500 font-medium"
                    >
                      {t.leadReadMore || 'Read more'}
                    </button>
                  </>
                )}
              </p>
            )}

            {/* Translation controls — preserved feature, quiet styling */}
            {replyTranslation && !editingFollowUp && (
              <div className="mt-2 flex items-center gap-3">
                {!translatedText ? (
                  <button
                    onClick={handleTranslate}
                    disabled={isTranslating}
                    className="text-[13px] text-[#7A5AF8] font-medium transition-colors disabled:opacity-50"
                  >
                    {isTranslating ? t.translating : t.translateTo}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => setShowingTranslation(p => !p)}
                      className="text-[13px] text-[#7A5AF8] font-medium transition-colors"
                    >
                      {showingTranslation ? t.showOriginal : t.showTranslation}
                    </button>
                    <span className="text-[#98A2B3] text-[13px]">·</span>
                    <button
                      onClick={handleTranslate}
                      disabled={isTranslating}
                      className="text-[13px] text-[#667085] transition-colors disabled:opacity-50"
                    >
                      {isTranslating ? t.translating : t.leadRetranslate}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Actions row — dark underlined link left · pencil disc + Send right */}
            <div className="mt-3 flex items-center justify-between gap-2">
              {rawText ? (
                <button
                  onClick={() => setShowRaw(p => !p)}
                  className="text-[14px] font-medium text-[#101828] underline underline-offset-[3px] decoration-[#101828]"
                >
                  {showRaw ? (t.leadHideOriginal || 'Hide original message') : (t.leadViewOriginal || 'View original message')}
                </button>
              ) : <span />}

              <div className="flex items-center gap-2 shrink-0">
                {editingFollowUp ? (
                  <button
                    onClick={() => setEditingFollowUp(false)}
                    className="text-[14px] font-medium text-accent-500"
                  >
                    {t.leadFollowupDone || 'Done'}
                  </button>
                ) : (
                  <button
                    onClick={handleEditClick}
                    className="w-9 h-9 rounded-full bg-[#065E46]/10 text-[#065F46] flex items-center justify-center active:opacity-70 transition-opacity"
                    aria-label={t.leadFollowupEdit || 'Edit'}
                  >
                    <PencilIcon />
                  </button>
                )}
                <button
                  onClick={handleSend}
                  disabled={isSending || hasSent}
                  className={`h-9 px-4 rounded-full text-[14px] font-semibold transition-colors
                              ${hasSent
                                ? 'bg-[#D0D5DD] text-white cursor-not-allowed'
                                : 'bg-[#065F46] active:bg-[#054C38] text-white disabled:opacity-60'}`}
                >
                  {hasSent ? t.leadSent : isSending ? t.leadSending : (t.leadSend || 'Send')}
                </button>
              </div>
            </div>

            {/* Raw original message reveal */}
            {showRaw && rawText && (
              <div className="mt-3 pt-3 border-t border-[#E5E7EB]">
                <p className="text-[13px] text-[#667085] leading-relaxed whitespace-pre-wrap">
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
