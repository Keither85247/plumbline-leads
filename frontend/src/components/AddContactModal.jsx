import { useState, useRef, useEffect } from 'react';
import { createContact } from '../api';
import { translations } from '../i18n';

// Contact type options — colours match ContactsPage badges
const CONTACT_TYPES = [
  { key: 'Lead',     label: 'addContactTypeLead',     active: 'bg-blue-600 text-white',   pill: 'bg-blue-50 text-blue-700' },
  { key: 'Customer', label: 'addContactTypeCustomer', active: 'bg-green-600 text-white',  pill: 'bg-green-50 text-green-700' },
  { key: 'Vendor',   label: 'addContactTypeVendor',   active: 'bg-purple-600 text-white', pill: 'bg-purple-50 text-purple-700' },
  { key: 'Supplier', label: 'addContactTypeSupplier', active: 'bg-amber-500 text-white',  pill: 'bg-amber-50 text-amber-700' },
];

/**
 * Bottom-sheet modal for creating a new manual contact.
 *
 * Props:
 *   onClose()          — close without saving
 *   onSaved(contact)   — called with the newly created contact row
 */
export default function AddContactModal({ onClose, onSaved }) {
  const lang = localStorage.getItem('language') || 'en';
  const t    = translations[lang] || translations.en;

  const firstInputRef = useRef(null);

  const [form, setForm] = useState({
    name:         '',
    phone:        '',
    email:        '',
    company:      '',
    notes:        '',
    contact_type: 'Lead',
  });
  const [errors,  setErrors]  = useState({});
  const [saving,  setSaving]  = useState(false);
  const [visible, setVisible] = useState(false);

  // Animate in on mount
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Auto-focus first input after animation
  useEffect(() => {
    if (visible) {
      const id = setTimeout(() => firstInputRef.current?.focus(), 200);
      return () => clearTimeout(id);
    }
  }, [visible]);

  function setField(key, value) {
    setForm(prev => ({ ...prev, [key]: value }));
    // Clear related error on change
    if (errors[key])      setErrors(prev => ({ ...prev, [key]: null }));
    if (errors.identity)  setErrors(prev => ({ ...prev, identity: null }));
  }

  function validate() {
    const errs = {};
    const hasIdentity = form.name.trim() || form.phone.trim() || form.email.trim();
    if (!hasIdentity) {
      errs.identity = t.addContactRequired;
    }
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      errs.email = t.addContactEmailInvalid;
    }
    return errs;
  }

  function handleClose() {
    setVisible(false);
    setTimeout(onClose, 220);
  }

  async function handleSave() {
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const contact = await createContact({
        name:         form.name.trim()    || null,
        phone:        form.phone.trim()   || null,
        email:        form.email.trim()   || null,
        company:      form.company.trim() || null,
        notes:        form.notes.trim()   || null,
        contact_type: form.contact_type,
      });
      setVisible(false);
      setTimeout(() => onSaved(contact), 80);
    } catch (err) {
      setErrors({ submit: err.message });
      setSaving(false);
    }
  }

  // Close on Escape
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center">

      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
      />

      {/* Sheet — slides up from bottom on mobile, centred on sm+ */}
      <div
        className={`relative bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden flex flex-col
          transition-transform duration-220 ease-out
          ${visible ? 'translate-y-0' : 'translate-y-full sm:translate-y-4 sm:opacity-0'}`}
        style={{ maxHeight: '92dvh' }}
      >
        {/* Drag handle (mobile only) */}
        <div className="flex justify-center pt-2.5 pb-1 sm:hidden shrink-0">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">{t.addContactTitle}</h2>
          <button
            onClick={handleClose}
            className="p-1.5 -mr-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable form body */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="px-5 pt-4 pb-6 space-y-4">

            {/* Contact type pills */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">{t.addContactType}</p>
              <div className="flex gap-2 flex-wrap">
                {CONTACT_TYPES.map(({ key, label, active, pill }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setField('contact_type', key)}
                    className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-all ${
                      form.contact_type === key ? active : `${pill} hover:brightness-95`
                    }`}
                  >
                    {t[label] || key}
                  </button>
                ))}
              </div>
            </div>

            {/* Identity error banner */}
            {errors.identity && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-100 text-red-700 text-xs rounded-lg px-3 py-2.5">
                <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {errors.identity}
              </div>
            )}

            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t.addContactName}</label>
              <input
                ref={firstInputRef}
                type="text"
                placeholder={t.addContactNamePH}
                value={form.name}
                onChange={e => setField('name', e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-shadow"
              />
            </div>

            {/* Phone */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t.addContactPhone}</label>
              <input
                type="tel"
                placeholder={t.addContactPhonePH}
                value={form.phone}
                onChange={e => setField('phone', e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-shadow"
              />
            </div>

            {/* Email */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t.addContactEmail}</label>
              <input
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder={t.addContactEmailPH}
                value={form.email}
                onChange={e => setField('email', e.target.value)}
                className={`w-full border rounded-xl px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-shadow ${
                  errors.email ? 'border-red-300 bg-red-50/30' : 'border-gray-200'
                }`}
              />
              {errors.email && (
                <p className="mt-1 text-xs text-red-600">{errors.email}</p>
              )}
            </div>

            {/* Business / Company */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t.addContactCompany}</label>
              <input
                type="text"
                placeholder={t.addContactCompanyPH}
                value={form.company}
                onChange={e => setField('company', e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-shadow"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t.addContactNotes}</label>
              <textarea
                placeholder={t.addContactNotesPH}
                value={form.notes}
                onChange={e => setField('notes', e.target.value)}
                rows={3}
                className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-shadow resize-none"
              />
            </div>

            {/* Submit error */}
            {errors.submit && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-100 text-red-700 text-xs rounded-lg px-3 py-2.5">
                <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {errors.submit}
              </div>
            )}

          </div>
        </div>

        {/* Sticky footer with action buttons */}
        <div className="shrink-0 px-5 py-4 border-t border-gray-100 bg-white" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={saving}
              className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-40 transition-colors"
            >
              {t.addContactCancel}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex-1 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? t.addContactSaving : t.addContactSave}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
