// ─────────────────────────────────────────────────────────────────────────────
// FloatingActionButton
// ─────────────────────────────────────────────────────────────────────────────
//
// The primary "create new" affordance on a list screen. A black-pill button
// anchored bottom-right, lifted above the bottom navigation and the iOS
// home-indicator safe area. Mobile-first by default — hidden on md+ screens
// because desktop has room for inline header CTAs.
//
// Usage:
//   <FloatingActionButton
//     icon={<PlusIcon />}
//     label="Dial"           // optional — without it the FAB is a round 56px button
//     onClick={openDialer}
//     aria-label="Open dialer"
//   />
//
// Positioning:
//   The fixed offset (96px + safe-area-inset-bottom) clears the bottom nav
//   pill on every Android model and the iOS home indicator on every phone.
//   The right offset (16px) matches the page side padding so the FAB aligns
//   with the right edge of the content.
//
// Why a single primitive (not per-screen FABs):
//   Three previous screens each rolled their own FAB with slightly different
//   colors, sizes, and offsets. The result was visually inconsistent and any
//   tweak to nav clearance had to be propagated four times. This centralizes
//   that decision in one file.

export default function FloatingActionButton({
  icon,
  label,
  onClick,
  hideOnDesktop = true,
  className = '',
  ariaLabel,
  ...rest
}) {
  const sized = label
    // Pill with label — slightly larger horizontal padding for comfort
    ? 'px-5 py-3.5 gap-2'
    // Round icon-only — perfect circle, 56px tap target
    : 'w-14 h-14 justify-center';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel || (typeof label === 'string' ? label : undefined)}
      className={`
        ${hideOnDesktop ? 'md:hidden' : ''}
        fixed right-4 z-30
        inline-flex items-center
        bg-ink-50 text-white
        rounded-full
        shadow-[0_8px_24px_rgba(15,35,25,0.18),0_2px_4px_rgba(15,35,25,0.08)]
        font-semibold text-sm
        active:scale-[0.96] transition-transform duration-150
        ${sized}
        ${className}
      `}
      // Keeping this inline so the safe-area calc isn't subject to JIT compilation
      // of arbitrary tailwind variants (and so its intent is obvious in the diff).
      style={{ bottom: 'calc(96px + env(safe-area-inset-bottom))' }}
      {...rest}
    >
      {icon}
      {label}
    </button>
  );
}
