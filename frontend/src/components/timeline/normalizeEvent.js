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
  INBOUND_VOICEMAIL:  'call-inbound-voicemail',   // missed + caller left voicemail
  OUTBOUND_ANSWERED:  'call-outbound-answered',
  OUTBOUND_VOICEMAIL: 'call-outbound-voicemail',
  OUTBOUND_NO_ANSWER: 'call-outbound-no-answer',
  OUTBOUND_UNKNOWN:   'call-outbound',
  INBOUND_EMAIL:      'email-inbound',
  OUTBOUND_EMAIL:     'email-outbound',
  INBOUND_SMS:        'sms-inbound',
  OUTBOUND_SMS:       'sms-outbound',
  SMS_THREAD:         'sms-thread',
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
  [EVENT_TYPES.INBOUND_VOICEMAIL]:  {
    label: 'Left a Voicemail',
    labelColor: 'text-amber-600',
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-500',
    showDuration: false,
    iconType: 'voicemail',
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
  [EVENT_TYPES.SMS_THREAD]: {
    label: 'Text Conversation',
    labelColor: 'text-teal-600',
    iconBg: 'bg-teal-50',
    iconColor: 'text-teal-500',
    showDuration: false,
    iconType: 'sms',
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
  const answered = !!(call.transcript || call.duration > 0);
  if (!answered && call.voicemail_lead_id) return EVENT_TYPES.INBOUND_VOICEMAIL;
  return answered ? EVENT_TYPES.INBOUND_ANSWERED : EVENT_TYPES.INBOUND_MISSED;
}

export function normalizeCall(call) {
  const isOutbound = call.classification === 'Outbound';
  const type = resolveCallType(call);
  const isInboundVoicemail = type === EVENT_TYPES.INBOUND_VOICEMAIL;

  // For inbound voicemail calls, prefer the voicemail lead's summary/key_points
  // since the calls row itself has no AI output (the recording was never answered).
  const keyPoints = isInboundVoicemail
    ? (Array.isArray(call.voicemail_key_points) ? call.voicemail_key_points : [])
    : (Array.isArray(call.key_points) ? call.key_points : []);

  const summary = isInboundVoicemail
    ? (call.voicemail_summary || null)
    : (call.summary || null);

  // Classification badge only makes sense for inbound calls (it's the lead category).
  const classification = isOutbound ? null : (call.classification || null);

  // A call with a recording is expandable even when the AI pipeline produced
  // no summary/key points (e.g. short call, pipeline failure, or outbound call
  // with no contractor note but with a Twilio recording).
  const effectiveRecordingUrl = isInboundVoicemail
    ? null  // voicemail recording is on the lead, handled separately via voicemailLeadId
    : (call.recording_url || null);

  const hasContent = !!(summary || call.contractor_note || keyPoints.length > 0
    || effectiveRecordingUrl || (isInboundVoicemail && call.voicemail_recording_url));

  return {
    id:                   call.id,
    type,
    isOutbound,
    contactName:          call.contact_name  || null,
    contactPhone:         call.from_number   || '',
    contactEmail:         null,
    subject:              null,
    summary,
    note:                 call.contractor_note || null,
    keyPoints,
    timestamp:            call.created_at,
    durationSeconds:      call.duration        || null,
    classification,
    isExpandable:         hasContent,
    recordingUrl:         effectiveRecordingUrl,
    // Voicemail-specific: lets EventRow load the recording via the leads proxy
    voicemailLeadId:      call.voicemail_lead_id       || null,
    voicemailRecordingUrl: call.voicemail_recording_url || null,
  };
}

// ── normalizeSmsThread ────────────────────────────────────────────────────────
// Collapses an entire conversation into a single timeline entry.
// `conversation` comes from GET /api/messages (one row per phone).
// `messages`     comes from GET /api/messages/:phone (full thread, oldest first).

export function normalizeSmsThread(conversation, messages = []) {
  // conversation.name is either the contact name or falls back to the phone number
  const contactName = conversation.name && conversation.name !== conversation.phone
    ? conversation.name
    : null;

  return {
    id:              `sms-thread-${conversation.phone}`,
    type:            EVENT_TYPES.SMS_THREAD,
    isOutbound:      conversation.lastMessageDir === 'outbound',
    contactName,
    contactPhone:    conversation.phone,
    contactEmail:    null,
    subject:         null,
    summary:         conversation.lastMessage || null,  // latest message preview
    note:            null,
    keyPoints:       [],
    timestamp:       conversation.timestamp,
    durationSeconds: null,
    classification:  null,
    isExpandable:    messages.length > 0,
    // Thread-specific fields consumed by EventRow's sms-thread expand section
    messageCount:    messages.length,
    unreadCount:     conversation.unread || 0,
    messages,
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
