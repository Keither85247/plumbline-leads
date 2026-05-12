import { useState, useEffect } from 'react';
import { getAdminUsers } from '../api';
import { translations } from '../i18n';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth()    === now.getMonth()
    && d.getDate()     === now.getDate();
}

function isThisWeek(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);
  return d >= weekAgo && d <= now;
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-4 flex flex-col gap-1">
      <span className={`text-2xl font-bold ${accent || 'text-gray-900'}`}>{value}</span>
      <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</span>
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function UserRow({ user, t }) {
  return (
    <div className="px-4 py-3 flex items-start gap-3">
      {/* Avatar */}
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold ${
        user.is_owner ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-500'
      }`}>
        {(user.display_name || user.email || '?')[0].toUpperCase()}
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-800 truncate">
            {user.display_name || user.email}
          </span>
          {/* Role badge */}
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
            user.is_owner
              ? 'bg-indigo-100 text-indigo-600'
              : 'bg-gray-100 text-gray-500'
          }`}>
            {user.is_owner ? t.adminOwner : t.adminTester}
          </span>
          {/* Suspended badge */}
          {!!user.is_suspended && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">
              {t.adminSuspended}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 truncate">{user.email}</p>
        <p className="text-xs text-gray-400 mt-0.5">
          {user.assigned_number
            ? <span className="text-green-600 font-medium">{user.assigned_number}</span>
            : <span className="text-gray-300">{t.adminNoPhone}</span>
          }
          {' · '}
          <span>{t.adminJoined} {formatDate(user.created_at)}</span>
        </p>
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;

  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    getAdminUsers()
      .then(setUsers)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const totalUsers  = users.length;
  const todayCount  = users.filter(u => isToday(u.created_at)).length;
  const weekCount   = users.filter(u => isThisWeek(u.created_at)).length;

  return (
    <div className="max-w-lg w-full">

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">{t.adminTitle}</h1>
        <p className="text-sm text-gray-400 mt-0.5">{t.adminSubtitle}</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label={t.adminTotalUsers} value={loading ? '—' : totalUsers} />
        <StatCard label={t.adminToday}    value={loading ? '—' : todayCount}  accent="text-blue-600" />
        <StatCard label={t.adminThisWeek} value={loading ? '—' : weekCount}   accent="text-indigo-600" />
      </div>

      {/* User list */}
      {loading ? (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {[1, 2, 3].map(i => (
            <div key={i} className="px-4 py-3 flex items-start gap-3 animate-pulse">
              <div className="w-8 h-8 rounded-full bg-gray-100 shrink-0" />
              <div className="flex-1 space-y-1.5 pt-0.5">
                <div className="h-3 w-32 bg-gray-100 rounded-full" />
                <div className="h-2.5 w-40 bg-gray-100 rounded-full" />
                <div className="h-2.5 w-24 bg-gray-100 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-4 text-sm text-red-700">
          {error}
        </div>
      ) : users.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-12 text-center">
          <p className="text-sm text-gray-400">{t.adminTotalUsers}: 0</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {users.map((user, idx) => (
            <div key={user.id}>
              {idx > 0 && <div className="h-px bg-gray-50 mx-4" />}
              <UserRow user={user} t={t} />
            </div>
          ))}
        </div>
      )}

      <div className="h-6" />
    </div>
  );
}
