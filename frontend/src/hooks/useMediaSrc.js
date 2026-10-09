import { useCallback, useEffect, useRef, useState } from 'react';
import { requestMediaUrl } from '../api';

// A player may refresh its ticket any number of times over its life (e.g.
// paused past expiry, again and again), but never more than twice within this
// window — so an object that keeps failing cannot cause a refresh loop.
const REFRESH_WINDOW_MS = 4 * 60 * 1000;

/**
 * Ticketed URL for one owned media object (see api.js requestMediaUrl).
 *
 * Returns { src, unavailable, onError, onLoadedMetadata }. Attach both
 * handlers to the <audio>/<img>: when a ticket has expired or used up its
 * allowance (or the network dropped), onError fetches a fresh ticket and, for
 * audio, playback resumes at the same position (and keeps playing if it was)
 * once metadata reloads. `unavailable` is true when no ticket could be had.
 * `version` forces a fresh ticket (e.g. after a new greeting upload).
 */
export function useMediaSrc(kind, id, part = 0, { enabled = true, version = 0 } = {}) {
  const [state, setState] = useState({ src: null, unavailable: false });
  const retries = useRef(0);
  const srcAt   = useRef(0);
  const resume  = useRef(null);

  useEffect(() => {
    let alive = true;
    retries.current = 0;
    if (!enabled || (kind !== 'greeting' && (id === null || id === undefined))) {
      setState({ src: null, unavailable: false });
      return undefined;
    }
    requestMediaUrl(kind, id, part, { fresh: version > 0 }).then((u) => {
      if (!alive) return;
      srcAt.current = Date.now();
      setState({ src: u, unavailable: !u });
    });
    return () => { alive = false; };
  }, [kind, id, part, enabled, version]);

  const onError = useCallback((e) => {
    if (Date.now() - srcAt.current > REFRESH_WINDOW_MS) retries.current = 0;
    if (retries.current >= 2) return;
    retries.current += 1;
    const el = e?.currentTarget;
    // Saved even at 0:00 — a Play press on an expired ticket still plays.
    resume.current = el && typeof el.currentTime === 'number'
      ? { t: el.currentTime, play: !el.paused }
      : null;
    requestMediaUrl(kind, id, part, { fresh: true }).then((u) => {
      srcAt.current = Date.now();
      setState({ src: u, unavailable: !u });
    });
  }, [kind, id, part]);

  const onLoadedMetadata = useCallback((e) => {
    const el = e?.currentTarget;
    const r = resume.current;
    if (!el || !r) return;
    resume.current = null;
    try {
      if (r.t > 0) el.currentTime = r.t;
      if (r.play) el.play().catch(() => {});
    } catch { /* ignore */ }
  }, []);

  return { src: state.src, unavailable: state.unavailable, onError, onLoadedMetadata };
}
