import { spawn, fork } from 'node:child_process';
import { mkdir, open, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { MacProxy } from './macos.js';
import { buildWebview } from '../scripts/build-webview.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.resolve(process.env.POCKET_PROXY_DATA_DIR || path.join(root, '.data'));
const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log('Pocket Proxy\n  npm start                  Native macOS window\n  npm run dev                Browser UI\n  npm run server             Headless server\n  npm start -- --system-proxy Enable all supported Mac network services on launch\n  npm start -- --restore      Restore saved Mac proxy settings and exit\nEnvironment: POCKET_PROXY_UI_PORT (9077), POCKET_PROXY_PORT (8899), POCKET_PROXY_DATA_DIR');
  process.exit(0);
}
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const lockPath = path.join(dataDir, 'app.lock');
async function lock() {
  try { const file = await open(lockPath, 'wx', 0o600); await file.writeFile(String(process.pid)); await file.close(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    try { process.kill(pid, 0); throw new Error('Pocket Proxy is already running. Close it before starting another instance.'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    await unlink(lockPath); await lock();
  }
}
await lock();
const mac = new MacProxy(dataDir);
let app, child, watcher, closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  try {
    if (app) await app.close(); else await mac.restore();
    watcher?.send('clean-exit'); child?.kill();
    await unlink(lockPath).catch(() => {});
    process.exit(0);
  } catch (error) {
    console.error(`Could not restore Mac proxy settings: ${error.message}\nThe server is still running. Retry Ctrl+C, or use the Mac proxy switch.`);
    closing = false;
  }
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
try {
  if (await mac.journal()) { console.log('Restoring saved Mac proxy settings…'); await mac.restore(); }
  if (args.has('--restore')) { await unlink(lockPath); process.exit(0); }
  const port = (name, fallback) => {
    const value = Number(process.env[name] || fallback);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a port from 1024 to 65535.`);
    return value;
  };
  app = await createApp({ dataDir, mac, uiPort: port('POCKET_PROXY_UI_PORT', 9077), proxyPort: port('POCKET_PROXY_PORT', 8899) });
  watcher = fork(fileURLToPath(new URL('./watchdog.js', import.meta.url)), [dataDir], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  watcher.on('error', error => console.error('Recovery watcher:', error.message));
  if (args.has('--system-proxy')) await mac.enable(await mac.services(), app.engine.port);
  console.log(`\nPocket Proxy is running\nProxy: 127.0.0.1:${app.engine.port}\nOpen:  ${app.url}\nCA:    ${app.ca.certPath}\n\nUse the Mac proxy switch to capture system traffic. Ctrl+C stops and restores settings.\n`);
  if (!args.has('--headless')) {
    if (args.has('--browser') || process.platform !== 'darwin') {
      if (process.platform === 'darwin') spawn('/usr/bin/open', [app.url]);
    } else {
      console.log('Opening the native WebView (first launch compiles a small Swift window)…');
      try {
        child = spawn(await buildWebview(), [app.url], { stdio: 'inherit' });
        child.on('exit', shutdown); child.on('error', error => console.error('WebView:', error.message));
      } catch (error) { console.error(`WebView could not compile: ${error.message}\nUse the browser URL above, or install Xcode Command Line Tools with xcode-select --install.`); }
    }
  }
} catch (error) {
  console.error(error.message);
  if (app) await app.close().catch(e => console.error('Restoration:', e.message));
  watcher?.disconnect();
  await unlink(lockPath).catch(() => {});
  process.exit(1);
}
