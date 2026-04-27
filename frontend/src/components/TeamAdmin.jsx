import { useState, useEffect, useCallback } from 'react';
import { API_BASE, getAdminUsers } from '../api';

function authFetch(url, options = {}) {
  const token = localStorage.getItem('plumbline_token');
  return globalThis.fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export default function TeamAdmin() {
  const [users,     setUsers]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [email,     setEmail]     = useState('');
  const [name,      setName]      = useState('');
  const [password,  setPassword]  = useState('');
  const [creating,  setCreating]  = useState(false);
  const [createErr, setCreateErr] = useState(null);
  const [deleting,  setDeleting]  = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getAdminUsers();
      setUsers(list.filter(u => !u.is_owner));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = useCallback(async (e) => {
    e.preventDefault();
    setCreating(true);
    setCreateErr(null);
    try {
      const res = await authFetch(`${API_BASE}/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, display_name: name, password }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create account');
      }
      setEmail('');
      setName('');
      setPassword('');
      await load();
    } catch (e) {
      setCreateErr(e.message);
    } finally {
      setCreating(false);
    }
  }, [email, name, password, load]);

  const handleDelete = useCallback(async (id) => {
    setDeleting(id);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/admin/users/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to remove');
      }
      setUsers(prev => prev.filter(u => u.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting(null);
    }
  }, []);

  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Tester Accounts
      </label>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-3">

        {loading ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : users.length === 0 ? (
          <p className="text-xs text-gray-400">No tester accounts yet.</p>
        ) : (
          <div className="space-y-1.5">
            {users.map(u => (
              <div key={u.id} className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{u.display_name || u.email}</p>
                  <p className="text-xs text-gray-400 truncate">{u.email}</p>
                </div>
                <button
                  onClick={() => handleDelete(u.id)}
                  disabled={deleting === u.id}
                  className="shrink-0 text-xs text-red-500 hover:text-red-700 font-medium transition-colors disabled:opacity-50"
                >
                  {deleting === u.id ? '…' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}

        <form onSubmit={handleCreate} className="space-y-2 pt-1">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add Tester</p>
          <input
            type="email"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Name (optional)"
            className="w-full text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="password"
            required
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {createErr && <p className="text-xs text-red-500">{createErr}</p>}
          <button
            type="submit"
            disabled={creating}
            className="w-full py-2 text-sm font-semibold bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-60"
          >
            {creating ? 'Creating…' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
