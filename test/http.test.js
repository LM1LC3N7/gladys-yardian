// -----------------------------------------------------------------------------
// src/yardian/http.js against a real local HTTP server (127.0.0.1): the
// method, the headers and the body, the size cap, beforeSend refusing before
// the first byte, one connection per request.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpRequest } from '../src/yardian/http.js';
import { YardianClient } from '../src/yardian/client.js';

async function server(t, handler) {
  const received = [];
  let connections = 0;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });
  srv.on('connection', () => {
    connections += 1;
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  return { port: srv.address().port, received, connections: () => connections };
}

const base = { host: '127.0.0.1', timeout: 2000, maxBytes: 1024 };

test('a POST carries its JSON body and the token header, one connection each', async (t) => {
  const s = await server(t, (req, res) => {
    res.setHeader('date', 'Thu, 22 Oct 2026 10:00:00 GMT');
    res.end('{"iCode":0}');
  });
  const answer = await httpRequest({
    ...base,
    port: s.port,
    method: 'POST',
    path: '/',
    headers: { 'Yardian-Token': 'abc' },
    body: Buffer.from('{"sEvent":"AE_IRR_STOP_INST_TASK"}'),
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.toString(), '{"iCode":0}');
  assert.equal(s.received[0].method, 'POST');
  assert.equal(s.received[0].headers['yardian-token'], 'abc');
  assert.equal(s.received[0].headers['content-type'], 'application/json');
  assert.equal(s.received[0].body, '{"sEvent":"AE_IRR_STOP_INST_TASK"}');
  await httpRequest({ ...base, port: s.port, path: '/API_GET_DEVICEINFO' });
  assert.equal(s.connections(), 2);
});

test('an answer above the size cap is refused', async (t) => {
  const s = await server(t, (req, res) => res.end('x'.repeat(5000)));
  await assert.rejects(httpRequest({ ...base, port: s.port, path: '/' }), { kind: 'tooLarge' });
});

test('beforeSend refusing: nothing reaches the server', async (t) => {
  const s = await server(t, (req, res) => res.end('{}'));
  await assert.rejects(
    httpRequest({
      ...base,
      port: s.port,
      method: 'POST',
      path: '/',
      body: Buffer.from('{}'),
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    (err) => err.beforeSend === true && err.sent === false,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.received.length, 0);
});

test('the client: 401 and iCode -1000 are a refused token, 503 a pause with Retry-After', async (t) => {
  const answers = [
    [401, '{}'],
    [200, '{"iCode":-1000}'],
    [503, ''],
    [200, '{"iCode":-3}'],
  ];
  const s = await server(t, (req, res) => {
    const [status, body] = answers.shift();
    res.statusCode = status;
    if (status === 503) res.setHeader('retry-after', '120');
    res.end(body);
  });
  const client = new YardianClient({
    request: (options) => httpRequest({ ...options, host: '127.0.0.1', port: s.port }),
  });
  await assert.rejects(client.deviceInfo('x', 't'), { kind: 'token' });
  await assert.rejects(client.deviceInfo('x', 't'), { kind: 'token' });
  await assert.rejects(client.deviceInfo('x', 't'), { kind: 'busy', retryAfter: 120_000 });
  await assert.rejects(client.ypStop('x', 't'), { kind: 'refused', sent: true });
});

test('the errors never carry the token, the address or a body', async (t) => {
  const s = await server(t, (req, res) => {
    res.statusCode = 404;
    res.end('secret body');
  });
  const client = new YardianClient({
    request: (options) => httpRequest({ ...options, host: '127.0.0.1', port: s.port }),
  });
  const err = await client.deviceInfo('x', 'TOKEN123').catch((e) => e);
  assert.equal(err.kind, 'http');
  assert.ok(!/TOKEN123|127\.0\.0\.1|secret/.test(`${err.message} ${err.stack}`));
});
