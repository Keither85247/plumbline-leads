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

  const deviceRef   = useRef(null);
  const ringtoneRef = useRef(null);

  // ── Ringtone + title alert ────────────────────────────────────────────────
  // Audio plays on desktop browsers where autoplay is unlocked by the user
  // gesture that called initialize(). On iOS Safari, autoplay is blocked
  // regardless — there is no production-safe workaround without a native app.
  // The page title flash works on all platforms including iPhone.

  const originalTitleRef = useRef(document.title);
  const titleTimerRef    = useRef(null);

  function startTitleFlash(from) {
    const alert = `📞 ${from || 'Incoming call'}`;
    let on = true;
    titleTimerRef.current = setInterval(() => {
      document.title = on ? alert : originalTitleRef.current;
      on = !on;
    }, 800);
  }

  function stopTitleFlash() {
    clearInterval(titleTimerRef.current);
    titleTimerRef.current = null;
    document.title = originalTitleRef.current;
  }

  function stopRingtone() {
    const r = ringtoneRef.current;
    if (!r) return;
    r.pause();
    r.currentTime = 0;
  }

  function stopAllAlerts() {
    stopRingtone();
    stopTitleFlash();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Wire all lifecycle events onto a call object.
  // `phone` is captured at call-setup time so the disconnect handler can
  // reference it without stale-closure issues.
  // `isInbound` distinguishes inbound (recorded/transcribed by backend) from
  // outbound (not recorded) so the post-call note modal only fires for outbound.
  function wireCallEvents(call, { isInbound = false, phone = null } = {}) {
    call.on('ringing', () => setStatus('ringing'));

    call.on('accept', () => {
      stopAllAlerts();
      setActiveCall(call);
      setStatus('connected');
    });

    call.on('disconnect', () => {
      stopAllAlerts();
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
      // Fires when the remote caller hangs up before the call is answered,
      // OR when an outbound attempt is cancelled. Always reset to ready.
      stopAllAlerts();
      setIncomingCall(null);
      setStatus(deviceRef.current ? 'ready' : 'idle');
    });

    call.on('error', (err) => {
      stopAllAlerts();
      console.error('[VoiceDevice] Call error — code:', err.code, '| message:', err.message, '| twilioError:', err.twilioError);
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
      // Prime ringtone inside the user-gesture window so browsers allow
      // it to play later when an incoming call arrives (no gesture available).
      const ringtone = new Audio('/ringtone.mp3');
      ringtone.loop = true;
      ringtone.play().then(() => ringtone.pause()).catch(() => {});
      ringtoneRef.current = ringtone;

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
        console.error('[VoiceDevice] Device error — code:', err.code, '| message:', err.message, '| twilioError:', err.twilioError);
        setError(err.message);
        setStatus('failed');
      });

      device.on('incoming', (call) => {
        const from = call.parameters?.From || call.customParameters?.get('From') || 'Unknown';
        console.log('[VoiceDevice] Incoming call from:', from);
        setRemoteIdentity(from);
        setIncomingCall(call);
        setStatus('incoming');
        ringtoneRef.current?.play().catch(() => {}); // works on desktop; silently ignored on iOS
        startTitleFlash(from);
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

    // Pre-warm the Render backend: retry until it responds 200 (up to 60s).
    // Render free-tier returns 502 during cold starts (~30s) and fetch() throws
    // immediately on a 502 with CORS headers missing. We must loop — not just
    // try once — so the webhook arrives to a live process, not a waking one.
    {
      const TIMEOUT_MS  = 60_000;
      const RETRY_MS    = 2_000;
      const deadline    = Date.now() + TIMEOUT_MS;
      let   backendReady = false;
      console.log('[VoiceDevice] Waiting for backend to be ready…');
      setStatus('registering'); // reuse 'registering' label so Dialer shows "Connecting to voice…"

      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${API_BASE}/health`);
          if (res.ok) { backendReady = true; break; }
        } catch { /* 502 / CORS error while Render is waking — keep retrying */ }
        await new Promise(r => setTimeout(r, RETRY_MS));
      }

      if (!backendReady) {
        console.warn('[VoiceDevice] Backend did not become ready in time — proceeding anyway');
      } else {
        console.log(`[VoiceDevice] Backend ready — placing call`);
      }
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
    stopAllAlerts();
    incomingCall.accept();
    setActiveCall(incomingCall);
    setIncomingCall(null);
    setStatus('connected');
  }, [incomingCall]);

  const rejectCall = useCallback(() => {
    if (!incomingCall) return;
    stopAllAlerts();
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
      stopAllAlerts();
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
