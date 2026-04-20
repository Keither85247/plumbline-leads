import { useState, useRef, useEffect, useCallback } from 'react';
import { getAppSettings, uploadVoicemailGreeting, deleteVoicemailGreeting, API_BASE } from '../api';

// ── WAV Recorder ──────────────────────────────────────────────────────────────
// Records mono PCM audio via Web Audio API and encodes it as a WAV blob.
// WAV is universally supported by Twilio's <Play> verb.
//
// iOS Safari notes:
//  - AudioContext must be created inside a user-gesture handler (it is — via startRecording)
//  - audioContext.resume() must be called explicitly after creation on iOS
//  - The processor node must be connected to audioContext.destination or iOS stops
//    delivering buffers to onaudioprocess
//  - Buffer size 4096 minimum to avoid glitching on mobile
//  - Sample rate is hardware-locked (typically 44100 or 48000) — always read at record time
class WavRecorder {
  constructor() {
    this.chunks     = [];
    this.sampleRate = 0;
    this.stream     = null;
    this.ctx        = null;
    this.proc       = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    this.ctx    = new AudioContext();
    await this.ctx.resume(); // required on iOS to actually start the context
    this.sampleRate = this.ctx.sampleRate;
    const src  = this.ctx.createMediaStreamSource(this.stream);
    // createScriptProcessor is deprecated but works on all platforms including iOS Safari 16+
    this.proc  = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (e) => {
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    src.connect(this.proc);
    // Connect to destination — iOS requires this or onaudioprocess stops firing
    this.proc.connect(this.ctx.destination);
  }

  stop() {
    this.proc?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    return this._toWAV();
  }

  _toWAV() {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const pcm   = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) { pcm.set(c, off); off += c.length; }

    const buf  = new ArrayBuffer(44 + pcm.length * 2);
    const v    = new DataView(buf);
    const str  = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    const sr   = this.sampleRate;

    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true);
    str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true);  // PCM
    v.setUint16(22, 1, true);  v.setUint32(24, sr, true); // mono, sample rate
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, pcm.length * 2, true);

    let o = 44;
    for (const s of pcm) {
      const c = Math.max(-1, Math.min(1, s));
      v.setInt16(o, c < 0 ? c * 0x8000 : c * 0x7FFF, true); o += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }
}

// ── Accepted upload types ─────────────────────────────────────────────────────
const ACCEPTED_TYPES  = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/ogg'];
const ACCEPT_ATTR     = '.mp3,.wav,.m4a,.ogg,audio/mpeg,audio/wav,audio/mp4,audio/ogg';
const MAX_BYTES       = 10 * 1024 * 1024; // 10 MB

function fmt(secs) {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function VoicemailGreetingEditor() {
  // 'idle' | 'recording' | 'preview' | 'uploading' | 'saved'
  const [phase,         setPhase]         = useState('idle');
  const [greetingType,  setGreetingType]  = useState('tts');  // 'tts' | 'audio'
  const [previewBlob,   setPreviewBlob]   = useState(null);
  const [previewUrl,    setPreviewUrl]    = useState(null);
  const [recordSecs,    setRecordSecs]    = useState(0);
  const [error,         setError]         = useState(null);
  const [loading,       setLoading]       = useState(true);

  const recorderRef  = useRef(null);
  const timerRef     = useRef(null);
  const fileInputRef = useRef(null);

  // Derive a cache-busted URL for the current saved audio greeting
  const [savedAudioKey, setSavedAudioKey] = useState(Date.now());
  const savedAudioUrl = `${API_BASE}/twilio/voicemail-audio?t=${savedAudioKey}`;

  // ── Load current state ──────────────────────────────────────────────────────
  useEffect(() => {
    getAppSettings()
      .then(s => setGreetingType(s.voicemail_greeting_type ?? 'tts'))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // ── Recording timer ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'recording') {
      setRecordSecs(0);
      timerRef.current = setInterval(() => setRecordSecs(s => s + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [phase]);

  // ── Cleanup blob URL on unmount ─────────────────────────────────────────────
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const rec = new WavRecorder();
      await rec.start(); // AudioContext.resume() called inside — satisfies iOS gesture requirement
      recorderRef.current = rec;
      setPhase('recording');
    } catch (e) {
      setError('Microphone access denied. Check your browser or phone settings.');
    }
  }, []);

  const stopRecording = useCallback(() => {
    const blob = recorderRef.current?.stop();
    recorderRef.current = null;
    if (!blob || blob.size === 0) {
      setError('No audio captured. Please try again.');
      setPhase('idle');
      return;
    }
    const url = URL.createObjectURL(blob);
    setPreviewBlob(blob);
    setPreviewUrl(url);
    setPhase('preview');
  }, []);

  const handleFileChange = useCallback((e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so same file can be re-selected
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Unsupported format. Upload mp3, wav, m4a, or ogg.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File too large — maximum 10 MB.');
      return;
    }
    setError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewBlob(file);
    setPreviewUrl(URL.createObjectURL(file));
    setPhase('preview');
  }, [previewUrl]);

  const handleSave = useCallback(async () => {
    if (!previewBlob) return;
    setPhase('uploading');
    setError(null);
    try {
      await uploadVoicemailGreeting(previewBlob);
      setGreetingType('audio');
      setSavedAudioKey(Date.now()); // bust cache so audio element reloads
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewBlob(null);
      setPreviewUrl(null);
      setPhase('saved');
      setTimeout(() => setPhase('idle'), 2500);
    } catch (e) {
      setError(e.message || 'Upload failed. Please try again.');
      setPhase('preview');
    }
  }, [previewBlob, previewUrl]);

  const handleRetry = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewBlob(null);
    setPreviewUrl(null);
    setPhase('idle');
    setError(null);
  }, [previewUrl]);

  const handleReset = useCallback(async () => {
    setError(null);
    try {
      await deleteVoicemailGreeting();
      setGreetingType('tts');
      setPhase('idle');
    } catch (e) {
      setError('Failed to reset greeting.');
    }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) return null;

  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Voicemail Greeting
      </label>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-3">

        {/* Status row */}
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${greetingType === 'audio' ? 'bg-green-400' : 'bg-gray-300'}`} />
          <span className="text-sm text-gray-700 font-medium flex-1">
            {greetingType === 'audio' ? 'Using recorded audio' : 'Using text-to-speech'}
          </span>
          {greetingType === 'audio' && phase === 'idle' && (
            <button
              onClick={handleReset}
              className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
            >
              Reset to TTS
            </button>
          )}
        </div>

        {/* Saved greeting playback */}
        {greetingType === 'audio' && phase !== 'preview' && phase !== 'uploading' && (
          <audio
            key={savedAudioKey}
            controls
            src={savedAudioUrl}
            className="w-full h-9"
          />
        )}

        {/* ── RECORDING phase ── */}
        {phase === 'recording' && (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-sm text-red-600 font-semibold min-w-[3.5rem]">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              {fmt(recordSecs)}
            </span>
            <button
              onClick={stopRecording}
              className="flex-1 py-2 text-sm font-semibold bg-gray-800 text-white rounded-lg hover:bg-gray-700 transition-colors"
            >
              Stop &amp; Preview
            </button>
          </div>
        )}

        {/* ── PREVIEW phase ── */}
        {phase === 'preview' && previewUrl && (
          <div className="space-y-2">
            <audio controls src={previewUrl} className="w-full h-9" />
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                className="flex-1 py-2 text-sm font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
              >
                Use this
              </button>
              <button
                onClick={handleRetry}
                className="flex-1 py-2 text-sm font-semibold bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {/* ── UPLOADING phase ── */}
        {phase === 'uploading' && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <span className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            Saving…
          </div>
        )}

        {/* ── SAVED confirmation ── */}
        {phase === 'saved' && (
          <p className="text-sm text-green-600 font-medium">✓ Greeting saved</p>
        )}

        {/* ── IDLE actions: Record + Upload ── */}
        {(phase === 'idle' || phase === 'saved') && (
          <div className="flex gap-2">
            <button
              onClick={startRecording}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-semibold border border-gray-300 rounded-lg hover:bg-white text-gray-700 transition-colors"
            >
              <svg className="w-4 h-4 shrink-0 text-red-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 15c1.657 0 3-1.343 3-3V6a3 3 0 00-6 0v6c0 1.657 1.343 3 3 3z" />
                <path d="M19 11v1a7 7 0 01-14 0v-1H3v1a9 9 0 008 8.944V22H9v2h6v-2h-2v-2.056A9 9 0 0021 12v-1h-2z" />
              </svg>
              Record
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-semibold border border-gray-300 rounded-lg hover:bg-white text-gray-700 transition-colors"
            >
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Upload
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-xs text-red-500 leading-snug">{error}</p>
        )}

        <p className="text-xs text-gray-400">
          Shared greeting — heard by all callers when a call is missed.
          Supports mp3, wav, m4a, ogg up to 10 MB.
        </p>
      </div>
    </div>
  );
}
