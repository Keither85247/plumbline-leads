'use strict';
/**
 * Voicemail intent classifier — deterministic, regex-based.
 *
 * Identifies high-confidence vendor / supplier / supply-house voicemails so
 * we can route them away from the Leads tab and into the Vendors/Suppliers
 * surface (contacts table, contact_type='Vendor').
 *
 * Design notes:
 *   • Conservative. Single-word triggers ("parts", "materials") are NOT
 *     enough on their own — homeowners say "I need parts replaced". Each
 *     pattern requires *context* that only a supplier-side caller would use
 *     ("your order is ready", "delivery tomorrow", "P.O. number").
 *   • Score-based. 2+ pattern matches → confident vendor. 1 match → hint
 *     only (returned for logging; AI gets the final call). 0 → no opinion.
 *   • No company-name allow-list. Mentioning "Ferguson" / "Home Depot"
 *     alone isn't enough — a customer can say "I bought it at Home Depot".
 *
 * Returns:
 *   {
 *     intent:     'vendor_supplier' | 'unknown',
 *     confidence: 'high' | 'medium' | 'none',
 *     matched:    string[]   // human-readable pattern names that matched
 *   }
 */

// Each entry: { name, pattern }. `name` is what we log so reviewing
// production logs reveals exactly which phrase tripped the classifier.
const VENDOR_PATTERNS = [
  // Order / parts / materials are READY (caller is informing the contractor)
  { name: 'order-ready',           pattern: /\b(your\s+)?(order|parts?|materials?|shipment)\s+(is|are)\s+(ready|in|here|available)\b/i },
  { name: 'ready-for-pickup',      pattern: /\bready\s+for\s+(pick\s*up|collection)\b/i },
  { name: 'come-pick-up',          pattern: /\b(come|stop\s+by)\s+(in|to)\s+(pick\s*up|grab)\s+(your|the)\b/i },

  // Delivery scheduled FROM supplier (not "I need delivery")
  { name: 'delivery-scheduled',    pattern: /\bdelivery\s+(will|should|is\s+scheduled|window|tomorrow|today|on\s+(mon|tue|wed|thu|fri|sat|sun))\b/i },
  { name: 'delivered-to-job',      pattern: /\bdeliver(ed|y)\s+(tomorrow|today|on|to\s+your\s+(job|site|address)|out)\b/i },
  { name: 'on-the-truck',          pattern: /\b(on\s+the|loaded\s+on(to)?\s+the)\s+truck\b/i },

  // Invoice / PO / purchase-side billing
  { name: 'invoice-ready',         pattern: /\binvoice\s+(is\s+(ready|attached)|number|for\s+(materials?|the\s+order|your))/i },
  { name: 'purchase-order',        pattern: /\bpurchase\s+order\b/i },
  { name: 'po-number',             pattern: /\bP\.?\s?O\.?\s+(number|#|\d)/i },

  // Pickup at supplier location
  { name: 'counter-pickup',        pattern: /\bcounter\s+pick\s*up\b/i },
  { name: 'pickup-at-counter',     pattern: /\bpick\s*up\s+at\s+(the\s+)?(counter|warehouse|store|shop|branch|yard)\b/i },
  { name: 'will-call-pickup',      pattern: /\bwill[\s-]?call\s+(order|pick\s*up|window)\b/i },

  // Supplier self-identification
  { name: 'this-is-supplier',      pattern: /\bthis\s+is\s+\w+\s+(supply|supplies|plumbing\s+supply|hardware|distribution|distributor|warehouse)\b/i },
  { name: 'calling-from-supplier', pattern: /\bcalling\s+from\s+\w+\s+(supply|supplies|plumbing\s+supply|hardware|distribution|distributor|warehouse)\b/i },
  { name: 'supply-house',          pattern: /\bsupply\s+(house|company|center)\b/i },

  // Stock / inventory / shipping language
  { name: 'in-stock',              pattern: /\b(now\s+)?(in|out\s+of|back\s+in)\s+stock\b/i },
  { name: 'backorder',             pattern: /\bback[\s-]?order(ed)?\b/i },
  { name: 'shipment-status',       pattern: /\bshipment\s+(arrived|will\s+arrive|tracking|status|en\s+route)\b/i },
  { name: 'shipped-today',         pattern: /\bshipped\s+(today|out|tomorrow|this\s+(morning|afternoon))\b/i },
  { name: 'tracking-number',       pattern: /\btracking\s+(number|#)\b/i },

  // Materials FOR the contractor's job (supplier-side phrasing)
  { name: 'materials-arrived',     pattern: /\bmaterials?\s+(are|have)\s+(arrived|come\s+in|landed|been\s+received)\b/i },
  { name: 'materials-for-job',     pattern: /\bmaterials?\s+for\s+(your|the)\s+(job|order|project|address)\b/i },

  // Account / pricing from supplier
  { name: 'account-rep',           pattern: /\baccount\s+(rep|representative|manager|executive)\b/i },
  { name: 'quote-prepared',        pattern: /\b(your|the)\s+quote\s+(is|has\s+been)\s+(ready|prepared|attached)\b/i },
  { name: 'estimate-ready',        pattern: /\bestimate\s+(is\s+ready|has\s+been\s+prepared)\b/i },
];

/**
 * Classify a voicemail transcript.
 *
 * @param {string} transcript
 * @returns {{intent:'vendor_supplier'|'unknown', confidence:'high'|'medium'|'none', matched:string[]}}
 */
function classifyVoicemailIntent(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return { intent: 'unknown', confidence: 'none', matched: [] };
  }

  const matched = [];
  for (const { name, pattern } of VENDOR_PATTERNS) {
    if (pattern.test(transcript)) matched.push(name);
  }

  if (matched.length >= 2) return { intent: 'vendor_supplier', confidence: 'high',   matched };
  if (matched.length === 1) return { intent: 'vendor_supplier', confidence: 'medium', matched };
  return { intent: 'unknown', confidence: 'none', matched: [] };
}

module.exports = { classifyVoicemailIntent };
