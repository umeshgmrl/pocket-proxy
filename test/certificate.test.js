import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureCA } from '../src/storage.js';
import { openCertificateSetup, HttpsSetup, certificateIdentity } from '../src/certificate.js';

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
    assert.equal(missing.keychain, 'login');
    assert.ok(missingCalls.some(([, args]) => args[0] === 'add-certificates'));
    assert.deepEqual(missingCalls.at(-1), ['/usr/bin/open', ['-a', 'Keychain Access']]);
    assert.match(missing.message, /login keychain/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('guided setup verifies before and after approval, and never equates import with trust', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pocket-setup-'));
  try {
    const ca = await ensureCA(dir);
    const identity = await certificateIdentity(ca.certPath);
    assert.match(identity.name, /^Pocket Proxy CA - [A-F0-9]{8}$/);
    assert.equal((await ensureCA(dir)).cert, ca.cert);
    const engine = { running: true, port: 8899, probeToken: 'a'.repeat(32) };
    const calls = [];
    let checks = 0;
    const setup = new HttpsSetup({ certPath: ca.certPath, engine, native: async args => { calls.push(args); return { ok: args[0] === '--trust' || ++checks > 1 }; } });
    assert.equal((await setup.setup()).phase, 'ready');
    assert.deepEqual(calls.map(c => c[0]), ['--verify', '--trust', '--verify']);
    assert.equal(calls[1][2], identity.fingerprint);
    calls.length = 0;
    assert.equal((await setup.setup()).phase, 'ready');
    assert.deepEqual(calls.map(c => c[0]), ['--verify']);
    setup.native = async args => ({ ok: args[0] === '--trust', message: 'Not trusted' });
    assert.equal((await setup.setup()).phase, 'needs-approval');
    setup.native = async () => ({ ok: false, message: 'Cancelled' });
    assert.equal((await setup.setup()).message, 'Cancelled');
    engine.running = false;
    assert.equal((await setup.verify()).phase, 'paused');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
