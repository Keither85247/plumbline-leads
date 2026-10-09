import { useMediaSrc } from '../../hooks/useMediaSrc';
import SafeImage from '../inbox/SafeImage';

/**
 * <audio> for an owned recording / voicemail / greeting, loaded with a
 * short-lived media ticket (never a session credential in the URL).
 * Expired tickets are refreshed transparently and playback resumes in place.
 */
export function TicketedAudio({ kind, id, part = 0, version = 0, onLoadedMetadata, children, ...audioProps }) {
  const media = useMediaSrc(kind, id, part, { version });
  return (
    <audio
      {...audioProps}
      src={media.src || undefined}
      onError={media.src ? media.onError : undefined}
      onLoadedMetadata={(e) => { media.onLoadedMetadata(e); onLoadedMetadata?.(e); }}
    >
      {children}
    </audio>
  );
}

/**
 * One MMS attachment of a stored message, shown via a media ticket.
 * A neutral box while the ticket loads; a broken-image icon if none is
 * available (e.g. the message was deleted).
 */
export function MmsImage({ messageId, part, alt = 'MMS attachment', className = '', ...imgProps }) {
  const media = useMediaSrc('mms', messageId, part);
  if (!media.src) {
    return (
      <div
        role="img"
        aria-label={media.unavailable ? 'Attachment unavailable' : alt}
        className={`${className} bg-gray-100 flex items-center justify-center text-gray-300`}
        style={{ minWidth: 80, minHeight: 80 }}
      >
        {media.unavailable && <BrokenImageIcon />}
      </div>
    );
  }
  return <SafeImage src={media.src} alt={alt} className={className} onLoadError={media.onError} {...imgProps} />;
}

/** Same glyph SafeImage shows for an image that failed to load. */
export function BrokenImageIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}
