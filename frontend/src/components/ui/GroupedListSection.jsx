// ─────────────────────────────────────────────────────────────────────────────
// GroupedListSection
// ─────────────────────────────────────────────────────────────────────────────
//
// The Timeline grouping primitive: an uppercase section label + a thin rule +
// an optional count chip, followed by a single white card whose children are
// flat rows with hairline dividers between them. Outer rounded corners only.
//
// This is the pattern that makes Timeline feel finished — every grouped
// screen (Calls, Email, Inbox, Contacts) should adopt it instead of rolling
// its own date / alphabetical / status section UI.
//
// Usage:
//   <GroupedListSection label="Today" count={5}>
//     {items.map(item => <YourRow key={item.id} item={item} />)}
//   </GroupedListSection>
//
// Variants via `tone`:
//   • 'default' — standard sage divider rule, used for date/alpha grouping
//   • 'quiet'   — even softer divider, used when stacking many sections
//
// Notes on the dividers:
//   The hairline between rows uses `bg-ink-800` (a barely-tinted off-white)
//   instead of pure gray so it harmonizes with the sage canvas. The hairline
//   is inset 16px (mx-4) so it doesn't bleed to the card edge — that's the
//   detail that separates an "iOS Settings" look from "Android Material list."

export default function GroupedListSection({
  label,
  count,
  children,
  tone = 'default',
  className = '',
}) {
  // Normalize children into an array so we can intersperse dividers between
  // siblings. Single-child usage passes through cleanly.
  const childArr = (Array.isArray(children) ? children : [children]).filter(Boolean);
  const displayCount = count ?? childArr.length;

  const ruleClass = tone === 'quiet' ? 'bg-ink-800' : 'bg-ink-700';

  return (
    <div>
      {/* Section header: label + flexible rule + count */}
      {label && (
        <div className="flex items-center gap-3 mb-2 px-1">
          <span className="text-[11px] font-semibold text-ink-400 uppercase tracking-widest whitespace-nowrap">
            {label}
          </span>
          <div className={`flex-1 h-px ${ruleClass}`} />
          {displayCount != null && (
            <span className="text-[11px] text-ink-500 tabular-nums">{displayCount}</span>
          )}
        </div>
      )}

      {/* Grouped card surface — outer rounded corners only */}
      <div className={`bg-ink-900 rounded-2xl ring-1 ring-ink-700 shadow-card overflow-hidden ${className}`}>
        {childArr.map((child, idx) => (
          <div key={idx}>
            {idx > 0 && <div className="h-px bg-ink-800 mx-4" />}
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}
