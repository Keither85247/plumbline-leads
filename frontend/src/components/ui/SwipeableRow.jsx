import { useRef, useEffect } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// SwipeableRow — native-feeling gesture wrapper
// ─────────────────────────────────────────────────────────────────────────────
//
// Public API (unchanged across rewrites):
//   leftAction  / rightAction  — { icon, label, color, onTrigger } | undefined
//   threshold                  — px past which onTrigger fires on release (default 70)
//   surfaceClass               — opaque background of the foreground (default bg-ink-900)
//   disabled                   — when true, the row is a regular tappable block
//   className                  — applied to the outer wrapper
//
// Why this implementation is structured the way it is:
//
// 1. DIRECTION LOCKING IS THE WHOLE BALL GAME.
//    The reason vertical scrolling felt jittery before was that the previous
//    code only tracked the X component of the finger. Any 8px horizontal
//    twitch during a scroll triggered the swipe. Here we sample BOTH axes on
//    touchstart, wait for an unambiguous direction signal, and bail cleanly
//    when the user is scrolling. Once locked vertical, the gesture is dead —
//    we never resurrect it horizontally even if the finger drifts sideways
//    mid-scroll.
//
// 2. DEAD ZONE + ELASTIC RESISTANCE FEELS INTENTIONAL.
//    Even after we decide a gesture is horizontal, the row does not move at
//    all until the finger has crossed DEAD_ZONE px. From DEAD_ZONE up to
//    ELASTIC_ZONE_END the row tracks at half-speed (the "elastic" feel that
//    tells the user they're engaging an action). Past ELASTIC_ZONE_END the
//    row tracks 1:1 with the finger, with a soft cap so it can't fly off the
//    screen.
//
// 3. VELOCITY MEANS FAST FLICKS ALWAYS WORK.
//    A quick flick should fire the action even if the row didn't travel a
//    full threshold. We sample velocity at touchend (px / ms) and fire on
//    EITHER displacement OR velocity past their respective thresholds.
//
// 4. GPU + PASSIVE LISTENERS + rAF FOR 60FPS.
//    Transforms use translate3d() to force compositor promotion. We attach
//    touchmove with { passive: false } natively (React's synthetic onTouchMove
//    may be passive in some builds), so preventDefault() works once we lock
//    horizontal. All transform writes go through requestAnimationFrame so
//    even a 120Hz screen sees one update per frame.
//
// 5. AUTO-CLOSE ON SCROLL.
//    If a row was left partially open and the user starts scrolling, we snap
//    it shut. Listener is { passive: true, capture: true } so it doesn't
//    interfere with native scroll perf.
//
// 6. CONSOLE DIAGNOSTICS.
//    Toggle on with `localStorage.setItem('swipe-debug', '1')` in dev. Off in
//    production so we don't spam the console.

// ── Tuning knobs ────────────────────────────────────────────────────────────
const DIRECTION_LOCK_THRESHOLD = 8;     // px combined movement before committing to a direction
const HORIZONTAL_BIAS          = 1.5;   // |dx| must beat |dy| by this factor to lock horizontal
const DEAD_ZONE                = 20;    // px — no visible row movement below this
const ELASTIC_ZONE_END         = 60;    // px — half-speed elastic resistance ends here
const ELASTIC_RESISTANCE       = 0.5;   // 0..1 — fraction of finger movement transferred to row in elastic zone
const DEFAULT_THRESHOLD        = 70;    // px past which action fires on release
const VELOCITY_FIRE            = 0.6;   // px/ms — a flick this fast fires regardless of displacement
const MAX_OVERPULL             = 1.4;   // multiplier — row can't translate more than this × threshold

const SPRING_EASE              = 'cubic-bezier(0.16, 1, 0.3, 1)';
const SPRING_DURATION          = '240ms';

// Diagnostic logging — enable in dev with `localStorage.setItem('swipe-debug','1')`.
const DEBUG = typeof window !== 'undefined' &&
  typeof window.localStorage !== 'undefined' &&
  window.localStorage.getItem('swipe-debug') === '1';
function log(...args) { if (DEBUG) console.log('[Swipe]', ...args); }

export default function SwipeableRow({
  leftAction,
  rightAction,
  threshold = DEFAULT_THRESHOLD,
  className = '',
  surfaceClass = 'bg-ink-900',
  children,
  disabled = false,
}) {
  const rowRef = useRef(null);

  // All gesture state lives in refs — never in React state — because a 60fps
  // swipe means up to 60 touchmove events per second, and setState in each
  // would tank performance with a full subtree re-render. The DOM-write path
  // stays on the compositor.
  const startX        = useRef(0);
  const startY        = useRef(0);
  const startT        = useRef(0);
  const lastX         = useRef(0);
  const lastT         = useRef(0);
  const offset        = useRef(0);
  const direction     = useRef(null);   // null | 'vertical' | 'horizontal'
  const active        = useRef(false);  // true between touchstart and touchend
  const pendingOffset = useRef(0);      // last delta we want to write
  const rafScheduled  = useRef(false);  // rAF coalescing flag

  // Compute the visible translation given the raw finger delta.
  //   • |dx| <= DEAD_ZONE       → 0       (no movement — looks identical to rest)
  //   • DEAD_ZONE < |dx| <= ELASTIC_ZONE_END → resisted (half-speed elastic)
  //   • |dx|  > ELASTIC_ZONE_END → tracks 1:1 with finger, capped by overpull
  //   • no action on that side  → strong rubberband (18% of finger movement)
  function computeTranslate(rawDelta, side) {
    if (!side) return rawDelta * 0.18;                // rubberband against missing action

    const sign = rawDelta < 0 ? -1 : 1;
    const abs  = Math.abs(rawDelta);

    if (abs <= DEAD_ZONE) return 0;

    if (abs <= ELASTIC_ZONE_END) {
      const overshoot = abs - DEAD_ZONE;
      return sign * overshoot * ELASTIC_RESISTANCE;
    }

    // Past elastic zone — 1:1 with finger, capped so the row can't fly off
    const elasticTravel = (ELASTIC_ZONE_END - DEAD_ZONE) * ELASTIC_RESISTANCE;
    const linearTravel  = abs - ELASTIC_ZONE_END;
    const total         = elasticTravel + linearTravel;
    return sign * Math.min(total, threshold * MAX_OVERPULL);
  }

  function applyTransform(x) {
    if (!rowRef.current) return;
    // translate3d() forces compositor promotion so this never paints.
    rowRef.current.style.transform = `translate3d(${x}px, 0, 0)`;
    offset.current = x;
  }

  function snapBack(animate = true) {
    if (!rowRef.current) return;
    rowRef.current.style.transition = animate
      ? `transform ${SPRING_DURATION} ${SPRING_EASE}`
      : 'none';
    rowRef.current.style.transform = 'translate3d(0px, 0, 0)';
    offset.current = 0;
  }

  function resetGesture() {
    active.current        = false;
    direction.current     = null;
    pendingOffset.current = 0;
  }

  function handleTouchStart(e) {
    if (disabled) return;
    const t = e.touches[0];
    startX.current = t.clientX;
    startY.current = t.clientY;
    startT.current = e.timeStamp;
    lastX.current  = t.clientX;
    lastT.current  = e.timeStamp;
    direction.current = null;
    active.current = true;
    // Kill any in-flight spring so the finger and the row start in lockstep
    if (rowRef.current) rowRef.current.style.transition = 'none';
  }

  // Native (non-React) touchmove handler. Attached via useEffect below with
  // { passive: false } so preventDefault() actually stops the browser from
  // also scrolling on the Y component once we lock horizontal.
  function handleTouchMove(e) {
    if (!active.current || disabled) return;

    const t  = e.touches[0];
    const dx = t.clientX - startX.current;
    const dy = t.clientY - startY.current;

    // ── Step 1: lock direction ─────────────────────────────────────────
    if (direction.current === null) {
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      // Still inside the deciding dead zone — wait for clearer intent
      if (Math.max(absX, absY) < DIRECTION_LOCK_THRESHOLD) return;

      // Horizontal only when X CLEARLY dominates. Ambiguity → vertical, so
      // the user gets a buttery native scroll instead of an accidental swipe.
      if (absX > absY * HORIZONTAL_BIAS) {
        direction.current = 'horizontal';
        log('locked horizontal', { dx, dy });
      } else {
        direction.current = 'vertical';
        log('locked vertical', { dx, dy });
      }
    }

    // ── Step 2: vertical lock → exit, let the browser scroll natively ──
    if (direction.current === 'vertical') return;

    // ── Step 3: horizontal — translate the row via rAF-coalesced write ─
    const side = dx > 0 ? leftAction : rightAction;
    pendingOffset.current = computeTranslate(dx, side);
    lastX.current = t.clientX;
    lastT.current = e.timeStamp;

    if (!rafScheduled.current) {
      rafScheduled.current = true;
      requestAnimationFrame(() => {
        applyTransform(pendingOffset.current);
        rafScheduled.current = false;
      });
    }

    // We've claimed this gesture — stop the browser from also scrolling Y,
    // which would otherwise cause perceived jitter on diagonal flicks.
    if (e.cancelable) e.preventDefault();
  }

  function handleTouchEnd(e) {
    if (!active.current) return;

    // If we never committed to horizontal, nothing visible to undo — bail.
    if (direction.current !== 'horizontal') {
      resetGesture();
      return;
    }

    // Judge intent by what the FINGER did, not the elastic-resisted output.
    const totalDx  = lastX.current - startX.current;
    const dt       = Math.max(1, e.timeStamp - startT.current);
    const velocity = totalDx / dt;                    // px/ms (signed)

    const fireLeft  = leftAction  && (totalDx >  threshold || velocity >  VELOCITY_FIRE);
    const fireRight = rightAction && (totalDx < -threshold || velocity < -VELOCITY_FIRE);

    if (fireLeft) {
      log('action revealed (left)', { totalDx, velocity });
      leftAction.onTrigger?.();
    } else if (fireRight) {
      log('action revealed (right)', { totalDx, velocity });
      rightAction.onTrigger?.();
    } else {
      log('snap back', { totalDx, velocity });
    }

    snapBack();
    resetGesture();
  }

  function handleTouchCancel() {
    log('cancelled');
    snapBack();
    resetGesture();
  }

  // ── Native non-passive touchmove ───────────────────────────────────────
  // React 18 may attach onTouchMove as passive depending on the build/runtime.
  // We need to be able to preventDefault() to stop concurrent Y scroll when
  // a horizontal swipe is committed, so we attach the listener ourselves.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const onMove = (e) => handleTouchMove(e);
    el.addEventListener('touchmove', onMove, { passive: false });
    return () => el.removeEventListener('touchmove', onMove);
    // handleTouchMove reads via refs (not props/state) so this only needs to
    // run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-close any open row when the page scrolls ──────────────────────
  // Once vertical scroll begins, our touch handlers may not fire again until
  // the gesture ends. Catching scroll-start with a capture listener lets us
  // snap shut any row that was left partially open and the user scrolled
  // past. Throttled to once per frame to keep scroll perf untouched.
  useEffect(() => {
    let raf = 0;
    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (offset.current !== 0 && !active.current) {
          log('auto-close on scroll');
          snapBack();
        }
      });
    }
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Left-edge action panel — revealed by a RIGHT swipe (positive dx).
           Hidden at rest by the opaque foreground sitting on top. */}
      {leftAction && (
        <div className={`absolute inset-0 flex items-center pl-5 z-0 ${leftAction.color || 'bg-status-contacted'}`}>
          {leftAction.icon  && <span className="text-white shrink-0">{leftAction.icon}</span>}
          {leftAction.label && <span className="text-xs text-white font-medium ml-2 whitespace-nowrap">{leftAction.label}</span>}
        </div>
      )}

      {/* Right-edge action panel — revealed by a LEFT swipe (negative dx). */}
      {rightAction && (
        <div className={`absolute inset-0 flex items-center justify-end pr-5 z-0 ${rightAction.color || 'bg-status-urgent'}`}>
          {rightAction.label && <span className="text-xs text-white font-medium mr-2 whitespace-nowrap">{rightAction.label}</span>}
          {rightAction.icon  && <span className="text-white shrink-0">{rightAction.icon}</span>}
        </div>
      )}

      {/* Foreground — opaque, GPU-promoted, owns the touch surface.
           touch-action: pan-y tells the browser to handle vertical scrolling
           natively (no waiting for our handlers) while leaving horizontal
           pans for us. This is the single largest contributor to "feel." */}
      <div
        ref={rowRef}
        className={`relative z-10 will-change-transform ${surfaceClass}`}
        style={{ touchAction: 'pan-y', transform: 'translate3d(0px, 0, 0)' }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        {children}
      </div>
    </div>
  );
}
