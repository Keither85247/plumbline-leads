import { useState } from 'react';

function formatPhone(num) {
  if (!num) return 'Unknown';
  const d = num.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return num;
}

const OUTCOMES = [
  {
    id: 'answered',
    label: 'They answered',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
      </svg>
    ),
    activeClass: 'bg-blue-600 text-white border-blue-600',
    inactiveClass: 'bg-white text-gray-600 border-gray-200',
    notePlaceholder: 'Notes from the conversation…',
  },
  {
    id: 'voicemail',
    label: 'Left a voicemail',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
      </svg>
    ),
    activeClass: 'bg-amber-500 text-white border-amber-500',
    inactiveClass: 'bg-white text-gray-600 border-gray-200',
    notePlaceholder: 'What did you say in your voicemail? (optional)',
  },
  {
    id: 'no-answer',
    label: 'No answer',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
    activeClass: 'bg-gray-500 text-white border-gray-500',
    inactiveClass: 'bg-white text-gray-600 border-gray-200',
    notePlaceholder: 'Any notes? (optional)',
  },
];

// Post-call modal — shown only after outbound calls end.
// Contractor selects an outcome + optionally adds a note.
// Inbound calls are handled by the backend recording/transcription pipeline.
export default function OutboundNoteModal({ phone, onSave, onClose }) {
  const [outcome, setOutcome] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedOutcome = OUTCOMES.find(o => o.id === outcome);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(note.trim() || null, outcome);
    } catch (err) {
      console.error('[OutboundNoteModal] Save failed:', err.message);
    } finally {
      setSaving(false);
      onClose();
    }
  };

  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSave();
  };

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      {/* Sheet */}
      <div
        className="w-full max-w-sm bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl px-5 pt-5"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-0.5">
              Call ended
            </p>
            <p className="text-base font-semibold text-gray-900">{formatPhone(phone)}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 -mr-1 text-gray-400 hover:text-gray-600 rounded-lg transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Outcome selector */}
        <p className="text-sm font-medium text-gray-700 mb-2">How did it go?</p>
        <div className="flex gap-2 mb-4">
          {OUTCOMES.map(o => (
            <button
              key={o.id}
              onClick={() => setOutcome(o.id)}
              className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 px-1 rounded-xl border text-xs font-medium transition-all
                ${outcome === o.id ? o.activeClass : o.inactiveClass}`}
            >
              {o.icon}
              <span className="leading-tight text-center">{o.label}</span>
            </button>
          ))}
        </div>

        {/* Note input — shown once an outcome is selected */}
        {outcome && (
          <>
            <textarea
              autoFocus
              value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={selectedOutcome?.notePlaceholder}
              rows={3}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none leading-relaxed"
            />
            <p className="text-[11px] text-gray-400 mt-1.5 mb-4">
              This will be saved to this contact's timeline.
            </p>
          </>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl text-sm font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 active:bg-gray-300 transition-colors"
          >
            Skip
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !outcome}
            className="flex-1 py-3 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
