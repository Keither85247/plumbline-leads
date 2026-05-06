import { useState } from 'react';
import { searchAvailableNumbersForClaim, claimPhoneNumber } from '../api';

/**
 * Blocking modal shown to non-owner users who have not yet claimed a phone number.
 * The user searches by area code, picks a number, and confirms.
 * On success calls onClaimed(numberRow).
 */
export default function NumberPickerModal({ onClaimed }) {
  const [areaCode,  setAreaCode]  = useState('');
  const [results,   setResults]   = useState(null);   // null = not searched yet
  const [searching, setSearching] = useState(false);
  const [selected,  setSelected]  = useState(null);   // phoneNumber string
  const [claiming,  setClaiming]  = useState(false);
  const [error,     setError]     = useState('');

  const handleSearch = async (e) => {
    e.preventDefault();
    setError('');
    setResults(null);
    setSelected(null);
    setSearching(true);
    try {
      const nums = await searchAvailableNumbersForClaim(areaCode.trim() || undefined);
      setResults(nums);
      if (nums.length === 0) setError('No numbers found for that area code. Try a different one.');
    } catch (err) {
      setError(err.message || 'Search failed. Please try again.');
    } finally {
      setSearching(false);
    }
  };

  const handleClaim = async () => {
    if (!selected) return;
    setError('');
    setClaiming(true);
    try {
      const row = await claimPhoneNumber(selected);
      onClaimed(row);
    } catch (err) {
      setError(err.message || 'Failed to claim number. Please try again.');
      setClaiming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/70 px-4"
         style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl overflow-hidden">

        {/* Header */}
        <div className="bg-blue-600 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
              </svg>
            </div>
            <div>
              <p className="text-white font-semibold text-base">Choose your business number</p>
              <p className="text-blue-100 text-xs mt-0.5">You'll use this number to call and text leads</p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">

          {/* Area code search */}
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              pattern="\d*"
              maxLength={3}
              value={areaCode}
              onChange={e => setAreaCode(e.target.value.replace(/\D/g, ''))}
              placeholder="Area code (optional)"
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={searching || claiming}
            />
            <button
              type="submit"
              disabled={searching || claiming}
              className="px-4 py-2 text-sm font-semibold bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-700 rounded-lg transition-colors"
            >
              {searching ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              ) : 'Search'}
            </button>
          </form>

          {/* Results list */}
          {results !== null && results.length > 0 && (
            <div className="border border-gray-200 rounded-xl overflow-hidden max-h-52 overflow-y-auto">
              {results.map(num => (
                <button
                  key={num.phoneNumber}
                  onClick={() => setSelected(num.phoneNumber)}
                  disabled={claiming}
                  className={`w-full text-left px-4 py-3 flex items-center justify-between transition-colors border-b border-gray-100 last:border-0 ${
                    selected === num.phoneNumber
                      ? 'bg-blue-50 text-blue-700'
                      : 'hover:bg-gray-50 text-gray-800'
                  }`}
                >
                  <div>
                    <p className="text-sm font-semibold">{num.friendlyName}</p>
                    {num.locality && (
                      <p className="text-xs text-gray-500">{num.locality}, {num.region}</p>
                    )}
                  </div>
                  {selected === num.phoneNumber && (
                    <svg className="w-5 h-5 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Hint when not yet searched */}
          {results === null && !error && (
            <p className="text-xs text-gray-500 text-center">
              Enter your preferred area code and tap Search, or search without one to see any available number.
            </p>
          )}

          {/* Confirm button */}
          <button
            onClick={handleClaim}
            disabled={!selected || claiming}
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            {claiming ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Reserving your number…
              </span>
            ) : selected ? `Claim ${selected}` : 'Select a number above'}
          </button>

          <p className="text-center text-xs text-gray-400">
            Your number is permanent — choose carefully.
          </p>
        </div>
      </div>
    </div>
  );
}
