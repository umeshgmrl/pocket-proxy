import { getLocal } from 'mockttp';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { matches } from './rules.js';

const PREVIEW_LIMIT = 64 * 1024;
function preview(body, headers = {}) {
  if (!body?.buffer?.length) return { text: '', note: 'Empty body, or omitted if larger than 1 MB.' };
  let bytes = body.buffer;
  const type = String(headers['content-type'] || '');
  if (type && !/text|json|javascript|xml|x-www-form-urlencoded|svg/i.test(type)) return { text: '', note: `Binary body (${bytes.length.toLocaleString()} bytes).` };
  try {
    const encoding = headers['content-encoding'];
    const decoder = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
    if (decoder) bytes = decoder(bytes, { maxOutputLength: PREVIEW_LIMIT });
    else if (encoding && encoding !== 'identity') return { text: '', note: `Encoded body: ${encoding}` };
  } catch { return { text: '', note: 'Compressed preview omitted (too large or unsupported).' }; }
  return { text: bytes.subarray(0, PREVIEW_LIMIT).toString('utf8'), note: bytes.length > PREVIEW_LIMIT ? 'Preview truncated to 64 KB.' : '' };
}

// Mockttp 4.6.3 does not expose a bind-address option. Intercept its server
// assignment to constrain listen() BEFORE it opens a socket. Keep this adapter
// covered by the loopback-address test when upgrading Mockttp.
function bindLoopback(mock) {
  let server;
  Object.defineProperty(mock, 'server', {
    configurable: true,
    get: () => server,
    set(value) {
      server = value;
      if (!value) return;
      const listen = value.listen;
      value.listen = function (port) { return listen.call(this, port, '127.0.0.1'); };
    }
  });
  return mock;
}
export class ProxyEngine {
  constructor({ ca, port = 8899, rules = [], publish = () => {}, adminPort = 9077 }) {
    this.ca = ca; this.port = port; this.rules = rules; this.publish = publish; this.adminPort = adminPort;
    this.records = new Map(); this.running = false; this.sequence = 0;
  }
  summaries() { return [...this.records.values()].reverse().map(({ requestBody, responseBody, requestHeaders, responseHeaders, ...rest }) => rest); }
  update(id, patch) {
    const entry = this.records.get(id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.publish('traffic', { id, sequence: ++this.sequence });
  }
  clear() { this.records.clear(); this.publish('traffic', { sequence: ++this.sequence }); }
  begin(req) {
    if (this.records.has(req.id)) return;
    this.records.set(req.id, { id: req.id, url: req.url, method: req.method, timestamp: Date.now(), status: null, outcome: 'pending', mocked: false, requestHeaders: req.headers });
    while (this.records.size > 300) this.records.delete(this.records.keys().next().value);
    this.publish('traffic', { id: req.id, sequence: ++this.sequence });
  }
  async start() {
    if (this.running) return;
    this.mock = bindLoopback(getLocal({ https: { key: this.ca.key, cert: this.ca.cert }, http2: true, recordTraffic: false, maxBodySize: 1024 * 1024 }));
    await this.mock.on('request-initiated', req => {
      this.begin(req);
    });
    await this.mock.on('request', req => this.update(req.id, { requestHeaders: req.headers, requestBody: preview(req.body, req.headers) }));
    await this.mock.on('response', res => {
      const start = this.records.get(res.id)?.timestamp;
      this.update(res.id, { status: res.statusCode, outcome: 'complete', duration: Date.now() - start, responseHeaders: res.headers, responseBody: preview(res.body, res.headers) });
    });
    await this.mock.on('abort', req => this.update(req.id, { outcome: 'error', error: req.error?.message || 'Connection aborted' }));
    await this.mock.on('tls-client-error', event => this.publish('notice', { message: `HTTPS connection failed${event.hostname ? ` for ${event.hostname}` : ''}. Check certificate trust or certificate pinning.` }));
    try {
      await this.mock.start(this.port);
      this.port = this.mock.port;
      await this.mock.forAnyRequest().thenPassThrough({ beforeRequest: async req => {
        // Mockttp emits lifecycle events asynchronously; the callback can arrive first.
        this.begin(req);
        const url = new URL(req.url);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (local && [this.port, this.adminPort].includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) {
          return { response: { statusCode: 403, body: 'The proxy cannot forward to its own ports.' } };
        }
        const rule = this.rules.find(rule => matches(rule, req));
        if (!rule) return;
        this.update(req.id, { mocked: true, ruleName: rule.name });
        if (rule.delay) await new Promise(resolve => setTimeout(resolve, rule.delay));
        return { response: { statusCode: rule.status, headers: rule.headers, body: req.method === 'HEAD' || [204, 205, 304].includes(rule.status) ? '' : rule.body } };
      } });
      await this.mock.forAnyWebSocket().thenPassThrough();
      this.running = true;
    } catch (error) { await this.mock.stop().catch(() => {}); throw error; }
  }
  async stop() {
    if (!this.running) return;
    await this.mock.stop(); this.running = false;
    for (const [id, row] of this.records) if (row.outcome === 'pending') this.update(id, { outcome: 'error', error: 'Capture stopped' });
  }
}
