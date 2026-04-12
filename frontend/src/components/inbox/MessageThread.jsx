import { useEffect, useRef } from 'react';
import MessageBubble, { DaySeparator } from './MessageBubble';
import MessageInput from './MessageInput';
import { parseTimestamp } from '../../utils/phone';

// Normalize message: real API rows have `created_at`; legacy/mock used `ts`
function msgTs(msg) {
  return msg.ts || msg.created_at || null;
}

function formatPhone(num) {
  if (!num) return '';
  const d = num.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return num;
}

// Group consecutive messages from the same sender within 5 minutes.
// Each group = { direction, messages[] }
function groupMessages(messages) {
  const groups = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    const ts = parseTimestamp(msgTs(msg)).getTime();
    const lastTs = last ? parseTimestamp(msgTs(last.messages[last.messages.length - 1])).getTime() : 0;
    if (last && last.direction === msg.direction && ts - lastTs < 5 * 60 * 1000) {
      last.messages.push(msg);
    } else {
      groups.push({ direction: msg.direction, messages: [msg] });
    }
  }
  return groups;
}

// Inject day separators between message groups that cross a calendar day boundary
function withDaySeparators(groups) {
  const result = [];
  let lastDay = null;
  for (const group of groups) {
    const day = parseTimestamp(msgTs(group.messages[0])).toDateString();
    if (day !== lastDay) {
      result.push({ type: 'separator', ts: msgTs(group.messages[0]) });
      lastDay = day;
    }
    result.push({ type: 'group', ...group });
  }
  return result;
}

function MessageSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-5 py-6 animate-pulse">
      <div className="flex items-end gap-2">
        <div className="h-8 w-48 bg-gray-100 rounded-2xl rounded-bl-[4px]" />
      </div>
      <div className="flex items-end gap-2 justify-end">
        <div className="h-8 w-56 bg-blue-50 rounded-2xl rounded-br-[4px]" />
      </div>
      <div className="flex items-end gap-2">
        <div className="h-8 w-36 bg-gray-100 rounded-2xl rounded-bl-[4px]" />
      </div>
      <div className="flex items-end gap-2 justify-end">
        <div className="h-8 w-64 bg-blue-50 rounded-2xl rounded-br-[4px]" />
      </div>
    </div>
  );
}

export default function MessageThread({
  conversation,
  messages,
  onSend,
  onBack,
  showDetails,
  onToggleDetails,
  loading = false,
}) {
  const bottomRef = useRef(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const items = withDaySeparators(groupMessages(messages));

  return (
    <div className="flex flex-col h-full min-w-0 pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0">

      {/* ── Thread header ──────────────────────────────────────────────────── */}
      <div className="shrink-0 h-14 border-b border-gray-100 flex items-center px-4 gap-3 bg-white">

        {/* Back button — mobile only */}
        <button
          onClick={onBack}
          className="md:hidden flex items-center gap-0.5 -ml-1 pl-1 pr-2.5 py-1.5 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors"
          aria-label="Back to inbox"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          <span className="text-sm font-medium">Inbox</span>
        </button>

        {/* Avatar + name */}
        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
          <span className="text-xs font-semibold text-blue-700">
            {conversation.name?.charAt(0).toUpperCase() || '?'}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 leading-tight truncate">
            {conversation.name || conversation.phone}
          </p>
          {conversation.name && (
            <p className="text-xs text-gray-400 leading-tight">{formatPhone(conversation.phone)}</p>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Call button */}
          <button
            className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label="Call contact"
            title="Call (coming soon)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l1.06 3.18a1 1 0 01-.23 1.05L7.5 9.43a16 16 0 006.07 6.07l1.52-1.56a1 1 0 011.05-.23l3.18 1.06a1 1 0 01.68.95V19a2 2 0 01-2 2C9.16 21 3 14.84 3 7V5z" />
            </svg>
          </button>

          {/* Toggle details panel — desktop only */}
          <button
            onClick={onToggleDetails}
            className={`hidden lg:flex p-2 rounded-lg transition-colors ${
              showDetails
                ? 'text-blue-600 bg-blue-50 hover:bg-blue-100'
                : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'
            }`}
            aria-label="Toggle details panel"
            title="Contact details"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Messages ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {loading ? (
          <MessageSkeleton />
        ) : messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <p className="text-xs text-gray-400">No messages yet.</p>
            <p className="text-xs text-gray-400 mt-0.5">Send one below to start the conversation.</p>
          </div>
        ) : (
          <>
            {items.map((item, i) =>
              item.type === 'separator' ? (
                <DaySeparator key={`sep-${i}`} ts={item.ts} />
              ) : (
                item.messages.map((msg, j) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    isFirst={j === 0}
                    isLast={j === item.messages.length - 1}
                  />
                ))
              )
            )}
            {/* Scroll anchor */}
            <div ref={bottomRef} className="h-3" />
          </>
        )}
      </div>

      {/* ── Composer ───────────────────────────────────────────────────────── */}
      <MessageInput
        onSend={onSend}
        placeholder={`Message ${conversation.name?.split(' ')[0] || ''}…`}
      />
    </div>
  );
}
