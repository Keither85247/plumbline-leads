import { useState } from 'react';
import { createLead } from '../api';

export default function TranscriptForm({ onLeadCreated, language }) {
  const [transcript, setTranscript] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!transcript.trim()) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const lead = await createLead(transcript, language);
      onLeadCreated(lead);
      setTranscript('');
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
      <h2 className="text-lg font-semibold text-gray-800 mb-1">New Transcript</h2>
      <p className="text-sm text-gray-500 mb-4">
        Paste a call transcript below. OpenAI will extract the contact name, generate a summary, and identify key points.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <textarea
          value={transcript}
          onChange={e => setTranscript(e.target.value)}
          placeholder="Paste the call transcript here...&#10;&#10;Example:&#10;Sarah: Hi, this is Sarah from Acme Corp. I'm calling about your enterprise plan.&#10;Rep: Great to hear from you Sarah! Let me walk you through our options..."
          rows={14}
          disabled={loading}
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm
                     text-gray-800 placeholder-gray-400 resize-y
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                     disabled:bg-gray-50 disabled:cursor-not-allowed"
        />
        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <span className="font-medium">Error:</span> {error}
          </div>
        )}
        {success && (
          <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
            Lead saved successfully! Check the list on the right.
          </div>
        )}
        <button
          type="submit"
          disabled={loading || !transcript.trim()}
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
              Analyzing with OpenAI...
            </>
          ) : (
            'Generate Summary & Save Lead'
          )}
        </button>
      </form>
    </div>
  );
}
