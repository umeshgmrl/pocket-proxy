import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
const exec = promisify(execFile);
const noMac = { services: async () => [], journal: async () => null, restore: async () => {}, trustCertificate: async () => {} };
let app, dir, upstream, upstreamPort;
const originRequest = (url, options = {}) => fetch(`${app.origin}/api/${url}`, { ...options, headers: { Cookie: `pocket_session=${app.token}`, Origin: app.origin, 'X-Pocket-Proxy': '1', 'Content-Type': 'application/json', ...options.headers } });
const post = (url, value) => originRequest(url, { method: 'POST', body: JSON.stringify(value) });
async function curl(url, extra = []) {
  return exec('/usr/bin/curl', ['--silent', '--show-error', '--max-time', '10', '--noproxy', '', '--proxy', `http://127.0.0.1:${app.engine.port}`, '--cacert', app.ca.certPath, ...extra, url], { maxBuffer: 4 * 1024 * 1024 });
}
const rule = (patch = {}) => ({ name: 'Test profile', pattern: 'https://pocket.test/profile', method: 'GET', match: 'exact', status: 201, headers: { 'content-type': 'application/json', 'x-test': 'mocked' }, body: '{"local":true}', enabled: true, ...patch });
test.before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pocket-test-'));
  upstream = http.createServer((req, res) => {
    if (req.url === '/large-response') return res.end('x'.repeat(1100000));
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, path: req.url, bytes: Buffer.concat(chunks).length, body: Buffer.concat(chunks).length < 1000 ? Buffer.concat(chunks).toString() : '' }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); upstreamPort = upstream.address().port;
  app = await createApp({ dataDir: dir, uiPort: 0, proxyPort: 0, mac: noMac });
});
test.after(async () => { await app?.close(); if (upstream) await new Promise(resolve => upstream.close(resolve)); await rm(dir, { recursive: true, force: true }); });
test('both listeners bind only to loopback', () => {
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal(app.engine.mock.server.address().address, '127.0.0.1');
});
test('admin API rejects unauthenticated requests, wrong Host and cross-origin writes', async () => {
  assert.equal((await fetch(`${app.origin}/api/status`)).status, 401);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${app.origin}/api/status`, { headers: { Host: 'evil.test', Cookie: `pocket_session=${app.token}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await post('rules', { rules: [] })).status, 200);
  assert.equal((await originRequest('rules', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{"rules":[]}' })).status, 403);
  assert.equal((await fetch(`${app.origin}/api/session`, { method: 'POST', headers: { Origin: app.origin, 'X-Pocket-Proxy': '1' }, body: JSON.stringify({ token: app.token }) })).status, 200);
});
test('forwards HTTP method, query and request body', async () => {
  const { stdout } = await curl(`http://127.0.0.1:${upstreamPort}/echo?a=1`, ['-X', 'POST', '--data', '{"hello":"world"}']);
  assert.deepEqual(JSON.parse(stdout), { method: 'POST', path: '/echo?a=1', bytes: 17, body: '{"hello":"world"}' });
});
test('HTTPS CONNECT interception uses the personal CA and returns a mock with delay', async () => {
  assert.equal((await post('rules', { rules: [rule({ delay: 60 })] })).status, 200);
  const start = Date.now();
  const { stdout } = await curl('https://pocket.test/profile', ['-i']);
  assert.match(stdout, /201/); assert.match(stdout, /x-test: mocked/i); assert.match(stdout, /\{"local":true\}/); assert.ok(Date.now() - start >= 60);
  await new Promise(resolve => setTimeout(resolve, 100));
  const rows = await (await originRequest('requests')).json();
  const row = rows.find(r => r.url === 'https://pocket.test/profile');
  assert.equal(row.mocked, true); assert.equal(row.status, 201);
  const detail = await (await originRequest(`requests/${row.id}`)).json();
  assert.equal(detail.responseBody.text, '{"local":true}');
});
test('first enabled rule wins; updates take effect without restarting', async () => {
  await post('rules', { rules: [rule({ body: 'first', enabled: false }), rule({ body: 'second' })] });
  assert.equal((await curl('https://pocket.test/profile')).stdout, 'second');
  await post('rules', { rules: [rule({ body: 'first' }), rule({ body: 'second' })] });
  assert.equal((await curl('https://pocket.test/profile')).stdout, 'first');
});
test('wildcard and method matching apply to HTTP requests', async () => {
  await post('rules', { rules: [rule({ pattern: `http://127.0.0.1:${upstreamPort}/items/*`, method: 'POST', match: 'glob', body: 'wildcard' })] });
  assert.equal((await curl(`http://127.0.0.1:${upstreamPort}/items/12`, ['-X', 'POST'])).stdout, 'wildcard');
  assert.equal(JSON.parse((await curl(`http://127.0.0.1:${upstreamPort}/items/12`)).stdout).method, 'GET');
});
test('large bodies pass through intact even when capture is omitted', async () => {
  await post('rules', { rules: [] });
  const requestBody = 'x'.repeat(1100000);
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: app.engine.port, path: `http://127.0.0.1:${upstreamPort}/upload`, method: 'POST', headers: { Host: `127.0.0.1:${upstreamPort}`, 'Content-Length': Buffer.byteLength(requestBody) } }, res => { let text = ''; res.on('data', c => text += c); res.on('end', () => resolve(JSON.parse(text))); });
    req.on('error', reject); req.end(requestBody);
  });
  assert.equal(response.bytes, 1100000);
  assert.equal((await curl(`http://127.0.0.1:${upstreamPort}/large-response`)).stdout.length, 1100000);
});
test('does not disable upstream HTTPS certificate verification', async () => {
  const invalidServer = https.createServer({ key: app.ca.key, cert: app.ca.cert }, (_, res) => res.end('should not trust upstream'));
  await new Promise(resolve => invalidServer.listen(0, '127.0.0.1', resolve));
  try { const { stdout } = await curl(`https://localhost:${invalidServer.address().port}`, ['-i']); assert.match(stdout, /502/); assert.match(stdout, /certificate|self.signed/i); assert.doesNotMatch(stdout, /should not trust upstream/); }
  finally { await new Promise(resolve => invalidServer.close(resolve)); }
});
test('self-forwarding is blocked and invalid rules cannot replace saved rules', async () => {
  assert.match((await curl(`${app.origin}/api/status`, ['-i'])).stdout, /403/);
  assert.match((await curl(`http://127.0.0.1:${app.engine.port}/`, ['-i'])).stdout, /403/);
  assert.equal((await post('rules', { rules: [rule({ headers: { 'content-length': '99' } })] })).status, 400);
  assert.equal((await post('rules', { rules: [rule({ status: 101 })] })).status, 400);
});
test('pause, restart, clear and persisted rules work', async () => {
  await post('rules', { rules: [rule()] });
  assert.equal((await post('capture', { enabled: false })).status, 200); assert.equal(app.engine.running, false);
  assert.equal((await post('capture', { enabled: true })).status, 200);
  assert.equal((await curl('https://pocket.test/profile')).stdout, '{"local":true}');
  await post('requests/clear', {}); assert.equal((await (await originRequest('requests')).json()).length, 0);
  await app.close();
  app = await createApp({ dataDir: dir, uiPort: 0, proxyPort: 0, mac: noMac });
  assert.equal((await curl('https://pocket.test/profile')).stdout, '{"local":true}');
});
