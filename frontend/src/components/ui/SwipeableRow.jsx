import { useRef } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// SwipeableRow
// ─────────────────────────────────────────────────────────────────────────────
//
// Generic swipe-gesture wrapper. The foreground slides left/right under the
// user's finger, revealing colored action panels underneath. On release past
// `threshold` the corresponding `onTrigger` fires; otherwise the row springs
// back to rest.
//
// Usage:
//   <SwipeableRow
//     leftAction={{
//       icon: <CheckIcon />,
//       label: 'Mark read',
//       color: 'bg-status-contacted',
//       onTrigger: () => markRead(item),
//     }}
//     rightAction={{
//       icon: <TrashIcon />,
//       label: 'Delete',
//       color: 'bg-status-urgent',
//       onTrigger: () => del(item),
//     }}
//   >
//     <YourRowContent />
//   </SwipeableRow>
//
// Conventions (chosen so all swipes feel the same across screens):
//   • RIGHT swipe → reveals leftAction (panel pinned to LEFT edge). Mental
//     model: "pull from the left to mark/affirm." Color cue: positive/blue.
//   • LEFT swipe  → reveals rightAction (panel pinned to RIGHT edge). Mental
//     model: "push off to the right to dismiss/destroy." Color cue: destructive/red.
//   • Threshold is the same magnitude in either direction so the gesture has
//     symmetric muscle memory regardless of action.
//
// Implementation notes:
//   • Pure touch events — no PointerEvent or mouse drag, because mouse drag
//     conflicts with click-to-open on desktop. The desktop hover actions
//     (icon buttons that appear on row hover) are the desktop equivalent.
//   • Transform is written directly to the DOM via a ref instead of React
//     state. Setting state on every touchmove would re-render the whole row
//     and tank the gesture's frame rate; the DOM-write path stays at 60fps.
//   • Spring release uses a cubic-bezier that overshoots slightly — feels
//     iOS-native without needing a JS animation library.

const DEFAULT_THRESHOLD = 70;        // px past which the action fires on release
const SPRING_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';  // gentle overshoot on settle
const SPRING_DURATION = '240ms';

export default function SwipeableRow({
  leftAction,
  rightAction,
  threshold = DEFAULT_THRESHOLD,
  className = '',
  // The foreground MUST be opaque or the action panel underneath bleeds
  // through at rest (the bug that turned every Calls row into a neon-green
  // slab). Default to bg-ink-900 (the white card surface) so any row sitting
  // inside a GroupedListSection looks correct out of the box. Override only
  // when you genuinely want a tinted at-rest fill (e.g. a "selected" master-
  // detail row) — and make sure your override is fully opaque.
  surfaceClass = 'bg-ink-900',
  children,
  // When disabled, swipe is a no-op (children render normally). Used by
  // selected rows in a master-detail layout where we want the row to NOT
  // visually slide while the detail panel is open.
  disabled = false,
}) {
  const rowRef = useRef(null);
  const startX = useRef(null);
  const isSwiping = useRef(false);

  function handleTouchStart(e) {
    if (disabled) return;
    startX.current = e.touches[0].clientX;
    isSwiping.current = false;
    // Disable the spring transition during active drag — we want the finger
    // and the row to move in perfect lockstep, no easing latency.
    if (rowRef.current) rowRef.current.style.transition = 'none';
  }

  function handleTouchMove(e) {
    if (disabled || startX.current === null) return;
    const delta = e.touches[0].clientX - startX.current;

    // Only count as a swipe once the user has moved at least 8px horizontally.
    // Below that we let the native vertical scroll handle it — otherwise a
    // small horizontal jitter during a vertical fling would lock the row.
    if (!isSwiping.current && Math.abs(delta) < 8) return;
    isSwiping.current = true;

    // Clamp travel based on which actions exist. If only `rightAction` is
    // configured, the row can only slide left (negative delta), and vice
    // versa. Going past 1.4x the threshold is the visual maximum — there's
    // no benefit to dragging further because the action will fire anyway.
    const maxLeft  = leftAction  ? threshold * 1.4 : 0;   // positive delta
    const maxRight = rightAction ? threshold * 1.4 : 0;   // negative delta
    const clamped  = Math.max(-maxRight, Math.min(maxLeft, delta));

    if (rowRef.current) {
      rowRef.current.style.transform = `translateX(${clamped}px)`;
    }
  }

  function handleTouchEnd() {
    if (disabled) return;
    if (!rowRef.current) { startX.current = null; return; }

    // Read the current transform back out of the DOM. The browser may have
    // clamped it differently than our handler intended (e.g. mid-frame
    // gesture cancel), and the DOM is the truth.
    const transform = rowRef.current.style.transform || 'translateX(0px)';
    const match = transform.match(/translateX\((-?[\d.]+)px\)/);
    const offset = match ? parseFloat(match[1]) : 0;

    // Spring back to rest on every release — regardless of whether the
    // action fires. Triggers run AFTER the spring starts, so the parent can
    // unmount/replace the row without a visible jump.
    rowRef.current.style.transition = `transform ${SPRING_DURATION} ${SPRING_EASE}`;
    rowRef.current.style.transform = 'translateX(0px)';

    if (offset < -threshold && rightAction?.onTrigger) {
      rightAction.onTrigger();
    } else if (offset > threshold && leftAction?.onTrigger) {
      leftAction.onTrigger();
    }

    startX.current = null;
    isSwiping.current = false;
  }

  function handleTouchCancel() {
    // Same as touchend without firing any action — pure visual reset.
    if (!rowRef.current) return;
    rowRef.current.style.transition = `transform ${SPRING_DURATION} ${SPRING_EASE}`;
    rowRef.current.style.transform = 'translateX(0px)';
    startX.current = null;
    isSwiping.current = false;
  }

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Left-edge action panel — revealed by a RIGHT swipe (positive delta) */}
      {leftAction && (
        <div className={`absolute inset-0 flex items-center pl-5 z-0 ${leftAction.color || 'bg-status-contacted'}`}>
          {leftAction.icon && (
            <span className="text-white shrink-0">{leftAction.icon}</span>
          )}
          {leftAction.label && (
            <span className="text-xs text-white font-medium ml-2 whitespace-nowrap">
              {leftAction.label}
            </span>
          )}
        </div>
      )}

      {/* Right-edge action panel — revealed by a LEFT swipe (negative delta) */}
      {rightAction && (
        <div className={`absolute inset-0 flex items-center justify-end pr-5 z-0 ${rightAction.color || 'bg-status-urgent'}`}>
          {rightAction.label && (
            <span className="text-xs text-white font-medium mr-2 whitespace-nowrap">
              {rightAction.label}
            </span>
          )}
          {rightAction.icon && (
            <span className="text-white shrink-0">{rightAction.icon}</span>
          )}
        </div>
      )}

      {/* Foreground — slides over the action panels. MUST be opaque
           (surfaceClass) or the action color bleeds through at rest. */}
      <div
        ref={rowRef}
        className={`relative z-10 will-change-transform ${surfaceClass}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        {children}
      </div>
    </div>
  );
}
