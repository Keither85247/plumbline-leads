// Single row in the conversation list sidebar.

function formatTimestamp(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1)  return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yestStart  = new Date(todayStart); yestStart.setDate(todayStart.getDate() - 1);
  if (date >= yestStart) return 'Yesterday';
  if (diffHours < 24 * 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ConversationItem({ conversation, selected, onClick }) {
  const { name, phone, lastMessage, lastMessageDir, timestamp, unread, category } = conversation;
  const hasUnread = unread > 0;

  return (
    <button
      onClick={onClick}
      className={`
        w-full text-left px-4 py-3 flex items-start gap-3 transition-colors duration-100
        border-l-2 outline-none
        ${selected
          ? 'bg-gray-50 border-blue-500'
          : 'border-transparent hover:bg-gray-50/70 active:bg-gray-100'}
      `}
    >
      {/* Avatar */}
      <div className={`
        shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold
        ${selected ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}
      `}>
        {name?.charAt(0).toUpperCase() || '?'}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 mb-0.5">
          <span className={`text-sm leading-snug truncate ${hasUnread ? 'font-semibold text-gray-900' : 'font-medium text-gray-800'}`}>
            {name || phone}
          </span>
          <span className="shrink-0 text-[11px] text-gray-400 leading-none">{formatTimestamp(timestamp)}</span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className={`text-xs truncate leading-snug ${hasUnread ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>
            {lastMessageDir === 'outbound' && <span className="text-gray-300 mr-0.5">↑</span>}
            {lastMessage}
          </p>
          {hasUnread && (
            <span className="shrink-0 min-w-[18px] h-[18px] px-1 bg-blue-600 text-white rounded-full text-[10px] font-semibold flex items-center justify-center leading-none">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
