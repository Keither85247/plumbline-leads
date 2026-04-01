function formatPhone(num) {
  if (!num) return num;
  const d = num.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return num;
}

// Thin 1px separator matching iOS dark menu style
function Separator() {
  return <div style={{ height: '0.5px', background: 'rgba(255,255,255,0.12)', marginLeft: '52px' }} />;
}

export default function PhoneActionSheet({ phone, onViewHistory, onCall, onClose }) {
  const display = formatPhone(phone);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
    >
      {/* Dark floating menu — iOS context menu style */}
      <div
        className="w-72 overflow-hidden shadow-2xl"
        style={{ borderRadius: '14px', background: '#2C2C2E' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header — phone number label */}
        <div className="px-5 pt-4 pb-3" style={{ borderBottom: '0.5px solid rgba(255,255,255,0.12)' }}>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 500 }}>
            Contact
          </p>
          <p style={{ fontSize: '15px', color: '#FFFFFF', fontWeight: 600, marginTop: '2px' }}>
            {display || phone}
          </p>
        </div>

        {/* Call — only shown when in-app Voice SDK handler is provided.
            Never uses tel: or any native-dialer link. */}
        {onCall && (
          <button
            onClick={() => { onCall(phone); onClose(); }}
            className="flex items-center w-full active:opacity-60 transition-opacity"
            style={{ padding: '14px 20px', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <span className="flex items-center justify-center shrink-0" style={{ width: '32px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
              </svg>
            </span>
            <span style={{ fontSize: '15px', color: '#FFFFFF', fontWeight: 400, marginLeft: '12px' }}>Call</span>
          </button>
        )}

        {onCall && <Separator />}

        {/* Text */}
        <a
          href={`sms:${phone}`}
          onClick={onClose}
          className="flex items-center w-full active:opacity-60 transition-opacity"
          style={{ padding: '14px 20px', textDecoration: 'none' }}
        >
          <span className="flex items-center justify-center shrink-0" style={{ width: '32px' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </span>
          <span style={{ fontSize: '15px', color: '#FFFFFF', fontWeight: 400, marginLeft: '12px' }}>Text</span>
        </a>

        {/* View History — only when callback provided */}
        {onViewHistory && (
          <>
            <Separator />
            <button
              onClick={() => { onViewHistory(); onClose(); }}
              className="flex items-center w-full active:opacity-60 transition-opacity"
              style={{ padding: '14px 20px', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <span className="flex items-center justify-center shrink-0" style={{ width: '32px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="1.8">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </span>
              <span style={{ fontSize: '15px', color: '#FFFFFF', fontWeight: 400, marginLeft: '12px' }}>View History</span>
            </button>
          </>
        )}

        {/* Full-width separator before cancel */}
        <div style={{ height: '0.5px', background: 'rgba(255,255,255,0.12)' }} />

        {/* Cancel */}
        <button
          onClick={onClose}
          className="flex items-center justify-center w-full active:opacity-60 transition-opacity"
          style={{ padding: '14px 20px', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <span style={{ fontSize: '15px', color: 'rgba(255,255,255,0.45)', fontWeight: 400 }}>Cancel</span>
        </button>
      </div>
    </div>
  );
}
