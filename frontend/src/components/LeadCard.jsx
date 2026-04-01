import { useState, useRef, useEffect } from 'react';
import { updateLeadStatus, archiveLead, unarchiveLead, deleteLead, translateText } from '../api';
import { normalizePhone } from '../utils/phone';
import PhoneActionSheet from './PhoneActionSheet';
import { translations } from '../i18n';

const STATUS_COLORS = {
  New: 'bg-blue-100 text-blue-800',
  Contacted: 'bg-yellow-100 text-yellow-800',
  Qualified: 'bg-green-100 text-green-800',
  Closed: 'bg-gray-100 text-gray-600'
};

const STATUSES = ['New', 'Contacted', 'Qualified', 'Closed'];

function getAgeLabel(createdAt) {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  const days = Math.floor(hours / 24);
  return `${days}d old`;
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
      // City is the last comma-segment (handles "17 Main St, Massapequa" or just "Hampstead")
      const parts = value.split(',');
      locationTag = { icon: '📍', value: parts[parts.length - 1].trim() };

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

// Variant styles create a clear visual hierarchy:
//   problem  — slate tint, medium weight  → most prominent
//   urgency  — amber tint, ringed border  → alert signal
//   location — soft gray                 → secondary
//   other    — soft gray                 → lowest prominence
const TAG_VARIANT_STYLES = {
  problem:  'bg-slate-100 text-slate-700 font-medium',
  location: 'bg-gray-100 text-gray-500',
  urgency:  'bg-amber-50 text-amber-700 font-medium ring-1 ring-inset ring-amber-200',
  other:    'bg-gray-100 text-gray-500',
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

  const handleSend = () => { alert('Texting integration coming soon'); };

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
      onLeadRemoved(lead.id);
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
    } catch (err) {
      console.error('Unarchive failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    if (!window.confirm('Permanently delete this lead? This cannot be undone.')) return;
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

  const formattedDate = new Date(lead.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  const ageLabel = getAgeLabel(lead.created_at);
  const urgency = getUrgency(lead.created_at, lead.status);
  const rawText = lead.raw_text || lead.transcript;
  const category = lead.category || 'Lead';
  const primaryPhone = lead.callback_number || lead.phone_number;
  const showCallerIdSecondary = lead.callback_number && lead.phone_number && lead.callback_number !== lead.phone_number;

  return (
    <div className={`border rounded-lg p-3 transition-colors
      ${urgency === 'overdue' && !isArchived ? 'border-l-[3px] border-l-amber-400' : ''}
      ${lead.status === 'New' && !isArchived ? 'bg-blue-50 border-blue-200 hover:border-blue-300' : 'border-gray-200 hover:border-gray-300'}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => onContactClick && onContactClick(normalizePhone(lead.callback_number || lead.phone_number))}
              className="font-semibold text-gray-900 truncate hover:text-blue-600 hover:underline transition-colors text-left"
            >
              {lead.contact_name}{lead.company_name ? ` (${lead.company_name})` : ''}
            </button>
            <span className="text-xs text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 shrink-0">{category}</span>
          </div>
          {primaryPhone && (
            <button
              onClick={() => setActionSheetPhone(primaryPhone)}
              className="text-sm text-blue-600 hover:text-blue-800 underline-offset-2 hover:underline cursor-pointer transition-colors text-left"
            >
              {primaryPhone}
            </button>
          )}
          {showCallerIdSecondary && (
            <p className="text-xs text-gray-400 mt-0.5">Called from: {lead.phone_number}</p>
          )}
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <p className="text-xs text-gray-400">{formattedDate}</p>
            <span className="text-xs text-gray-400">&middot;</span>
            <span className="text-xs text-gray-400">{ageLabel}</span>
            {urgency === 'overdue' && <span className="text-xs font-medium text-red-600 bg-red-50 rounded px-1.5 py-0.5">Overdue</span>}
            {urgency === 'warning' && <span className="text-xs font-medium text-yellow-700 bg-yellow-50 rounded px-1.5 py-0.5">Needs follow-up</span>}
          </div>
        </div>

        {/* Status + kebab menu */}
        <div className="flex items-center gap-1.5 shrink-0">
          {!isArchived && (
            <select
              value={lead.status}
              onChange={handleStatusChange}
              disabled={updating}
              className={`text-xs font-medium rounded-full px-3 py-1 cursor-pointer border-0
                          focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:cursor-wait
                          ${STATUS_COLORS[lead.status] || STATUS_COLORS['New']}`}
            >
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}

          {/* Kebab menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              disabled={updating}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:cursor-wait"
              aria-label="More options"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
              </svg>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-7 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[130px]">
                {isArchived ? (
                  <button
                    onClick={handleUnarchive}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Unarchive
                  </button>
                ) : (
                  <button
                    onClick={handleArchive}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Archive
                  </button>
                )}
                <button
                  onClick={handleDelete}
                  className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {lead.summary && (
        <p
          className={`text-sm text-gray-600 mt-2 leading-snug cursor-pointer ${!descExpanded ? 'line-clamp-2' : ''}`}
          onClick={() => setDescExpanded(v => !v)}
        >
          {lead.summary}
        </p>
      )}
      {lead.key_points && lead.key_points.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {formatLeadTags(lead).map((tag, i) => (
            <Tag key={i} icon={tag.icon} text={tag.value} variant={tag.variant} />
          ))}
        </div>
      )}
      {baseFollowUp && !isArchived && (
        <div className="mt-2 border-t border-gray-100 pt-2">
          <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-gray-500">Suggested follow-up</p>
                {!editingFollowUp
                  ? <button onClick={handleEditClick} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">Edit</button>
                  : <button onClick={() => setEditingFollowUp(false)} className="text-xs text-blue-500 hover:text-blue-700 transition-colors">Done</button>
                }
              </div>
              <button onClick={handleSend} className="text-xs text-blue-500 hover:text-blue-700 transition-colors">Send</button>
            </div>
            {editingFollowUp ? (
              <textarea
                value={displayedFollowUp}
                onChange={e => setFollowUpDraft(e.target.value)}
                rows={3}
                className="w-full text-xs text-gray-700 border border-gray-200 rounded-md px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none bg-white"
              />
            ) : (
              <p className="text-xs text-gray-600 leading-relaxed">
                {showingTranslation && translatedText ? translatedText : displayedFollowUp}
              </p>
            )}

            {/* Translation controls — only visible when feature is enabled */}
            {replyTranslation && !editingFollowUp && (
              <div className="mt-2 pt-2 border-t border-gray-100 flex items-center gap-3">
                {!translatedText ? (
                  <button
                    onClick={handleTranslate}
                    disabled={isTranslating}
                    className="text-xs text-violet-600 hover:text-violet-800 font-medium transition-colors disabled:opacity-50"
                  >
                    {isTranslating ? t.translating : t.translateTo}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => setShowingTranslation(p => !p)}
                      className="text-xs text-violet-600 hover:text-violet-800 font-medium transition-colors"
                    >
                      {showingTranslation ? t.showOriginal : t.showTranslation}
                    </button>
                    <span className="text-gray-300 text-xs">·</span>
                    <button
                      onClick={handleTranslate}
                      disabled={isTranslating}
                      className="text-xs text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
                    >
                      {isTranslating ? t.translating : '↺ Retranslate'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {rawText && (
        <div className="mt-2 border-t border-gray-100 pt-2">
          <button onClick={() => setShowRaw(p => !p)} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
            {showRaw ? 'Hide original message' : 'View original message'}
          </button>
          {showRaw && <p className="mt-2 text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">{rawText}</p>}
        </div>
      )}

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
