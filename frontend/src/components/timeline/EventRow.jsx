import { EVENT_META } from './normalizeEvent';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatPhone(num) {
  if (!num) return '';
  const d = num.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return num;
}

// Exact clock time — events are already grouped by date in the parent,
// so a timestamp like "10:23 AM" is unambiguous within the group.
function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDuration(seconds) {
  if (!seconds || seconds < 5) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

// ── Icons ────────────────────────────────────────────────────────────────────
// Each icon type renders a distinct SVG for fast visual scanning.

// Phone handset — same path already used in LeadDetailsPanel (proven to render)
const PHONE_PATH = 'M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z';
// Microphone — for voicemail events
const MIC_PATH  = 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z';
// Outbound arrow (up-right) — already in codebase as OutboundArrow
const ARROW_OUT = 'M7 17L17 7M17 7H7M17 7v10';

function EventIcon({ iconType, bgClass, colorClass }) {
  const isVoicemail = iconType === 'voicemail';
  const isOutbound  = iconType === 'phone-out';
  const isMissed    = iconType === 'phone-missed';

  return (
    <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${bgClass}`}>
      {isVoicemail ? (
        // Microphone icon for voicemail
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={MIC_PATH} />
        </svg>
      ) : isOutbound ? (
        // Phone + outbound arrow overlay
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={PHONE_PATH} />
          {/* Small outbound arrow tucked in top-right corner of the 24×24 grid */}
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 3h6m0 0v6m0-6L14 10" />
        </svg>
      ) : isMissed ? (
        // Phone + diagonal X for missed
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={PHONE_PATH} />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 5L5 19" />
        </svg>
      ) : (
        // Plain phone for inbound answered
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={PHONE_PATH} />
          {/* Small down arrow for inbound direction hint */}
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 21h6m0 0v-6m0 6L14 14" />
        </svg>
      )}
    </div>
  );
}

// ── Classification badge ──────────────────────────────────────────────────────

const CLASS_STYLES = {
  'Likely Lead':       'text-blue-600  bg-blue-50',
  'Existing Customer': 'text-green-700 bg-green-50',
  'Vendor':            'text-purple-700 bg-purple-50',
  'Likely Spam':       'text-red-500   bg-red-50',
};

function ClassBadge({ value }) {
  if (!value || value === 'Unknown') return null;
  const style = CLASS_STYLES[value] || 'text-gray-500 bg-gray-100';
  return (
    <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 shrink-0 leading-none ${style}`}>
      {value}
    </span>
  );
}

// ── EventRow ─────────────────────────────────────────────────────────────────

export default function EventRow({ event, expanded, onToggle }) {
  const meta = EVENT_META[event.type] ?? EVENT_META['call-outbound'];
  const duration = meta.showDuration ? formatDuration(event.durationSeconds) : null;

  // Display name: contact name if known, otherwise formatted phone
  const displayName = event.contactName || formatPhone(event.contactPhone);
  const showPhone   = !!event.contactName; // show phone as secondary line when name is known

  return (
    <div>
      {/* ── Main row ─────────────────────────────────────────────────────── */}
      <div
        className={`
          flex items-start gap-3 px-4 py-3 transition-colors duration-100
          ${event.isExpandable ? 'cursor-pointer hover:bg-gray-50/70 active:bg-gray-100/50' : ''}
        `}
        onClick={() => event.isExpandable && onToggle()}
      >
        {/* Icon */}
        <EventIcon
          iconType={meta.iconType}
          bgClass={meta.iconBg}
          colorClass={meta.iconColor}
        />

        {/* Content — name is the strongest element, event type is secondary */}
        <div className="flex-1 min-w-0">
          {/* Line 1: contact name + classification badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900 leading-snug truncate">
              {displayName}
            </span>
            <ClassBadge value={event.classification} />
          </div>

          {/* Line 2: phone number (only when name is shown above it) */}
          {showPhone && (
            <p className="text-[11px] text-gray-400 mt-0.5 leading-none">
              {formatPhone(event.contactPhone)}
            </p>
          )}

          {/* Line 3: event type + duration */}
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`text-xs font-medium leading-none ${meta.labelColor}`}>
              {meta.label}
            </span>
            {duration && (
              <span className="text-[11px] text-gray-400 leading-none">· {duration}</span>
            )}
          </div>

          {/* Line 4: 1-line summary preview — collapsed state only */}
          {!expanded && (event.summary || event.note) && (
            <p className="text-[11px] text-gray-500 mt-1.5 line-clamp-1 leading-snug">
              {event.summary || event.note}
            </p>
          )}
        </div>

        {/* Right: exact time + expand chevron */}
        <div className="shrink-0 flex flex-col items-end gap-1.5 pt-0.5">
          <span className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap">
            {formatTime(event.timestamp)}
          </span>
          {event.isExpandable && (
            <svg
              className={`w-3.5 h-3.5 text-gray-300 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </div>
      </div>

      {/* ── Expanded detail ───────────────────────────────────────────────── */}
      {/* ml-11 = icon(32) + gap(12) — aligns detail under the icon column  */}
      {event.isExpandable && expanded && (
        <div className="ml-11 mr-4 mb-4 space-y-2">

          {/* Inbound answered: AI summary */}
          {!event.isOutbound && event.summary && (
            <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">
                Summary
              </p>
              <p className="text-xs text-gray-700 leading-relaxed">{event.summary}</p>
            </div>
          )}

          {/* Inbound answered: AI key points */}
          {!event.isOutbound && event.keyPoints.length > 0 && (
            <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">
                Key Points
              </p>
              <ul className="space-y-1.5">
                {event.keyPoints.map((pt, i) => (
                  <li key={i} className="flex gap-2 text-xs text-gray-600 leading-snug">
                    <span className="text-gray-300 shrink-0 select-none mt-px">—</span>
                    {pt}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Outbound voicemail or answered: contractor note */}
          {event.note && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2.5">
              <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-widest mb-1.5">
                Your Note
              </p>
              <p className="text-xs text-gray-700 leading-relaxed">{event.note}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
