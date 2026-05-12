// SafeImage — drop-in replacement for <img> that prevents the three
// rendering glitches we hit with messaging attachments:
//
//   1. Partial-decode paint. Large gallery photos can paint mid-decode on
//      mobile webviews (Capacitor Android, older iOS Safari). We force
//      `decoding="async"` so the browser fully decodes before painting,
//      and we keep the <img> at opacity-0 until onLoad fires so even if
//      something paints mid-decode the user never sees it.
//
//   2. URL swap mid-render. When the thread poll replaces an optimistic
//      message (blob:… URL) with the server's version (/api/messages/
//      media/…), the same <img> element keeps the old src in the DOM
//      while it fetches the new one — visible flash of stale content.
//      Resetting status on every src change makes us hide the image and
//      show the skeleton again until the new src finishes decoding.
//
//   3. Decode errors. A broken URL or unsupported codec used to fall back
//      to the browser's broken-image glyph. We render an explicit
//      placeholder instead so the bubble stays clean.
//
// Loading skeleton: while opacity-0, the parent's background shows
// through. Callers wrap SafeImage in an element with bg-gray-100 (the
// composer thumbnail, the chat bubble container) — that's the skeleton.
//
// API: drop-in. `className` is applied to the <img> exactly like a normal
// <img>. All other props pass through (loading, draggable, onClick, etc).
import { useEffect, useState } from 'react';

export default function SafeImage({ src, alt = '', className = '', ...imgProps }) {
  // 'loading' | 'loaded' | 'error'
  const [status, setStatus] = useState('loading');

  // Reset on every src change so URL swaps (optimistic → server) get a
  // clean skeleton → loaded transition instead of leaking the previous
  // image while the new one fetches.
  useEffect(() => {
    setStatus('loading');
  }, [src]);

  if (status === 'error') {
    return (
      <div
        role="img"
        aria-label={alt || 'Image failed to load'}
        className={`${className} flex items-center justify-center bg-gray-100 text-gray-300`}
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      // Async decode prevents partial-decode paint on mobile webviews.
      decoding="async"
      onLoad={() => setStatus('loaded')}
      onError={() => setStatus('error')}
      // opacity-0 until decoded — the wrapping element's bg shows the
      // skeleton. transition-opacity smooths the reveal so the image
      // doesn't pop in jarringly.
      className={`${className} transition-opacity duration-150 ${status === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
      {...imgProps}
    />
  );
}
