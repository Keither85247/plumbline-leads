// Vercel serverless proxy
// ─────────────────────────────────────────────────────────────────────────────
// All /api/* requests are handled here automatically by Vercel's function routing.
// /auth/* requests are rewritten to /api/auth/* (see vercel.json) so they also
// land here with 'auth' as the first path segment.
//
// Why this exists: Safari's ITP blocks SameSite=None cookies from third-party
// domains (onrender.com). By proxying through Vercel, the browser only ever
// talks to plumbline-leads.vercel.app. The session cookie is stored as a
// first-party cookie on that domain — ITP has no objection.
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  api: { bodyParser: false }, // stream raw body through unchanged (required for multipart/form-data)
};

const BACKEND = 'https://plumbline-leads.onrender.com';

// Headers that must not be forwarded upstream (Vercel internals / hop-by-hop)
const DROP_REQUEST_HEADERS = new Set([
  'host', 'x-forwarded-host', 'x-vercel-id', 'x-vercel-deployment-url',
  'x-vercel-forwarded-for', 'x-real-ip',
]);

// Headers that must not be forwarded to the browser (hop-by-hop)
const DROP_RESPONSE_HEADERS = new Set([
  'transfer-encoding', 'connection', 'keep-alive', 'upgrade',
]);

function bufferBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // req.query.path is an array from the catch-all segment, e.g. ['leads'] or ['auth', 'login']
  const parts = Array.isArray(req.query.path)
    ? req.query.path
    : String(req.query.path || '').split('/').filter(Boolean);

  // /auth/* was rewritten to /api/auth/* — detect by first segment
  let targetUrl;
  if (parts[0] === 'auth') {
    targetUrl = `${BACKEND}/auth/${parts.slice(1).join('/')}`;
  } else {
    targetUrl = `${BACKEND}/api/${parts.join('/')}`;
  }

  // Preserve query string
  const qIdx = req.url.indexOf('?');
  if (qIdx !== -1) targetUrl += req.url.slice(qIdx);

  // Build upstream request headers
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }

  // Buffer body for non-GET requests (handles JSON, form-data, multipart)
  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    body = await bufferBody(req);
  }

  // Forward to Render
  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body?.length ? body : undefined,
    });
  } catch (err) {
    console.error('[proxy] fetch failed:', err.message);
    res.status(502).json({ error: 'Backend unreachable' });
    return;
  }

  // Forward response status
  res.status(upstream.status);

  // Forward response headers (including Set-Cookie so the session cookie reaches the browser)
  for (const [k, v] of upstream.headers.entries()) {
    if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      res.setHeader(k, v);
    }
  }

  // Forward response body
  const buf = await upstream.arrayBuffer();
  res.end(Buffer.from(buf));
}
