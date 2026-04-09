import { useState, useEffect, useRef } from 'react';
import { getCalls, getVoicemailLeads, markCallsSeen, API_BASE } from '../api';
import { parseTimestamp } from '../utils/phone';
import PhoneActionSheet from './PhoneActionSheet';

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

// Mirrors the same logic in TimelinePage — outcome-aware label for any call row.
function getCallMeta(call) {
  const isOutbound = call.classification === 'Outbound';
  if (isOutbound) {
    switch (call.outcome) {
      case 'answered':  return { text: 'Answered',           labelClass: 'text-blue-600 font-medium',  isExpandable: !!(call.contractor_note) };
      case 'voicemail': return { text: 'You Left a Message', labelClass: 'text-amber-600 font-medium', isExpandable: !!(call.contractor_note) };
      case 'no-answer': return { text: 'No Answer',          labelClass: 'text-gray-400',              isExpandable: false };
      default:          return { text: 'Outbound',           labelClass: 'text-gray-400',              isExpandable: !!(call.contractor_note) };
    }
  }
  // transcript OR duration > 0 means the call was answered
  const answered = !!(call.transcript || call.duration > 0);
  return {
    text: answered ? 'Answered' : 'Missed',
    labelClass: answered ? 'text-green-600 font-medium' : 'text-red-400 font-medium',
    isExpandable: answered,
  };
}

function timeAgo(dateStr) {
  const diff = Date.now() - parseTimestamp(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
}

export default function CallsPage({ onContactClick, voiceDevice = {}, onCallsSeen }) {
  const [dialInput, setDialInput] = useState('');
  const [activeTab, setActiveTab] = useState('Dialer');
  const [calls, setCalls] = useState([]);
  const [voicemails, setVoicemails] = useState([]);
  const [loadingCalls, setLoadingCalls] = useState(false);
  const [expandedCallId, setExpandedCallId] = useState(null);
  const [actionSheetPhone, setActionSheetPhone] = useState(null);

  // Guard: fires markCallsSeen at most once per CallsPage mount.
  // Resets automatically when the component unmounts (user navigates away).
  const hasMarkedSeenRef = useRef(false);

  const {
    status: deviceStatus = 'idle',
    error: deviceError = null,
    remoteIdentity,
    makeCall,
    hangUp,
    isReady,
  } = voiceDevice;

  // Derived dialer state from SDK
  const isDialing = deviceStatus === 'dialing';
  const isRinging = deviceStatus === 'ringing';
  const isConnected = deviceStatus === 'connected';
  const isEnded = deviceStatus === 'ended';
  const isFailed = deviceStatus === 'failed';
  const isBusy = isDialing || isRinging || isConnected || isEnded;

  useEffect(() => {
    if (activeTab === 'Recent') {
      setLoadingCalls(true);
      getCalls()
        .then(data => setCalls(data))
        .catch(err => console.error('Failed to load calls:', err))
        .finally(() => setLoadingCalls(false));
    }
    if (activeTab === 'Voicemail') {
      setLoadingCalls(true);
      getVoicemailLeads()
        .then(data => setVoicemails(data))
        .catch(err => console.error('Failed to load voicemails:', err))
        .finally(() => setLoadingCalls(false));
    }
  }, [activeTab]);

  // Mark calls as seen once the Recent list has actually rendered.
  // Fires at most once per CallsPage mount (hasMarkedSeenRef resets on unmount).
  // Does NOT fire on: nav click to Calls tab, Dialer inner tab, Voicemail inner tab.
  // After marking, triggers an immediate getCounts refresh in App so the badge
  // clears right away instead of waiting up to 30 seconds for the next poll.
  useEffect(() => {
    console.log('[CallsPage] mark-seen effect: activeTab=', activeTab, 'calls.length=', calls.length, 'hasMarked=', hasMarkedSeenRef.current);
    if (activeTab !== 'Recent' || calls.length === 0 || hasMarkedSeenRef.current) return;
    hasMarkedSeenRef.current = true;
    console.log('[CallsPage] → firing markCallsSeen');
    markCallsSeen()
      .then(() => { console.log('[CallsPage] markCallsSeen resolved → calling onCallsSeen'); onCallsSeen?.(); })
      .catch(err => console.error('Failed to mark calls seen:', err));
  }, [activeTab, calls, onCallsSeen]);

  const handleKeypad = (val) => setDialInput(prev => prev + val);
  const handleBackspace = () => setDialInput(prev => prev.slice(0, -1));

  const handleCall = () => {
    if (!dialInput.trim() || isBusy || !makeCall) return;
    makeCall(dialInput.trim());
  };

  // Called from Recent row or PhoneActionSheet — populates dialer, switches tab, then calls
  const handleCallFromRecent = (phone) => {
    if (!phone) return;
    setDialInput(phone);
    setActiveTab('Dialer');
    if (makeCall && !isBusy) makeCall(phone);
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
          {/* Number display / call status */}
          <div className="relative w-full flex flex-col items-center justify-center mb-6 min-h-[52px]">
            {isConnected ? (
              <div className="flex flex-col items-center gap-1">
                <span className="text-base font-semibold text-green-600">Connected</span>
                <span className="text-sm text-gray-500">{remoteIdentity || dialInput}</span>
              </div>
            ) : isRinging ? (
              <div className="flex flex-col items-center gap-1">
                <span className="text-base font-medium text-blue-500 animate-pulse">Ringing…</span>
                <span className="text-sm text-gray-400">{remoteIdentity || dialInput}</span>
              </div>
            ) : isDialing ? (
              <span className="text-base font-medium text-blue-500 animate-pulse">Calling…</span>
            ) : isEnded ? (
              <span className="text-base font-medium text-gray-400">Call ended</span>
            ) : isFailed ? (
              <span className="text-sm font-medium text-red-500 text-center px-4">{deviceError || 'Call failed'}</span>
            ) : deviceStatus === 'registering' ? (
              <span className="text-sm text-gray-400 animate-pulse">Connecting to voice…</span>
            ) : (
              <span className={`text-4xl font-light tracking-widest text-gray-900 ${!dialInput ? 'opacity-30' : ''}`}>
                {dialInput || '—'}
              </span>
            )}
            {dialInput && !isBusy && (
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
          {/* Call / Hang up button */}
          {isConnected || isRinging || isDialing ? (
            <button
              onClick={hangUp}
              className="w-[68px] h-[68px] rounded-full flex items-center justify-center bg-red-500 hover:bg-red-600 active:bg-red-700 transition-colors duration-150"
              aria-label="Hang up"
            >
              <svg className="w-7 h-7 text-white rotate-135" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleCall}
              disabled={!dialInput.trim() || isBusy}
              className={`w-[68px] h-[68px] rounded-full flex items-center justify-center
                         transition-colors duration-150
                         ${isFailed ? 'bg-red-500' : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800'}
                         disabled:opacity-60 disabled:cursor-not-allowed`}
              aria-label="Call"
            >
              <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
              </svg>
            </button>
          )}
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
            <ul>
              {calls.map(call => {
                const isOutbound = call.classification === 'Outbound';
                const meta = getCallMeta(call);
                const isExpanded = expandedCallId === call.id;
                const duration = formatDuration(call.duration);
                const keyPoints = Array.isArray(call.key_points) ? call.key_points : [];
                const displayName = call.contact_name || formatPhone(call.from_number);
                const showPhone = !!call.contact_name;

                return (
                  <li key={call.id} className="border-b border-gray-100 last:border-0">
                    {/* Row — 3-column: [name+meta] [label/badge] [chevron] */}
                    <div
                      className={`flex items-center py-2 gap-2 ${meta.isExpandable ? 'cursor-pointer' : ''}`}
                      onClick={() => meta.isExpandable && setExpandedCallId(isExpanded ? null : call.id)}
                    >
                      {/* Col 1: name / number + time */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          {/* Outbound arrow indicator */}
                          {isOutbound && (
                            <svg className="w-3 h-3 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7M17 7H7M17 7v10" />
                            </svg>
                          )}
                          <button
                            onClick={e => { e.stopPropagation(); handleCallFromRecent(call.from_number); }}
                            className="block text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2 transition-colors text-left leading-tight truncate"
                          >
                            {displayName}
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {showPhone && (
                            <span className="text-xs text-gray-400 truncate">{formatPhone(call.from_number)}</span>
                          )}
                          {showPhone && <span className="text-xs text-gray-300">·</span>}
                          <span className="text-xs text-gray-400 shrink-0">{timeAgo(call.created_at)}</span>
                          {duration && <span className="text-xs text-gray-300 shrink-0">· {duration}</span>}
                        </div>
                      </div>

                      {/* Col 2: outcome label for all calls (answered/missed/no-answer/etc.) */}
                      <div className="shrink-0 w-[120px] flex justify-end">
                        <span className={`text-xs whitespace-nowrap ${meta.labelClass}`}>
                          {meta.text}
                        </span>
                      </div>

                      {/* Col 3: chevron */}
                      <div className="shrink-0 w-4">
                        {meta.isExpandable && (
                          <svg
                            className={`w-4 h-4 text-gray-300 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                            fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        )}
                      </div>
                    </div>

                    {/* Expanded detail */}
                    {meta.isExpandable && isExpanded && (
                      <div className="pb-3 space-y-2">
                        {/* Inbound: AI summary + key points */}
                        {!isOutbound && call.summary && (
                          <div className="bg-blue-50 rounded-lg p-3">
                            <p className="text-sm font-bold text-gray-800 mb-1.5">Call Summary</p>
                            <p className="text-sm text-gray-700 leading-relaxed">{call.summary}</p>
                          </div>
                        )}
                        {!isOutbound && keyPoints.length > 0 && (
                          <div className="bg-blue-50 rounded-lg p-3">
                            <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide mb-1.5">Call Notes</p>
                            <ul className="space-y-1">
                              {keyPoints.map((pt, i) => (
                                <li key={i} className="text-xs text-gray-600 flex gap-1.5">
                                  <span className="text-blue-400 font-bold shrink-0">•</span>
                                  <span>{pt}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {/* Outbound: contractor note */}
                        {isOutbound && call.contractor_note && (
                          <div className="bg-amber-50 rounded-lg p-3">
                            <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1.5">Your Note</p>
                            <p className="text-sm text-gray-700 leading-relaxed">{call.contractor_note}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Voicemail tab */}
      {activeTab === 'Voicemail' && (
        <div>
          {loadingCalls ? (
            <p className="text-sm text-gray-400 text-center py-12 animate-pulse">Loading…</p>
          ) : voicemails.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-12">No voicemails yet.</p>
          ) : (
            <ul className="space-y-3">
              {voicemails.map(vm => {
                const keyPoints = Array.isArray(vm.key_points) ? vm.key_points : [];
                return (
                  <li key={vm.id} className="border border-gray-100 rounded-lg p-4 bg-gray-50">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-400">
                          {new Date(vm.created_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric'
                          })}
                        </span>
                        <span className="text-xs font-medium text-gray-500 bg-gray-200 rounded-full px-2 py-0.5">
                          Voicemail
                        </span>
                      </div>
                      <span className="text-xs text-gray-500 font-medium truncate shrink-0">
                        {formatPhone(vm.callback_number || vm.phone_number)}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-gray-800 mb-1">
                      {vm.contact_name !== 'Unknown' ? vm.contact_name : formatPhone(vm.phone_number)}
                    </p>
                    {vm.summary && (
                      <p className="text-sm text-gray-600 leading-relaxed">{vm.summary}</p>
                    )}
                    {keyPoints.length > 0 && (
                      <ul className="mt-2 space-y-0.5">
                        {keyPoints.map((pt, i) => (
                          <li key={i} className="text-xs text-gray-500 flex gap-1.5">
                            <span className="text-gray-400 font-bold shrink-0">•</span>
                            <span>{pt}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {vm.recording_url && (
                      <div className="mt-3 pt-3 border-t border-gray-200">
                        <audio
                          controls
                          preload="metadata"
                          src={`${API_BASE}/leads/${vm.id}/voicemail`}
                          className="w-full h-9"
                          style={{ colorScheme: 'light' }}
                        >
                          Your browser does not support audio playback.
                        </audio>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {actionSheetPhone && (
        <PhoneActionSheet
          phone={actionSheetPhone}
          onViewHistory={onContactClick ? () => onContactClick(actionSheetPhone) : null}
          onCall={handleCallFromRecent}
          onClose={() => setActionSheetPhone(null)}
        />
      )}

    </div>
  );
}
