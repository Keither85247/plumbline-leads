import { useState, useEffect, useRef, useCallback } from 'react';
import { Device } from '@twilio/voice-sdk';
import { API_BASE, ensureCallLogged } from '../api';

// Normalize to E.164 for Twilio
function toE164(num) {
  const digits = num.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return num.trim();
}

async function fetchToken() {
  const storedToken = typeof localStorage !== 'undefined'
    ? localStorage.getItem('plumbline_token')
    : null;
  const headers = {};
  if (storedToken) headers['Authorization'] = `Bearer ${storedToken}`;

  const res = await globalThis.fetch(`${API_BASE}/twilio/token`, {
    credentials: 'include',
    headers,
  });
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

  // True while a token refresh / device reinit is in flight. Used to
  // dedupe concurrent triggers (tokenWillExpire + visibilitychange + focus
  // can all fire close together when the user returns from background).
  const refreshingRef = useRef(false);

  // Mirrors activeCall + incomingCall as a single boolean. Read from inside
  // the refresh helper without taking those as deps, so we never tear down
  // the Device mid-call.
  const callInFlightRef = useRef(false);

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
  //
  // Lifecycle invariants enforced here:
  //   - Post-call note modal fires ONLY when an outbound call truly connected
  //     for at least MIN_REAL_CALL_MS (i.e. the user actually had a chance to
  //     talk). A call that dies in <3s of accept → disconnect (caller-ID
  //     rejected, dialed number invalid, instant remote hangup, WebRTC bridge
  //     failure, TwiML ran out of verbs) shows "Call did not connect" instead
  //     of a misleading "How did it go?" prompt.
  //   - Every SDK event is logged with CallSid + timing so the call lifecycle
  //     is traceable end-to-end in production logs.
  function wireCallEvents(call, { isInbound = false, phone = null } = {}) {
    const MIN_REAL_CALL_MS = 3000;
    // Captured in closure so the disconnect handler can compute call duration
    // without racing the React state setter for `status`.
    let acceptedAt = null;
    const initialCallSid =
      call.parameters?.CallSid ||
      call.customParameters?.get?.('CallSid') ||
      null;

    console.log('[VoiceDevice] wireCallEvents', {
      isInbound,
      phone,
      callSid: initialCallSid,
      at: Date.now(),
    });

    call.on('ringing', (hasEarlyMedia) => {
      console.log('[VoiceDevice] Event: ringing', {
        callSid: initialCallSid,
        hasEarlyMedia,
        at: Date.now(),
      });
      setStatus('ringing');
    });

    call.on('accept', () => {
      acceptedAt = Date.now();
      console.log('[VoiceDevice] Event: accept (call truly connected)', {
        callSid: initialCallSid,
        acceptedAt,
      });
      stopAllAlerts();
      setActiveCall(call);
      callInFlightRef.current = true;
      setStatus('connected');
    });

    call.on('disconnect', () => {
      const disconnectedAt = Date.now();
      const duration = acceptedAt ? disconnectedAt - acceptedAt : 0;
      const reallyConnected = acceptedAt !== null && duration >= MIN_REAL_CALL_MS;
      const sid =
        call.parameters?.CallSid ||
        call.customParameters?.get?.('CallSid') ||
        initialCallSid;

      console.log('[VoiceDevice] Event: disconnect', {
        callSid: sid,
        acceptedAt,
        disconnectedAt,
        durationMs: duration,
        reallyConnected,
        isInbound,
      });

      stopAllAlerts();
      setActiveCall(null);
      setIncomingCall(null);
      callInFlightRef.current = false;
      setStatus('ended');

      // ── Call history is independent of post-call feedback ────────────────
      // Fire-and-forget: guarantee a calls row exists for this CallSid even
      // if the user dismisses the post-call modal without saving and even if
      // the /voice-client webhook never landed (Render free-tier cold start
      // / network blip). The backend endpoint is idempotent — safe to call
      // alongside the webhook and alongside saveOutboundNote.
      //
      // We only do this when an outbound call truly connected, so failed
      // setups (never accepted) don't pollute the history list. Short calls
      // (<MIN_REAL_CALL_MS but accepted) ARE logged — they're real calls
      // that the user might want to see, just not worth asking feedback on.
      if (!isInbound && phone && sid && acceptedAt !== null) {
        ensureCallLogged({ callSid: sid, phone, direction: 'outbound' })
          .then(result => {
            console.log('[VoiceDevice] ensure-logged result', { callSid: sid, ...result });
          })
          .catch(err => {
            console.warn('[VoiceDevice] ensure-logged failed', { callSid: sid, err: err.message });
          });
      }

      // Post-call note modal fires ONLY for outbound calls that genuinely
      // connected for at least MIN_REAL_CALL_MS. A call that lasted <3s of
      // accept→disconnect (or never accepted at all) is treated as a failed
      // setup — we surface a friendly error instead of asking the user to
      // characterise a non-conversation. The note path still works for real
      // calls; the modal just no longer appears for dead-on-arrival ones.
      //
      // Critically: the call history row is created above regardless of
      // whether this modal shows. Skip → no API call → row already exists.
      if (!isInbound && phone && reallyConnected) {
        console.log('[VoiceDevice] Triggering post-call note modal', {
          callSid: sid,
          durationMs: duration,
        });
        setPendingPostCallNote({ phone, callSid: sid });
      } else if (!isInbound && phone) {
        console.warn('[VoiceDevice] Outbound call ended without real connection — suppressing post-call modal', {
          callSid: sid,
          acceptedAt,
          durationMs: duration,
          reason: !acceptedAt ? 'never_accepted' : 'too_short',
        });
        setError('Call did not connect. Please try again.');
      }

      // Brief "ended" display, then back to ready
      setTimeout(() => setStatus(deviceRef.current ? 'ready' : 'idle'), 1500);
    });

    call.on('cancel', () => {
      console.log('[VoiceDevice] Event: cancel', {
        callSid: initialCallSid,
        acceptedAt,
        at: Date.now(),
      });
      // Fires when the remote caller hangs up before the call is answered,
      // OR when an outbound attempt is cancelled. Always reset to ready.
      stopAllAlerts();
      setIncomingCall(null);
      callInFlightRef.current = false;
      setStatus(deviceRef.current ? 'ready' : 'idle');
    });

    call.on('error', (err) => {
      stopAllAlerts();
      console.error('[VoiceDevice] Event: error', {
        callSid: initialCallSid,
        code: err.code,
        message: err.message,
        twilioError: err.twilioError,
        // err.causes/explanation/solutions exist on Twilio SDK errors —
        // log them so production logs reveal WHY the call failed.
        causes: err.causes,
        explanation: err.explanation,
        solutions: err.solutions,
        at: Date.now(),
      });
      setError(err.message);
      setActiveCall(null);
      setIncomingCall(null);
      callInFlightRef.current = false;
      setStatus('failed');
    });
  }

  // ── Initialize Device ──────────────────────────────────────────────────────

  // Build a fresh Device with all listeners attached. Pulled out of
  // initialize() so refreshVoiceSession() can recreate the Device when
  // updateToken() isn't enough (e.g. after a fatal device error). Listeners
  // include the proper Twilio-SDK token-lifecycle hooks (tokenWillExpire +
  // error code 20104) so we no longer rely on a brittle setTimeout that
  // gets throttled while the app is backgrounded.
  const createDevice = useCallback((token) => {
    const device = new Device(token, {
      logLevel: 'debug',
      codecPreferences: ['opus', 'pcmu'],
    });

    device.on('registered', () => {
      console.log('[VoiceDevice] Registered — ready for calls');
      setError(null);   // clear any stale reconnect error
      setStatus('ready');
    });

    device.on('unregistered', () => {
      console.log('[VoiceDevice] Unregistered');
      setStatus('idle');
    });

    // PROACTIVE refresh — Twilio fires this ~30s before the access token
    // expires. Unlike setTimeout, the SDK manages this internally based on
    // the JWT's `exp` claim, so it works correctly across backgrounding
    // (the SDK fires it as soon as the page is foregrounded if the time
    // has already passed).
    device.on('tokenWillExpire', () => {
      console.log('[VoiceDevice] tokenWillExpire — refreshing');
      refreshVoiceSession('token_will_expire');
    });

    device.on('error', (err) => {
      console.error('[VoiceDevice] Device error — code:', err.code, '| message:', err.message, '| twilioError:', err.twilioError);
      // 20104 = AccessTokenExpired. Recover automatically instead of
      // wedging into a sticky 'failed' state — the user shouldn't have to
      // kill/reopen the app over a token TTL.
      if (err.code === 20104) {
        console.log('[VoiceDevice] AccessTokenExpired (20104) — refreshing');
        refreshVoiceSession('device_error_20104');
        return;
      }
      setError(err.message);
      setStatus('failed');
    });

    device.on('incoming', (call) => {
      const from = call.parameters?.From || call.customParameters?.get('From') || 'Unknown';
      console.log('[VoiceDevice] Incoming call from:', from);
      setRemoteIdentity(from);
      setIncomingCall(call);
      callInFlightRef.current = true;
      setStatus('incoming');
      ringtoneRef.current?.play().catch(() => {});
      startTitleFlash(from);
      wireCallEvents(call, { isInbound: true, phone: from });
    });

    device.register();
    return device;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single source of truth for token refresh / device recovery. All four
  // triggers (tokenWillExpire, error 20104, visibilitychange→visible,
  // window focus) funnel through here, deduped by refreshingRef. Active
  // calls are NEVER torn down — refresh defers when a call is in flight
  // and is retried when the call ends or the next trigger fires.
  const refreshVoiceSession = useCallback(async (reason) => {
    if (refreshingRef.current) {
      console.log('[VoiceDevice] refresh already in flight — skipping', { reason });
      return;
    }
    if (callInFlightRef.current) {
      console.log('[VoiceDevice] active call — deferring refresh', { reason });
      return;
    }

    refreshingRef.current = true;
    console.log('[VoiceDevice] refreshVoiceSession start', { reason });
    setStatus('registering'); // reuse "Connecting to voice…" copy

    try {
      const newToken = await fetchToken();

      if (deviceRef.current) {
        try {
          deviceRef.current.updateToken(newToken);
          console.log('[VoiceDevice] updateToken succeeded', { reason });
        } catch (updateErr) {
          // If updateToken throws (device in a fatal state, destroyed, etc.),
          // recreate the Device with the fresh token.
          console.warn('[VoiceDevice] updateToken failed — recreating device', {
            reason, err: updateErr.message,
          });
          try { deviceRef.current.destroy(); } catch {}
          deviceRef.current = null;
          deviceRef.current = createDevice(newToken);
        }
      } else {
        deviceRef.current = createDevice(newToken);
      }

      setError(null);
      // status will move to 'ready' via the device 'registered' event
    } catch (err) {
      console.error('[VoiceDevice] refreshVoiceSession failed', { reason, err: err.message });
      setError(err.message);
      setStatus('failed');
    } finally {
      refreshingRef.current = false;
    }
  }, [createDevice]);

  const initialize = useCallback(async () => {
    if (deviceRef.current) return; // already initialized
    setStatus('registering');
    setError(null);

    try {
      // Preload the ringtone so it's ready to play instantly when an incoming
      // call arrives.
      const ringtone = new Audio('/ringtone.mp3');
      ringtone.loop = true;
      ringtone.load();
      ringtoneRef.current = ringtone;

      // iOS Safari blocks audio.play() unless it was triggered by a direct user
      // gesture. The WebSocket message that delivers an incoming call is not a
      // gesture, so play() would be silently swallowed on iPhone.
      // Fix: on the very next touch or click after init, call play()+pause() to
      // "unlock" the audio element. After that, play() works from any context.
      const unlockRingtone = () => {
        ringtone.play().then(() => ringtone.pause()).catch(() => {});
      };
      document.addEventListener('touchstart', unlockRingtone, { once: true, capture: true, passive: true });
      document.addEventListener('click',      unlockRingtone, { once: true, capture: true });

      const token = await fetchToken();
      deviceRef.current = createDevice(token);
    } catch (err) {
      console.error('[VoiceDevice] Init failed:', err.message);
      setError(err.message);
      setStatus('failed');
    }
  }, [createDevice]);

  // ── App-resume / visibility recovery ───────────────────────────────────────
  // Browsers throttle background timers heavily, so a token that should
  // refresh at 55min can quietly pass its expiry while the app is hidden.
  // When the user returns we re-validate the session: refreshVoiceSession
  // is idempotent + deduplicated, and skipped during active calls.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') {
        refreshVoiceSession('visibility_visible');
      }
    }
    function onFocus() {
      refreshVoiceSession('window_focus');
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshVoiceSession]);

  // Manual retry surface for the UI — clears the error and triggers a
  // refresh. Bound at module scope so the Dialer / failure card can wire
  // a "Retry" button without prop-drilling.
  const retryVoiceSession = useCallback(() => {
    setError(null);
    refreshVoiceSession('manual_retry');
  }, [refreshVoiceSession]);

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
      console.log('[VoiceDevice] makeCall → device.connect', { to: e164, at: Date.now() });
      const call = await device.connect({ params: { To: e164 } });
      console.log('[VoiceDevice] device.connect resolved', {
        to: e164,
        callSid: call?.parameters?.CallSid || null,
        at: Date.now(),
      });
      setActiveCall(call);
      // isInbound: false + phone captured — disconnect will trigger post-call note
      // modal ONLY if the call truly connected (see MIN_REAL_CALL_MS in wireCallEvents).
      wireCallEvents(call, { isInbound: false, phone: e164 });
    } catch (err) {
      console.error('[VoiceDevice] makeCall failed', {
        to: e164,
        code: err.code,
        message: err.message,
        twilioError: err.twilioError,
      });
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
    // Manual retry — drives the "Tap to retry" affordance the failure card
    // shows when refresh has failed several times. Cleared error first then
    // routes through the standard refresh pipeline.
    retryVoiceSession,
  };
}
