import { useState, useEffect, useCallback } from 'react';
import ConversationList from './ConversationList';
import MessageThread from './MessageThread';
import LeadDetailsPanel from './LeadDetailsPanel';
import NewMessageModal from './NewMessageModal';
import { getConversations, getMessageThread, sendMessage, markMessagesRead, deleteConversation } from '../../api';
import { translations } from '../../i18n';

function EmptyThreadState({ t }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8 bg-gray-50/50">
      <div className="w-12 h-12 rounded-2xl bg-white border border-gray-100 shadow-sm flex items-center justify-center">
        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 16a2 2 0 01-2 2H7l-4 4V6a2 2 0 012-2h14a2 2 0 012 2v10z" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium text-gray-600">{t.inboxNoConvSelected}</p>
        <p className="text-xs text-gray-400 mt-0.5">{t.inboxChooseContact}</p>
      </div>
    </div>
  );
}

// ── InboxLayout ─────────────────────────────────────────────────────────────
// Top-level state manager for the inbox. Fetches real conversations + messages
// from the backend. Send is wired to POST /api/messages/send via Twilio.

export default function InboxLayout() {
  const lang = localStorage.getItem('language') || 'en';
  const t = translations[lang] || translations.en;

  const [conversations, setConversations]   = useState([]);
  const [messageMap,    setMessageMap]       = useState({});
  const [selectedId,    setSelectedId]       = useState(null);
  const [showDetails,   setShowDetails]      = useState(true);
  const [mobileView,    setMobileView]       = useState('list'); // 'list' | 'thread'
  const [composeOpen,   setComposeOpen]      = useState(false);
  const [loading,       setLoading]          = useState(true);
  // Conversation pending deletion confirmation. `null` when no modal is open;
  // otherwise the full conversation object (so we can render its name in the
  // dialog). Separate from `deleting` so the modal stays disabled mid-request.
  const [pendingDelete, setPendingDelete]    = useState(null);
  const [deleting,      setDeleting]         = useState(false);

  // ── Load + poll conversation list ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    function fetchConversations() {
      getConversations()
        .then(data => { if (!cancelled) setConversations(data); })
        .catch(err => console.error('[Inbox] Failed to load conversations:', err))
        .finally(() => { if (!cancelled) setLoading(false); });
    }

    fetchConversations();
    const interval = setInterval(fetchConversations, 10_000); // refresh every 10s
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const selected = conversations.find(c => c.id === selectedId) ?? null;
  const messages = selectedId ? (messageMap[selectedId] ?? null) : null; // null = not loaded yet

  // ── Poll the open thread ───────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;

    function fetchThread() {
      getMessageThread(selectedId)
        .then(msgs => { if (!cancelled) setMessageMap(m => ({ ...m, [selectedId]: msgs })); })
        .catch(err => console.error('[Inbox] Failed to load thread:', err));
    }

    fetchThread(); // load immediately on selection
    const interval = setInterval(fetchThread, 5_000); // poll every 5s while open
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedId]);

  // ── Select a conversation ──────────────────────────────────────────────────
  const handleSelect = useCallback((id) => {
    setSelectedId(id);
    setMobileView('thread');
    // Mark as read locally + persist to backend so badge count clears
    setConversations(prev => prev.map(c => c.id === id ? { ...c, unread: 0 } : c));
    markMessagesRead(id).catch(err => console.error('[Inbox] mark-read error:', err.message));
  }, []);

  const handleBack = useCallback(() => {
    setMobileView('list');
  }, []);

  // ── Send a message in the current thread ───────────────────────────────────
  const handleSend = useCallback(async (text, files = []) => {
    if (!selectedId || (!text.trim() && files.length === 0)) return;

    // Build object URLs for any attached images so we can show them immediately
    const optimisticMediaUrls = files.length > 0
      ? JSON.stringify(files.map(f => URL.createObjectURL(f)))
      : null;

    // Optimistic UI update first
    const optimisticMsg = {
      id:         `optimistic-${Date.now()}`,
      body:       text.trim(),
      media_urls: optimisticMediaUrls,
      direction:  'outbound',
      created_at: new Date().toISOString(),
    };
    setMessageMap(prev => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] ?? []), optimisticMsg],
    }));
    setConversations(prev => prev.map(c =>
      c.id === selectedId
        ? { ...c, lastMessage: text.trim() || '📷 Photo', lastMessageDir: 'outbound', timestamp: new Date().toISOString() }
        : c
    ));

    // Real send
    try {
      await sendMessage(selectedId, text.trim(), files);
    } catch (err) {
      console.error('[Inbox] Send failed:', err.message);
      // Revoke optimistic object URLs
      if (optimisticMediaUrls) {
        JSON.parse(optimisticMediaUrls).forEach(u => URL.revokeObjectURL(u));
      }
      // Remove optimistic message on failure
      setMessageMap(prev => ({
        ...prev,
        [selectedId]: (prev[selectedId] ?? []).filter(m => m.id !== optimisticMsg.id),
      }));
      alert(`Failed to send message: ${err.message}`);
    }
  }, [selectedId]);

  // ── Compose: start a new conversation or open an existing one ──────────────
  //
  // Flow:
  //   1. Send first (await sendMessage). If it fails, we rethrow — the
  //      compose modal catches the error and shows it inline while keeping
  //      its state intact (recipient, message body, attachments).
  //   2. Only AFTER the send succeeds do we navigate / optimistically
  //      surface the new thread. Previously this navigation happened up
  //      front, so a backend rejection (international SMS, suspended user,
  //      rate-limit) left the user staring at "No Conversation Selected"
  //      because the 10s polling refresh replaced the optimistic
  //      conversation with the server's list while selectedId still pointed
  //      at the now-missing row.
  const handleComposeSend = useCallback(async (phone, text, files = []) => {
    const normalizedPhone = phone.trim();

    // 1. Send. Throws on failure → bubbles to the modal's catch.
    await sendMessage(normalizedPhone, text.trim(), files);

    // 2. Success path — navigate + optimistically render the new message
    //    so the user immediately sees their thread without waiting for the
    //    next conversation poll.
    const existing = conversations.find(c => c.phone === normalizedPhone);

    if (existing) {
      handleSelect(existing.id);
    } else {
      const newConv = {
        id:             normalizedPhone,
        phone:          normalizedPhone,
        name:           normalizedPhone,
        lastMessage:    text || (files.length > 0 ? '📷 Photo' : ''),
        lastMessageDir: 'outbound',
        timestamp:      new Date().toISOString(),
        unread:         0,
      };
      setConversations(prev => [newConv, ...prev]);
      setMessageMap(prev => ({ ...prev, [normalizedPhone]: [] }));
      setSelectedId(normalizedPhone);
      setMobileView('thread');
    }

    const targetId = existing ? existing.id : normalizedPhone;

    // Local-only previews for any attached images so the just-sent message
    // shows immediately. The real media_urls will arrive from the next
    // thread poll; we revoke these blob URLs only when the component
    // unmounts (acceptable — small set, short-lived).
    const optimisticMediaUrls = files.length > 0
      ? JSON.stringify(files.map(f => URL.createObjectURL(f)))
      : null;

    const optimisticMsg = {
      id:         `optimistic-${Date.now()}`,
      body:       text.trim(),
      media_urls: optimisticMediaUrls,
      direction:  'outbound',
      created_at: new Date().toISOString(),
    };
    setMessageMap(prev => ({
      ...prev,
      [targetId]: [...(prev[targetId] ?? []), optimisticMsg],
    }));
  }, [conversations, handleSelect]);

  // ── Soft-delete (hide) a conversation ──────────────────────────────────────
  // Two-stage: ConversationItem invokes onDelete with the conversation, which
  // sets `pendingDelete` to surface the confirmation modal. The modal's
  // Delete button calls `confirmDelete`, which performs the hide.
  const handleDeleteRequest = useCallback((conv) => {
    setPendingDelete(conv);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deleting) return;
    const { id, phone } = pendingDelete;
    setDeleting(true);
    try {
      await deleteConversation(phone);
      // Optimistic: drop the conversation locally so the list updates
      // immediately. Server-side it's soft-deleted; the next conversation
      // poll won't return it either.
      setConversations(prev => prev.filter(c => c.id !== id));
      setMessageMap(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      // If the deleted conversation was selected, clear selection and pop
      // mobile back to the list view so we don't sit on a dead thread.
      if (selectedId === id) {
        setSelectedId(null);
        setMobileView('list');
      }
      setPendingDelete(null);
    } catch (err) {
      console.error('[Inbox] Delete conversation failed:', err.message);
      // Keep the modal open so the user can see the error and retry. The
      // existing pendingDelete is preserved; nothing has been removed from
      // local state because the API call failed before our setConversations.
      alert(`Failed to delete conversation: ${err.message}`);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, deleting, selectedId]);

  const cancelDelete = useCallback(() => {
    if (deleting) return;
    setPendingDelete(null);
  }, [deleting]);

  return (
    // Fills the full available height. Parent in App.jsx must be flex-1 + overflow-hidden.
    <div className="flex flex-1 min-h-0 overflow-hidden bg-white border-t border-gray-100">

      {/* ── Left: conversation list ─────────────────────────────── */}
      <aside className={`
        flex-col border-r border-gray-100 shrink-0
        w-full md:w-72 lg:w-80
        ${mobileView === 'thread' ? 'hidden md:flex' : 'flex'}
      `}>
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={handleSelect}
          onCompose={() => setComposeOpen(true)}
          onDelete={handleDeleteRequest}
          loading={loading}
        />
      </aside>

      {/* ── Center: message thread ──────────────────────────────── */}
      <div className={`
        flex-1 min-w-0 flex flex-col overflow-hidden
        ${mobileView === 'list' ? 'hidden md:flex' : 'flex'}
      `}>
        {selected
          ? <MessageThread
              conversation={selected}
              messages={messages ?? []}
              onSend={handleSend}
              onBack={handleBack}
              showDetails={showDetails}
              onToggleDetails={() => setShowDetails(v => !v)}
            />
          : <EmptyThreadState t={t} />
        }
      </div>

      {/* ── Right: lead details (desktop, collapsible) ─────────── */}
      {selected && showDetails && (
        <aside className="hidden lg:flex flex-col w-64 xl:w-72 border-l border-gray-100 shrink-0">
          <LeadDetailsPanel conversation={selected} />
        </aside>
      )}

      {/* ── New message composer ────────────────────────────────── */}
      {composeOpen && (
        <NewMessageModal
          onSend={handleComposeSend}
          onClose={() => setComposeOpen(false)}
          conversations={conversations}
        />
      )}

      {/* ── Delete-conversation confirmation ─────────────────────── */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-conv-title"
          onClick={cancelDelete}
          onKeyDown={e => { if (e.key === 'Escape') cancelDelete(); }}
        >
          <div
            className="w-full max-w-sm bg-white rounded-2xl shadow-2xl px-5 py-5"
            onClick={e => e.stopPropagation()}
          >
            <h3 id="delete-conv-title" className="text-base font-semibold text-gray-900 mb-1">
              {t.inboxDeleteConvTitle || 'Delete conversation?'}
            </h3>
            <p className="text-sm text-gray-500 leading-relaxed mb-1">
              {t.inboxDeleteConvBody  || 'This will remove this conversation from your inbox. This cannot be undone.'}
            </p>
            <p className="text-xs text-gray-400 truncate mb-5">
              {pendingDelete.name && pendingDelete.name !== pendingDelete.phone
                ? `${pendingDelete.name} · ${pendingDelete.phone}`
                : pendingDelete.phone}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelDelete}
                disabled={deleting}
                className="text-sm px-4 py-2 rounded-lg text-gray-600 hover:text-gray-800 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {t.inboxCancel || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className="text-sm px-5 py-2 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {deleting
                  ? (t.inboxDeleting || 'Deleting…')
                  : (t.inboxDelete   || 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
