import { useState, useEffect } from 'react';
import { getCalls, getEmails } from '../api';
import { normalizeCall, normalizeEmail } from './timeline/normalizeEvent';
import EventRow from './timeline/EventRow';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDateLabel(dateStr) {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yestStart  = new Date(todayStart);
  yestStart.setDate(todayStart.getDate() - 1);
  if (date >= todayStart) return 'Today';
  if (date >= yestStart)  return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function groupByDate(events) {
  const groups = [];
  const seen = new Map();
  for (const event of events) {
    const label = getDateLabel(event.timestamp);
    if (!seen.has(label)) {
      seen.set(label, groups.length);
      groups.push({ label, events: [] });
    }
    groups[seen.get(label)].events.push(event);
  }
  return groups;
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-start gap-3 px-4 py-3 animate-pulse">
      <div className="w-8 h-8 rounded-lg bg-gray-100 shrink-0" />
      <div className="flex-1 space-y-2 pt-0.5">
        <div className="flex items-center justify-between">
          <div className="h-3 w-28 bg-gray-100 rounded-full" />
          <div className="h-2.5 w-10 bg-gray-100 rounded-full" />
        </div>
        <div className="h-2.5 w-20 bg-gray-100 rounded-full" />
        <div className="h-2.5 w-44 bg-gray-100 rounded-full" />
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      {[4, 3].map((count, gi) => (
        <div key={gi}>
          {/* Date header skeleton */}
          <div className="flex items-center gap-3 mb-2 px-1 animate-pulse">
            <div className="h-2.5 w-14 bg-gray-100 rounded-full" />
            <div className="flex-1 h-px bg-gray-100" />
            <div className="h-2.5 w-4 bg-gray-100 rounded-full" />
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            {Array.from({ length: count }).map((_, i) => (
              <div key={i}>
                {i > 0 && <div className="h-px bg-gray-50 mx-4" />}
                <SkeletonRow />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20">
      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mb-3">
        <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <p className="text-sm font-medium text-gray-500">No activity yet</p>
      <p className="text-xs text-gray-400 mt-1">Calls and messages will appear here</p>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TimelinePage({ onContactClick }) {
  const [events,     setEvents]     = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    Promise.all([getCalls(), getEmails()])
      .then(([calls, emails]) => {
        const all = [
          ...calls.map(normalizeCall),
          ...emails.map(normalizeEmail),
        ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        setEvents(all);
      })
      .catch(err => console.error('[Timeline] fetch failed:', err))
      .finally(() => setLoading(false));
  }, []);

  const groups = groupByDate(events);

  return (
    <div className="max-w-lg w-full">

      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Timeline</h1>
        <p className="text-sm text-gray-400 mt-0.5">All activity in one place</p>
      </div>

      {loading ? (
        <LoadingSkeleton />
      ) : events.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.label}>

              {/* Date group header: label + rule + event count */}
              <div className="flex items-center gap-3 mb-2 px-1">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest whitespace-nowrap">
                  {group.label}
                </span>
                <div className="flex-1 h-px bg-gray-100" />
                <span className="text-[11px] text-gray-300 tabular-nums">
                  {group.events.length}
                </span>
              </div>

              {/* Event card */}
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                {group.events.map((event, idx) => (
                  <div key={event.id}>
                    {idx > 0 && <div className="h-px bg-gray-50 mx-4" />}
                    <EventRow
                      event={event}
                      expanded={expandedId === event.id}
                      onToggle={() => setExpandedId(expandedId === event.id ? null : event.id)}
                      onContactClick={onContactClick}
                    />
                  </div>
                ))}
              </div>

            </div>
          ))}

          <div className="h-6" />
        </div>
      )}
    </div>
  );
}
