// ─────────────────────────────────────────────────────────────────────────────
// EmptyState
// ─────────────────────────────────────────────────────────────────────────────
//
// The "you have nothing here yet" experience. A centered icon tile, a brief
// title, an optional subtitle, and an optional CTA. Replaces the per-screen
// "p.text-sm.text-gray-400.py-12 // No items" placeholders with something
// that feels designed.
//
// Usage:
//   <EmptyState
//     icon={<PhoneIcon className="w-5 h-5" />}
//     title={t.callsNoRecent}
//     subtitle={t.callsNoRecentHint}
//     action={{ label: t.callsMakeCall, icon: <PlusIcon />, onClick: openDialer }}
//   />
//
// Notes on the icon tile:
//   The 12 × 12 rounded-2xl tile with a soft ring + ink-800 background reads
//   as the same surface vocabulary as our list cards, just shrunk. That
//   visual rhyme is what makes an empty state look like "designed UI" instead
//   of "fallback text."

export default function EmptyState({ icon, title, subtitle, action, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center text-center py-16 px-6 ${className}`}>
      {icon && (
        <div className="w-12 h-12 rounded-2xl bg-ink-800 ring-1 ring-ink-700 flex items-center justify-center mb-4 text-ink-400">
          {icon}
        </div>
      )}

      {title && (
        <p className="text-sm font-semibold text-ink-100 mb-1">{title}</p>
      )}

      {subtitle && (
        <p className="text-xs text-ink-400 leading-relaxed max-w-[280px]">{subtitle}</p>
      )}

      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-5 inline-flex items-center gap-2 bg-ink-50 text-white text-sm font-semibold px-4 py-2 rounded-full hover:bg-ink-100 active:scale-[0.97] transition-all"
        >
          {action.icon}
          {action.label}
        </button>
      )}
    </div>
  );
}
