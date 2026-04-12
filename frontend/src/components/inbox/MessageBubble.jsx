// Renders a single message bubble.
// Messages from the same sender within 5 minutes are grouped — only the
// first in a group shows the timestamp; the last shows the "tail" shape.
import { parseTimestamp } from '../../utils/phone';
import { API_BASE } from '../../api';

function formatTime(iso) {
  const date = parseTimestamp(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);

  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (isToday)                             return time;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`;
}

// A day separator between messages on different calendar days
export function DaySeparator({ ts }) {
  const date = parseTimestamp(ts);
  const now  = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);

  let label;
  if (isToday)                              label = 'Today';
  else if (date.toDateString() === yesterday.toDateString()) label = 'Yesterday';
  else label = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

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
}) {
  const { body, direction } = message;
  const ts = message.ts || message.created_at || null;
  const isOut = direction === 'outbound';

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

      {/* Media images — rendered above the text bubble */}
      {hasMedia && (
        <div className={`flex flex-wrap gap-1.5 mb-1 max-w-[72%] sm:max-w-xs lg:max-w-sm xl:max-w-md ${isOut ? 'justify-end' : 'justify-start'}`}>
          {mediaUrls.map((url, i) => (
            <a
              key={i}
              href={resolveMediaUrl(url)}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-xl overflow-hidden border border-white/20 shadow-sm"
            >
              <img
                src={resolveMediaUrl(url)}
                alt="MMS attachment"
                className="max-w-[200px] max-h-[200px] object-cover block"
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}

      {/* Text bubble — only shown if there's text */}
      {hasText && (
        <div
          className={`
            max-w-[72%] sm:max-w-xs lg:max-w-sm xl:max-w-md
            px-3.5 py-2.5 text-sm leading-relaxed
            ${isOut
              ? `bg-blue-600 text-white
                 ${isLast ? 'rounded-2xl rounded-br-[4px]' : 'rounded-2xl'}`
              : `bg-gray-100 text-gray-900
                 ${isLast ? 'rounded-2xl rounded-bl-[4px]' : 'rounded-2xl'}`
            }
          `}
        >
          {body}
        </div>
      )}
    </div>
  );
}
