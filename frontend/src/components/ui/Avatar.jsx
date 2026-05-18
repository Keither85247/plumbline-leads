// ─────────────────────────────────────────────────────────────────────────────
// Avatar
// ─────────────────────────────────────────────────────────────────────────────
//
// A consistent contact-avatar primitive. Renders an initials disc tinted by
// the contact's category, with a soft ring so it sits on the white card
// surface without looking pasted on. Single sizing scale (sm/md/lg) so every
// list across the app uses the same proportions.
//
// Why one component instead of inline disc divs:
//   Calls, Contacts, Inbox, and Timeline each had their own avatar styling,
//   each pulling from different legacy color maps (`bg-blue-100`,
//   `bg-green-100`, etc.). The result was inconsistent saturation and an
//   off-brand palette. Centralizing here means the design system can evolve
//   in one file.
//
// Usage:
//   <Avatar name="John Smith" category="Lead" size="md" />
//   <Avatar name={null} fallback="?" />     // unknown contact → "?"
//   <Avatar name="J" category="Vendor" />   // single-letter still works

const SIZE_CLASSES = {
  sm: 'w-8  h-8  text-xs   leading-none',
  md: 'w-10 h-10 text-sm   leading-none',
  lg: 'w-12 h-12 text-base leading-none',
};

// Maps a category string (lead/vendor/customer/etc.) to a tint pair. Keeps
// the avatar in the same color family as the matching status chip so the
// row reads as a coherent semantic unit.
const CATEGORY_TINTS = {
  Lead:                'bg-accent-100         text-accent-700        ring-accent-200/60',
  'Likely Lead':       'bg-accent-100         text-accent-700        ring-accent-200/60',
  Customer:            'bg-status-customer/15 text-status-customer   ring-status-customer/25',
  'Existing Customer': 'bg-status-customer/15 text-status-customer   ring-status-customer/25',
  Vendor:              'bg-status-vendor/15   text-status-vendor     ring-status-vendor/25',
  Supplier:            'bg-status-scheduled/15 text-status-scheduled ring-status-scheduled/25',
  Spam:                'bg-status-urgent/12   text-status-urgent     ring-status-urgent/25',
  'Likely Spam':       'bg-status-urgent/12   text-status-urgent     ring-status-urgent/25',
  Other:               'bg-ink-800            text-ink-400           ring-ink-700',
};

// Computes the initials shown inside the disc. Two letters when there are
// two name parts ("John Smith" → "JS"), one letter otherwise ("Acme" → "A").
// Falls back to `fallback` when no name is available — useful for phone-only
// rows where we still want a placeholder shape.
function initialsOf(name, fallback) {
  if (!name || typeof name !== 'string') return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export default function Avatar({
  name,
  category,
  size = 'md',
  fallback = '?',
  className = '',
}) {
  const sizeCls = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const tint = CATEGORY_TINTS[category] || CATEGORY_TINTS.Other;
  const initials = initialsOf(name, fallback);

  return (
    <div
      className={`shrink-0 rounded-full flex items-center justify-center font-semibold ring-1 ${sizeCls} ${tint} ${className}`}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}
