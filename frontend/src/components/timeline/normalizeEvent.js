// ── Timeline event normalization ────────────────────────────────────────────
//
// Maps raw records from the API into a clean, typed event shape consumed by
// EventRow. All conditional logic lives here so EventRow stays declarative.
//
// Call data model notes (from backend/routes/calls.js):
//   - `from_number`    = customer's phone for BOTH inbound and outbound calls
//   - `classification` = direction ('Outbound') OR lead category for inbound calls
//   - `outcome`        = 'answered' | 'voicemail' | 'no-answer' | null  (outbound only)
//   - `transcript`     = non-null iff the call was answered + AI-transcribed
// ─────────────────────────────────────────────────────────────────────────────

export const EVENT_TYPES = {
  INBOUND_ANSWERED:   'call-inbound-answered',
  INBOUND_MISSED:     'call-inbound-missed',
  OUTBOUND_ANSWERED:  'call-outbound-answered',
  OUTBOUND_VOICEMAIL: 'call-outbound-voicemail',
  OUTBOUND_NO_ANSWER: 'call-outbound-no-answer',
  OUTBOUND_UNKNOWN:   'call-outbound',
  INBOUND_EMAIL:      'email-inbound',
  OUTBOUND_EMAIL:     'email-outbound',
  INBOUND_SMS:        'sms-inbound',
  OUTBOUND_SMS:       'sms-outbound',
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
  [EVENT_TYPES.INBOUND_EMAIL]: {
    label: 'Email Received',
    labelColor: 'text-violet-600',
    iconBg: 'bg-violet-50',
    iconColor: 'text-violet-500',
    showDuration: false,
    iconType: 'email',
  },
  [EVENT_TYPES.OUTBOUND_EMAIL]: {
    label: 'Email Sent',
    labelColor: 'text-violet-600',
    iconBg: 'bg-violet-50',
    iconColor: 'text-violet-500',
    showDuration: false,
    iconType: 'email-out',
  },
  [EVENT_TYPES.INBOUND_SMS]: {
    label: 'Text Received',
    labelColor: 'text-teal-600',
    iconBg: 'bg-teal-50',
    iconColor: 'text-teal-500',
    showDuration: false,
    iconType: 'sms',
  },
  [EVENT_TYPES.OUTBOUND_SMS]: {
    label: 'Text Sent',
    labelColor: 'text-teal-600',
    iconBg: 'bg-teal-50',
    iconColor: 'text-teal-500',
    showDuration: false,
    iconType: 'sms-out',
  },
};

// ── normalizeCall ─────────────────────────────────────────────────────────────

function resolveCallType(call) {
  if (call.classification === 'Outbound') {
    switch (call.outcome) {
      case 'answered':  return EVENT_TYPES.OUTBOUND_ANSWERED;
      case 'voicemail': return EVENT_TYPES.OUTBOUND_VOICEMAIL;
      case 'no-answer': return EVENT_TYPES.OUTBOUND_NO_ANSWER;
      default:
        // Outbound calls that were recorded + transcribed = answered
        return call.transcript ? EVENT_TYPES.OUTBOUND_ANSWERED : EVENT_TYPES.OUTBOUND_UNKNOWN;
    }
  }
  // Inbound: transcript OR duration > 0 = answered.
  // Duration is set by the recording webhook; transcript may be missing if
  // the call was short or the AI pipeline failed, but duration is reliable.
  return (call.transcript || call.duration > 0)
    ? EVENT_TYPES.INBOUND_ANSWERED
    : EVENT_TYPES.INBOUND_MISSED;
}

export function normalizeCall(call) {
  const isOutbound = call.classification === 'Outbound';
  const type = resolveCallType(call);
  const keyPoints = Array.isArray(call.key_points) ? call.key_points : [];

  // Classification badge only makes sense for inbound calls (it's the lead category).
  const classification = isOutbound ? null : (call.classification || null);

  const hasContent = !!(call.summary || call.contractor_note || keyPoints.length > 0);

  return {
    id:              call.id,
    type,
    isOutbound,
    contactName:     call.contact_name  || null,
    contactPhone:    call.from_number   || '',
    contactEmail:    null,
    subject:         null,
    summary:         call.summary         || null,
    note:            call.contractor_note || null,
    keyPoints,
    timestamp:       call.created_at,
    durationSeconds: call.duration        || null,
    classification,
    isExpandable: hasContent,
  };
}

// ── normalizeSms ──────────────────────────────────────────────────────────────

export function normalizeSms(msg) {
  const isOutbound = msg.direction === 'outbound';
  const type = isOutbound ? EVENT_TYPES.OUTBOUND_SMS : EVENT_TYPES.INBOUND_SMS;

  return {
    id:              `sms-${msg.id}`,
    type,
    isOutbound,
    contactName:     msg.contact_name || null,
    contactPhone:    msg.phone || '',
    contactEmail:    null,
    subject:         null,
    summary:         msg.body || null,
    note:            null,
    keyPoints:       [],
    timestamp:       msg.created_at,
    durationSeconds: null,
    classification:  null,
    isExpandable:    !!(msg.body),
  };
}

// ── normalizeEmail ────────────────────────────────────────────────────────────

export function normalizeEmail(email) {
  const isOutbound = email.direction === 'outbound';
  const type = isOutbound ? EVENT_TYPES.OUTBOUND_EMAIL : EVENT_TYPES.INBOUND_EMAIL;

  // Counterpart address — who sent to us (inbound) or who we sent to (outbound)
  const contactEmail = isOutbound ? (email.to_address || '') : (email.from_address || '');

  // contact_name is resolved server-side by matching the counterpart address
  // against contacts.email and joining with leads for the human name.
  // When present it becomes the primary display label; the raw email address
  // is shown as smaller secondary text (handled in EventRow via showEmailAddr).
  const contactName = email.contact_name || null;

  return {
    id:              `email-${email.id}`,
    type,
    isOutbound,
    contactName,
    contactPhone:    email.phone   || '',
    contactEmail,
    subject:         email.subject || null,
    summary:         email.body_preview || email.subject || null,
    note:            null,
    keyPoints:       [],
    timestamp:       email.created_at,
    durationSeconds: null,
    classification:  null,
    isExpandable:    !!(email.subject || email.body_preview),
  };
}
