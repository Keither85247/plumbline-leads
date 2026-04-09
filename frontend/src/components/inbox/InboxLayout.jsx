import { useState, useEffect, useCallback } from 'react';
import ConversationList from './ConversationList';
import MessageThread from './MessageThread';
import LeadDetailsPanel from './LeadDetailsPanel';
import NewMessageModal from './NewMessageModal';
import { getConversations, getMessageThread, sendMessage, markMessagesRead } from '../../api';

function EmptyThreadState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8 bg-gray-50/50">
      <div className="w-12 h-12 rounded-2xl bg-white border border-gray-100 shadow-sm flex items-center justify-center">
        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 16a2 2 0 01-2 2H7l-4 4V6a2 2 0 012-2h14a2 2 0 012 2v10z" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium text-gray-600">No conversation selected</p>
        <p className="text-xs text-gray-400 mt-0.5">Choose a contact from the list</p>
      </div>
    </div>
  );
}

// ── InboxLayout ─────────────────────────────────────────────────────────────
// Top-level state manager for the inbox. Fetches real conversations + messages
// from the backend. Send is wired to POST /api/messages/send via Twilio.

export default function InboxLayout() {
  const [conversations, setConversations]   = useState([]);
  const [messageMap,    setMessageMap]       = useState({});
  const [selectedId,    setSelectedId]       = useState(null);
  const [showDetails,   setShowDetails]      = useState(true);
  const [mobileView,    setMobileView]       = useState('list'); // 'list' | 'thread'
  const [composeOpen,   setComposeOpen]      = useState(false);
  const [loading,       setLoading]          = useState(true);

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
  const handleSend = useCallback(async (text) => {
    if (!selectedId || !text.trim()) return;

    // Optimistic UI update first
    const optimisticMsg = {
      id:        `optimistic-${Date.now()}`,
      body:      text.trim(),
      direction: 'outbound',
      created_at: new Date().toISOString(),
    };
    setMessageMap(prev => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] ?? []), optimisticMsg],
    }));
    setConversations(prev => prev.map(c =>
      c.id === selectedId
        ? { ...c, lastMessage: text.trim(), lastMessageDir: 'outbound', timestamp: new Date().toISOString() }
        : c
    ));

    // Real send
    try {
      await sendMessage(selectedId, text.trim());
    } catch (err) {
      console.error('[Inbox] Send failed:', err.message);
      // Remove optimistic message on failure
      setMessageMap(prev => ({
        ...prev,
        [selectedId]: (prev[selectedId] ?? []).filter(m => m.id !== optimisticMsg.id),
      }));
      alert(`Failed to send message: ${err.message}`);
    }
  }, [selectedId]);

  // ── Compose: start a new conversation or open an existing one ──────────────
  const handleComposeSend = useCallback(async (phone, text) => {
    const normalizedPhone = phone.trim();
    const existing = conversations.find(c => c.phone === normalizedPhone);

    if (existing) {
      handleSelect(existing.id);
    } else {
      // Optimistically add the conversation
      const newConv = {
        id:             normalizedPhone,
        phone:          normalizedPhone,
        name:           normalizedPhone,
        lastMessage:    text,
        lastMessageDir: 'outbound',
        timestamp:      new Date().toISOString(),
        unread:         0,
      };
      setConversations(prev => [newConv, ...prev]);
      setMessageMap(prev => ({ ...prev, [normalizedPhone]: [] }));
      setSelectedId(normalizedPhone);
      setMobileView('thread');
    }

    // Send the message (goes through handleSend after selectedId is set,
    // but selectedId state update is async — call sendMessage directly here)
    const targetId = existing ? existing.id : normalizedPhone;
    const optimisticMsg = {
      id:        `optimistic-${Date.now()}`,
      body:      text.trim(),
      direction: 'outbound',
      created_at: new Date().toISOString(),
    };
    setMessageMap(prev => ({
      ...prev,
      [targetId]: [...(prev[targetId] ?? []), optimisticMsg],
    }));

    try {
      await sendMessage(normalizedPhone, text.trim());
    } catch (err) {
      console.error('[Inbox] Compose send failed:', err.message);
      setMessageMap(prev => ({
        ...prev,
        [targetId]: (prev[targetId] ?? []).filter(m => m.id !== optimisticMsg.id),
      }));
      alert(`Failed to send message: ${err.message}`);
    }
  }, [conversations, handleSelect]);

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
          loading={loading}
        />
      </aside>

      {/* ── Center: message thread ──────────────────────────────── */}
      <div className={`
        flex-1 min-w-0 flex flex-col
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
          : <EmptyThreadState />
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
        />
      )}
    </div>
  );
}
