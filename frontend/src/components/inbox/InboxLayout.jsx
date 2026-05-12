import { useState, useEffect, useCallback, useRef } from 'react';
import ConversationList from './ConversationList';
import MessageThread from './MessageThread';
import LeadDetailsPanel from './LeadDetailsPanel';
import NewMessageModal from './NewMessageModal';
import { getConversations, getMessageThread, sendMessage, markMessagesRead, deleteConversation } from '../../api';
import { translations } from '../../i18n';

// Revoke any blob: URLs owned by an optimistic message. Server URLs (e.g.
// /api/messages/media/...) are skipped, so this is always safe to call on
// any message shape — including server-only rows that have media_urls.
//
// media_urls is stored as a JSON string in the DB / API but our optimistic
// path also writes it as the same JSON string format, so a single parse
// handles both. If parsing fails we bail silently — we'd rather leak a URL
// than throw inside a state setter.
function revokeBlobMediaUrls(message) {
  if (!message || !message.media_urls) return;
  let urls;
  try {
    urls = typeof message.media_urls === 'string'
      ? JSON.parse(message.media_urls)
      : message.media_urls;
  } catch { return; }
  if (!Array.isArray(urls)) return;
  for (const url of urls) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch {}
    }
  }
}

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

  // Mirror current messageMap into a ref so the unmount-only cleanup effect
  // can read the latest blob URLs without taking a dep on messageMap (which
  // would re-run the cleanup on every change and prematurely revoke URLs
  // that are still visible).
  const messageMapRef = useRef(messageMap);
  useEffect(() => { messageMapRef.current = messageMap; }, [messageMap]);
  useEffect(() => () => {
    // On unmount (logout, full app close, route change away from inbox),
    // revoke every blob: URL still pinned by an optimistic message. Server
    // URLs are skipped by the helper. Wrapped in try/catch via the helper
    // so a malformed message never crashes the cleanup.
    for (const msgs of Object.values(messageMapRef.current)) {
      if (Array.isArray(msgs)) msgs.forEach(revokeBlobMediaUrls);
    }
  }, []);

  // ── Load + poll conversation list ──────────────────────────────────────────
  // MERGE policy: we never just replace `conversations` with the server list,
  // because that would wipe out locally-added "pending" conversations whose
  // first message is still mid-flight on a slow backend. Pending conversations
  // are kept until the server reports the same phone (then we drop the
  // pending copy and use the server's version).
  useEffect(() => {
    let cancelled = false;

    function fetchConversations() {
      getConversations()
        .then(serverList => {
          if (cancelled) return;
          setConversations(prev => {
            const serverPhones = new Set(serverList.map(c => c.phone));
            const localPending = prev.filter(c => c.pending && !serverPhones.has(c.phone));
            return [...localPending, ...serverList];
          });
        })
        .catch(err => console.error('[Inbox] Failed to load conversations:', err))
        .finally(() => { if (!cancelled) setLoading(false); });
    }

    fetchConversations();
    const interval = setInterval(fetchConversations, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const selected = conversations.find(c => c.id === selectedId) ?? null;
  const messages = selectedId ? (messageMap[selectedId] ?? null) : null;

  // ── Poll the open thread ───────────────────────────────────────────────────
  // MERGE policy: in-flight ('sending') and persistent ('failed') optimistic
  // messages are preserved across polls. Once an optimistic message has been
  // patched with the server's real id (success path), the next poll's
  // serverIds set contains it and the optimistic copy is dropped, leaving
  // the server row as the source of truth.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;

    function fetchThread() {
      getMessageThread(selectedId)
        .then(serverMsgs => {
          if (cancelled) return;
          setMessageMap(prev => {
            const local     = prev[selectedId] || [];
            const serverIds = new Set(serverMsgs.map(m => m.id));
            const stillLocal = local.filter(m =>
              m.clientTempId
              && !serverIds.has(m.id)
              && (m.status === 'sending' || m.status === 'failed')
            );
            // Anything in `local` that we're NOT keeping is being replaced
            // by a server row (or is just stale). Revoke any blob URLs the
            // dropped messages owned — the SafeImage rendering them will
            // unmount in the upcoming commit, so the underlying File data
            // no longer needs to be pinned. Skips non-blob URLs by design.
            const keepIds = new Set(stillLocal.map(m => m.id));
            for (const m of local) {
              if (!keepIds.has(m.id)) revokeBlobMediaUrls(m);
            }
            return { ...prev, [selectedId]: [...serverMsgs, ...stillLocal] };
          });
        })
        .catch(err => console.error('[Inbox] Failed to load thread:', err));
    }

    fetchThread();
    const interval = setInterval(fetchThread, 5_000);
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
  // Optimistic-first: the message bubble appears IMMEDIATELY with status
  // 'sending', then transitions to 'sent' or 'failed' once the API resolves.
  // Failed messages stay visible (with the error) so the user can see what
  // happened instead of having the bubble silently disappear.
  const handleSend = useCallback((text, files = []) => {
    if (!selectedId || (!text.trim() && files.length === 0)) return;

    const clientTempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nowIso = new Date().toISOString();
    const optimisticMediaUrls = files.length > 0
      ? JSON.stringify(files.map(f => URL.createObjectURL(f)))
      : null;

    const optimisticMsg = {
      id:           clientTempId,
      clientTempId,
      status:       'sending',
      body:         text.trim(),
      media_urls:   optimisticMediaUrls,
      direction:    'outbound',
      created_at:   nowIso,
    };

    setMessageMap(prev => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] ?? []), optimisticMsg],
    }));
    setConversations(prev => prev.map(c =>
      c.id === selectedId
        ? { ...c, lastMessage: text.trim() || '📷 Photo', lastMessageDir: 'outbound', timestamp: nowIso }
        : c
    ));

    // Fire-and-forget. On resolution we patch the optimistic message in place
    // (still identified by clientTempId) rather than removing+inserting, so
    // its DOM position is stable and there's no flicker.
    sendMessage(selectedId, text.trim(), files)
      .then(result => {
        setMessageMap(prev => ({
          ...prev,
          [selectedId]: (prev[selectedId] ?? []).map(m =>
            m.clientTempId === clientTempId
              ? { ...m, status: 'sent', id: result?.id ?? m.id, twilio_sid: result?.sid ?? null }
              : m
          ),
        }));
      })
      .catch(err => {
        console.error('[Inbox] Send failed:', err.message);
        setMessageMap(prev => ({
          ...prev,
          [selectedId]: (prev[selectedId] ?? []).map(m =>
            m.clientTempId === clientTempId
              ? { ...m, status: 'failed', errorMessage: err.message || 'Failed to send' }
              : m
          ),
        }));
      });
  }, [selectedId]);

  // ── Compose: start a new conversation or open an existing one ──────────────
  //
  // Optimistic-first: synchronously
  //   1. Adds (or reuses) the conversation in local state, flagged `pending`
  //      if new so the conv-list poll's merge keeps it until the server has it
  //   2. Selects it and switches mobileView to 'thread' so the user lands in
  //      the thread immediately — no 4-5 s wait for the round trip
  //   3. Appends the outbound message with status='sending'
  //
  // Then fires sendMessage in the background. On success the optimistic
  // message is patched to status='sent' with the real id (the next thread
  // poll naturally consolidates it). On failure the optimistic message is
  // patched to status='failed' with the error text; the bubble stays in the
  // thread so the user can see what happened.
  //
  // Client-side validation (international, blank, etc.) runs in the modal
  // BEFORE onSend is invoked, so by the time we get here the recipient is
  // already known-good.
  const handleComposeSend = useCallback((phone, text, files = []) => {
    const normalizedPhone = phone.trim();
    const clientTempId    = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nowIso          = new Date().toISOString();
    const optimisticMediaUrls = files.length > 0
      ? JSON.stringify(files.map(f => URL.createObjectURL(f)))
      : null;

    const existing = conversations.find(c => c.phone === normalizedPhone);
    const targetId = existing ? existing.id : normalizedPhone;

    // 1. Conversation — add as pending if new; update preview if existing.
    if (existing) {
      setConversations(prev => prev.map(c =>
        c.id === existing.id
          ? { ...c, lastMessage: text.trim() || '📷 Photo', lastMessageDir: 'outbound', timestamp: nowIso }
          : c
      ));
    } else {
      setConversations(prev => [
        {
          id:             normalizedPhone,
          phone:          normalizedPhone,
          name:           normalizedPhone,
          lastMessage:    text.trim() || (files.length > 0 ? '📷 Photo' : ''),
          lastMessageDir: 'outbound',
          timestamp:      nowIso,
          unread:         0,
          pending:        true,
        },
        ...prev,
      ]);
    }

    // 2. Optimistic message — appended to the thread.
    const optimisticMsg = {
      id:           clientTempId,
      clientTempId,
      status:       'sending',
      body:         text.trim(),
      media_urls:   optimisticMediaUrls,
      direction:    'outbound',
      created_at:   nowIso,
    };
    setMessageMap(prev => ({
      ...prev,
      [targetId]: [...(prev[targetId] ?? []), optimisticMsg],
    }));

    // 3. Navigate immediately. For existing convs handleSelect resets unread
    //    + marks-read on the backend; for brand-new convs that's a harmless
    //    no-op (the endpoint just zero-touches a phone with no inbound).
    handleSelect(targetId);

    // 4. Background send — patch optimistic in place once it resolves.
    sendMessage(normalizedPhone, text.trim(), files)
      .then(result => {
        setMessageMap(prev => ({
          ...prev,
          [targetId]: (prev[targetId] ?? []).map(m =>
            m.clientTempId === clientTempId
              ? { ...m, status: 'sent', id: result?.id ?? m.id, twilio_sid: result?.sid ?? null }
              : m
          ),
        }));
      })
      .catch(err => {
        console.error('[Inbox] Compose send failed:', err.message);
        setMessageMap(prev => ({
          ...prev,
          [targetId]: (prev[targetId] ?? []).map(m =>
            m.clientTempId === clientTempId
              ? { ...m, status: 'failed', errorMessage: err.message || 'Failed to send' }
              : m
          ),
        }));
      });
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
        // Revoke any optimistic blob URLs in this conv's messages before
        // dropping them — once the entry is removed, those URLs would
        // become unreachable from any state and the underlying File data
        // would be pinned for the rest of the session.
        const dropping = prev[id] || [];
        for (const m of dropping) revokeBlobMediaUrls(m);
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
