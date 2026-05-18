import { useState, useEffect, useRef, useMemo } from 'react';
import { getCalls, getVoicemailLeads, markCallsSeen, API_BASE, recordingUrl } from '../api';
import { parseTimestamp } from '../utils/phone';
import PhoneActionSheet from './PhoneActionSheet';
import SwipeableRow from './ui/SwipeableRow';
import GroupedListSection from './ui/GroupedListSection';
import FloatingActionButton from './ui/FloatingActionButton';
import EmptyState from './ui/EmptyState';
import Avatar from './ui/Avatar';
import { translations } from '../i18n';

const KEYPAD = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatPhone(num) {
  if (!num) return 'Unknown';
  const d = num.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10)                  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return num;
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

// Recency label used inline on each row's metadata line.
//
// The section header (Today / Yesterday / Saturday) already supplies the day,
// so the row's own time only needs to disambiguate within that day:
//   • <1m   → "just now"
//   • <60m  → "5m ago"
//   • <24h  → "3h ago"
//   • older → "10:42 AM" (time-of-day; day comes from the section header)
//
// Returning a relative "Xm ago" for the today bucket gives missed-call rows
// the human-time signal the user explicitly asked for in the redesign brief.
function rowTime(dateStr) {
  const date = parseTimestamp(dateStr);
  const ms = Date.now() - date.getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Date-section label, matched to Timeline's vocabulary so the two pages feel
// like the same product.
function dayLabel(dateStr, t) {
  const date = parseTimestamp(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yestStart  = new Date(todayStart); yestStart.setDate(todayStart.getDate() - 1);
  if (date >= todayStart) return t.timeToday;
  if (date >= yestStart)  return t.timeYesterday;
  const dayDiff = Math.floor((todayStart - date) / 86_400_000);
  if (dayDiff < 7) return date.toLocaleDateString('en-US', { weekday: 'long' });
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

// Buckets a flat array of items into ordered date groups. Generic over the
// timestamp accessor so we can reuse it for calls or voicemails or anything
// else with a created_at-like field.
function groupByDay(items, getTs, t) {
  const groups = [];
  const seen = new Map();
  for (const item of items) {
    const label = dayLabel(getTs(item), t);
    if (!seen.has(label)) { seen.set(label, groups.length); groups.push({ label, items: [] }); }
    groups[seen.get(label)].items.push(item);
  }
  return groups;
}

// Returns the metadata we display per-call row. The shape is wider than the
// old version: we also return an `iconType` and a `tint` so the icon disc
// and label color are derived from one switch instead of being calculated
// separately at each call site.
//
//   iconType — which glyph to draw inside the avatar disc:
//                'inbound'  - inbound answered (or any inbound with content)
//                'outbound' - outbound (any outcome — caller-side action)
//                'missed'   - inbound no-answer, no voicemail
//                'voicemail'- inbound no-answer, voicemail recorded
//
//   tint     — Avatar `category` value, controlling disc background tint.
//                'Lead'                → blue (inbound default)
//                'Existing Customer'   → teal (outbound — actions you took)
//                'Spam'                → red (missed)
//                'Vendor'              → violet (voicemail)
//
// `text` and `labelClass` continue to drive the inline outcome label.
function getCallMeta(call, t) {
  const isOutbound   = call.classification === 'Outbound';
  const hasRecording = !!call.recording_url;

  if (isOutbound) {
    switch (call.outcome) {
      case 'answered':
        return { text: t.callsAnswered,       labelClass: 'text-status-customer', iconType: 'outbound', tint: 'Existing Customer', isExpandable: !!(call.contractor_note) || hasRecording, isVoicemail: false };
      case 'voicemail':
        return { text: t.callsYouLeftMessage, labelClass: 'text-status-vendor',   iconType: 'outbound', tint: 'Existing Customer', isExpandable: !!(call.contractor_note) || hasRecording, isVoicemail: false };
      case 'no-answer':
        return { text: t.callsNoAnswer,       labelClass: 'text-ink-400',         iconType: 'outbound', tint: 'Existing Customer', isExpandable: hasRecording, isVoicemail: false };
      default:
        return { text: t.callsOutbound,       labelClass: 'text-ink-400',         iconType: 'outbound', tint: 'Existing Customer', isExpandable: !!(call.contractor_note) || hasRecording, isVoicemail: false };
    }
  }

  // Inbound — answered if there's a transcript OR positive duration
  const answered = !!(call.transcript || call.duration > 0);

  if (!answered && call.voicemail_lead_id) {
    return { text: t.callsVoicemail, labelClass: 'text-status-vendor',  iconType: 'voicemail', tint: 'Vendor', isExpandable: false, isVoicemail: true };
  }

  if (!answered) {
    return { text: t.callsMissed,    labelClass: 'text-status-urgent',  iconType: 'missed',    tint: 'Spam',   isExpandable: hasRecording, isVoicemail: false };
  }

  return     { text: t.callsAnswered, labelClass: 'text-status-new',     iconType: 'inbound',   tint: 'Lead',   isExpandable: true || hasRecording, isVoicemail: false };
}

// ─── Iconography ────────────────────────────────────────────────────────────

// Centralized SVG glyph for each call type. The disc background comes from
// the Avatar component (via `category` mapping); this just renders the glyph
// on top. Stroke uses currentColor so the disc's text class drives the color.

const PhoneArrow = ({ direction }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
    {direction === 'outbound' && (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M15 3h6m0 0v6m0-6L14 10" />
    )}
    {direction === 'inbound' && (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M15 21h6m0 0v-6m0 6L14 14" />
    )}
    {direction === 'missed' && (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M19 5L5 19" />
    )}
  </svg>
);

const MicGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
  </svg>
);

// Small avatar wrapper that prefers the call's contact name (for color +
// initials) but overlays a directional icon for unknown contacts so the row
// type is still readable at a glance.
function CallAvatar({ call, meta }) {
  const hasName = call.contact_name && call.contact_name !== 'Unknown';
  if (hasName) {
    return <Avatar name={call.contact_name} category={meta.tint} size="md" />;
  }
  // Unknown contact → no initials, just the glyph in a tinted disc.
  return (
    <div className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
         style={{ background: 'transparent' }}>
      <div className={`w-10 h-10 rounded-full flex items-center justify-center ring-1 ${
        meta.iconType === 'inbound'   ? 'bg-status-new/12 text-status-new ring-status-new/25' :
        meta.iconType === 'outbound'  ? 'bg-accent-100 text-accent-700 ring-accent-200/60'    :
        meta.iconType === 'voicemail' ? 'bg-status-vendor/15 text-status-vendor ring-status-vendor/25' :
                                        'bg-status-urgent/12 text-status-urgent ring-status-urgent/25'
      }`}>
        {meta.iconType === 'voicemail' ? <MicGlyph /> : <PhoneArrow direction={meta.iconType} />}
      </div>
    </div>
  );
}

// ─── Recent row ─────────────────────────────────────────────────────────────

function RecentRow({ call, t, expanded, onToggle, onOpenActions, onCallback, onJumpVoicemail }) {
  const isOutbound = call.classification === 'Outbound';
  const meta = getCallMeta(call, t);
  const duration = formatDuration(call.duration);
  const keyPoints = Array.isArray(call.key_points) ? call.key_points : [];
  const displayName = call.contact_name && call.contact_name !== 'Unknown'
    ? call.contact_name
    : formatPhone(call.from_number);
  const showPhone = call.contact_name && call.contact_name !== 'Unknown';

  function handleTap() {
    if (meta.isVoicemail) {
      onJumpVoicemail(call.voicemail_lead_id);
      return;
    }
    if (meta.isExpandable) {
      onToggle();
      return;
    }
    // For rows with no extra content (no transcript, no recording), tap
    // opens the action sheet so the user can call back / text / view history.
    onOpenActions(call.from_number);
  }

  // Right-column ornament — at most one glyph at a time so the column stays
  // visually quiet. Voicemail rows show a jump-arrow (tap to scroll-in-view);
  // expandable rows show a chevron that rotates on open; everything else
  // shows nothing (the row is still tappable via the action sheet).
  const rightOrnament = meta.isVoicemail ? (
    <svg className="w-4 h-4 text-status-vendor" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  ) : meta.isExpandable ? (
    <svg
      className={`w-4 h-4 text-ink-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
      fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  ) : null;

  return (
    <SwipeableRow
      leftAction={{
        icon: <PhoneArrow direction="outbound" />,
        label: t.callsSwipeCallBack || 'Call back',
        color: 'bg-status-new',
        onTrigger: () => onCallback(call.from_number),
      }}
    >
      <div
        onClick={handleTap}
        className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-ink-800/40 active:bg-ink-800/70 transition-colors"
      >
        <CallAvatar call={call} meta={meta} />

        {/* Main column — iPhone-Recents three-line hierarchy:
              1. Contact name (bold, dominant)
              2. Direction + recency (quiet, colored)
              3. Phone number (tertiary, tabular)
            The row deliberately reads top-to-bottom: WHO → WHAT → DETAIL. */}
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-semibold text-ink-50 truncate leading-tight">
            {displayName}
          </p>
          <p className="text-xs mt-1 truncate leading-tight">
            <span className={`${meta.labelClass} font-medium`}>{meta.text}</span>
            <span className="text-ink-400"> · {rowTime(call.created_at)}</span>
          </p>
          {showPhone && (
            <p className="text-xs text-ink-500 mt-0.5 tabular-nums truncate leading-tight">
              {formatPhone(call.from_number)}
            </p>
          )}
        </div>

        {/* Right column — duration top, ornament bottom. Stretched to match
             the row's vertical rhythm so both line up cleanly even when the
             phone line is hidden (unknown contacts). */}
        <div className="shrink-0 flex flex-col items-end self-stretch min-w-[2.75rem] py-0.5">
          {duration ? (
            <span className="text-[11px] text-ink-400 tabular-nums leading-tight">{duration}</span>
          ) : (
            <span className="leading-tight">&nbsp;</span>
          )}
          <div className="flex-1" />
          {rightOrnament}
        </div>
      </div>

      {/* Expanded detail. Lives inside the swipe foreground so it scrolls
           with the row, not separately. Quieter color palette than the old
           bg-blue-50 / bg-amber-50 boxes — those competed with the rest of
           the list visually. */}
      {meta.isExpandable && expanded && (
        <div className="px-4 pb-3 -mt-1 space-y-2.5">
          {!isOutbound && call.summary && (
            <div className="rounded-xl bg-ink-800 ring-1 ring-ink-700 px-3 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400 mb-1">{t.callsSummary}</p>
              <p className="text-xs text-ink-200 leading-relaxed">{call.summary}</p>
            </div>
          )}
          {!isOutbound && keyPoints.length > 0 && (
            <div className="rounded-xl bg-ink-800 ring-1 ring-ink-700 px-3 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400 mb-1.5">{t.callsNotes}</p>
              <ul className="space-y-1">
                {keyPoints.map((pt, i) => (
                  <li key={i} className="text-xs text-ink-300 flex gap-1.5">
                    <span className="text-ink-500 shrink-0">•</span>
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isOutbound && call.contractor_note && (
            <div className="rounded-xl bg-status-scheduled/10 ring-1 ring-status-scheduled/25 px-3 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-status-scheduled mb-1">{t.callsYourNote}</p>
              <p className="text-xs text-ink-200 leading-relaxed">{call.contractor_note}</p>
            </div>
          )}
          {call.recording_url && (
            <div className="rounded-xl bg-ink-800 ring-1 ring-ink-700 px-3 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400 mb-2">{t.callsRecording}</p>
              <audio
                controls
                preload="metadata"
                src={recordingUrl(`${API_BASE}/calls/${call.id}/recording`)}
                className="w-full h-9"
                style={{ colorScheme: 'light' }}
              >
                {t.callsAudioNotSupported}
              </audio>
            </div>
          )}
        </div>
      )}
    </SwipeableRow>
  );
}

// ─── Voicemail row ──────────────────────────────────────────────────────────
// Richer than a Recent row: prominent play CTA + transcript-first hierarchy +
// key-points pills. Tap anywhere to expand into the full transcript + recording.

function VoicemailRow({ vm, t, expanded, onToggle, onCallback, onOpenActions, highlighted }) {
  const keyPoints = Array.isArray(vm.key_points) ? vm.key_points : [];
  const phone = vm.callback_number || vm.phone_number;
  const displayName = vm.contact_name && vm.contact_name !== 'Unknown' ? vm.contact_name : formatPhone(vm.phone_number);
  const time = rowTime(vm.created_at);

  return (
    <SwipeableRow
      leftAction={{
        icon: <PhoneArrow direction="outbound" />,
        label: t.callsSwipeCallBack || 'Call back',
        color: 'bg-status-new',
        onTrigger: () => onCallback(phone),
      }}
    >
      <div
        id={`vm-${vm.id}`}
        onClick={onToggle}
        className={`flex flex-col gap-2 px-4 py-3 cursor-pointer transition-colors
          ${highlighted ? 'bg-status-vendor/8' : 'hover:bg-ink-800/60 active:bg-ink-800'}`}
      >
        {/* Top row — play CTA + name + time */}
        <div className="flex items-center gap-3">
          {/* Prominent play button — black pill (primary CTA per row) */}
          <div className="shrink-0 w-10 h-10 rounded-full bg-ink-50 text-white flex items-center justify-center">
            <svg className="w-4 h-4 ml-0.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink-50 truncate">{displayName}</p>
              <span className="shrink-0 text-[11px] text-ink-400 tabular-nums whitespace-nowrap">{time}</span>
            </div>
            <p className="text-[11px] text-ink-400 truncate mt-0.5 tabular-nums">{formatPhone(phone)}</p>
          </div>
        </div>

        {/* Transcript preview — front-and-center, the thing you actually want to read */}
        {vm.summary && (
          <p className={`text-xs text-ink-300 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
            {vm.summary}
          </p>
        )}

        {/* Key-points pills — quick context tags inline (no avatar/bullet noise) */}
        {keyPoints.length > 0 && !expanded && (
          <div className="flex flex-wrap gap-1.5">
            {keyPoints.slice(0, 3).map((pt, i) => (
              <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-ink-800 text-ink-300 ring-1 ring-ink-700">
                {pt.length > 28 ? pt.slice(0, 26) + '…' : pt}
              </span>
            ))}
            {keyPoints.length > 3 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-ink-800 text-ink-400 ring-1 ring-ink-700">
                +{keyPoints.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Expanded: full key points list + audio player */}
        {expanded && keyPoints.length > 0 && (
          <ul className="space-y-1 mt-1">
            {keyPoints.map((pt, i) => (
              <li key={i} className="text-xs text-ink-300 flex gap-1.5">
                <span className="text-ink-500 shrink-0">•</span>
                <span>{pt}</span>
              </li>
            ))}
          </ul>
        )}

        {expanded && vm.recording_url && (
          <audio
            controls
            preload="metadata"
            src={recordingUrl(`${API_BASE}/leads/${vm.id}/voicemail`)}
            onClick={e => e.stopPropagation()}
            className="w-full h-9 mt-1"
            style={{ colorScheme: 'light' }}
          >
            {t.callsAudioNotSupported}
          </audio>
        )}
      </div>
    </SwipeableRow>
  );
}

// ─── Skeleton + empty ───────────────────────────────────────────────────────

function CallSkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 animate-pulse">
      <div className="w-10 h-10 rounded-full bg-ink-800 shrink-0" />
      <div className="flex-1 space-y-2 pt-0.5">
        <div className="flex justify-between">
          <div className="h-3 w-28 bg-ink-800 rounded-full" />
          <div className="h-2.5 w-10 bg-ink-800 rounded-full" />
        </div>
        <div className="h-2.5 w-40 bg-ink-800 rounded-full" />
      </div>
    </div>
  );
}

function CallsSkeleton() {
  return (
    <div className="space-y-6">
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
                <CallSkeletonRow />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function CallsPage({ onContactClick, voiceDevice = {}, onCallsSeen, language = 'en', callsRefreshKey = 0 }) {
  const t = translations[language] || translations.en;
  const TABS = [
    { key: 'Dialer',    label: t.callsTabDialer    },
    { key: 'Recent',    label: t.callsTabRecent    },
    { key: 'Voicemail', label: t.callsTabVoicemail },
  ];

  const [dialInput,       setDialInput]       = useState('');
  const [activeTab,       setActiveTab]       = useState('Recent');
  const [calls,           setCalls]           = useState([]);
  const [voicemails,      setVoicemails]      = useState([]);
  const [loadingCalls,    setLoadingCalls]    = useState(false);
  const [expandedCallId,  setExpandedCallId]  = useState(null);
  const [expandedVmId,    setExpandedVmId]    = useState(null);
  const [actionSheetPhone, setActionSheetPhone] = useState(null);
  const [highlightedVmId, setHighlightedVmId] = useState(null);

  const hasMarkedSeenRef = useRef(false);

  const {
    status: deviceStatus = 'idle',
    error: deviceError = null,
    remoteIdentity,
    makeCall,
    hangUp,
  } = voiceDevice;

  const isDialing   = deviceStatus === 'dialing';
  const isRinging   = deviceStatus === 'ringing';
  const isConnected = deviceStatus === 'connected';
  const isEnded     = deviceStatus === 'ended';
  const isFailed    = deviceStatus === 'failed';
  const isBusy      = isDialing || isRinging || isConnected || isEnded;

  // Re-fetch on tab switch + on callsRefreshKey bump. Background refreshes
  // keep the list visible — only the very first load of a tab shows the
  // skeleton, never a refresh.
  useEffect(() => {
    let cancelled = false;
    if (activeTab === 'Recent') {
      if (calls.length === 0) setLoadingCalls(true);
      getCalls()
        .then(data => { if (!cancelled) setCalls(data); })
        .catch(err => console.error('Failed to load calls:', err))
        .finally(() => { if (!cancelled) setLoadingCalls(false); });
    }
    if (activeTab === 'Voicemail') {
      if (voicemails.length === 0) setLoadingCalls(true);
      getVoicemailLeads()
        .then(data => { if (!cancelled) setVoicemails(data); })
        .catch(err => console.error('Failed to load voicemails:', err))
        .finally(() => { if (!cancelled) setLoadingCalls(false); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, callsRefreshKey]);

  // Voicemail highlight + scroll-into-view after cross-tab navigation.
  useEffect(() => {
    if (activeTab !== 'Voicemail' || !highlightedVmId || voicemails.length === 0) return;
    const el = document.getElementById(`vm-${highlightedVmId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const tid = setTimeout(() => setHighlightedVmId(null), 2500);
    return () => clearTimeout(tid);
  }, [activeTab, highlightedVmId, voicemails]);

  // markCallsSeen fires once per CallsPage mount when Recent is the current
  // tab and has rendered rows. Unchanged from before — preserves badge
  // clearing semantics exactly.
  useEffect(() => {
    if (activeTab !== 'Recent' || calls.length === 0 || hasMarkedSeenRef.current) return;
    hasMarkedSeenRef.current = true;
    markCallsSeen()
      .then(() => { onCallsSeen?.(); })
      .catch(err => console.error('Failed to mark calls seen:', err));
  }, [activeTab, calls, onCallsSeen]);

  const handleKeypad      = (val) => setDialInput(prev => prev + val);
  const handleBackspace   = ()    => setDialInput(prev => prev.slice(0, -1));
  const handleCall        = ()    => { if (dialInput.trim() && !isBusy && makeCall) makeCall(dialInput.trim()); };

  // Tap-to-call from any list — populates the dialer, switches tab, then
  // dials. Called from the swipe-callback action (a deliberate gesture),
  // never from a tap on the row body.
  const handleCallback = (phone) => {
    if (!phone) return;
    setDialInput(phone);
    setActiveTab('Dialer');
    if (makeCall && !isBusy) makeCall(phone);
  };

  const handleKeyDown = (e) => { if (e.key === 'Enter') handleCall(); };

  // ── Memoized groups ──────────────────────────────────────────────────────
  const callGroups = useMemo(
    () => groupByDay(calls, c => c.created_at, t),
    [calls, t]
  );
  const vmGroups = useMemo(
    () => groupByDay(voicemails, v => v.created_at, t),
    [voicemails, t]
  );

  // ── Tab strip — segmented control, near-black active ─────────────────────
  function TabStrip() {
    return (
      <div className="bg-ink-800 rounded-full p-1 flex items-center mb-5">
        {TABS.map(tab => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-all duration-150
                ${isActive
                  ? 'bg-ink-50 text-white shadow-sm'
                  : 'text-ink-400 hover:text-ink-200'
                }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`w-full mx-auto pt-2 ${activeTab === 'Dialer' ? 'max-w-xs' : 'max-w-lg'}`}>

      {/* Page title */}
      <h1 className="text-xl font-bold text-ink-50 tracking-tight mb-4">{t.callsPageTitle}</h1>

      {/* Segmented tabs */}
      <TabStrip />

      {/* ── DIALER ─────────────────────────────────────────────────────────── */}
      {activeTab === 'Dialer' && (
        <div className="flex flex-col items-center">
          {/* Number display / call status */}
          <div className="relative w-full flex flex-col items-center justify-center mb-6 min-h-[56px]">
            {isConnected ? (
              <div className="flex flex-col items-center gap-1">
                <span className="text-base font-semibold text-status-new">{t.callsConnected}</span>
                <span className="text-sm text-ink-400">{remoteIdentity || dialInput}</span>
              </div>
            ) : isRinging ? (
              <div className="flex flex-col items-center gap-1">
                <span className="text-base font-medium text-accent-600 animate-pulse">{t.callsRinging}</span>
                <span className="text-sm text-ink-400">{remoteIdentity || dialInput}</span>
              </div>
            ) : isDialing ? (
              <span className="text-base font-medium text-accent-600 animate-pulse">{t.callsCalling}</span>
            ) : isEnded ? (
              <span className="text-base font-medium text-ink-400">{t.callsCallEnded}</span>
            ) : isFailed ? (
              <span className="text-sm font-medium text-status-urgent text-center px-4">{deviceError || t.callsCallFailed}</span>
            ) : deviceStatus === 'registering' ? (
              <span className="text-sm text-ink-400 animate-pulse">{t.callsConnectingVoice}</span>
            ) : (
              <span className={`text-4xl font-light tracking-widest text-ink-50 tabular-nums ${!dialInput ? 'opacity-30' : ''}`}>
                {dialInput || '—'}
              </span>
            )}
            {dialInput && !isBusy && (
              <button
                onClick={handleBackspace}
                className="absolute right-0 top-1/2 -translate-y-1/2 p-2 text-ink-400 hover:text-ink-100 transition-colors"
                aria-label="Backspace"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M22 5H9L2 12l7 7h13V5z" />
                  <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </button>
            )}
          </div>

          <input
            type="tel"
            value={dialInput}
            onChange={e => setDialInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="sr-only"
            aria-label="Phone number"
          />

          {/* Keypad — soft ink-800 buttons with a faint ring; press goes ink-700 */}
          <div className="grid grid-cols-3 gap-3 w-full mb-8">
            {KEYPAD.map(({ digit, sub }) => (
              <button
                key={digit}
                onClick={() => handleKeypad(digit)}
                className="flex flex-col items-center justify-center rounded-full
                           w-[68px] h-[68px] mx-auto
                           bg-ink-900 ring-1 ring-ink-700
                           hover:bg-ink-800 active:bg-ink-700
                           transition-colors duration-100 select-none active:scale-[0.96]"
              >
                <span className="text-xl font-medium text-ink-50 leading-tight">{digit}</span>
                {sub && (
                  <span className="text-[9px] font-semibold tracking-widest text-ink-400 leading-none mt-0.5">
                    {sub}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Call / Hang up button */}
          {isConnected || isRinging || isDialing ? (
            <button
              onClick={hangUp}
              className="w-[68px] h-[68px] rounded-full flex items-center justify-center bg-status-urgent hover:bg-red-700 active:bg-red-800 transition-colors duration-150 active:scale-[0.96] shadow-lg"
              aria-label="Hang up"
            >
              <svg className="w-7 h-7 text-white rotate-135" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleCall}
              disabled={!dialInput.trim() || isBusy}
              className={`w-[68px] h-[68px] rounded-full flex items-center justify-center
                         transition-all duration-150 active:scale-[0.96] shadow-lg
                         ${isFailed ? 'bg-status-urgent' : 'bg-status-new hover:brightness-110 active:brightness-95'}
                         disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none`}
              aria-label="Call"
            >
              <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* ── RECENT ─────────────────────────────────────────────────────────── */}
      {activeTab === 'Recent' && (
        <>
          {loadingCalls && calls.length === 0 ? (
            <CallsSkeleton />
          ) : calls.length === 0 ? (
            <EmptyState
              icon={<PhoneArrow direction="inbound" />}
              title={t.callsNoRecent}
              subtitle={t.callsNoRecentHint || 'Inbound and outbound calls will appear here as they happen.'}
              action={{
                label: t.callsMakeCall || 'Open dialer',
                icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>,
                onClick: () => setActiveTab('Dialer'),
              }}
            />
          ) : (
            <div className="space-y-6 pb-24">
              {callGroups.map(group => (
                <GroupedListSection
                  key={group.label}
                  label={group.label}
                  count={group.items.length}
                >
                  {group.items.map(call => (
                    <RecentRow
                      key={call.id}
                      call={call}
                      t={t}
                      expanded={expandedCallId === call.id}
                      onToggle={() => setExpandedCallId(prev => prev === call.id ? null : call.id)}
                      onOpenActions={(phone) => setActionSheetPhone(phone)}
                      onCallback={handleCallback}
                      onJumpVoicemail={(vmId) => { setHighlightedVmId(vmId); setActiveTab('Voicemail'); }}
                    />
                  ))}
                </GroupedListSection>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── VOICEMAIL ──────────────────────────────────────────────────────── */}
      {activeTab === 'Voicemail' && (
        <>
          {loadingCalls && voicemails.length === 0 ? (
            <CallsSkeleton />
          ) : voicemails.length === 0 ? (
            <EmptyState
              icon={<MicGlyph />}
              title={t.callsNoVoicemails}
              subtitle={t.callsNoVoicemailsHint || 'Missed calls with a voicemail will appear here.'}
            />
          ) : (
            <div className="space-y-6 pb-24">
              {vmGroups.map(group => (
                <GroupedListSection
                  key={group.label}
                  label={group.label}
                  count={group.items.length}
                >
                  {group.items.map(vm => (
                    <VoicemailRow
                      key={vm.id}
                      vm={vm}
                      t={t}
                      expanded={expandedVmId === vm.id}
                      onToggle={() => setExpandedVmId(prev => prev === vm.id ? null : vm.id)}
                      onCallback={handleCallback}
                      onOpenActions={(phone) => setActionSheetPhone(phone)}
                      highlighted={highlightedVmId === vm.id}
                    />
                  ))}
                </GroupedListSection>
              ))}
            </div>
          )}
        </>
      )}

      {/* Floating dial CTA — visible on Recent / Voicemail, swaps the tab to
          Dialer when tapped. Hidden on the Dialer tab itself (redundant). */}
      {activeTab !== 'Dialer' && (
        <FloatingActionButton
          onClick={() => setActiveTab('Dialer')}
          label={t.callsDial || 'Dial'}
          ariaLabel={t.callsDial || 'Open dialer'}
          icon={
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
            </svg>
          }
        />
      )}

      {actionSheetPhone && (
        <PhoneActionSheet
          phone={actionSheetPhone}
          onViewHistory={onContactClick ? () => { onContactClick(actionSheetPhone); setActionSheetPhone(null); } : null}
          onCall={handleCallback}
          onClose={() => setActionSheetPhone(null)}
        />
      )}

    </div>
  );
}
