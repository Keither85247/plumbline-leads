import { useState, useEffect } from 'react';

const CARDS = [
  {
    color: '#22c55e',
    bg: 'rgba(34,197,94,0.12)',
    badge: { label: 'New Lead', color: '#22c55e', bg: 'rgba(34,197,94,0.15)' },
    icon: (
      <svg width="18" height="18" fill="none" stroke="#22c55e" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z"/>
      </svg>
    ),
    title: 'Chris M. – Fence repair quote',
    sub: 'Incoming call · 2 min ago',
  },
  {
    color: '#3b82f6',
    bg: 'rgba(59,130,246,0.12)',
    badge: null,
    dot: true,
    icon: (
      <svg width="18" height="18" fill="none" stroke="#3b82f6" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M8 10h.01M12 10h.01M16 10h.01M21 16a2 2 0 01-2 2H7l-4 4V6a2 2 0 012-2h14a2 2 0 012 2v10z"/>
      </svg>
    ),
    title: '"When can you come out to look?"',
    sub: 'Maria G. · Text message · now',
  },
  {
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.12)',
    badge: { label: 'Scheduled', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
    icon: (
      <svg width="18" height="18" fill="none" stroke="#f59e0b" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
      </svg>
    ),
    title: 'Sarah K. – Follow up Friday',
    sub: 'Callback set · today',
  },
];

export default function CoreValueSlide({ onNext }) {
  const [visible, setVisible] = useState([false, false, false]);

  useEffect(() => {
    const timers = [120, 320, 520].map((delay, i) =>
      setTimeout(() =>
        setVisible(prev => { const n = [...prev]; n[i] = true; return n; }),
        delay
      )
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="flex flex-col h-full">

      {/* ── Visual area ───────────────────────────────────────── */}
      <div
        className="flex-1 flex flex-col justify-center items-center px-6 py-8 relative overflow-hidden"
        style={{ background: 'linear-gradient(160deg, #0D1117 0%, #0f1f3d 100%)' }}
      >
        {/* Soft glow */}
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: 280, height: 280,
            background: 'radial-gradient(circle, rgba(37,99,235,0.18) 0%, transparent 70%)',
            top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        />

        {/* Cards */}
        <div className="w-full max-w-xs space-y-3 relative z-10">
          {CARDS.map((card, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-2xl px-4 py-3.5"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.10)',
                backdropFilter: 'blur(12px)',
                opacity: visible[i] ? 1 : 0,
                transform: visible[i] ? 'translateY(0)' : 'translateY(14px)',
                transition: 'opacity 420ms ease, transform 420ms ease',
              }}
            >
              {/* Icon */}
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                style={{ background: card.bg }}
              >
                {card.icon}
              </div>

              {/* Text */}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate" style={{ color: 'rgba(255,255,255,0.92)' }}>
                  {card.title}
                </p>
                <p className="text-xs mt-0.5 truncate" style={{ color: 'rgba(255,255,255,0.45)' }}>
                  {card.sub}
                </p>
              </div>

              {/* Badge or dot */}
              {card.badge && (
                <span
                  className="text-xs font-medium px-2 py-0.5 rounded-full shrink-0"
                  style={{ color: card.badge.color, background: card.badge.bg }}
                >
                  {card.badge.label}
                </span>
              )}
              {card.dot && (
                <div className="w-2.5 h-2.5 rounded-full bg-blue-500 shrink-0" />
              )}
            </div>
          ))}
        </div>

        {/* Bottom fade */}
        <div
          className="absolute bottom-0 left-0 right-0 pointer-events-none"
          style={{ height: 40, background: 'linear-gradient(to bottom, transparent, rgba(13,17,23,0.6))' }}
        />
      </div>

      {/* ── Copy area ─────────────────────────────────────────── */}
      <div className="bg-white px-7 pt-7 pb-6">
        <h1 className="text-[32px] font-bold leading-tight tracking-tight" style={{ color: '#0F172A' }}>
          Never lose a<br />lead again.
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed" style={{ color: '#64748B' }}>
          Calls, texts, emails, and customer history — all in one place.
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
