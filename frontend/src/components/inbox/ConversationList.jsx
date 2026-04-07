import { useState } from 'react';
import ConversationItem from './ConversationItem';

function SearchIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
    </svg>
  );
}

function ConversationSkeleton() {
  return (
    <div className="px-4 py-3 flex items-start gap-3 animate-pulse">
      <div className="shrink-0 w-9 h-9 rounded-full bg-gray-100" />
      <div className="flex-1 space-y-2 pt-0.5">
        <div className="flex justify-between">
          <div className="h-3 w-28 bg-gray-100 rounded-full" />
          <div className="h-3 w-8 bg-gray-100 rounded-full" />
        </div>
        <div className="h-2.5 w-40 bg-gray-100 rounded-full" />
      </div>
    </div>
  );
}

export default function ConversationList({ conversations, selectedId, onSelect, onCompose, loading = false }) {
  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? conversations.filter(c =>
        c.name?.toLowerCase().includes(query.toLowerCase()) ||
        c.phone?.includes(query) ||
        c.company?.toLowerCase().includes(query.toLowerCase())
      )
    : conversations;

  const unreadCount = conversations.reduce((n, c) => n + (c.unread || 0), 0);

  return (
    <div className="flex flex-col h-full">

      {/* Sidebar header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-900">
            Inbox
            {unreadCount > 0 && (
              <span className="ml-2 text-[10px] font-semibold text-blue-600 bg-blue-50 rounded-full px-1.5 py-0.5">
                {unreadCount}
              </span>
            )}
          </h2>
          {/* Compose button */}
          <button
            onClick={onCompose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer"
            aria-label="New conversation"
            title="New conversation"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
            <SearchIcon />
          </div>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search conversations…"
            className="w-full bg-gray-50 border border-gray-200 rounded-lg pl-8 pr-3 py-2 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 transition-colors"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => <ConversationSkeleton key={i} />)
        ) : filtered.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-xs text-gray-400">
              {query ? 'No results.' : 'No conversations yet.'}
            </p>
          </div>
        ) : (
          <>
            {filtered.map(conv => (
              <div key={conv.id}>
                <ConversationItem
                  conversation={conv}
                  selected={conv.id === selectedId}
                  onClick={() => onSelect(conv.id)}
                />
                {/* Thin divider — skip on selected to avoid double line with border */}
                {conv.id !== selectedId && (
                  <div className="h-px bg-gray-50 mx-4" />
                )}
              </div>
            ))}
            {/* Bottom breathing room */}
            <div className="h-4" />
          </>
        )}
      </div>
    </div>
  );
}
