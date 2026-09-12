import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ensureCA, readJson, writeJson } from './storage.js';
import { validateRule } from './rules.js';
import { ProxyEngine } from './proxy.js';
import { MacProxy } from './macos.js';
import { certificateIdentity, HttpsSetup } from './certificate.js';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
function same(a, b) { return typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Request exceeds 2 MB.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export async function createApp({ dataDir, uiPort = 9077, proxyPort = 8899, mac = new MacProxy(dataDir) }) {
  const ca = await ensureCA(dataDir);
  const rulesPath = path.join(dataDir, 'rules.json');
  const saved = await readJson(rulesPath, []);
  if (!Array.isArray(saved) || saved.length > 200) throw new Error('Invalid saved rules file.');
  const rules = saved.map(validateRule);
  const clients = new Set();
  const token = randomBytes(32).toString('hex');
  let origin, mutation = Promise.resolve(), shuttingDown = false;
  function publish(type, value) {
    const data = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const client of clients) { if (!client.write(data)) { client.destroy(); clients.delete(client); } }
  }
  const engine = new ProxyEngine({ ca, rules, port: proxyPort, publish });
  const identity = await certificateIdentity(ca.certPath);
  const setup = new HttpsSetup({ certPath: ca.certPath, engine });
  async function status() {
    let journal = null, services = [], systemError = '';
    try { journal = await mac.journal(); services = await mac.services(); } catch (error) { systemError = error.message; }
    return { running: engine.running, proxyPort: engine.port, uiPort: server.address().port, systemProxy: !!journal, selectedServices: [...new Set(journal?.entries.map(e => e.service) || [])], services, systemError, certPath: ca.certPath, certificate: identity, httpsSetup: setup.state, requestCount: engine.records.size, ruleCount: engine.rules.filter(r => r.enabled).length };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== new URL(origin).host) return json({ error: 'Invalid host.' }, 403);
      const url = new URL(req.url, origin);
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && (req.headers.origin !== origin || req.headers['x-pocket-proxy'] !== '1')) return json({ error: 'Invalid request origin.' }, 403);
      if (url.pathname === '/api/session' && req.method === 'POST') {
        if (!same((await body(req)).token, token)) return json({ error: 'Invalid session. Open the URL printed in your terminal.' }, 401);
        res.setHeader('Set-Cookie', `pocket_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return json({ ok: true });
      }
      if (assets[url.pathname] && req.method === 'GET') {
        const [file, type] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await readFile(path.join(publicDir, file))); return;
      }
      const session = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('pocket_session='))?.slice('pocket_session='.length);
      if (!same(session, token)) return json({ error: 'Session expired. Reopen the app using the URL printed in your terminal.' }, 401);
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(': connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'GET') {
        if (url.pathname === '/api/status') return json(await status());
        if (url.pathname === '/api/rules') return json(engine.rules);
        if (url.pathname === '/api/requests') return json(engine.summaries());
        if (url.pathname.startsWith('/api/requests/')) {
          const row = engine.records.get(url.pathname.slice('/api/requests/'.length));
          return json(row || { error: 'Request no longer in history.' }, row ? 200 : 404);
        }
        if (url.pathname === '/api/certificate') {
          res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': 'attachment; filename="pocket-proxy-ca.pem"' }); res.end(ca.cert); return;
        }
      }
      if (req.method === 'POST') {
        const input = await body(req);
        const task = mutation.then(async () => {
          if (shuttingDown) throw new Error('The app is shutting down.');
          switch (url.pathname) {
            case '/api/rules': {
              if (!Array.isArray(input.rules) || input.rules.length > 200) throw new Error('Provide up to 200 rules.');
              const next = input.rules.map(validateRule);
              if (new Set(next.map(r => r.id)).size !== next.length) throw new Error('Rule IDs must be unique.');
              await writeJson(rulesPath, next); engine.rules = next; return next;
            }
            case '/api/capture':
              if (typeof input.enabled !== 'boolean') throw new Error('Enabled must be a boolean.');
              if (input.enabled) await engine.start();
              else { await mac.restore(); await engine.stop(); }
              return status();
            case '/api/system-proxy':
              if (typeof input.enabled !== 'boolean') throw new Error('Enabled must be a boolean.');
              if (input.enabled) { if (!engine.running) await engine.start(); await mac.enable(input.services, engine.port); }
              else await mac.restore();
              return status();
            case '/api/certificate/trust': return await mac.trustCertificate(ca.certPath);
            case '/api/setup/verify': return await setup.verify();
            case '/api/setup/https': return await setup.setup();
            case '/api/requests/clear': engine.clear(); return { ok: true };
            default: throw new Error('Unknown action.');
          }
        });
        mutation = task.catch(() => {});
        const result = await task; publish('state', {}); return json(result);
      }
      json({ error: 'Not found.' }, 404);
    } catch (error) { if (!res.headersSent) json({ error: error.message }, 400); else res.end(); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(uiPort, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  engine.adminPort = server.address().port;
  try { await engine.start(); } catch (error) { server.close(); throw error; }
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();
  return {
    engine, mac, ca, server, origin, token, url: `${origin}/#${token}`, status,
    async close() {
      shuttingDown = true; await mutation;
      try { await mac.restore(); } catch (error) { shuttingDown = false; throw error; }
      clearInterval(heartbeat); for (const client of clients) client.end();
      await engine.stop();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}
