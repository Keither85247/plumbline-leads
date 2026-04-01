import { translations } from '../i18n';

export default function OnboardingModal({ onDismiss, language }) {
  const t = translations[language] || translations.en;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-8 flex flex-col items-center text-center">

        {/* Icon */}
        <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mb-5">
          <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
          </svg>
        </div>

        {/* Title */}
        <h1 className="text-xl font-bold text-gray-900 mb-2 leading-snug">
          {t.onboardingTitle}
        </h1>

        {/* Subtitle */}
        <p className="text-sm text-gray-500 leading-relaxed mb-6">
          {t.onboardingSubtitle}
        </p>

        {/* Bullet points */}
        <ul className="w-full text-left space-y-3 mb-8">
          {t.onboardingBullets.map((point) => (
            <li key={point} className="flex items-start gap-3">
              <span className="mt-0.5 w-5 h-5 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                <svg className="w-3 h-3 text-blue-600" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <span className="text-sm text-gray-700">{point}</span>
            </li>
          ))}
        </ul>

        {/* CTA */}
        <button
          onClick={onDismiss}
          className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold rounded-xl py-3 transition-colors"
        >
          {t.getStarted}
        </button>

      </div>
    </div>
  );
}
