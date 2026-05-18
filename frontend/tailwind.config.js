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
          50:  '#0c1010',   // primary text / black-pill CTA fill
          100: '#171b1b',   // heading
          200: '#252a2a',   // subheading / strong body
          300: '#3a403e',   // body text
          400: '#5f6663',   // secondary text
          500: '#8a918d',   // tertiary text / metadata
          // Border + surface scale (mid → lightest). The lightest is the
          // sage body tint — every other surface stacks on top.
          600: '#c5cac7',   // heavier border
          700: '#dee1de',   // light border / divider
          800: '#eef1ee',   // slightly tinted sub-surface (nested cards)
          900: '#ffffff',   // elevated card surface — pure white
          950: '#d6e6db',   // outermost background — soft sage tint
        },

        // ── Accent — electric blue (secondary actions, links, focus) ──────
        // Note: in this edition the PRIMARY CTA is black-pill (bg-ink-50),
        // matching the reference. Accent stays blue for hyperlink-style
        // affordances and focus rings where a pop of color helps.
        accent: {
          50:  '#eef5ff',
          100: '#d9e8ff',
          200: '#b3d1ff',
          300: '#7eaeff',
          400: '#4d87ff',
          500: '#2563eb',   // primary
          600: '#1d4ed8',
          700: '#1e40af',
          800: '#1e3a8a',
          900: '#172554',
        },

        // ── Status palette (semantic, used by chips + status edges) ─────
        // Unchanged across editions — green/red/amber/violet are universal
        // signals that read identically on dark and light surfaces.
        status: {
          new:        '#16a34a',  // emerald — new lead, alive, fresh (slightly deeper than dark edition for white-card contrast)
          contacted:  '#2563eb',  // blue   — already reached out
          scheduled:  '#d97706',  // amber  — on the calendar
          urgent:     '#dc2626',  // red    — overdue / action required
          vendor:     '#7c3aed',  // violet — vendor/supplier
          customer:   '#0d9488',  // teal   — existing customer
          spam:       '#6b7280',  // gray   — junk
        },
      },

      // ── Premium shadows tuned for LIGHT surfaces ─────────────────────────
      // Standard tailwind shadows are too gray/dim for white cards on a
      // tinted background — they read as flat. These are slightly softer
      // and warmer (sage-tinted) for natural depth on the new canvas.
      boxShadow: {
        'card':       '0 1px 2px rgba(15, 35, 25, 0.04), 0 4px 16px -3px rgba(15, 35, 25, 0.08)',
        'card-hover': '0 2px 4px rgba(15, 35, 25, 0.06), 0 14px 32px -6px rgba(15, 35, 25, 0.14)',
        'nav-glass':  '0 -1px 0 rgba(255,255,255,0.9) inset, 0 -8px 28px rgba(15, 35, 25, 0.08), 0 8px 32px rgba(15, 35, 25, 0.08)',
        'inset-soft': 'inset 0 1px 0 rgba(255,255,255,0.6)',
        'badge-glow': '0 0 0 2px #ffffff, 0 0 12px rgba(220, 38, 38, 0.45)',
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
