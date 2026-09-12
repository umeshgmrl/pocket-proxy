import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);

export async function openCertificateSetup(certPath, execute = exec) {
  const identity = await certificateIdentity(certPath);
  const fingerprint = identity.fingerprint;
  let keychain = null;
  for (const [name, file] of [
    ['System', '/Library/Keychains/System.keychain'],
    ['login', path.join(homedir(), 'Library/Keychains/login.keychain-db')]
  ]) {
    try {
      const { stdout } = await execute('/usr/bin/security', ['find-certificate', '-a', '-p', file], { timeout: 15000 });
      const certs = stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      if (certs.some(pem => new X509Certificate(pem).fingerprint256 === fingerprint)) { keychain = name; break; }
    } catch {
      // A missing/locked keychain must not prevent opening the public certificate.
    }
  }
  // Trust must be approved in an interactive GUI session. Do not attempt to
  // change the authorization database or treat importing as granting trust.
  if (!keychain) {
    try {
      await execute('/usr/bin/security', ['add-certificates', '-k', path.join(homedir(), 'Library/Keychains/login.keychain-db'), certPath], { timeout: 30000 });
      keychain = 'login';
    } catch {
      // If import needs a GUI, open the exact public file for macOS's import dialog.
    }
  }
  await execute('/usr/bin/open', ['-a', 'Keychain Access', ...(keychain ? [] : [certPath])], { timeout: 15000 });
  return {
    requiresUserAction: true,
    keychain,
    message: `${keychain ? `The certificate is in your ${keychain} keychain.` : 'Add the certificate to login if prompted.'} In Keychain Access, find “${identity.name}” (SHA-256 starts ${identity.shortId}), double-click it, expand Trust, and set Secure Sockets Layer (SSL) to Always Trust. Close the window to save, then return here and verify HTTPS.`
  };
}

export async function certificateIdentity(certPath) {
  const cert = new X509Certificate(await readFile(certPath));
  return { name: cert.subject.split('\n').find(line => line.startsWith('CN='))?.slice(3) || 'Pocket Proxy certificate', fingerprint: cert.fingerprint256, shortId: cert.fingerprint256.replaceAll(':', '').slice(0, 8) };
}
async function helperPath() {
  const { access } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const bundled = fileURLToPath(new URL('../../MacOS/CertificateSetup', import.meta.url));
  try { await access(bundled); return bundled; } catch {}
  const { buildCertificateHelper } = await import('../scripts/build-certificate-helper.js');
  return buildCertificateHelper();
}
export async function nativeCertificateAction(args, execute = exec) {
  const { stdout } = await execute(await helperPath(), args, { timeout: args[0] === '--trust' ? 180000 : 15000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}
export class HttpsSetup {
  constructor({ certPath, engine, native = nativeCertificateAction, fallback = openCertificateSetup }) {
    this.certPath = certPath; this.engine = engine; this.native = native; this.fallback = fallback;
    this.state = { phase: 'unchecked', message: 'Check HTTPS setup to see what this Mac needs.' };
  }
  async verify() {
    if (!this.engine.running) return this.state = { phase: 'paused', message: 'Start capture to check HTTPS.' };
    try {
      const result = await this.native(['--verify', String(this.engine.port), this.engine.probeToken]);
      return this.state = result.ok
        ? { phase: 'ready', verifiedAt: Date.now(), message: 'HTTPS verified through this proxy using macOS certificate trust.' }
        : { phase: 'needs-approval', message: 'HTTPS is not verified yet. Set up this app’s certificate, then check again.', detail: result.message, errorCode: result.errorCode };
    } catch (error) { return this.state = { phase: 'error', message: 'The HTTPS check could not run. Try again or use the Keychain fallback.', detail: error.message }; }
  }
  async setup() {
    if ((await this.verify()).phase === 'ready') return this.state;
    if (!this.engine.running) return this.state;
    try {
      const identity = await certificateIdentity(this.certPath);
      const result = await this.native(['--trust', this.certPath, identity.fingerprint]);
      if (!result.ok) return this.state = { phase: 'needs-approval', message: result.message, fallback: true };
      return await this.verify();
    } catch { return this.state = { phase: 'needs-approval', message: 'Native approval could not finish. Use the Keychain fallback, then verify HTTPS.', fallback: true }; }
  }
}
