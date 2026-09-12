import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureCA } from '../src/storage.js';
import { openCertificateSetup } from '../src/certificate.js';

test('certificate setup opens the existing exact certificate keychain without granting trust', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pocket-cert-'));
  try {
    const ca = await ensureCA(dir);
    const calls = [];
    const result = await openCertificateSetup(ca.certPath, async (command, args) => {
      calls.push([command, args]);
      return { stdout: command.endsWith('/security') ? ca.cert : '' };
    });
    assert.equal(result.keychain, 'System');
    assert.equal(result.requiresUserAction, true);
    assert.match(result.message, /Secure Sockets Layer/);
    assert.deepEqual(calls.at(-1), ['/usr/bin/open', ['-a', 'Keychain Access']]);
    assert.equal(calls.some(([command, args]) => command.endsWith('/osascript') || args.includes('add-trusted-cert')), false);
    const missingCalls = [];
    const missing = await openCertificateSetup(ca.certPath, async (command, args) => { missingCalls.push([command, args]); return { stdout: '' }; });
    assert.equal(missing.keychain, null);
    assert.deepEqual(missingCalls.at(-1), ['/usr/bin/open', ['-a', 'Keychain Access', ca.certPath]]);
    assert.match(missing.message, /login keychain/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
