import { useState, useEffect } from 'react';

const FEATURES = [
  'Unlimited leads from calls & texts',
  'AI-generated call summaries',
  'Full customer timeline',
  'SMS inbox & outbound texting',
  'Email thread sync',
  'Voicemail transcription',
  'Contact history & notes',
];

function Check() {
  return (
    <svg width="13" height="13" fill="none" stroke="#2563EB" strokeWidth="2.5" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
    </svg>
  );
}

export default function PricingSlide({ onGetStarted, onTesterBypass }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 60);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="flex flex-col h-full bg-white overflow-y-auto">

      {/* ── Top: price + features ─────────────────────────────── */}
      <div
        className="flex-1 flex flex-col items-center justify-center px-7 py-8"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(10px)',
          transition: 'opacity 350ms ease, transform 350ms ease',
        }}
      >
        {/* Label */}
        <p className="text-xs font-semibold tracking-widest uppercase mb-4" style={{ color: '#94A3B8' }}>
          Simple pricing
        </p>

        {/* Price */}
        <div className="flex items-start justify-center mb-1">
          <span className="text-2xl font-bold mt-2.5 mr-0.5" style={{ color: '#0F172A' }}>$</span>
          <span
            className="leading-none font-bold"
            style={{ fontSize: 76, color: '#0F172A', letterSpacing: '-3px' }}
          >
            49
          </span>
          <span className="text-base self-end mb-2.5 ml-1" style={{ color: '#94A3B8' }}>/mo</span>
        </div>

        <p className="text-[13px] mb-8" style={{ color: '#94A3B8' }}>
          Everything included. No add-ons.
        </p>

        {/* Divider */}
        <div className="w-full h-px mb-7" style={{ background: '#F1F5F9' }} />

        {/* Feature list */}
        <ul className="w-full space-y-3.5">
          {FEATURES.map(f => (
            <li key={f} className="flex items-center gap-3">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                style={{ background: '#EFF6FF' }}
              >
                <Check />
              </div>
              <span className="text-[14px]" style={{ color: '#334155' }}>{f}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Bottom: CTAs ──────────────────────────────────────── */}
      <div className="px-7 pb-7 pt-2 bg-white" style={{ borderTop: '1px solid #F1F5F9' }}>
        {/* Headline */}
        <p
          className="text-[22px] font-bold leading-snug tracking-tight mb-1"
          style={{ color: '#0F172A' }}
        >
          Built for serious<br />contractors.
        </p>
        <p className="text-[13px] mb-5 leading-relaxed" style={{ color: '#94A3B8' }}>
          Replace missed calls, scattered texts, and forgotten follow-ups.
        </p>

        {/* Primary CTA */}
        <button
          onClick={onGetStarted}
          className="w-full rounded-2xl py-4 text-[15px] font-semibold text-white transition-all active:scale-[0.98] mb-3"
          style={{ background: '#2563EB' }}
        >
          Get Started
        </button>

        {/* Tester bypass */}
        <button
          onClick={onTesterBypass}
          className="w-full py-2.5 text-[14px] transition-colors active:opacity-60"
          style={{ color: '#94A3B8' }}
        >
          Continue as Tester
        </button>

        {/* Founding member note */}
        <p
          className="text-center text-[11px] mt-3 leading-relaxed px-4"
          style={{ color: '#CBD5E1' }}
        >
          Early testers and beta users will receive discounted founding-member pricing later.
        </p>
      </div>

    </div>
  );
}
