// api/relay.js
//
// Spün MovieBox Relay — Vercel serverless function.
//
// Purpose: MovieBox's mobile API (aoneroom.com / inmoviebox.com hosts) rejects
// requests originating from Cloudflare Workers' egress IPs with HTTP 440/530
// at the transport layer, before the request ever reaches MovieBox's app
// logic. Confirmed via side-by-side testing: identical signed requests (same
// HMAC signature, same bootstrapped bearer token, same timestamp window)
// succeed from a non-Cloudflare IP and fail uniformly across all 7 MovieBox
// mirror hosts from Cloudflare's edge (wrangler tail showed 440/530 on every
// host for the same request that succeeded 6/7 from a residential IP).
//
// This relay is a dumb, generic forwarder — it knows nothing about MovieBox,
// HMAC signing, or auth tokens. The Cloudflare Worker (spun-moviebox) keeps
// doing all of that exactly as before; it just sends the fully-formed,
// already-signed request here instead of directly to MovieBox, and this
// relay re-issues it byte-for-byte from Vercel's IP instead.
//
// Contract:
//   POST /api/relay
//   Body: { "url": "<full target URL>", "method": "GET"|"POST", "headers": {...}, "body": "<string|null>" }
//   Response: { "status": <upstream status>, "headers": {...}, "body": "<raw text>" }
//
// Auth: requires header `X-Relay-Secret: <RELAY_SECRET>` matching the env var,
// so this can't be used as an open proxy by anyone who finds the URL.

const ALLOWED_HOSTS = new Set([
  'api6.aoneroom.com', 'api5.aoneroom.com', 'api4.aoneroom.com',
  'api4sg.aoneroom.com', 'api3.aoneroom.com', 'api6sg.aoneroom.com',
  'api.inmoviebox.com', 'h5.aoneroom.com',
]);

const STRIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'x-relay-secret',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
]);
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'connection', 'transfer-encoding',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed, use POST' });
    return;
  }

  const suppliedSecret = req.headers['x-relay-secret'];
  const relaySecret = process.env.RELAY_SECRET;

  if (!relaySecret) {
    res.status(500).json({ error: 'RELAY_SECRET not configured on server' });
    return;
  }
  if (suppliedSecret !== relaySecret) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const { url, method, headers, body } = req.body || {};

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'missing url' });
    return;
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    res.status(400).json({ error: 'invalid url' });
    return;
  }

  if (!ALLOWED_HOSTS.has(target.hostname)) {
    res.status(403).json({ error: `host not allowed: ${target.hostname}` });
    return;
  }

  const outboundHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      outboundHeaders[key] = value;
    }
  }

  const reqMethod = (method || 'GET').toUpperCase();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const upstreamRes = await fetch(target.toString(), {
      method: reqMethod,
      headers: outboundHeaders,
      body: reqMethod === 'GET' || reqMethod === 'HEAD' ? undefined : (body ?? undefined),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const responseHeaders = {};
    upstreamRes.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    const text = await upstreamRes.text();

    res.status(200).json({
      status: upstreamRes.status,
      headers: responseHeaders,
      body: text,
    });
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    res.status(502).json({
      error: isTimeout ? 'upstream timeout' : 'upstream fetch failed',
      detail: String(err),
    });
  }
}
