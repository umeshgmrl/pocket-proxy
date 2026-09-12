import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf("$('capture-toggle').onclick ="), source.indexOf("$('local-only').onchange"));
async function run({ active = false, local = false, phase = 'ready', failRouting = false, services = ['Wi-Fi'] } = {}) {
  const calls = [], nodes = { 'capture-toggle': {}, services: { querySelectorAll: () => services.map(value => ({ value })) } };
  const context = vm.createContext({ calls, nodes, state: { running: active, systemProxy: active, httpsSetup: {} }, localOnly: local,
    busy: false, interceptionWork: '', setupWork: '', page() {}, notice() {}, renderState() {}, renderSetup() {}, refreshState: async () => {},
    action: async (_, fn) => fn(), $: id => nodes[id], api: async (url, data) => { calls.push([url, data]); if (url === 'setup/https') return { phase }; if (url === 'system-proxy' && failRouting) throw new Error('Denied'); }
  });
  vm.runInContext(handler, context);
  let error;
  try { await nodes['capture-toggle'].onclick(); } catch (e) { error = e; }
  return { calls, context, error };
}
test('one start control verifies HTTPS before enabling routing; cancellation never routes', async () => {
  assert.deepEqual((await run()).calls.map(c => c[0]), ['capture', 'setup/https', 'system-proxy']);
  assert.deepEqual((await run({ phase: 'needs-approval' })).calls.map(c => c[0]), ['capture', 'setup/https']);
  assert.equal((await run({ services: [] })).calls.length, 0);
});
test('stop uses restore-before-stop API; local mode skips trust and routing', async () => {
  assert.deepEqual(JSON.parse(JSON.stringify((await run({ active: true })).calls)), [['capture', { enabled: false }]]);
  assert.deepEqual((await run({ local: true })).calls.map(c => c[0]), ['capture']);
  const failed = await run({ failRouting: true });
  assert.match(failed.error.message, /Denied/);
  assert.equal(failed.context.interceptionWork, '');
  assert.equal(failed.context.state.systemProxy, false);
});
