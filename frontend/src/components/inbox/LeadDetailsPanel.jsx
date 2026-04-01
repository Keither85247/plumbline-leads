import { useState } from 'react';

function formatPhone(num) {
  if (!num) return '';
  const d = num.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return num;
}

const STATUS_STYLES = {
  New:        'bg-amber-50  text-amber-700',
  Contacted:  'bg-blue-50   text-blue-700',
  Qualified:  'bg-green-50  text-green-700',
  Closed:     'bg-gray-100  text-gray-500',
};

const CATEGORY_STYLES = {
  'Likely Lead':        'bg-blue-50   text-blue-700',
  'Existing Customer':  'bg-green-50  text-green-700',
  'Vendor':             'bg-purple-50 text-purple-700',
  'Likely Spam':        'bg-red-50    text-red-600',
};

function Field({ label, children }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-0.5">{label}</p>
      <div className="text-sm text-gray-800">{children}</div>
    </div>
  );
}

export default function LeadDetailsPanel({ conversation }) {
  const { name, phone, company, status, category, notes } = conversation;
  const [noteValue, setNoteValue] = useState(notes || '');
  const [saved, setSaved] = useState(false);

  const handleNoteChange = (e) => {
    setNoteValue(e.target.value);
    setSaved(false);
  };

  const handleSaveNote = () => {
    // TODO: persist via API
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* Panel header */}
      <div className="shrink-0 h-14 border-b border-gray-100 flex items-center px-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Contact</h3>
      </div>

      <div className="flex-1 px-4 py-4 space-y-5">

        {/* Identity */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
            <span className="text-sm font-semibold text-blue-700">
              {name?.charAt(0).toUpperCase() || '?'}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 leading-tight">{name || 'Unknown'}</p>
            {company && <p className="text-xs text-gray-400 mt-0.5 truncate">{company}</p>}
            <p className="text-xs text-gray-400 mt-0.5">{formatPhone(phone)}</p>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-gray-100" />

        {/* Status + category badges */}
        <div className="flex flex-wrap gap-1.5">
          {status && (
            <span className={`text-[11px] font-medium rounded-full px-2.5 py-0.5 ${STATUS_STYLES[status] || 'bg-gray-100 text-gray-500'}`}>
              {status}
            </span>
          )}
          {category && (
            <span className={`text-[11px] font-medium rounded-full px-2.5 py-0.5 ${CATEGORY_STYLES[category] || 'bg-gray-100 text-gray-500'}`}>
              {category}
            </span>
          )}
        </div>

        {/* Fields */}
        {phone && (
          <Field label="Phone">
            <a
              href={`tel:${phone}`}
              className="text-blue-600 hover:underline"
            >
              {formatPhone(phone)}
            </a>
          </Field>
        )}
        {company && <Field label="Company">{company}</Field>}

        {/* Divider */}
        <div className="h-px bg-gray-100" />

        {/* Notes */}
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Notes</p>
          <textarea
            value={noteValue}
            onChange={handleNoteChange}
            placeholder="Add a note about this contact…"
            rows={4}
            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 resize-none leading-relaxed transition-colors"
          />
          <div className="flex justify-end mt-1.5">
            <button
              onClick={handleSaveNote}
              disabled={!noteValue.trim()}
              className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
                saved
                  ? 'bg-green-50 text-green-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed'
              }`}
            >
              {saved ? '✓ Saved' : 'Save note'}
            </button>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-gray-100" />

        {/* Quick actions */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Actions</p>
          <button className="w-full text-left text-xs text-gray-600 px-3 py-2.5 rounded-lg hover:bg-gray-100 active:bg-gray-200 transition-colors flex items-center gap-2.5">
            <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
            </svg>
            Call contact
          </button>
          <button className="w-full text-left text-xs text-gray-600 px-3 py-2.5 rounded-lg hover:bg-gray-100 active:bg-gray-200 transition-colors flex items-center gap-2.5">
            <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            View lead record
          </button>
          <button className="w-full text-left text-xs text-gray-600 px-3 py-2.5 rounded-lg hover:bg-gray-100 active:bg-gray-200 transition-colors flex items-center gap-2.5">
            <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Mark as read
          </button>
        </div>
      </div>
    </div>
  );
}
