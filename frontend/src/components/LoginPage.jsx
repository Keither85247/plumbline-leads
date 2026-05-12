import { useState } from 'react';
import { login, register, AUTH_BASE } from '../api';
import { translations } from '../i18n';

/**
 * Full-screen login / sign-up page.
 *
 * Modes:
 *  'signin'  — existing email + password (original flow, unchanged)
 *  'create'  — name, business name, email, password, confirm password
 *
 * After successful sign-in OR sign-up, calls onSuccess(user) which
 * App.jsx uses to transition into the main app.
 */
export default function LoginPage({ onSuccess }) {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;

  // ── Mode toggle ────────────────────────────────────────────────────────────
  const [mode, setMode] = useState('signin'); // 'signin' | 'create'

  // ── Shared fields ──────────────────────────────────────────────────────────
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  // ── Create-account-only fields ─────────────────────────────────────────────
  const [displayName,   setDisplayName]   = useState('');
  const [businessName,  setBusinessName]  = useState('');
  const [confirmPw,     setConfirmPw]     = useState('');

  // ── Mode switch ────────────────────────────────────────────────────────────
  const switchMode = (next) => {
    setMode(next);
    setError('');
  };

  // ── Sign-in ────────────────────────────────────────────────────────────────
  const handleSignIn = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    console.log(`[PlumbLine] Login POST → ${AUTH_BASE}/login`);
    try {
      const user = await login(email.trim(), password);
      onSuccess(user);
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Create account ─────────────────────────────────────────────────────────
  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError(t.loginPasswordShort);
      return;
    }
    if (password !== confirmPw) {
      setError(t.loginPasswordMismatch);
      return;
    }

    setLoading(true);
    try {
      const user = await register({
        email:        email.trim(),
        password,
        displayName:  displayName.trim(),
        businessName: businessName.trim(),
      });
      onSuccess(user);
    } catch (err) {
      setError(err.message || t.loginSignupFailed);
    } finally {
      setLoading(false);
    }
  };

  // ── Shared input class ─────────────────────────────────────────────────────
  const inputCls = 'w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow disabled:bg-gray-50 disabled:cursor-not-allowed';

  return (
    <div className="h-dvh bg-gray-50 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo / wordmark */}
        <div className="text-center mb-8">
          <p className="text-2xl font-bold tracking-tight text-gray-900">
            PlumbLine<span className="text-blue-600"> Leads</span>
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {mode === 'signin' ? t.loginSubtitle : t.loginModeCreate}
          </p>
        </div>

        {/* Mode toggle tabs */}
        <div className="flex rounded-xl overflow-hidden border border-gray-200 mb-5 bg-white">
          <button
            type="button"
            onClick={() => switchMode('signin')}
            className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
              mode === 'signin'
                ? 'bg-gray-900 text-white'
                : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            {t.loginModeSignIn}
          </button>
          <button
            type="button"
            onClick={() => switchMode('create')}
            className={`flex-1 py-2.5 text-sm font-semibold border-l border-gray-200 transition-colors ${
              mode === 'create'
                ? 'bg-gray-900 text-white'
                : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            {t.loginModeCreate}
          </button>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8">

          {/* ── SIGN IN FORM ── */}
          {mode === 'signin' && (
            <form onSubmit={handleSignIn} className="space-y-5">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                  {t.loginEmailLabel}
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className={inputCls}
                  placeholder={t.loginEmailPH}
                  disabled={loading}
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                  {t.loginPasswordLabel}
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={inputCls}
                  placeholder={t.loginPasswordPH}
                  disabled={loading}
                />
              </div>

              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2.5">
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !email || !password}
                className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    {t.loginSigningIn}
                  </span>
                ) : t.loginButton}
              </button>
            </form>
          )}

          {/* ── CREATE ACCOUNT FORM ── */}
          {mode === 'create' && (
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label htmlFor="displayName" className="block text-sm font-medium text-gray-700 mb-1">
                  {t.loginFullName}
                </label>
                <input
                  id="displayName"
                  type="text"
                  autoComplete="name"
                  required
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  className={inputCls}
                  placeholder={t.loginNamePH}
                  disabled={loading}
                />
              </div>

              <div>
                <label htmlFor="businessName" className="block text-sm font-medium text-gray-700 mb-1">
                  {t.businessName}
                </label>
                <input
                  id="businessName"
                  type="text"
                  autoComplete="organization"
                  value={businessName}
                  onChange={e => setBusinessName(e.target.value)}
                  className={inputCls}
                  placeholder={t.loginBizNamePH}
                  disabled={loading}
                />
              </div>

              <div>
                <label htmlFor="createEmail" className="block text-sm font-medium text-gray-700 mb-1">
                  {t.loginEmailLabel}
                </label>
                <input
                  id="createEmail"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className={inputCls}
                  placeholder={t.loginEmailPH}
                  disabled={loading}
                />
              </div>

              <div>
                <label htmlFor="createPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  {t.loginPasswordLabel}
                </label>
                <input
                  id="createPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={inputCls}
                  placeholder={t.loginPasswordPH}
                  disabled={loading}
                />
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  {t.loginConfirmPassword}
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPw}
                  onChange={e => setConfirmPw(e.target.value)}
                  className={inputCls}
                  placeholder={t.loginPasswordPH}
                  disabled={loading}
                />
              </div>

              {error && (
                <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2.5">
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !email || !password || !displayName || !confirmPw}
                className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    {t.loginCreating}
                  </span>
                ) : t.loginCreateBtn}
              </button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          {mode === 'signin' ? t.loginNoAccount : t.loginHaveAccount}
          {mode === 'signin' ? '' : (
            <button
              type="button"
              onClick={() => switchMode('signin')}
              className="ml-1 text-blue-500 hover:text-blue-700 font-medium underline-offset-2 hover:underline"
            >
              {t.loginModeSignIn}
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
