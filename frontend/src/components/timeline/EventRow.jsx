import { EVENT_META } from './normalizeEvent';
import { parseTimestamp } from '../../utils/phone';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatPhone(num) {
  if (!num) return '';
  const d = num.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return num;
}

function formatTime(iso) {
  if (!iso) return '';
  return parseTimestamp(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDuration(seconds) {
  if (!seconds || seconds < 5) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

// ── Icons ────────────────────────────────────────────────────────────────────

const PHONE_PATH = 'M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z';
const MIC_PATH   = 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z';

const SMS_PATH = 'M8 10h.01M12 10h.01M16 10h.01M21 16a2 2 0 01-2 2H7l-4 4V6a2 2 0 012-2h14a2 2 0 012 2v10z';

function EventIcon({ iconType, bgClass, colorClass }) {
  const isVoicemail  = iconType === 'voicemail';
  const isPhoneOut   = iconType === 'phone-out';
  const isMissed     = iconType === 'phone-missed';
  const isEmail      = iconType === 'email';
  const isEmailOut   = iconType === 'email-out';
  const isSms        = iconType === 'sms';
  const isSmsOut     = iconType === 'sms-out';

  return (
    <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${bgClass}`}>
      {isSms || isSmsOut ? (
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={SMS_PATH} />
          {isSmsOut && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 3h6m0 0v6m0-6L14 10" />}
        </svg>
      ) : isVoicemail ? (
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={MIC_PATH} />
        </svg>
      ) : isPhoneOut ? (
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={PHONE_PATH} />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 3h6m0 0v6m0-6L14 10" />
        </svg>
      ) : isMissed ? (
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={PHONE_PATH} />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 5L5 19" />
        </svg>
      ) : isEmail ? (
        // Envelope icon — inbound email
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ) : isEmailOut ? (
        // Envelope + arrow — outbound email
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 3h6m0 0v6m0-6L14 10" />
        </svg>
      ) : (
        // Plain phone with down-arrow for inbound answered
        <svg className={`w-4 h-4 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d={PHONE_PATH} />
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

export default function EventRow({ event, expanded, onToggle, onContactClick }) {
  const meta = EVENT_META[event.type] ?? EVENT_META['call-outbound'];
  const duration    = meta.showDuration ? formatDuration(event.durationSeconds) : null;
  const isEmail     = event.type === 'email-inbound' || event.type === 'email-outbound';
  const isSms       = event.type === 'sms-inbound'   || event.type === 'sms-outbound';
  const isSmsThread = event.type === 'sms-thread';

  // Display name: contact name → email address → formatted phone
  const displayName = event.contactName
    || (isEmail ? event.contactEmail : null)
    || formatPhone(event.contactPhone);

  // Secondary line: phone when name is shown; for email show phone only if it's set
  const showPhone = !isEmail && !!event.contactName;
  const showEmailAddr = isEmail && !!event.contactName; // show email as secondary when name is known

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
        <EventIcon
          iconType={meta.iconType}
          bgClass={meta.iconBg}
          colorClass={meta.iconColor}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {onContactClick && event.contactPhone ? (
              <button
                className="text-sm font-semibold text-gray-900 leading-snug truncate hover:text-blue-600 transition-colors text-left"
                onClick={e => { e.stopPropagation(); onContactClick(event.contactPhone); }}
              >
                {displayName}
              </button>
            ) : (
              <span className="text-sm font-semibold text-gray-900 leading-snug truncate">
                {displayName}
              </span>
            )}
            <ClassBadge value={event.classification} />
          </div>

          {showPhone && (
            <p className="text-[11px] text-gray-400 mt-0.5 leading-none">
              {formatPhone(event.contactPhone)}
            </p>
          )}

          {showEmailAddr && (
            <p className="text-[11px] text-gray-400 mt-0.5 leading-none truncate">
              {event.contactEmail}
            </p>
          )}

          {/* Event type label + duration / thread count */}
          <div className="flex items-center gap-1.5 mt-1">
            {isSmsThread ? (
              <>
                <span className="text-xs font-medium leading-none text-teal-600">
                  {event.messageCount} {event.messageCount === 1 ? 'text' : 'texts'}
                </span>
                {event.unreadCount > 0 && (
                  <span className="text-[10px] font-bold bg-teal-500 text-white rounded-full px-1.5 leading-[18px]">
                    {event.unreadCount} new
                  </span>
                )}
              </>
            ) : (
              <>
                <span className={`text-xs font-medium leading-none ${meta.labelColor}`}>
                  {meta.label}
                </span>
                {duration && (
                  <span className="text-[11px] text-gray-400 leading-none">· {duration}</span>
                )}
                {/* Email subject inline when collapsed */}
                {isEmail && event.subject && (
                  <span className="text-[11px] text-gray-400 leading-none truncate">· {event.subject}</span>
                )}
              </>
            )}
          </div>

          {/* 1-line summary preview — collapsed state only */}
          {!expanded && (event.summary || event.note) && !isEmail && (
            <p className="text-[11px] text-gray-500 mt-1.5 line-clamp-1 leading-snug">
              {isSmsThread && event.isOutbound ? '→ ' : isSmsThread ? '← ' : ''}
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
      {event.isExpandable && expanded && (
        <div className="ml-11 mr-4 mb-4 space-y-2">

          {/* Email: subject + body preview */}
          {isEmail && (event.subject || event.summary) && (
            <div className="bg-violet-50 border border-violet-100 rounded-lg px-3 py-2.5">
              {event.subject && (
                <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-widest mb-1">
                  {event.subject}
                </p>
              )}
              {event.summary && (
                <p className="text-xs text-gray-700 leading-relaxed">{event.summary}</p>
              )}
            </div>
          )}

          {/* SMS: show message body (individual message events, legacy) */}
          {isSms && event.summary && (
            <div className="bg-teal-50 border border-teal-100 rounded-lg px-3 py-2.5">
              <p className="text-xs text-gray-700 leading-relaxed">{event.summary}</p>
            </div>
          )}

          {/* SMS thread: chat bubble view of last 5 messages */}
          {isSmsThread && event.messages && event.messages.length > 0 && (
            <div className="space-y-1.5">
              {event.messages.length > 5 && (
                <p className="text-[10px] text-gray-400 text-center pb-0.5">
                  {event.messages.length - 5} earlier {event.messages.length - 5 === 1 ? 'message' : 'messages'}
                </p>
              )}
              {event.messages.slice(-5).map(msg => (
                <div
                  key={msg.id}
                  className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[82%] rounded-2xl px-3 py-2 ${
                    msg.direction === 'outbound'
                      ? 'bg-teal-500 text-white rounded-br-sm'
                      : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                  }`}>
                    <p className="text-xs leading-snug">{msg.body}</p>
                    <p className={`text-[10px] mt-1 leading-none ${
                      msg.direction === 'outbound' ? 'text-teal-200' : 'text-gray-400'
                    }`}>
                      {formatTime(msg.created_at)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Inbound answered: AI summary */}
          {!event.isOutbound && !isEmail && !isSms && event.summary && (
            <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">
                Summary
              </p>
              <p className="text-xs text-gray-700 leading-relaxed">{event.summary}</p>
            </div>
          )}

          {/* Outbound answered: AI summary (now that outbound calls are recorded) */}
          {event.isOutbound && !isEmail && !isSms && event.summary && (
            <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">
                Call Summary
              </p>
              <p className="text-xs text-gray-700 leading-relaxed">{event.summary}</p>
            </div>
          )}

          {/* Key points */}
          {event.keyPoints.length > 0 && (
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

          {/* Contractor note */}
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
