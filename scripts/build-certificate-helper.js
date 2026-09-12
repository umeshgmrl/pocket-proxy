import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
let pending;
export async function buildCertificateHelper() {
  if (pending) return pending;
  pending = (async () => {
    const source = fileURLToPath(new URL('../native/CertificateSetup.swift', import.meta.url));
    const output = fileURLToPath(new URL('../build/certificate-helper/CertificateSetup', import.meta.url));
    const cache = fileURLToPath(new URL('../build/certificate-helper/cache', import.meta.url));
    try { if ((await stat(output)).mtimeMs >= (await stat(source)).mtimeMs) return output; } catch {}
    await mkdir(cache, { recursive: true });
    try { await exec('/usr/bin/swiftc', ['-O', '-module-cache-path', cache, source, '-o', output, '-framework', 'Cocoa', '-framework', 'Security'], { timeout: 180000 }); }
    finally { await rm(cache, { recursive: true, force: true }); }
    return output;
  })();
  try { return await pending; } finally { pending = undefined; }
}
