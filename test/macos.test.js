import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MacProxy, parseProxy } from '../src/macos.js';
import { matches, validateRule } from '../src/rules.js';

test('Mac proxy settings restore previous values and leave unrelated changes alone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pocket-mac-'));
  const initial = { enabled: true, server: 'previous.proxy', port: 8080, authenticated: false };
  const settings = { webproxy: { ...initial }, securewebproxy: { ...initial } };
  const mac = new MacProxy(dir, async args => {
    if (args[0] === '-listallnetworkservices') return 'An asterisk denotes a disabled service.\nWi-Fi\n';
    if (args[0] === '-getautoproxyurl') return 'URL: (null)\nEnabled: No';
    if (args[0] === '-getproxyautodiscovery') return 'Auto Proxy Discovery: Off';
    const s = settings[args[0].slice(4)];
    return `Enabled: ${s.enabled ? 'Yes' : 'No'}\nServer: ${s.server}\nPort: ${s.port}\nAuthenticated Proxy Enabled: ${s.authenticated ? '1' : '0'}`;
  }, async commands => {
    for (const [, option, , host, port] of commands) {
      const key = option.slice(4).replace('state', '');
      if (option.endsWith('state')) settings[key].enabled = host === 'on';
      else { settings[key].server = host; settings[key].port = Number(port); }
    }
  });
  try {
    await mac.enable(['Wi-Fi'], 8899); assert.equal(settings.webproxy.port, 8899); assert.ok(await mac.journal());
    await mac.restore(); assert.deepEqual(settings.webproxy, initial); assert.equal(await mac.journal(), null);
    await mac.enable(['Wi-Fi'], 8899); settings.securewebproxy.server = 'changed.by.user';
    await mac.restore(); assert.deepEqual(settings.webproxy, initial); assert.equal(settings.securewebproxy.server, 'changed.by.user');
    // With no old proxy address, disable the owned endpoint without setting an invalid port 0.
    for (const mode of Object.keys(settings)) settings[mode] = { enabled: false, server: '', port: 0, authenticated: false };
    await mac.enable(['Wi-Fi'], 8899); await mac.restore();
    assert.equal(settings.webproxy.enabled, false); assert.equal(await mac.journal(), null);
    // A failed restoration must preserve the journal for a later recovery attempt.
    await mac.enable(['Wi-Fi'], 8899);
    const elevate = mac.elevate; mac.elevate = async () => {};
    await assert.rejects(mac.restore(), /Restoration failed/); assert.ok(await mac.journal());
    mac.elevate = elevate; await mac.restore();
    settings.webproxy.authenticated = true;
    await assert.rejects(mac.enable(['Wi-Fi'], 8899), /authenticated/); assert.equal(await mac.journal(), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('rules validate header injection and match literal URL characters', () => {
  assert.deepEqual(parseProxy('Enabled: Yes\nServer: localhost\nPort: 8899\nAuthenticated Proxy Enabled: 0'), { enabled: true, server: 'localhost', port: 8899, authenticated: false });
  const rule = validateRule({ name: 'glob', pattern: 'https://example.test/users/*?id=*', match: 'glob' });
  assert.equal(matches(rule, { method: 'GET', url: 'https://example.test/users/42?id=1' }), true);
  assert.equal(matches(rule, { method: 'GET', url: 'https://exampleXtest/users/42?id=1' }), false);
  assert.throws(() => validateRule({ name: 'bad', pattern: '*', headers: { hello: 'a\r\nb' } }));
});
