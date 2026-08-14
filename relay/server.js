import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 10000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_FORWARD_BODY_BYTES = 1 * 1024 * 1024;

export const ALLOWED_HOSTS = new Set([
  'api6.aoneroom.com',
  'api5.aoneroom.com',
  'api4.aoneroom.com',
  'api4sg.aoneroom.com',
  'api3.aoneroom.com',
  'api6sg.aoneroom.com',
  'api.inmoviebox.com',
  'h5.aoneroom.com',
]);

const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'x-relay-secret',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
]);

const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'connection',
  'transfer-encoding',
]);

function configuredPort() {
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
}

function configuredTimeoutMs() {
  const timeout = Number.parseInt(process.env.RELAY_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isInteger(timeout) && timeout >= 1_000 && timeout <= 60_000
    ? timeout
    : DEFAULT_TIMEOUT_MS;
}

function secretsMatch(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function validateTargetUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    return { error: 'missing or invalid url' };
  }

  let target;
  try {
    target = new URL(value);
  } catch {
    return { error: 'invalid url' };
  }

  const hostname = target.hostname.toLowerCase();
  if (target.protocol !== 'https:') {
    return { error: 'only https upstream urls are allowed' };
  }
  if (target.username || target.password || target.port) {
    return { error: 'upstream url must not contain credentials or a custom port' };
  }
  if (!ALLOWED_HOSTS.has(hostname)) {
    return { error: `host not allowed: ${hostname}` };
  }

  return { target };
}

function normalizeRequestHeaders(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'headers must be an object' };
  }

  const outbound = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== 'string') {
      return { error: `header value must be a string: ${key}` };
    }
    if (/\r|\n/.test(key) || /\r|\n/.test(rawValue)) {
      return { error: 'header names and values must not contain newlines' };
    }
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      outbound[key] = rawValue;
    }
  }

  return { headers: outbound };
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'request body must be a JSON object' };
  }

  const { url, method = 'GET', headers, body = null } = payload;
  const targetResult = validateTargetUrl(url);
  if (targetResult.error) return targetResult;

  if (typeof method !== 'string' || !['GET', 'POST'].includes(method.toUpperCase())) {
    return { error: 'method must be GET or POST' };
  }

  const headerResult = normalizeRequestHeaders(headers);
  if (headerResult.error) return headerResult;

  if (body !== null && typeof body !== 'string') {
    return { error: 'body must be a string or null' };
  }
  if (typeof body === 'string' && Buffer.byteLength(body, 'utf8') > MAX_FORWARD_BODY_BYTES) {
    return { error: 'forward body exceeds the maximum allowed size' };
  }

  return {
    target: targetResult.target,
    method: method.toUpperCase(),
    headers: headerResult.headers,
    body,
  };
}

function stripResponseHeaders(headers) {
  const result = {};
  headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  });
  return result;
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timer };
}

export async function forwardRequest({ suppliedSecret, payload, expectedSecret, fetchImpl = fetch, timeoutMs = configuredTimeoutMs() }) {
  if (!expectedSecret) {
    return { statusCode: 500, payload: { error: 'RELAY_SECRET not configured on server' } };
  }
  if (!secretsMatch(suppliedSecret, expectedSecret)) {
    return { statusCode: 401, payload: { error: 'unauthorized' } };
  }

  const normalized = normalizePayload(payload);
  if (normalized.error) {
    const statusCode = normalized.error.startsWith('host not allowed') ? 403 : 400;
    return { statusCode, payload: { error: normalized.error } };
  }

  const { controller, timer } = createAbortSignal(timeoutMs);
  try {
    const upstreamResponse = await fetchImpl(normalized.target.toString(), {
      method: normalized.method,
      headers: normalized.headers,
      body: normalized.method === 'GET' ? undefined : (normalized.body ?? undefined),
      redirect: 'error',
      signal: controller.signal,
    });

    const responseBody = await upstreamResponse.text();
    return {
      statusCode: 200,
      payload: {
        status: upstreamResponse.status,
        headers: stripResponseHeaders(upstreamResponse.headers),
        body: responseBody,
      },
    };
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return {
      statusCode: 502,
      payload: {
        error: isTimeout ? 'upstream timeout' : 'upstream fetch failed',
        detail: isTimeout ? undefined : String(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonRequest(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      const error = new Error('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

export function createServer({ expectedSecret = process.env.RELAY_SECRET, fetchImpl = fetch } = {}) {
  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (request.method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
      sendJson(response, 200, { status: 'ok', service: 'spun-moviebox-relay', ts: Date.now() });
      return;
    }

    if (pathname !== '/api/relay') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method not allowed, use POST' });
      return;
    }

    try {
      const payload = await readJsonRequest(request);
      const result = await forwardRequest({
        suppliedSecret: request.headers['x-relay-secret'],
        payload,
        expectedSecret,
        fetchImpl,
      });
      sendJson(response, result.statusCode, result.payload);
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, { error: error.message ?? 'internal server error' });
    }
  });
}

export function startServer() {
  const server = createServer();
  const port = configuredPort();
  server.listen(port, '0.0.0.0', () => {
    console.log(`spun-moviebox-relay listening on 0.0.0.0:${port}`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
