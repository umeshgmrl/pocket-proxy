import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export const binaryPath = fileURLToPath(new URL('../build/Pocket Proxy.app/Contents/MacOS/PocketProxy', import.meta.url));
export async function buildWebview() {
  const source = fileURLToPath(new URL('../native/WebView.swift', import.meta.url));
  const contents = fileURLToPath(new URL('../build/Pocket Proxy.app/Contents/', import.meta.url));
  await mkdir(`${contents}/MacOS`, { recursive: true });
  await writeFile(`${contents}/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>PocketProxy</string><key>CFBundleIdentifier</key><string>local.pocketproxy.webview</string><key>CFBundleName</key><string>Pocket Proxy</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>\n`);
  try { if ((await stat(binaryPath)).mtimeMs >= (await stat(source)).mtimeMs) return binaryPath; } catch {}
  const cache = fileURLToPath(new URL('../build/module-cache/', import.meta.url));
  await mkdir(cache, { recursive: true });
  try {
    await exec('/usr/bin/swiftc', ['-O', '-module-cache-path', cache, source, '-o', binaryPath, '-framework', 'Cocoa', '-framework', 'WebKit'], { timeout: 180000 });
  } finally { await rm(cache, { recursive: true, force: true }); }
  return binaryPath;
}
