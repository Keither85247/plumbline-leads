import { normalizePhone } from '../utils/phone';

const STATUS_COLORS = {
  New: 'bg-blue-100 text-blue-800',
  Contacted: 'bg-yellow-100 text-yellow-800',
  Qualified: 'bg-green-100 text-green-800',
  Closed: 'bg-gray-100 text-gray-600',
};

export default function ContactHistoryModal({ phone, leads, onClose }) {
  if (!phone) return null;

  // Normalize the lookup key so formats like +1631..., 631-..., and 6317... all match
  const normalizedTarget = normalizePhone(phone);

  // All leads that share this phone number (callback or caller ID), normalized before compare
  const history = leads
    .filter(l => {
      const primary = normalizePhone(l.callback_number || l.phone_number);
      const fallback = normalizePhone(l.phone_number);
      return primary === normalizedTarget || fallback === normalizedTarget;
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const contact = history[0] || {};
  const primaryPhone = contact.callback_number || contact.phone_number || phone;
  const callerPhone = contact.phone_number;
  const showCallerSeparate = callerPhone && callerPhone !== primaryPhone;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      {/* Panel */}
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {contact.contact_name || 'Unknown'}
              {contact.company_name ? (
                <span className="font-normal text-gray-500"> ({contact.company_name})</span>
              ) : null}
            </h2>
            <a
              href={`tel:${primaryPhone}`}
              className="text-sm text-blue-600 hover:underline"
            >
              {primaryPhone}
            </a>
            {showCallerSeparate && (
              <p className="text-xs text-gray-400 mt-0.5">Called from: {callerPhone}</p>
            )}
            <p className="text-xs text-gray-400 mt-1">
              {history.length} {history.length === 1 ? 'interaction' : 'interactions'} on record
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors ml-4 shrink-0"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* History list */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
          {history.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No history found.</p>
          ) : (
            history.map(lead => (
              <div key={lead.id} className="border border-gray-100 rounded-lg p-4 bg-gray-50">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-400">
                      {new Date(lead.created_at).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric'
                      })}
                    </span>
                    <span className="text-xs text-gray-300">·</span>
                    <span className="text-xs text-gray-400 bg-gray-200 rounded px-1.5 py-0.5">
                      {lead.category || 'Lead'}
                    </span>
                  </div>
                  <span className={`text-xs font-medium rounded-full px-2.5 py-0.5 shrink-0 ${STATUS_COLORS[lead.status] || STATUS_COLORS['New']}`}>
                    {lead.status}
                  </span>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed">{lead.summary}</p>
                {lead.key_points && lead.key_points.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {(Array.isArray(lead.key_points) ? lead.key_points : JSON.parse(lead.key_points || '[]')).map((point, i) => (
                      <li key={i} className="text-xs text-gray-500 flex gap-1.5">
                        <span className="text-blue-400 font-bold shrink-0">•</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
