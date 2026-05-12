/**
 * PaywallGate — post-login access gate.
 *
 * Shown after successful authentication whenever the user's access_status
 * does not grant them app access (i.e. not owner / tester / active / trial).
 *
 * Architecture:
 *  - Primary CTA  → "Start Free Trial" — disabled until payments are wired
 *  - Tester bypass → "I'm a Tester"   — visible only when TESTER_BYPASS_ENABLED
 *
 * To remove the tester bypass later:
 *  1. Set VITE_ENABLE_TESTER_BYPASS=false (or delete the Vercel env var)
 *  2. Set ENABLE_TESTER_BYPASS=false on the Render backend
 *  The button vanishes from the UI; the endpoint returns 403 if called anyway.
 *
 * To enable real payments later:
 *  1. Wire the primary CTA to your Stripe Checkout or payment modal
 *  2. On success, the backend sets access_status='active'
 *  3. Call onBypass({ ...user, access_status: 'active' }) to advance the gate
 */

import { useState, useEffect } from 'react';
import { activateTesterBypass } from '../api';
import { translations } from '../i18n';

// Baked in at Vercel build time. Set VITE_ENABLE_TESTER_BYPASS=true in Vercel env.
const TESTER_BYPASS_ENABLED = import.meta.env.VITE_ENABLE_TESTER_BYPASS === 'true';

function Check() {
  return (
    <svg width="13" height="13" fill="none" stroke="#2563EB" strokeWidth="2.5" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

export default function PaywallGate({ user, onBypass }) {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;

  const FEATURES = [
    t.pricingFeat1,
    t.pricingFeat2,
    t.pricingFeat3,
    t.pricingFeat4,
    t.pricingFeat5,
    t.pricingFeat6,
    t.pricingFeat7,
  ];

  const [visible,     setVisible]     = useState(false);
  const [activating,  setActivating]  = useState(false);
  const [testerError, setTesterError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 60);
    return () => clearTimeout(timer);
  }, []);

  const handleTesterBypass = async () => {
    setActivating(true);
    setTesterError('');
    try {
      const result = await activateTesterBypass();
      // Persist legacy flag so existing users who switch devices still pass the
      // localStorage fallback check until they next authenticate.
      localStorage.setItem('plIsTester', '1');
      // Bubble updated user up so App.jsx can re-evaluate paywallCleared()
      onBypass({ ...user, access_status: result.access_status || 'tester' });
    } catch (err) {
      setTesterError(err.message || 'Something went wrong. Please try again.');
      setActivating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-white overflow-y-auto flex flex-col"
         style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>

      {/* ── Price + feature list ────────────────────────────────────────────── */}
      <div
        className="flex-1 flex flex-col items-center justify-center px-7 py-8"
        style={{
          opacity:   visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(10px)',
          transition: 'opacity 350ms ease, transform 350ms ease',
        }}
      >
        {/* Label */}
        <p className="text-xs font-semibold tracking-widest uppercase mb-4" style={{ color: '#94A3B8' }}>
          {t.paywallLabel}
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
          {t.onboardEverythingIncl}
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

      {/* ── CTA area ────────────────────────────────────────────────────────── */}
      <div className="px-7 pb-7 pt-4 bg-white shrink-0" style={{ borderTop: '1px solid #F1F5F9' }}>

        {/* Headline */}
        <p
          className="text-[22px] font-bold leading-snug tracking-tight mb-1"
          style={{ color: '#0F172A' }}
        >
          {t.paywallHeadline}
        </p>
        <p className="text-[13px] mb-5 leading-relaxed" style={{ color: '#94A3B8' }}>
          {t.paywallSub}
        </p>

        {/* ── PRIMARY CTA — disabled until payments are wired ── */}
        {/* TO ENABLE: remove disabled / opacity styling and wire onClick to payment flow */}
        <div className="relative mb-3">
          <button
            disabled
            className="w-full rounded-2xl py-4 text-[15px] font-semibold text-white transition-all"
            style={{ background: '#93C5FD', cursor: 'not-allowed' }}
            title={t.paywallCtaHint}
          >
            {t.paywallCta}
          </button>
          {/* "Coming soon" badge */}
          <span
            className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full"
            style={{ background: 'rgba(255,255,255,0.25)', color: 'white' }}
          >
            {t.paywallCtaSoon}
          </span>
        </div>

        <p className="text-center text-[11px] mb-4 leading-relaxed px-2" style={{ color: '#CBD5E1' }}>
          {t.paywallCtaHint}
        </p>

        {/* ── TESTER BYPASS — temporary, isolated block ── */}
        {/* Remove this entire block (and the TESTER_BYPASS_ENABLED constant) when payments launch */}
        {TESTER_BYPASS_ENABLED && (
          <div className="border-t border-gray-100 pt-4 mt-2">
            {testerError && (
              <p className="text-center text-[12px] text-red-500 mb-2">{testerError}</p>
            )}
            <button
              onClick={handleTesterBypass}
              disabled={activating}
              className="w-full py-2.5 text-[14px] font-medium transition-colors active:opacity-60 disabled:opacity-40"
              style={{ color: '#94A3B8' }}
            >
              {activating ? t.paywallActivating : t.paywallTesterBtn}
            </button>
            <p className="text-center text-[11px] mt-1.5 leading-relaxed px-4" style={{ color: '#CBD5E1' }}>
              {t.paywallTesterNote}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
