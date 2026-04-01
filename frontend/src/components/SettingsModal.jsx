import { translations } from '../i18n';

export default function SettingsModal({
  onClose,
  contractorName, onContractorNameChange,
  businessName, onBusinessNameChange,
  language, onLanguageChange,
  replyTranslation, onReplyTranslationChange,
}) {
  const t = translations[language] || translations.en;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">{t.settings}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-5 space-y-5">

          {/* Your Name */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              {t.yourName}
            </label>
            <input
              type="text"
              value={contractorName}
              onChange={onContractorNameChange}
              placeholder={t.yourNamePlaceholder}
              className="w-full text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-400 mt-1">{t.yourNameHint}</p>
          </div>

          {/* Business Name */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              {t.businessName}
            </label>
            <input
              type="text"
              value={businessName}
              onChange={onBusinessNameChange}
              placeholder={t.businessNamePlaceholder}
              className="w-full text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Reply Translation toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {t.enableReplyTranslation}
              </p>
            </div>
            <button
              onClick={() => onReplyTranslationChange(!replyTranslation)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none ${
                replyTranslation ? 'bg-blue-600' : 'bg-gray-200'
              }`}
              role="switch"
              aria-checked={replyTranslation}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  replyTranslation ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Language */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              {t.language}
            </label>
            <div className="flex rounded-lg overflow-hidden border border-gray-200">
              <button
                onClick={() => onLanguageChange('en')}
                className={`flex-1 text-sm py-2.5 font-medium transition-colors ${
                  language === 'en'
                    ? 'bg-gray-900 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                English
              </button>
              <button
                onClick={() => onLanguageChange('es')}
                className={`flex-1 text-sm py-2.5 font-medium border-l border-gray-200 transition-colors ${
                  language === 'es'
                    ? 'bg-gray-900 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                Español
              </button>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 pb-5">
          <button
            onClick={onClose}
            className="w-full bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold rounded-lg py-2.5 transition-colors"
          >
            {t.done}
          </button>
        </div>
      </div>
    </div>
  );
}
