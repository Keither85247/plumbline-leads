/** @type {import('tailwindcss').Config} */
//
// Plumbline Leads — design system (light/sage edition).
//
// Premium field-service aesthetic, take 2: soft sage canvas, white cards,
// near-black primary CTAs (black-pill), category-coded status colors. We
// kept the same token names from the dark edition so components don't need
// renames — only the underlying values flipped.
//
// Color naming convention (semantic, theme-agnostic):
//   ink/*       → surface + text scale. ink-950 is the OUTERMOST surface
//                 (the body sage tint), ink-900 is the elevated card
//                 surface (white). ink-50 is the PRIMARY text/CTA fill
//                 (near-black). The scale runs background → text.
//   accent/*    → secondary action color (electric blue). Used for links,
//                 focus rings, "translate" / link-style affordances.
//                 Primary CTAs use a black pill (bg-ink-50) per the ref.
//   status/*    → semantic colors (lead, contacted, scheduled, urgent...).
//                 Unchanged across themes — green/red/amber are universal.

export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,jsx}'
  ],
  theme: {
    extend: {
      colors: {
        // ── Surface + text scale ────────────────────────────────────────────
        // Reading the scale: 950 = the outermost body tint (sage). 900 = the
        // elevated card surface (pure white for max legibility on the tint).
        // 800/700 = slightly lifted variants for sub-surfaces / borders.
        // 500-300 = text scale from quietest metadata to body text. 200-50 =
        // headings down to the near-black used for primary text and the
        // black-pill primary CTA.
        //
        // Component usage convention (same as the dark edition):
        //   bg-ink-950  → outermost app background (sage tint)
        //   bg-ink-900  → elevated card surface (white)
        //   bg-ink-800  → nested sub-surface inside a card
        //   bg-ink-700  → quiet pressed/active row tint
        //   border-ink-700/600 → light dividers / card edges
        //   text-ink-50  → primary text & primary CTA fill (near-black)
        //   text-ink-300 → body text
        //   text-ink-400 → secondary text
        //   text-ink-500 → tertiary text / metadata
        ink: {
          // Text scale (darkest → mid). text-ink-50 = primary text.
          50:  '#0c1010',   // primary text — card titles, section headers
          100: '#171b1b',   // heading
          200: '#252a2a',   // subheading / strong body
          300: '#3a403e',   // body text
          400: '#5f6663',   // secondary text
          500: '#6b7280',   // tertiary text / metadata (date, "13 total") — bumped slightly per Figma
          // Border + surface scale (mid → lightest). Body surface is now
          // near-white to match the approved Figma (sage removed).
          600: '#c5cac7',   // heavier border
          700: '#e5e7eb',   // light border / divider
          800: '#f3f4f6',   // key-point tag pill bg / nested sub-surface
          900: '#ffffff',   // elevated card surface — pure white
          950: '#f9fafb',   // outermost body background — near-white
        },

        // ── Brand — the primary green from the Figma. The card-glow shadow
        //     color (#039855) is the anchor; everything else in the ramp
        //     derives from that value. Used for:
        //       • Send button fill
        //       • "Suggested follow-up" heading + "Read more" + "View
        //         original message" link
        //       • NEW status dot + pill
        //       • Bottom nav active-tab pill
        brand: {
          50:  '#ecfdf5',   // suggested-follow-up panel tint / lightest bg
          100: '#d1fae5',   // NEW status pill background / edit icon disc
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',   // NEW status dot
          600: '#059669',   // "Suggested follow-up" heading / links
          700: '#047857',   // Send button hover
          800: '#039855',   // Send button fill + card-glow shadow — CONFIRMED FROM FIGMA
          900: '#065f46',
        },

        // ── Accent — kept as electric blue for phone-number links and any
        //     hyperlink-style affordance where brand green would compete.
        accent: {
          50:  '#eef5ff',
          100: '#d9e8ff',
          200: '#b3d1ff',
          300: '#7eaeff',
          400: '#4d87ff',
          500: '#2563eb',   // primary blue — phone number
          600: '#1d4ed8',
          700: '#1e40af',
          800: '#1e3a8a',
          900: '#172554',
        },

        // ── Status palette — one hex per named state, used by pill tokens
        //     and the card-glow shadow (see boxShadow below). Values match
        //     the approved Figma preview:
        //       NEW / QUALIFIED → brand green (#039855)
        //       CONTACTED       → amber
        //       OVERDUE / URGENT→ red
        //       VENDOR          → violet
        //       CUSTOMER        → teal
        //       CLOSED / SPAM   → gray
        status: {
          new:        '#039855',  // brand green — new lead, alive
          contacted:  '#d97706',  // amber — reached out, awaiting reply
          scheduled:  '#d97706',  // amber — legacy alias, same tone
          urgent:     '#dc2626',  // red — overdue / action required
          qualified:  '#039855',  // brand green — accepted lead
          vendor:     '#7c3aed',  // violet — vendor/supplier
          customer:   '#0d9488',  // teal — existing customer
          spam:       '#6b7280',  // gray — junk
          closed:     '#6b7280',  // gray — finished
        },
      },

      // ── Shadows ──────────────────────────────────────────────────────────
      // The lead-card state glow is the star of this system — it replaces
      // the old status-edge bar with a soft colored halo around each card.
      // Values come straight from the approved Figma spec:
      //     X:0  Y:0  Blur:11  Spread:0  Color:{status hex}  Opacity:60%
      // The `glow-*` tokens name each status; the color inside the rgba()
      // matches the corresponding entry in `colors.status`.
      boxShadow: {
        'card':          '0 1px 2px rgba(15, 35, 25, 0.04), 0 4px 16px -3px rgba(15, 35, 25, 0.08)',
        'card-hover':    '0 2px 4px rgba(15, 35, 25, 0.06), 0 14px 32px -6px rgba(15, 35, 25, 0.14)',
        'nav-glass':     '0 -1px 0 rgba(255,255,255,0.9) inset, 0 -8px 28px rgba(15, 35, 25, 0.08), 0 8px 32px rgba(15, 35, 25, 0.08)',
        'inset-soft':    'inset 0 1px 0 rgba(255,255,255,0.6)',
        'badge-glow':    '0 0 0 2px #ffffff, 0 0 12px rgba(220, 38, 38, 0.45)',

        // State-glow halos — Figma spec: 0 0 11px 0 <status>@60%
        'glow-new':       '0 0 11px 0 rgba(3, 152, 85, 0.6)',    // brand green
        'glow-qualified': '0 0 11px 0 rgba(3, 152, 85, 0.6)',    // brand green (same as new)
        'glow-contacted': '0 0 11px 0 rgba(217, 119, 6, 0.6)',   // amber
        'glow-scheduled': '0 0 11px 0 rgba(217, 119, 6, 0.6)',   // amber (legacy alias)
        'glow-overdue':   '0 0 11px 0 rgba(220, 38, 38, 0.6)',   // red
        'glow-urgent':    '0 0 11px 0 rgba(220, 38, 38, 0.6)',   // red (legacy alias)
        'glow-closed':    '0 0 11px 0 rgba(107, 114, 128, 0.35)',// muted gray
      },

      // ── Border radius scale (slightly larger than default for premium feel) ─
      borderRadius: {
        '4xl': '2rem',
      },

      // ── Animations ────────────────────────────────────────────────────
      keyframes: {
        'fade-in-up': {
          '0%':   { opacity: '0', transform: 'translate(-50%, 0.5rem)' },
          '100%': { opacity: '1', transform: 'translate(-50%, 0)' },
        },
        'fade-in': {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%':   { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Subtle press feedback — used on touchable surfaces
        'press': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%':      { transform: 'scale(0.98)' },
        },
        // Quiet attention pulse for "NEW" badges — emerald ring on white
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(22, 163, 74, 0.45)' },
          '50%':      { boxShadow: '0 0 0 6px rgba(22, 163, 74, 0)' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.18s ease-out both',
        'fade-in':    'fade-in 0.18s ease-out both',
        'slide-up':   'slide-up 0.24s cubic-bezier(0.16, 1, 0.3, 1) both',
        'press':      'press 0.15s ease-out',
        'pulse-glow': 'pulse-glow 2.4s ease-in-out infinite',
      },

      // ── Backdrop blur scale ───────────────────────────────────────────
      // Used for glass-effect bottom nav, modal overlays
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: []
};
