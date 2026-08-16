import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { forwardMediaRequest, forwardRequest, createServer } from '../server.js';

function mediaSignature(expires, targetUrl, secret) {
  return createHmac('sha256', secret).update(`${expires}\n${targetUrl}`).digest('hex');
}

function fakeHeaders(values = {}) {
  return {
    get(name) {
      const key = Object.keys(values).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      return key ? values[key] : null;
    },
    forEach(callback) {
      for (const [key, value] of Object.entries(values)) callback(value, key);
    },
  };
}

test('rejects requests with an invalid relay secret', async () => {
  const result = await forwardRequest({
    suppliedSecret: 'wrong',
    expectedSecret: 'correct',
    payload: { url: 'https://api6.aoneroom.com/example' },
    fetchImpl: async () => {
      throw new Error('fetch must not be called');
    },
  });

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.payload, { error: 'unauthorized' });
});

test('rejects hosts outside the MovieBox allowlist', async () => {
  const result = await forwardRequest({
    suppliedSecret: 'correct',
    expectedSecret: 'correct',
    payload: { url: 'https://example.com/' },
    fetchImpl: async () => {
      throw new Error('fetch must not be called');
    },
  });

  assert.equal(result.statusCode, 403);
  assert.match(result.payload.error, /host not allowed/);
});

test('forwards the signed request and returns the upstream envelope', async () => {
  let request;
  const result = await forwardRequest({
    suppliedSecret: 'correct',
    expectedSecret: 'correct',
    payload: {
      url: 'https://api6.aoneroom.com/path?q=1',
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'X-Relay-Secret': 'should-be-stripped',
      },
      body: '{"hello":"world"}',
    },
    fetchImpl: async (...args) => {
      request = args;
      return {
        status: 201,
        headers: fakeHeaders({ 'content-type': 'application/json', 'content-length': '99' }),
        text: async () => '{"code":0}',
      };
    },
  });

  assert.equal(request[0], 'https://api6.aoneroom.com/path?q=1');
  assert.equal(request[1].method, 'POST');
  assert.equal(request[1].headers.Authorization, 'Bearer token');
  assert.equal(request[1].headers['X-Relay-Secret'], undefined);
  assert.equal(request[1].body, '{"hello":"world"}');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.payload, {
    status: 201,
    headers: { 'content-type': 'application/json' },
    body: '{"code":0}',
  });
});

test('forwards signed media requests with range and Android playback headers', async () => {
  const secret = 'correct';
  const targetUrl = 'https://bcdn.hakunaymatata.com/resource/h265/video.mp4?sign=upstream&t=1786838688';
  const expires = 1786838688;
  let request;

  const result = await forwardMediaRequest({
    targetUrl,
    expires,
    suppliedSignature: mediaSignature(expires, targetUrl, secret),
    range: 'bytes=0-1023',
    expectedSecret: secret,
    fetchImpl: async (...args) => {
      request = args;
      return {
        status: 206,
        headers: fakeHeaders({
          'content-type': 'video/mp4',
          'content-range': 'bytes 0-1023/2048',
          'accept-ranges': 'bytes',
        }),
        body: null,
      };
    },
  });

  assert.equal(result.statusCode, 206);
  assert.deepEqual(result.headers, {
    'accept-ranges': 'bytes',
    'content-range': 'bytes 0-1023/2048',
    'content-type': 'video/mp4',
  });
  assert.equal(request[0], targetUrl);
  assert.equal(request[1].headers.Range, 'bytes=0-1023');
  assert.match(request[1].headers['User-Agent'], /com\.community\.oneroom/);
  assert.equal(result.headers['content-disposition'], undefined);
});

test('marks download media responses as attachments', async () => {
  const secret = 'correct';
  const targetUrl = 'https://bcdn.hakunaymatata.com/resource/h265/video-file.mp4?sign=upstream&t=1786838688';
  const expires = 1786838688;

  const result = await forwardMediaRequest({
    targetUrl,
    expires,
    suppliedSignature: mediaSignature(expires, targetUrl, secret),
    download: true,
    expectedSecret: secret,
    fetchImpl: async () => ({
      status: 200,
      headers: fakeHeaders({ 'content-type': 'video/mp4' }),
      body: null,
    }),
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-disposition'], 'attachment; filename="video-file.mp4"');
});

test('rejects unsigned or non-CDN media targets before fetching', async () => {
  const targetUrl = 'https://example.com/video.mp4?sign=x&t=1786838688';
  const result = await forwardMediaRequest({
    targetUrl,
    expires: 1786838688,
    suppliedSignature: 'wrong',
    expectedSecret: 'correct',
    fetchImpl: async () => {
      throw new Error('fetch must not be called');
    },
  });

  assert.equal(result.statusCode, 403);
  assert.match(result.payload.error, /media host not allowed/);
});

test('rejects media requests with an invalid proxy signature', async () => {
  const result = await forwardMediaRequest({
    targetUrl: 'https://bcdn.hakunaymatata.com/resource/video.mp4?sign=x&t=1786838688',
    expires: 1786838688,
    suppliedSignature: 'wrong',
    expectedSecret: 'correct',
    fetchImpl: async () => {
      throw new Error('fetch must not be called');
    },
  });

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.payload, { error: 'unauthorized' });
});

test('serves a public health endpoint', async () => {
  const server = createServer({ expectedSecret: 'correct' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
