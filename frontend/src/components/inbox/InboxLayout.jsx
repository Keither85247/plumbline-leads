import { useState, useCallback } from 'react';
import ConversationList from './ConversationList';
import MessageThread from './MessageThread';
import LeadDetailsPanel from './LeadDetailsPanel';
import NewMessageModal from './NewMessageModal';
import { MOCK_CONVERSATIONS, MOCK_MESSAGES } from './mockData';

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
// Top-level state manager for the inbox. Owns:
//   - selected conversation id
//   - message map (local for now, replace with API calls)
//   - mobile panel visibility ('list' | 'thread')
//   - right details panel toggle
//
// When wired to a real backend, replace MOCK_CONVERSATIONS / MOCK_MESSAGES
// with useSWR/useQuery calls and pass `loading` down to ConversationList.

export default function InboxLayout() {
  const [conversations, setConversations]   = useState(MOCK_CONVERSATIONS);
  const [messageMap,    setMessageMap]       = useState(MOCK_MESSAGES);
  const [selectedId,    setSelectedId]       = useState(null);
  const [showDetails,   setShowDetails]      = useState(true);
  const [mobileView,    setMobileView]       = useState('list'); // 'list' | 'thread'
  const [composeOpen,   setComposeOpen]      = useState(false);

  const selected = conversations.find(c => c.id === selectedId) ?? null;
  const messages = selectedId ? (messageMap[selectedId] ?? []) : [];

  const handleSelect = useCallback((id) => {
    setSelectedId(id);
    setMobileView('thread');
    // Mark as read locally; replace with PATCH /api/conversations/:id/read
    setConversations(prev => prev.map(c => c.id === id ? { ...c, unread: 0 } : c));
  }, []);

  const handleBack = useCallback(() => {
    setMobileView('list');
  }, []);

  const handleSend = useCallback((text) => {
    if (!selectedId || !text.trim()) return;
    const msg = {
      id:        `msg-${Date.now()}`,
      body:      text.trim(),
      direction: 'outbound',
      ts:        new Date().toISOString(),
    };
    // Optimistic update — replace with POST /api/messages
    setMessageMap(prev => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] ?? []), msg],
    }));
    setConversations(prev => prev.map(c =>
      c.id === selectedId
        ? { ...c, lastMessage: text.trim(), lastMessageDir: 'outbound', timestamp: new Date().toISOString() }
        : c
    ));
  }, [selectedId]);

  // Called from NewMessageModal — creates (or selects existing) conversation + sends first message
  const handleComposeSend = useCallback((phone, text) => {
    const normalized = phone.trim();
    const existing = conversations.find(c => c.phone === normalized);

    if (existing) {
      handleSelect(existing.id);
      // Append message to existing thread directly (selectedId may not be updated yet)
      const msg = {
        id:        `msg-${Date.now()}`,
        body:      text.trim(),
        direction: 'outbound',
        ts:        new Date().toISOString(),
      };
      setMessageMap(prev => ({
        ...prev,
        [existing.id]: [...(prev[existing.id] ?? []), msg],
      }));
    } else {
      // Create a new stub conversation
      const newId = `conv-new-${Date.now()}`;
      const newConv = {
        id:             newId,
        name:           normalized,
        phone:          normalized,
        lastMessage:    text,
        lastMessageDir: 'outbound',
        timestamp:      new Date().toISOString(),
        unread:         0,
      };
      const firstMsg = {
        id:        `msg-${Date.now()}`,
        body:      text,
        direction: 'outbound',
        ts:        new Date().toISOString(),
      };
      setConversations(prev => [newConv, ...prev]);
      setMessageMap(prev => ({ ...prev, [newId]: [firstMsg] }));
      setSelectedId(newId);
      setMobileView('thread');
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
              messages={messages}
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
