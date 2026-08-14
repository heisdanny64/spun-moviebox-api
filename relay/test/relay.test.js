import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardRequest, createServer } from '../server.js';

function fakeHeaders(values = {}) {
  return {
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
