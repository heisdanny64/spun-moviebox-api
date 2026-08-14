// src/signing.ts
// MovieBox Mobile API v3 request signing — Web Crypto API (Cloudflare Workers compatible)
// Ports the Python library's HMAC-MD5 signing logic to the Workers runtime.
// No Node.js crypto — uses SubtleCrypto throughout.
//
// ─── 2026-06-29 fix ──────────────────────────────────────────────────────────
// Every request to the Android mobile pool started failing with HTTP 440/530
// across all 7 hosts uniformly. Confirmed via wrangler tail — not a transient
// outage. Root cause, confirmed by live testing against the real API: the
// HMAC-MD5 signing logic below was NEVER broken — what was missing is a
// bearer auth token. MovieBox's mobile API now requires every signed request
// to also carry `Authorization: Bearer {token}`, where the token is obtained
// via a one-time bootstrap call (any GET against the API, e.g. the homepage
// tab-operating endpoint) whose response includes an `x-user` header:
//   x-user: {"token": "...", "userId": "...", "userType": 0}
// That token is then reused as the Authorization header on every subsequent
// signed request, and is itself a JWT with a long (~90 day) lifetime.
//
// This was confirmed end-to-end with real, live requests before being wired
// in here: a hand-signed bootstrap call returned a valid x-user token, and
// that token was then used to sign and authorize a real /search call which
// returned genuine MovieBox search results.
//
// The token is cached in Workers KV (not module-scope memory) because we
// confirmed via wrangler tail in a separate but related fix (the H5 worker's
// session cache) that Cloudflare does not reliably reuse the same isolate
// across requests — in-memory caching would mean every request re-bootstraps,
// which both adds latency and risks tripping MovieBox's own rate limits.

const SECRET_KEY_B64 = '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O';
const SIGNATURE_BODY_MAX_BYTES = 102_400;

// ─── Base64 helpers ────────────────────────────────────────────────────────────

function b64Decode(value: string): Uint8Array {
  const padding = (4 - (value.length % 4)) % 4;
  const padded = value + '='.repeat(padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function b64Encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// ─── MD5 via SubtleCrypto ──────────────────────────────────────────────────────
// SubtleCrypto supports MD5 in Cloudflare Workers (non-browser context)

async function md5Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest('MD5', bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── HMAC-MD5 ─────────────────────────────────────────────────────────────────

async function hmacMd5(keyBytes: Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'MD5' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

// ─── Token & signature generators ─────────────────────────────────────────────

export async function generateClientToken(ts: number): Promise<string> {
  const tsStr = String(ts);
  const reversed = tsStr.split('').reverse().join('');
  const hash = await md5Hex(reversed);
  return `${tsStr},${hash}`;
}

function sortedQueryString(url: string): string {
  const u = new URL(url);
  const params: string[] = [];
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of sorted) {
    params.push(`${key}=${value}`);
  }
  return params.join('&');
}

async function buildCanonicalString(
  method: string,
  accept: string,
  contentType: string,
  url: string,
  body: string | null,
  ts: number
): Promise<string> {
  const u = new URL(url);
  const path = u.pathname;
  const query = sortedQueryString(url);
  const canonicalUrl = query ? `${path}?${query}` : path;

  let bodyHash = '';
  let bodyLength = '';

  if (body !== null) {
    const bodyBytes = new TextEncoder().encode(body);
    const truncated = bodyBytes.slice(0, SIGNATURE_BODY_MAX_BYTES);
    bodyHash = await md5Hex(truncated);
    bodyLength = String(bodyBytes.length);
  }

  return [method.toUpperCase(), accept, contentType, bodyLength, ts, bodyHash, canonicalUrl].join(
    '\n'
  );
}

export async function generateSignature(
  method: string,
  accept: string,
  contentType: string,
  url: string,
  body: string | null,
  ts: number
): Promise<string> {
  const canonical = await buildCanonicalString(method, accept, contentType, url, body, ts);
  const secretBytes = b64Decode(SECRET_KEY_B64);
  const mac = await hmacMd5(secretBytes, canonical);
  return `${ts}|2|${b64Encode(mac)}`;
}

// ─── Auth token bootstrap (KV-backed) ─────────────────────────────────────────

export interface SigningEnv {
  MOVIEBOX_SESSION_KV: KVNamespace;
  // ─── 2026-08-13 relay fix ──────────────────────────────────────────────
  // MovieBox rejects requests from Cloudflare Workers' egress IPs at the
  // transport layer (HTTP 440/530, before app logic runs) — confirmed via
  // side-by-side testing: identical signed requests succeed from a
  // non-Cloudflare IP and fail uniformly across all 7 hosts from the Worker.
  // All outbound calls now route through a small Render web service that
  // re-issues the already-signed request from a different IP. See
  // moviebox.ts's attemptHostPool and spun-moviebox-relay/README.md.
  RELAY_URL: string;
  RELAY_SECRET: string;
}

const KV_TOKEN_KEY = 'mobile_auth_token';
const KV_TTL_SECONDS = 60 * 60 * 24; // 24h backstop, JWT itself is long-lived
const EXPIRY_SAFETY_MARGIN_SECONDS = 300;

interface CachedToken {
  token: string;
  expiresAtSeconds: number;
}

// Guards against duplicate concurrent bootstraps WITHIN a single isolate —
// does not replace KV, just avoids a thundering herd if several requests on
// the same isolate all find a stale/missing KV entry at once.
let _bootstrapPromise: Promise<string> | null = null;

function decodeJwtExpSeconds(jwt: string): number | null {
  try {
    const payloadB64 = jwt.split('.')[1];
    if (!payloadB64) return null;
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (padded.length % 4)) % 4);
    const json = atob(padded + padding);
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

async function readTokenFromKv(kv: KVNamespace): Promise<CachedToken | null> {
  try {
    const raw = await kv.get(KV_TOKEN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedToken;
  } catch (e) {
    console.warn(`[Signing] Failed to read/parse KV token: ${e}`);
    return null;
  }
}

async function writeTokenToKv(kv: KVNamespace, cached: CachedToken): Promise<void> {
  try {
    await kv.put(KV_TOKEN_KEY, JSON.stringify(cached), { expirationTtl: KV_TTL_SECONDS });
  } catch (e) {
    console.warn(`[Signing] Failed to write token to KV: ${e}`);
  }
}

function isExpiringSoon(cached: CachedToken): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return nowSeconds >= cached.expiresAtSeconds - EXPIRY_SAFETY_MARGIN_SECONDS;
}

/**
 * Performs the one-time bootstrap call needed to obtain an auth token: any
 * signed GET request against the mobile API works for this, since the token
 * arrives via the `x-user` response header on every response, not from a
 * dedicated endpoint. We use the lightweight homepage tab-operating call.
 *
 * `signedFetch` is injected (rather than imported) to avoid a circular
 * dependency between this module and moviebox.ts's host-pool fetch logic —
 * moviebox.ts already knows how to try hosts in order and handle failures,
 * so bootstrap reuses that instead of duplicating host-pool logic here.
 */
export async function bootstrapAuthToken(
  env: SigningEnv,
  signedFetch: () => Promise<string | null>
): Promise<string> {
  if (!_bootstrapPromise) {
    _bootstrapPromise = (async () => {
      const token = await signedFetch();
      if (!token) {
        throw new Error('[Signing] Bootstrap failed — no x-user token received from any host');
      }

      const exp = decodeJwtExpSeconds(token);
      const expiresAtSeconds = exp ?? Math.floor(Date.now() / 1000) + 3600;

      await writeTokenToKv(env.MOVIEBOX_SESSION_KV, { token, expiresAtSeconds });

      return token;
    })().finally(() => {
      _bootstrapPromise = null;
    });
  }

  return _bootstrapPromise;
}

/**
 * Returns a valid cached auth token from KV, or null if none exists / it's
 * expiring soon and needs a fresh bootstrap.
 */
export async function getCachedAuthToken(env: SigningEnv): Promise<string | null> {
  const cached = await readTokenFromKv(env.MOVIEBOX_SESSION_KV);
  if (cached && !isExpiringSoon(cached)) {
    return cached.token;
  }
  return null;
}

/**
 * Forces the next getCachedAuthToken() call to miss, triggering a fresh
 * bootstrap. Use when a request gets rejected despite the cache believing
 * the token is still valid (e.g. MovieBox revoked it server-side early).
 */
export async function invalidateAuthToken(env: SigningEnv): Promise<void> {
  try {
    await env.MOVIEBOX_SESSION_KV.delete(KV_TOKEN_KEY);
  } catch (e) {
    console.warn(`[Signing] Failed to invalidate KV token: ${e}`);
  }
}