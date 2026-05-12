import { useState, useRef } from 'react';
import CoreValueSlide from './slides/CoreValueSlide';
import HowItWorksSlide from './slides/HowItWorksSlide';

// Two intro slides shown before login — marketing/orientation only.
// The paywall/access gate (PaywallGate) runs AFTER login as a separate screen.
const TOTAL_STEPS = 2;

export default function FirstRunOnboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const [transitioning, setTransitioning] = useState(false);

  // Touch-swipe detection
  const touchStartX = useRef(null);

  const goNext = () => {
    if (transitioning || step >= TOTAL_STEPS - 1) return;
    setTransitioning(true);
    setTimeout(() => {
      setStep(s => s + 1);
      setTransitioning(false);
    }, 200);
  };

  const finish = () => {
    localStorage.setItem('plOnboardingSeen', '1');
    onComplete();
  };

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e) => {
    if (touchStartX.current === null) return;
    const delta = touchStartX.current - e.changedTouches[0].clientX;
    touchStartX.current = null;
    if (delta > 60 && step < TOTAL_STEPS - 1) goNext();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-white overflow-hidden"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Slide area */}
      <div
        className="h-full flex flex-col"
        style={{
          opacity: transitioning ? 0 : 1,
          transform: transitioning ? 'translateY(6px)' : 'translateY(0)',
          transition: 'opacity 200ms ease, transform 200ms ease',
        }}
      >
        {step === 0 && <CoreValueSlide onNext={goNext} />}
        {step === 1 && <HowItWorksSlide onNext={finish} />}
      </div>

      {/* Progress dots */}
      <div
        className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-2 pb-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      >
        {[0, 1].map(i => (
          <div
            key={i}
            style={{
              width:        i === step ? 24 : 8,
              height:       8,
              borderRadius: 4,
              background:   i === step ? '#2563EB' : '#CBD5E1',
              transition:   'width 250ms ease, background 250ms ease',
            }}
          />
        ))}
      </div>
    </div>
  );
}
