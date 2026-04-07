import { useState, useEffect, useRef, useCallback } from 'react';
import { Device } from '@twilio/voice-sdk';
import { API_BASE } from '../api';

// Normalize to E.164 for Twilio
function toE164(num) {
  const digits = num.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return num.trim();
}

async function fetchToken() {
  const res = await fetch(`${API_BASE}/twilio/token`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch voice token');
  }
  const { token } = await res.json();
  return token;
}

export function useVoiceDevice() {
  // status: 'idle' | 'registering' | 'ready' | 'incoming' | 'dialing' | 'ringing' | 'connected' | 'ended' | 'failed'
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);     // Call object (inbound, not yet answered)
  const [activeCall, setActiveCall] = useState(null);         // Call object (answered or outbound)
  const [remoteIdentity, setRemoteIdentity] = useState(null); // phone number of the other party

  // Post-call note prompt — set to { phone } when an outbound call ends, null otherwise.
  // App.jsx watches this and renders the OutboundNoteModal.
  const [pendingPostCallNote, setPendingPostCallNote] = useState(null);

  const deviceRef = useRef(null);

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Wire all lifecycle events onto a call object.
  // `phone` is captured at call-setup time so the disconnect handler can
  // reference it without stale-closure issues.
  // `isInbound` distinguishes inbound (recorded/transcribed by backend) from
  // outbound (not recorded) so the post-call note modal only fires for outbound.
  function wireCallEvents(call, { isInbound = false, phone = null } = {}) {
    call.on('ringing', () => setStatus('ringing'));

    call.on('accept', () => {
      setActiveCall(call);
      setStatus('connected');
    });

    call.on('disconnect', () => {
      setActiveCall(null);
      setIncomingCall(null);
      setStatus('ended');

      // Trigger post-call note prompt for outbound calls only.
      // Inbound calls are already recorded + summarised by the backend pipeline.
      if (!isInbound && phone) {
        setPendingPostCallNote({ phone });
      }

      // Brief "ended" display, then back to ready
      setTimeout(() => setStatus(deviceRef.current ? 'ready' : 'idle'), 1500);
    });

    call.on('cancel', () => {
      setIncomingCall(null);
      if (!isInbound) setStatus('ready');
    });

    call.on('error', (err) => {
      console.error('[VoiceDevice] Call error:', err.message);
      setError(err.message);
      setActiveCall(null);
      setIncomingCall(null);
      setStatus('failed');
    });
  }

  // ── Initialize Device ──────────────────────────────────────────────────────

  const initialize = useCallback(async () => {
    if (deviceRef.current) return; // already initialized
    setStatus('registering');
    setError(null);

    try {
      const token = await fetchToken();
      const device = new Device(token, {
        logLevel: 'debug',
        codecPreferences: ['opus', 'pcmu'],
      });

      device.on('registered', () => {
        console.log('[VoiceDevice] Registered — ready for calls');
        setStatus('ready');
      });

      device.on('unregistered', () => {
        console.log('[VoiceDevice] Unregistered');
        setStatus('idle');
      });

      device.on('error', (err) => {
        console.error('[VoiceDevice] Device error:', err.message);
        setError(err.message);
        setStatus('failed');
      });

      device.on('incoming', (call) => {
        const from = call.parameters?.From || call.customParameters?.get('From') || 'Unknown';
        console.log('[VoiceDevice] Incoming call from:', from);
        setRemoteIdentity(from);
        setIncomingCall(call);
        setStatus('incoming');
        // isInbound: true — ensures post-call note modal is NOT shown for inbound calls
        wireCallEvents(call, { isInbound: true, phone: from });
      });

      // Token refresh before expiry (55 min, token TTL is 60)
      const refreshTimer = setTimeout(async () => {
        try {
          const newToken = await fetchToken();
          device.updateToken(newToken);
          console.log('[VoiceDevice] Token refreshed');
        } catch (e) {
          console.warn('[VoiceDevice] Token refresh failed:', e.message);
        }
      }, 55 * 60 * 1000);

      device.register();
      deviceRef.current = device;

      return () => clearTimeout(refreshTimer);
    } catch (err) {
      console.error('[VoiceDevice] Init failed:', err.message);
      setError(err.message);
      setStatus('failed');
    }
  }, []);

  // ── Outbound call ──────────────────────────────────────────────────────────

  const makeCall = useCallback(async (to) => {
    const device = deviceRef.current;
    if (!device) {
      setError('Voice device not initialized. Tap the mic button to connect.');
      return;
    }
    const e164 = toE164(to);
    setRemoteIdentity(e164);
    setStatus('dialing');
    setError(null);

    try {
      const call = await device.connect({ params: { To: e164 } });
      setActiveCall(call);
      // isInbound: false + phone captured — disconnect will trigger post-call note modal
      wireCallEvents(call, { isInbound: false, phone: e164 });
    } catch (err) {
      console.error('[VoiceDevice] makeCall failed:', err.message);
      setError(err.message);
      setStatus('failed');
    }
  }, []);

  // ── Answer / reject incoming ───────────────────────────────────────────────

  const answerCall = useCallback(() => {
    if (!incomingCall) return;
    incomingCall.accept();
    setActiveCall(incomingCall);
    setIncomingCall(null);
    setStatus('connected');
  }, [incomingCall]);

  const rejectCall = useCallback(() => {
    if (!incomingCall) return;
    incomingCall.reject();
    setIncomingCall(null);
    setStatus('ready');
  }, [incomingCall]);

  // ── Hang up ────────────────────────────────────────────────────────────────

  const hangUp = useCallback(() => {
    activeCall?.disconnect();
    incomingCall?.reject();
    setActiveCall(null);
    setIncomingCall(null);
  }, [activeCall, incomingCall]);

  // ── Post-call note lifecycle ───────────────────────────────────────────────

  // Called by App.jsx after the note is saved or skipped
  const clearPostCallNote = useCallback(() => {
    setPendingPostCallNote(null);
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (deviceRef.current) {
        deviceRef.current.destroy();
        deviceRef.current = null;
      }
    };
  }, []);

  return {
    status,            // 'idle' | 'registering' | 'ready' | 'incoming' | 'dialing' | 'ringing' | 'connected' | 'ended' | 'failed'
    error,
    incomingCall,
    activeCall,
    remoteIdentity,
    isReady: status === 'ready' || status === 'ended',
    pendingPostCallNote, // { phone } | null — set after an outbound call ends
    initialize,
    makeCall,
    answerCall,
    rejectCall,
    hangUp,
    clearPostCallNote,
  };
}
