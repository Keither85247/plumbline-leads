/** @type {import('tailwindcss').Config} */
//
// Plumbline Leads — design system.
//
// Premium field-service aesthetic: deep charcoal surfaces, electric blue
// accents, intentional status colors. Tokens are deliberately small and
// purposeful — components opt into the system by class name, no theme
// provider needed.
//
// Color naming convention:
//   ink/*       → dark surface scale (50 → 950, dark by default)
//   accent/*    → primary action color (electric blue)
//   status/*    → semantic colors (lead, contacted, scheduled, urgent, ...)
//
// Use these tokens for ALL new UI. Older components can stay on default
// Tailwind grays until phase-2 migration.

export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,jsx}'
  ],
  theme: {
    extend: {
      colors: {
        // ── Layered ink surfaces (the new dark scale) ───────────────────
        // Use as: bg-ink-950 (app background) → bg-ink-900 (elevated card)
        //         → bg-ink-800 (nested content) → bg-ink-700 (active row)
        // Borders: border-ink-800 (subtle separator), border-ink-700 (card edge)
        // Text:    text-ink-50 (primary), text-ink-300 (secondary),
        //          text-ink-500 (tertiary / metadata)
        ink: {
          50:  '#f6f7f9',
          100: '#eceef2',
          200: '#d3d8e0',
          300: '#a4adba',
          400: '#737e8e',
          500: '#525c6b',
          600: '#3a424e',
          700: '#2a313b',
          800: '#1c2230',   // elevated card surface
          900: '#141a26',   // app surface
          950: '#0b0f1a',   // outermost background
        },

        // ── Accent — electric blue (primary actions, brand) ────────────
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
        status: {
          new:        '#22c55e',  // emerald — new lead, alive, fresh
          contacted:  '#60a5fa',  // sky    — already reached out
          scheduled:  '#f59e0b',  // amber  — on the calendar
          urgent:     '#ef4444',  // red    — overdue / action required
          vendor:     '#a78bfa',  // violet — vendor/supplier
          customer:   '#2dd4bf',  // teal   — existing customer
          spam:       '#6b7280',  // gray   — junk
        },
      },

      // ── Premium shadows tuned for dark surfaces ───────────────────────
      // Standard tailwind shadows are designed for light UIs — they
      // disappear or blow out on dark. These have higher opacity + larger
      // spread for visible elevation on ink-900/950.
      boxShadow: {
        'card':       '0 1px 2px rgba(0,0,0,0.4), 0 4px 12px -2px rgba(0,0,0,0.3)',
        'card-hover': '0 2px 4px rgba(0,0,0,0.45), 0 12px 28px -4px rgba(0,0,0,0.45)',
        'nav-glass':  '0 -1px 0 rgba(255,255,255,0.06) inset, 0 8px 32px rgba(0,0,0,0.5)',
        'inset-soft': 'inset 0 1px 0 rgba(255,255,255,0.04)',
        'badge-glow': '0 0 0 2px rgba(11,15,26,1), 0 0 12px rgba(239,68,68,0.5)',
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
        // Quiet attention pulse for "NEW" badges
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(34,197,94,0.5)' },
          '50%':      { boxShadow: '0 0 0 6px rgba(34,197,94,0)' },
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
