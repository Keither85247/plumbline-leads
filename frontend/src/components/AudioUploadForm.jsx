import { useState, useRef } from 'react';
import { API_BASE } from '../api';

export default function AudioUploadForm({ onLeadCreated, language }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [transcript, setTranscript] = useState('');
  const inputRef = useRef(null);

  const handleFileChange = (e) => {
    setFile(e.target.files[0] || null);
    setError(null);
    setSuccess(false);
    setTranscript('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setSuccess(false);
    setTranscript('');

    try {
      const formData = new FormData();
      formData.append('audio', file);
      if (language) formData.append('language', language);

      const res = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Transcription failed');
      }

      const data = await res.json();
      setTranscript(data.transcript);
      onLeadCreated(data.lead);
      setFile(null);
      inputRef.current.value = '';
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-1">Upload Voicemail</h2>
      <p className="text-sm text-gray-500 mb-4">
        Upload an audio file to transcribe it and auto-create a lead. Accepts mp3, m4a, wav, mp4.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.m4a,.wav,.mp4,audio/*"
          onChange={handleFileChange}
          disabled={loading}
          className="block w-full text-sm text-gray-600
                     file:mr-4 file:py-2 file:px-4
                     file:rounded-lg file:border-0
                     file:text-sm file:font-medium
                     file:bg-gray-100 file:text-gray-700
                     hover:file:bg-gray-200
                     disabled:opacity-50 disabled:cursor-not-allowed"
        />
        {transcript && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
            <p className="text-xs font-medium text-gray-500 mb-1">Transcribed text</p>
            <p className="text-xs text-gray-600 leading-relaxed">{transcript}</p>
          </div>
        )}
        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <span className="font-medium">Error:</span> {error}
          </div>
        )}
        {success && (
          <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
            Lead created from voicemail!
          </div>
        )}
        <button
          type="submit"
          disabled={loading || !file}
          className="w-full bg-blue-600 text-white font-medium py-2.5 px-4 rounded-lg
                     hover:bg-blue-700 active:bg-blue-800 transition-colors duration-150
                     disabled:bg-blue-300 disabled:cursor-not-allowed
                     flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Transcribing...
            </>
          ) : (
            'Transcribe & Save Lead'
          )}
        </button>
      </form>
    </div>
  );
}
