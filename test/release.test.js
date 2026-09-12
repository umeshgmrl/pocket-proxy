import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, rm, access, writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { gzipSync, brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const sourceApp = fileURLToPath(new URL('../dist/Pocket Proxy.app', import.meta.url));
let built = true;
try { await access(path.join(sourceApp, 'Contents/MacOS/PocketProxy')); } catch { built = false; }
if (!built && process.env.POCKET_PROXY_RELEASE_TEST === '1') throw new Error('Run npm run build:release first.');
const releaseTest = (name, fn) => test(name, { skip: !built }, fn);
async function freePort() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
releaseTest('native launcher finds nvm Node from a Finder-like PATH and reports missing/old Node', async () => {
  const binary = path.join(sourceApp, 'Contents/MacOS/PocketProxy');
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }; delete env.POCKET_PROXY_NODE;
  const found = JSON.parse((await exec(binary, ['--check-node'], { env })).stdout);
  assert.ok(Number(found.version.split('.')[0]) >= 22);
  await assert.rejects(exec(binary, ['--check-node'], { env: { ...env, POCKET_PROXY_NODE: '/nonexistent/pocket-node' } }), error => { assert.match(error.stderr, /requires Node.js 22/); return true; });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pocket-old-node-'));
  try {
    const old = path.join(dir, 'node');
    await writeFile(old, '#!/bin/sh\nprintf \'{"version":"20.0.0","executable":"/old/node"}\\n\'\n', { mode: 0o700 });
    await assert.rejects(exec(binary, ['--check-node'], { env: { ...env, POCKET_PROXY_NODE: old } }), error => { assert.match(error.stderr, /Node 20.0.0/); return true; });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
releaseTest('relocated release runs without node_modules: HTTPS mocks, forwarding, compression and persistence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pocket-release-'));
  const app = path.join(dir, 'Pocket Proxy.app');
  await cp(sourceApp, app, { recursive: true });
  const resources = path.join(app, 'Contents/Resources');
  const dataDir = path.join(dir, 'user-data');
  let child, stopping = false;
  const uiPort = await freePort(), proxyPort = await freePort();
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const json = '{"forwarded":true}';
    if (req.url === '/gzip') { res.setHeader('content-encoding', 'gzip'); res.end(gzipSync(json)); }
    else if (req.url === '/brotli') { res.setHeader('content-encoding', 'br'); res.end(brotliCompressSync(json)); }
    else res.end(json);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let url, token;
  async function start() {
    let output = '';
    child = spawn(process.execPath, ['--experimental-require-module', path.join(resources, 'src/main.js'), '--desktop-child'], { cwd: dir, env: { ...process.env, NODE_PATH: '', POCKET_PROXY_DATA_DIR: dataDir, POCKET_PROXY_PORT: String(proxyPort), POCKET_PROXY_UI_PORT: String(uiPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Release startup timed out: ${output.slice(-2000)}`)), 30000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => { clearTimeout(timeout); if (!stopping) reject(new Error(`Release exited ${code}: ${output.slice(-2000)}`)); });
      child.stderr.on('data', chunk => output += chunk);
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/POCKET_PROXY_READY (\{[^\n]+\})/);
        if (match) { clearTimeout(timeout); resolve(JSON.parse(match[1])); }
      });
    });
    const parsed = new URL(ready.url); url = parsed.origin; token = parsed.hash.slice(1);
  }
  async function stop() { if (child && child.exitCode === null) { stopping = true; const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; stopping = false; } }
  async function api(endpoint, body) {
    const response = await fetch(`${url}/api/${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: `pocket_session=${token}`, Origin: url, 'X-Pocket-Proxy': '1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  const curl = async target => (await exec('/usr/bin/curl', ['--silent', '--show-error', '--max-time', '10', '--noproxy', '', '--compressed', '--proxy', `http://127.0.0.1:${proxyPort}`, '--cacert', path.join(dataDir, 'pocket-proxy-ca.pem'), target])).stdout;
  try {
    await start();
    const setup = await api('setup/verify', {});
    assert.equal(setup.phase, 'needs-approval', JSON.stringify(setup));
    assert.ok([-1200, -1202].includes(setup.errorCode), JSON.stringify(setup));
    assert.equal((await api('requests')).length, 0, 'Verification must not pollute captured traffic');
    assert.equal((await fetch(url)).status, 200);
    assert.match(await (await fetch(`${url}/app.js`)).text(), /refreshTraffic/);
    await api('rules', { rules: [{ name: 'Release mock', method: 'GET', match: 'exact', pattern: 'https://release.pocket.test/profile', status: 200, body: '{"release":true}', headers: { 'content-type': 'application/json' }, enabled: true }] });
    assert.equal(await curl('https://release.pocket.test/profile'), '{"release":true}');
    for (const endpoint of ['/', '/gzip']) assert.equal(await curl(`http://127.0.0.1:${upstream.address().port}${endpoint}`), '{"forwarded":true}');
    const brotli = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${upstream.address().port}/brotli` }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
      }).on('error', reject);
    });
    assert.equal(brotliDecompressSync(brotli).toString(), '{"forwarded":true}');
    await new Promise(resolve => setTimeout(resolve, 100));
    const records = await api('requests');
    assert.ok(records.some(row => row.mocked && row.status === 200));
    const gzip = records.find(row => row.url.endsWith('/gzip'));
    assert.equal((await api(`requests/${gzip.id}`)).responseBody.text, '{"forwarded":true}');
    const cert = await readFile(path.join(dataDir, 'pocket-proxy-ca.pem'), 'utf8');
    await stop(); await start();
    assert.equal(await curl('https://release.pocket.test/profile'), '{"release":true}');
    assert.equal(await readFile(path.join(dataDir, 'pocket-proxy-ca.pem'), 'utf8'), cert);
    await api('capture', { enabled: false }); await api('capture', { enabled: true });
    assert.equal(await curl('https://release.pocket.test/profile'), '{"release":true}');
  } finally { await stop(); await new Promise(resolve => upstream.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
