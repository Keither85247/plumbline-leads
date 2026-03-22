import { useState, useRef, useEffect } from 'react';
import { updateLeadStatus, archiveLead, unarchiveLead, deleteLead } from '../api';
import { normalizePhone } from '../utils/phone';

const STATUS_COLORS = {
  New: 'bg-blue-100 text-blue-800',
  Contacted: 'bg-yellow-100 text-yellow-800',
  Qualified: 'bg-green-100 text-green-800',
  Closed: 'bg-gray-100 text-gray-600'
};

const STATUSES = ['New', 'Contacted', 'Qualified', 'Closed'];

function getAgeLabel(createdAt) {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  const days = Math.floor(hours / 24);
  return `${days}d old`;
}

function getUrgency(createdAt, status) {
  if (status !== 'New') return null;
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const hours = diffMs / 3600000;
  if (hours >= 24) return 'overdue';
  if (hours >= 2) return 'warning';
  return null;
}

export default function LeadCard({ lead, onLeadUpdated, onLeadRemoved, contractorName, onContactClick, isArchived = false }) {
  const [updating, setUpdating] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [editingFollowUp, setEditingFollowUp] = useState(false);
  const [followUpDraft, setFollowUpDraft] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const baseFollowUp = contractorName
    ? (lead.follow_up_text || '').replace(/\[Your Name\]/g, contractorName)
    : lead.follow_up_text;

  const displayedFollowUp = followUpDraft !== null ? followUpDraft : baseFollowUp;

  const handleEditClick = () => {
    if (followUpDraft === null) setFollowUpDraft(baseFollowUp);
    setEditingFollowUp(true);
  };

  const handleSend = () => { alert('Texting integration coming soon'); };

  const handleStatusChange = async (e) => {
    const newStatus = e.target.value;
    setUpdating(true);
    try {
      const updated = await updateLeadStatus(lead.id, newStatus);
      onLeadUpdated(updated);
    } catch (err) {
      console.error('Status update failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const handleArchive = async () => {
    setMenuOpen(false);
    setUpdating(true);
    try {
      await archiveLead(lead.id);
      onLeadRemoved(lead.id);
    } catch (err) {
      console.error('Archive failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const handleUnarchive = async () => {
    setMenuOpen(false);
    setUpdating(true);
    try {
      await unarchiveLead(lead.id);
      onLeadRemoved(lead.id);
    } catch (err) {
      console.error('Unarchive failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    if (!window.confirm('Permanently delete this lead? This cannot be undone.')) return;
    setUpdating(true);
    try {
      await deleteLead(lead.id);
      onLeadRemoved(lead.id);
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setUpdating(false);
    }
  };

  const formattedDate = new Date(lead.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  const ageLabel = getAgeLabel(lead.created_at);
  const urgency = getUrgency(lead.created_at, lead.status);
  const rawText = lead.raw_text || lead.transcript;
  const category = lead.category || 'Lead';
  const primaryPhone = lead.callback_number || lead.phone_number;
  const showCallerIdSecondary = lead.callback_number && lead.phone_number && lead.callback_number !== lead.phone_number;

  return (
    <div className={`border rounded-lg p-4 transition-colors ${lead.status === 'New' && !isArchived ? 'bg-blue-50 border-blue-200 hover:border-blue-300' : 'border-gray-200 hover:border-gray-300'}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => onContactClick && onContactClick(normalizePhone(lead.callback_number || lead.phone_number))}
              className="font-semibold text-gray-900 truncate hover:text-blue-600 hover:underline transition-colors text-left"
            >
              {lead.contact_name}{lead.company_name ? ` (${lead.company_name})` : ''}
            </button>
            <span className="text-xs text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 shrink-0">{category}</span>
          </div>
          {primaryPhone && (
            <a href={`tel:${primaryPhone}`} className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline">
              {primaryPhone}
            </a>
          )}
          {showCallerIdSecondary && (
            <p className="text-xs text-gray-400 mt-0.5">Called from: {lead.phone_number}</p>
          )}
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <p className="text-xs text-gray-400">{formattedDate}</p>
            <span className="text-xs text-gray-400">&middot;</span>
            <span className="text-xs text-gray-400">{ageLabel}</span>
            {urgency === 'overdue' && <span className="text-xs font-medium text-red-600 bg-red-50 rounded px-1.5 py-0.5">Overdue</span>}
            {urgency === 'warning' && <span className="text-xs font-medium text-yellow-700 bg-yellow-50 rounded px-1.5 py-0.5">Needs follow-up</span>}
          </div>
        </div>

        {/* Status + kebab menu */}
        <div className="flex items-center gap-1.5 shrink-0">
          {!isArchived && (
            <select
              value={lead.status}
              onChange={handleStatusChange}
              disabled={updating}
              className={`text-xs font-medium rounded-full px-3 py-1 cursor-pointer border-0
                          focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:cursor-wait
                          ${STATUS_COLORS[lead.status] || STATUS_COLORS['New']}`}
            >
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}

          {/* Kebab menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              disabled={updating}
              className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:cursor-wait"
              aria-label="More options"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
              </svg>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-7 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[130px]">
                {isArchived ? (
                  <button
                    onClick={handleUnarchive}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Unarchive
                  </button>
                ) : (
                  <button
                    onClick={handleArchive}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Archive
                  </button>
                )}
                <button
                  onClick={handleDelete}
                  className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="text-sm text-gray-600 mt-3 leading-relaxed">{lead.summary}</p>
      {lead.key_points && lead.key_points.length > 0 && (
        <ul className="mt-2 space-y-1">
          {lead.key_points.map((point, i) => (
            <li key={i} className="text-xs text-gray-500 flex gap-1.5">
              <span className="text-blue-400 font-bold shrink-0 mt-0.5">•</span>
              <span>{point}</span>
            </li>
          ))}
        </ul>
      )}
      {baseFollowUp && !isArchived && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-gray-500">Suggested follow-up</p>
                {!editingFollowUp
                  ? <button onClick={handleEditClick} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">Edit</button>
                  : <button onClick={() => setEditingFollowUp(false)} className="text-xs text-blue-500 hover:text-blue-700 transition-colors">Done</button>
                }
              </div>
              <button onClick={handleSend} className="text-xs text-blue-500 hover:text-blue-700 transition-colors">Send</button>
            </div>
            {editingFollowUp ? (
              <textarea
                value={displayedFollowUp}
                onChange={e => setFollowUpDraft(e.target.value)}
                rows={3}
                className="w-full text-xs text-gray-700 border border-gray-200 rounded-md px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none bg-white"
              />
            ) : (
              <p className="text-xs text-gray-600 leading-relaxed">{displayedFollowUp}</p>
            )}
          </div>
        </div>
      )}
      {rawText && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <button onClick={() => setShowRaw(p => !p)} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
            {showRaw ? 'Hide original message' : 'View original message'}
          </button>
          {showRaw && <p className="mt-2 text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">{rawText}</p>}
        </div>
      )}
    </div>
  );
}
