import { useState, useEffect } from 'react';

const STEPS = [
  {
    color: '#2563EB',
    bg: '#EFF6FF',
    label: 'Customer calls or texts',
    detail: 'Any number, any time',
    icon: (
      <svg width="18" height="18" fill="none" stroke="#2563EB" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z"/>
      </svg>
    ),
  },
  {
    color: '#7C3AED',
    bg: '#F5F3FF',
    label: 'Lead created automatically',
    detail: 'AI-extracted name, summary, notes',
    icon: (
      <svg width="18" height="18" fill="none" stroke="#7C3AED" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0121 9.414V19a2 2 0 01-2 2z"/>
      </svg>
    ),
  },
  {
    color: '#059669',
    bg: '#ECFDF5',
    label: 'Timeline updates instantly',
    detail: 'Every call, text, and voicemail linked',
    icon: (
      <svg width="18" height="18" fill="none" stroke="#059669" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
    ),
  },
  {
    color: '#D97706',
    bg: '#FFFBEB',
    label: 'Follow-up stays organized',
    detail: 'Nothing slips through the cracks',
    icon: (
      <svg width="18" height="18" fill="none" stroke="#D97706" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M5 13l4 4L19 7"/>
      </svg>
    ),
  },
];

export default function HowItWorksSlide({ onNext }) {
  const [visible, setVisible] = useState([false, false, false, false]);

  useEffect(() => {
    const timers = [80, 200, 320, 440].map((delay, i) =>
      setTimeout(() =>
        setVisible(prev => { const n = [...prev]; n[i] = true; return n; }),
        delay
      )
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="flex flex-col h-full" style={{ background: '#F8FAFC' }}>

      {/* ── Visual area ───────────────────────────────────────── */}
      <div className="flex-1 flex flex-col justify-center px-7 py-6">
        <div className="relative">
          {/* Connecting line */}
          <div
            className="absolute left-[19px] top-5 bottom-5 w-px"
            style={{ background: 'linear-gradient(to bottom, #CBD5E1, #CBD5E1)' }}
          />

          <div className="space-y-0">
            {STEPS.map((step, i) => (
              <div
                key={i}
                className="flex items-start gap-4 relative"
                style={{
                  paddingBottom: i < STEPS.length - 1 ? 24 : 0,
                  opacity: visible[i] ? 1 : 0,
                  transform: visible[i] ? 'translateX(0)' : 'translateX(-10px)',
                  transition: 'opacity 350ms ease, transform 350ms ease',
                }}
              >
                {/* Icon circle — sits on top of the line */}
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 relative z-10"
                  style={{ background: step.bg, border: `1.5px solid ${step.color}20` }}
                >
                  {step.icon}
                </div>

                {/* Text */}
                <div className="pt-2">
                  <p className="text-[15px] font-semibold" style={{ color: '#0F172A' }}>
                    {step.label}
                  </p>
                  <p className="text-[13px] mt-0.5" style={{ color: '#94A3B8' }}>
                    {step.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Copy area ─────────────────────────────────────────── */}
      <div className="bg-white px-7 pt-7 pb-6" style={{ borderTop: '1px solid #F1F5F9' }}>
        <h1 className="text-[32px] font-bold leading-tight tracking-tight" style={{ color: '#0F172A' }}>
          Everything stays<br />connected.
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed" style={{ color: '#64748B' }}>
          Every call, text, voicemail, and follow-up tied to the customer automatically.
        </p>
        <button
          onClick={onNext}
          className="mt-6 w-full rounded-2xl py-4 text-[15px] font-semibold text-white transition-all active:scale-[0.98]"
          style={{ background: '#2563EB' }}
        >
          Continue
        </button>
      </div>

    </div>
  );
}
