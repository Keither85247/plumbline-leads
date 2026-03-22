import { useState, useEffect } from 'react';
import { getCalls } from '../api';

const KEYPAD = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
];

const TABS = ['Dialer', 'Recent', 'Voicemail'];

const CLASSIFICATION_STYLES = {
  'Likely Lead':        'bg-blue-50 text-blue-700',
  'Existing Customer':  'bg-green-50 text-green-700',
  'Vendor':             'bg-purple-50 text-purple-700',
  'Likely Spam':        'bg-red-50 text-red-600',
  'Unknown':            'bg-gray-100 text-gray-500',
};

function formatPhone(num) {
  if (!num) return 'Unknown';
  const d = num.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') {
    return `+1 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  }
  return num;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function CallsPage() {
  const [dialInput, setDialInput] = useState('');
  const [activeTab, setActiveTab] = useState('Dialer');
  const [calls, setCalls] = useState([]);
  const [loadingCalls, setLoadingCalls] = useState(false);

  useEffect(() => {
    if (activeTab === 'Recent' || activeTab === 'Voicemail') {
      setLoadingCalls(true);
      getCalls()
        .then(data => setCalls(data))
        .catch(err => console.error('Failed to load calls:', err))
        .finally(() => setLoadingCalls(false));
    }
  }, [activeTab]);

  const handleKeypad = (val) => setDialInput(prev => prev + val);
  const handleBackspace = () => setDialInput(prev => prev.slice(0, -1));
  const handleCall = () => {
    if (!dialInput.trim()) return;
    alert(`Calling ${dialInput}… (telephony integration coming soon)`);
  };
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleCall();
  };

  return (
    <div className="w-full max-w-xs mx-auto pt-2">

      {/* Page title */}
      <h1 className="text-xl font-bold text-gray-900 mb-4">Calls</h1>

      {/* Top tabs */}
      <div className="flex border-b border-gray-200 mb-6">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 pb-2.5 text-sm font-medium transition-colors
              ${activeTab === tab
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-400 hover:text-gray-600 border-b-2 border-transparent'
              }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Dialer tab */}
      {activeTab === 'Dialer' && (
        <div className="flex flex-col items-center">
          {/* Number display */}
          <div className="relative w-full flex items-center justify-center mb-6 min-h-[52px]">
            <span className={`text-4xl font-light tracking-widest text-gray-900 ${!dialInput ? 'opacity-30' : ''}`}>
              {dialInput || '—'}
            </span>
            {dialInput && (
              <button
                onClick={handleBackspace}
                className="absolute right-0 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-gray-700 transition-colors"
                aria-label="Backspace"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M22 5H9L2 12l7 7h13V5z" />
                  <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </button>
            )}
          </div>
          <input
            type="tel"
            value={dialInput}
            onChange={e => setDialInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="sr-only"
            aria-label="Phone number"
          />
          {/* Keypad */}
          <div className="grid grid-cols-3 gap-3 w-full mb-8">
            {KEYPAD.map(({ digit, sub }) => (
              <button
                key={digit}
                onClick={() => handleKeypad(digit)}
                className="flex flex-col items-center justify-center rounded-full
                           w-[68px] h-[68px] mx-auto
                           bg-gray-100 hover:bg-gray-200 active:bg-gray-300
                           transition-colors duration-100 select-none"
              >
                <span className="text-xl font-medium text-gray-900 leading-tight">{digit}</span>
                {sub && (
                  <span className="text-[9px] font-semibold tracking-widest text-gray-400 leading-none mt-0.5">
                    {sub}
                  </span>
                )}
              </button>
            ))}
          </div>
          {/* Call button */}
          <button
            onClick={handleCall}
            disabled={!dialInput.trim()}
            className="w-[68px] h-[68px] rounded-full flex items-center justify-center
                       bg-blue-600 hover:bg-blue-700 active:bg-blue-800
                       disabled:bg-gray-200 disabled:cursor-not-allowed
                       transition-colors duration-150"
            aria-label="Call"
          >
            <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
            </svg>
          </button>
        </div>
      )}

      {/* Recent tab */}
      {activeTab === 'Recent' && (
        <div>
          {loadingCalls ? (
            <p className="text-sm text-gray-400 text-center py-12 animate-pulse">Loading…</p>
          ) : calls.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">No recent calls yet.</p>
          ) : (
            <ul className="space-y-2">
              {calls.map(call => (
                <li key={call.id} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {formatPhone(call.from_number)}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">{timeAgo(call.created_at)}</p>
                  </div>
                  <span className={`ml-3 shrink-0 text-xs font-medium rounded-full px-2.5 py-1
                    ${CLASSIFICATION_STYLES[call.classification] || CLASSIFICATION_STYLES['Unknown']}`}>
                    {call.classification}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Voicemail tab */}
      {activeTab === 'Voicemail' && (
        <p className="text-sm text-gray-400 text-center py-12">No voicemails yet.</p>
      )}

    </div>
  );
}
