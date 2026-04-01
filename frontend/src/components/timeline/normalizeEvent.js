// ── Timeline event normalization ────────────────────────────────────────────
//
// Maps raw call records from GET /api/calls into a clean, typed event shape.
// All conditional logic lives here so EventRow stays declarative.
//
// Data model notes (from backend/routes/calls.js):
//   - `from_number`    = customer's phone for BOTH inbound and outbound calls
//   - `classification` = direction ('Outbound') OR lead category for inbound calls
//   - `outcome`        = 'answered' | 'voicemail' | 'no-answer' | null  (outbound only)
//   - `transcript`     = non-null iff the inbound call was answered + AI-transcribed
// ─────────────────────────────────────────────────────────────────────────────

export const EVENT_TYPES = {
  INBOUND_ANSWERED:   'call-inbound-answered',
  INBOUND_MISSED:     'call-inbound-missed',
  OUTBOUND_ANSWERED:  'call-outbound-answered',
  OUTBOUND_VOICEMAIL: 'call-outbound-voicemail',
  OUTBOUND_NO_ANSWER: 'call-outbound-no-answer',
  OUTBOUND_UNKNOWN:   'call-outbound',
};

// Visual metadata per event type.
// Keeps all color/label decisions in one place — EventRow just looks up by type.
export const EVENT_META = {
  [EVENT_TYPES.INBOUND_ANSWERED]:   {
    label: 'Incoming Call',
    labelColor: 'text-blue-600',
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-500',
    showDuration: true,
    iconType: 'phone',
  },
  [EVENT_TYPES.INBOUND_MISSED]:     {
    label: 'Missed Call',
    labelColor: 'text-red-500',
    iconBg: 'bg-red-50',
    iconColor: 'text-red-400',
    showDuration: false,
    iconType: 'phone-missed',
  },
  [EVENT_TYPES.OUTBOUND_ANSWERED]:  {
    label: 'You Called',
    labelColor: 'text-emerald-600',
    iconBg: 'bg-emerald-50',
    iconColor: 'text-emerald-500',
    showDuration: true,
    iconType: 'phone-out',
  },
  [EVENT_TYPES.OUTBOUND_VOICEMAIL]: {
    label: 'Left a Voicemail',
    labelColor: 'text-amber-600',
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-500',
    showDuration: false,
    iconType: 'voicemail',
  },
  [EVENT_TYPES.OUTBOUND_NO_ANSWER]: {
    label: 'No Answer',
    labelColor: 'text-gray-400',
    iconBg: 'bg-gray-100',
    iconColor: 'text-gray-400',
    showDuration: false,
    iconType: 'phone-out',
  },
  [EVENT_TYPES.OUTBOUND_UNKNOWN]:   {
    label: 'Outbound Call',
    labelColor: 'text-gray-400',
    iconBg: 'bg-gray-100',
    iconColor: 'text-gray-400',
    showDuration: true,
    iconType: 'phone-out',
  },
};

function resolveType(call) {
  if (call.classification === 'Outbound') {
    switch (call.outcome) {
      case 'answered':  return EVENT_TYPES.OUTBOUND_ANSWERED;
      case 'voicemail': return EVENT_TYPES.OUTBOUND_VOICEMAIL;
      case 'no-answer': return EVENT_TYPES.OUTBOUND_NO_ANSWER;
      default:          return EVENT_TYPES.OUTBOUND_UNKNOWN;
    }
  }
  // Inbound: transcript present = was answered; absent = call was missed
  return call.transcript ? EVENT_TYPES.INBOUND_ANSWERED : EVENT_TYPES.INBOUND_MISSED;
}

export function normalizeCall(call) {
  const isOutbound = call.classification === 'Outbound';
  const type = resolveType(call);
  const keyPoints = Array.isArray(call.key_points) ? call.key_points : [];

  // Classification badge only makes sense for inbound calls (it's the lead category).
  // For outbound rows classification = 'Outbound' which is directional, not categorical.
  const classification = isOutbound ? null : (call.classification || null);

  const hasContent = !!(call.summary || call.contractor_note || keyPoints.length > 0);

  return {
    id:              call.id,
    type,
    isOutbound,
    contactName:     call.contact_name || null,
    contactPhone:    call.from_number  || '',
    summary:         call.summary         || null,
    note:            call.contractor_note || null,
    keyPoints,
    timestamp:       call.created_at,
    durationSeconds: call.duration        || null,
    classification,
    isExpandable: hasContent,
  };
}
