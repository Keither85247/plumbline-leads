import { useState, useEffect, useCallback } from 'react';
import {
  getPhoneNumbers,
  getAdminUsers,
  searchAvailableNumbers,
  purchasePhoneNumber,
  assignPhoneNumber,
  releasePhoneNumber,
} from '../api';

function fmt(phone) {
  const d = phone.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') {
    return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  }
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return phone;
}

export default function PhoneNumbersAdmin() {
  const [numbers,   setNumbers]   = useState([]);
  const [users,     setUsers]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  // search panel
  const [areaCode,  setAreaCode]  = useState('');
  const [results,   setResults]   = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState(null);

  // purchase state
  const [purchasing, setPurchasing] = useState(null); // phone string being purchased

  // release confirm
  const [releasing, setReleasing] = useState(null); // id being released

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nums, usrs] = await Promise.all([getPhoneNumbers(), getAdminUsers()]);
      setNumbers(nums);
      setUsers(usrs);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSearch = useCallback(async () => {
    setSearching(true);
    setSearchErr(null);
    setResults(null);
    try {
      const found = await searchAvailableNumbers(areaCode.trim() || undefined);
      setResults(found);
    } catch (e) {
      setSearchErr(e.message);
    } finally {
      setSearching(false);
    }
  }, [areaCode]);

  const handlePurchase = useCallback(async (phoneNumber) => {
    setPurchasing(phoneNumber);
    setSearchErr(null);
    try {
      await purchasePhoneNumber(phoneNumber);
      setResults(r => r?.filter(n => n.phoneNumber !== phoneNumber) ?? r);
      await load();
    } catch (e) {
      setSearchErr(e.message);
    } finally {
      setPurchasing(null);
    }
  }, [load]);

  const handleAssign = useCallback(async (id, userId) => {
    setError(null);
    try {
      const updated = await assignPhoneNumber(id, userId ?? null);
      setNumbers(prev => prev.map(n => n.id === id ? { ...n, ...updated } : n));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const handleRelease = useCallback(async (id) => {
    setReleasing(id);
    setError(null);
    try {
      await releasePhoneNumber(id);
      setNumbers(prev => prev.filter(n => n.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setReleasing(null);
    }
  }, []);

  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Phone Numbers
      </label>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-3">

        {/* Owned numbers list */}
        {loading ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : numbers.length === 0 ? (
          <p className="text-xs text-gray-400">No numbers purchased yet.</p>
        ) : (
          <div className="space-y-2">
            {numbers.map(n => (
              <div key={n.id} className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">{fmt(n.phone_number)}</p>
                  <p className="text-xs text-gray-400 truncate">{n.friendly_name || n.phone_number}</p>
                </div>

                {/* Assign dropdown */}
                <select
                  value={n.assigned_user_id ?? ''}
                  onChange={e => handleAssign(n.id, e.target.value ? parseInt(e.target.value, 10) : null)}
                  className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[120px]"
                >
                  <option value="">Unassigned</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.display_name || u.email}
                    </option>
                  ))}
                </select>

                {/* Release button */}
                <button
                  onClick={() => handleRelease(n.id)}
                  disabled={releasing === n.id}
                  className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors disabled:opacity-50 shrink-0"
                >
                  {releasing === n.id ? '…' : 'Release'}
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}

        {/* Search + purchase */}
        <div className="pt-1 space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add a Number</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={areaCode}
              onChange={e => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
              placeholder="Area code (optional)"
              className="flex-1 text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              onClick={handleSearch}
              disabled={searching}
              className="shrink-0 text-sm font-semibold px-3 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-60"
            >
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>

          {searchErr && <p className="text-xs text-red-500">{searchErr}</p>}

          {results !== null && (
            results.length === 0 ? (
              <p className="text-xs text-gray-400">No numbers available for that area code.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {results.map(r => (
                  <div key={r.phoneNumber} className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800">{fmt(r.phoneNumber)}</p>
                      {(r.locality || r.region) && (
                        <p className="text-xs text-gray-400">{[r.locality, r.region].filter(Boolean).join(', ')}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handlePurchase(r.phoneNumber)}
                      disabled={purchasing === r.phoneNumber}
                      className="shrink-0 text-xs font-semibold px-2.5 py-1.5 bg-indigo-600 text-white rounded-full hover:bg-indigo-700 transition-colors disabled:opacity-60"
                    >
                      {purchasing === r.phoneNumber ? 'Purchasing…' : 'Purchase'}
                    </button>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        <p className="text-xs text-gray-400">
          Each number routes calls, voicemails, and texts to its assigned user.
          Purchasing a number incurs a monthly Twilio charge (~$1/mo).
        </p>
      </div>
    </div>
  );
}
