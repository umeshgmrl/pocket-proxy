import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './storage.js';
import { withFileLock } from './lock.js';
import { openCertificateSetup } from './certificate.js';
const exec = promisify(execFile);
const networksetup = '/usr/sbin/networksetup';
const modes = ['webproxy', 'securewebproxy'];
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function parseProxy(output) {
  const fields = Object.fromEntries(output.trim().split('\n').map(line => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
  return { enabled: fields.Enabled === 'Yes', server: fields.Server || '', port: Number(fields.Port || 0), authenticated: fields['Authenticated Proxy Enabled'] === '1' };
}
async function run(args) {
  const { stdout, stderr } = await exec(networksetup, args, { timeout: 15000 });
  if (/failed|\*\* Error|not a recognized network service/i.test(stdout + stderr)) throw new Error((stdout + stderr).trim());
  return stdout;
}
async function elevated(commands) {
  if (!commands.length) return;
  // AppleScript receives a shell program as a separate argv value; every argument
  // is shell-quoted. No network name, path or port is interpolated as code.
  const shell = 'set -e\n' + commands.map(args => args.map(quote).join(' ')).join('\n');
  await exec('/usr/bin/osascript', ['-e', 'on run argv\n do shell script (item 1 of argv) with administrator privileges\nend run', shell], { timeout: 180000 });
}
export class MacProxy {
  constructor(dir, runner = run, elevate = elevated) {
    this.journalPath = path.join(dir, 'mac-proxy.json'); this.run = runner; this.elevate = elevate;
  }
  async services() {
    if (process.platform !== 'darwin') return [];
    return (await this.run(['-listallnetworkservices'])).split('\n').slice(1).map(x => x.trim()).filter(x => x && !x.startsWith('*'));
  }
  async current(service, mode) { return parseProxy(await this.run([`-get${mode}`, service])); }
  async journal() { return readJson(this.journalPath, null); }
  async enable(services, port) {
    if (await this.journal()) throw new Error('Mac proxy is already enabled, or needs restoration first.');
    const available = await this.services();
    if (!Array.isArray(services) || !services.length || services.some(s => !available.includes(s))) throw new Error('Choose at least one available network service.');
    const entries = [];
    for (const service of [...new Set(services)]) {
      const pac = await this.run(['-getautoproxyurl', service]);
      const discovery = await this.run(['-getproxyautodiscovery', service]);
      if (/Enabled: Yes/i.test(pac) || /:\s*On/i.test(discovery)) throw new Error(`${service} uses automatic proxy configuration. Turn it off before using Pocket Proxy.`);
      for (const mode of modes) {
        const previous = await this.current(service, mode);
        if (previous.authenticated) throw new Error(`${service} has an authenticated proxy that cannot be safely restored. Use manual client proxy configuration.`);
        entries.push({ service, mode, previous });
      }
    }
    // Persist before any OS changes so interrupted setup can also be restored.
    await writeJson(this.journalPath, { port, entries, createdAt: Date.now() });
    try {
      await this.elevate(entries.flatMap(({ service, mode }) => [
        [networksetup, `-set${mode}`, service, '127.0.0.1', String(port)],
        [networksetup, `-set${mode}state`, service, 'on']
      ]));
      for (const { service, mode } of entries) {
        const current = await this.current(service, mode);
        if (!current.enabled || current.server !== '127.0.0.1' || current.port !== port) throw new Error(`Could not enable proxy for ${service}.`);
      }
    } catch (error) {
      await this.restore().catch(restoreError => { error.message += ` Restoration needs attention: ${restoreError.message}`; });
      throw error;
    }
  }
  async restore() {
    return withFileLock(`${this.journalPath}.lock`, () => this.restoreLocked());
  }
  async restoreLocked() {
    const journal = await this.journal();
    if (!journal) return;
    const commands = [];
    const owned = [];
    for (const { service, mode, previous } of journal.entries) {
      const current = await this.current(service, mode);
      // Do not overwrite a proxy that the user or another application changed.
      if (current.server !== '127.0.0.1' || current.port !== journal.port) continue;
      owned.push({ service, mode, previous });
      if (previous.server && previous.port) commands.push([networksetup, `-set${mode}`, service, previous.server, String(previous.port)]);
      commands.push([networksetup, `-set${mode}state`, service, previous.enabled ? 'on' : 'off']);
    }
    await this.elevate(commands);
    // Keep the journal if any still-owned configuration was not restored.
    for (const { service, mode, previous } of owned) {
      const current = await this.current(service, mode);
      if (current.enabled !== previous.enabled || (previous.server && previous.port && (current.server !== previous.server || current.port !== previous.port))) throw new Error(`Restoration failed for ${service}; recovery data was preserved.`);
    }
    await unlink(this.journalPath);
  }
  async trustCertificate(certPath) {
    return openCertificateSetup(certPath);
  }
}
