// Renders a single message bubble.
// Messages from the same sender within 5 minutes are grouped — only the
// first in a group shows the timestamp; the last shows the "tail" shape.
import { parseTimestamp } from '../../utils/phone';
import { API_BASE } from '../../api';
import { translations } from '../../i18n';
import SafeImage from './SafeImage';

function getLocale() {
  const lang = localStorage.getItem('language') || 'en';
  return lang === 'es' ? 'es-MX' : 'en-US';
}

function getT() {
  const lang = localStorage.getItem('language') || 'en';
  return translations[lang] || translations.en;
}

function formatTime(iso) {
  const t = getT();
  const locale = getLocale();
  const date = parseTimestamp(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);

  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (isToday)                             return time;
  if (date.toDateString() === yesterday.toDateString()) return `${t.msgYesterday} ${time}`;
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }) + ` ${time}`;
}

// A day separator between messages on different calendar days
export function DaySeparator({ ts }) {
  const t = getT();
  const locale = getLocale();
  const date = parseTimestamp(ts);
  const now  = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);

  let label;
  if (isToday)                              label = t.msgToday;
  else if (date.toDateString() === yesterday.toDateString()) label = t.msgYesterday;
  else label = date.toLocaleDateString(locale, { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div className="flex items-center gap-3 my-4 px-1">
      <div className="flex-1 h-px bg-gray-100" />
      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest whitespace-nowrap">
        {label}
      </span>
      <div className="flex-1 h-px bg-gray-100" />
    </div>
  );
}

/**
 * Resolve a media URL for display in the browser.
 *
 * - Object URLs (blob:…) — optimistic previews from our own file picker; use as-is.
 * - Twilio CDN URLs (api.twilio.com/…) — require Basic auth; route through our proxy.
 * - Our own temp-file URLs (/api/messages/media/…) — use as-is (served by our backend).
 * - Anything else — use as-is.
 */
function resolveMediaUrl(url) {
  if (!url) return url;
  if (url.startsWith('blob:')) return url;
  if (url.includes('api.twilio.com') || url.includes('twilio.com/2010')) {
    return `${API_BASE}/messages/media-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

export default function MessageBubble({
  message,
  isFirst,   // first in its sender-group → show timestamp above
  isLast,    // last in its sender-group → sharp corner on the "tail" side
  onOpenMediaPreview,  // (resolvedUrl) => void — opens the in-app preview overlay
}) {
  const { body, direction, status, errorMessage } = message;
  const ts = message.ts || message.created_at || null;
  const isOut = direction === 'outbound';
  // Optimistic-send states drive the bubble's visual treatment + footer copy
  const isPending = isOut && status === 'sending';
  const isFailed  = isOut && status === 'failed';

  // Parse media_urls — stored as JSON string or already an array
  let mediaUrls = [];
  if (message.media_urls) {
    try {
      const parsed = typeof message.media_urls === 'string'
        ? JSON.parse(message.media_urls)
        : message.media_urls;
      if (Array.isArray(parsed)) mediaUrls = parsed;
    } catch {}
  }

  const hasMedia = mediaUrls.length > 0;
  const hasText  = body && body.trim().length > 0;

  return (
    <div className={`flex flex-col ${isOut ? 'items-end' : 'items-start'} ${isFirst ? 'mt-3' : 'mt-0.5'}`}>

      {/* Timestamp — shown only for first message in the group */}
      {isFirst && (
        <span className="text-[10px] text-gray-400 mb-1 px-1">
          {formatTime(ts)}
        </span>
      )}

      {/* Media images — rendered above the text bubble.
          Tapping a thumbnail opens an in-app preview (handled by
          MessageThread). Previously this was an <a target="_blank">
          which opened a new external browser tab — that tab has no
          session cookie for /api/messages/media/... so it landed on
          "Not Authenticated". A real <button> keeps the user inside
          the authenticated webview where the media route works.
          Keyed by URL (not index) so when an optimistic message is
          replaced by the server version the old blob: <img> unmounts
          cleanly and the new /api/messages/media/... <img> mounts fresh. */}
      {hasMedia && (
        <div className={`flex flex-wrap gap-1.5 mb-1 max-w-[72%] sm:max-w-xs lg:max-w-sm xl:max-w-md ${isOut ? 'justify-end' : 'justify-start'}`}>
          {mediaUrls.map(url => {
            const resolved = resolveMediaUrl(url);
            return (
              <button
                key={resolved}
                type="button"
                onClick={() => onOpenMediaPreview?.(resolved)}
                aria-label="View attachment"
                className="block rounded-xl overflow-hidden border border-white/20 shadow-sm bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <SafeImage
                  src={resolved}
                  alt="MMS attachment"
                  className="max-w-[200px] max-h-[200px] object-cover block"
                  loading="lazy"
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Text bubble — only shown if there's text */}
      {hasText && (
        <div
          className={`
            max-w-[72%] sm:max-w-xs lg:max-w-sm xl:max-w-md
            px-3.5 py-2.5 text-sm leading-relaxed transition-opacity
            ${isOut
              ? `${isFailed ? 'bg-blue-600/70 text-white ring-2 ring-red-400/70' : 'bg-blue-600 text-white'}
                 ${isPending ? 'opacity-70' : ''}
                 ${isLast ? 'rounded-2xl rounded-br-[4px]' : 'rounded-2xl'}`
              : `bg-gray-100 text-gray-900
                 ${isLast ? 'rounded-2xl rounded-bl-[4px]' : 'rounded-2xl'}`
            }
          `}
        >
          {body}
        </div>
      )}

      {/* Outbound status footer — Sending… / Failed.
          Only shown on the LAST bubble in a sender-group so the thread doesn't
          look noisy when we have a few queued messages from the same user. */}
      {isOut && isLast && (isPending || isFailed) && (
        <span
          className={`mt-1 px-1 flex items-center gap-1 text-[10px] leading-none ${
            isFailed ? 'text-red-500' : 'text-gray-400'
          }`}
        >
          {isPending && (
            <>
              <span className="w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin" />
              <span>Sending…</span>
            </>
          )}
          {isFailed && (
            <>
              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span>{errorMessage || 'Failed to send'}</span>
            </>
          )}
        </span>
      )}
    </div>
  );
}
