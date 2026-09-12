import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
export async function ensureCA(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'ca.json');
  let ca = await readJson(file, null);
  if (!ca) {
    const { generateCACertificate } = await import('mockttp');
    ca = await generateCACertificate({ subject: { commonName: 'Pocket Proxy Personal CA', organizationName: 'Pocket Proxy' } });
    await writeJson(file, ca);
  }
  const certPath = path.join(dir, 'pocket-proxy-ca.pem');
  await writeFile(certPath, ca.cert, { mode: 0o600 });
  return { ...ca, certPath };
}
