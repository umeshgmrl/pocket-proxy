import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);

export async function openCertificateSetup(certPath, execute = exec) {
  const fingerprint = new X509Certificate(await readFile(certPath)).fingerprint256;
  let keychain = null;
  for (const [name, file] of [
    ['System', '/Library/Keychains/System.keychain'],
    ['login', path.join(homedir(), 'Library/Keychains/login.keychain-db')]
  ]) {
    try {
      const { stdout } = await execute('/usr/bin/security', ['find-certificate', '-a', '-c', 'Pocket Proxy Personal CA', '-p', file], { timeout: 15000 });
      const certs = stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      if (certs.some(pem => new X509Certificate(pem).fingerprint256 === fingerprint)) { keychain = name; break; }
    } catch {
      // A missing/locked keychain must not prevent opening the public certificate.
    }
  }
  // Trust must be approved in an interactive GUI session. Do not attempt to
  // change the authorization database or treat importing as granting trust.
  await execute('/usr/bin/open', ['-a', 'Keychain Access', ...(keychain ? [] : [certPath])], { timeout: 15000 });
  return {
    requiresUserAction: true,
    keychain,
    message: `${keychain ? `In Keychain Access, select the ${keychain} keychain.` : 'In Keychain Access, add the certificate to the login keychain if prompted.'} Search for “Pocket Proxy Personal CA”, double-click it, expand Trust, and set Secure Sockets Layer (SSL) to Always Trust. Close the certificate window and authorize macOS to save. Opening or importing the certificate alone does not enable trust.`
  };
}
