'use strict';
/**
 * Sentry privacy settings for the backend.
 *
 * @sentry/node's defaults attach request cookies, headers (incl.
 * Authorization: Bearer <session>), bodies and query strings to error events,
 * and tracing spans record full URLs. That would send session tokens, OAuth
 * codes/state, Gmail launch tickets and submitted text to Sentry. These options
 * turn that off and strip every query string and fragment from URLs that are
 * still reported.
 */

const URL_KEYS   = ['url', 'http.url', 'url.full', 'http.target', 'to', 'from'];
const QUERY_KEYS = ['http.query', 'url.query', 'http.fragment', 'url.fragment', 'query_string'];

const stripUrl = (u) => (typeof u === 'string' ? u.split(/[?#]/)[0] : u);

function scrubData(d) {
  if (!d || typeof d !== 'object') return;
  for (const k of URL_KEYS) if (k in d) d[k] = stripUrl(d[k]);
  for (const k of QUERY_KEYS) if (k in d) delete d[k];
}

function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.url) event.request.url = stripUrl(event.request.url);
  }
  if (typeof event.transaction === 'string') event.transaction = stripUrl(event.transaction);
  if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.filter(b => b?.category !== 'console');
  for (const b of event.breadcrumbs || []) scrubData(b?.data);
  for (const sp of event.spans || []) {
    scrubData(sp?.data);
    if (typeof sp?.description === 'string') sp.description = stripUrl(sp.description);
  }
  scrubData(event.contexts?.trace?.data);
  return event;
}

function scrubBreadcrumb(b) {
  // Console breadcrumbs carry raw log text (addresses, subjects, previews).
  if (b?.category === 'console') return null;
  scrubData(b?.data);
  return b;
}

/** Options merged into Sentry.init in index.js. */
function sentryPrivacyOptions(Sentry) {
  return {
    sendDefaultPii: false,
    integrations: [
      Sentry.requestDataIntegration({ include: { cookies: false, data: false, headers: false, query_string: false, ip: false } }),
      Sentry.httpIntegration({
        maxIncomingRequestBodySize: 'none',
        // OAuth endpoints carry codes, state, tickets and handles: never traced.
        ignoreIncomingRequests: (urlPath) => typeof urlPath === 'string' && urlPath.startsWith('/auth/'),
        ignoreOutgoingRequests: (url) => typeof url === 'string' && /(^|\/\/)(oauth2\.googleapis\.com|accounts\.google\.com)/.test(url),
      }),
    ],
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

module.exports = { scrubEvent, scrubBreadcrumb, sentryPrivacyOptions, stripUrl };
