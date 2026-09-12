import { build } from 'esbuild';
import { mkdir, rm, readFile, writeFile, readdir, copyFile, cp, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const app = path.join(dist, 'Pocket Proxy.app');
const resources = path.join(app, 'Contents/Resources');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
const onlyJS = process.argv.includes('--js-only');
await mkdir(dist, { recursive: true });
await rm(app, { recursive: true, force: true });
await mkdir(path.join(resources, 'src'), { recursive: true });
await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
await writeFile(path.join(resources, 'package.json'), JSON.stringify({ type: 'module', version: pkg.version }));
await cp(path.join(root, 'public'), path.join(resources, 'public'), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.js', 'src/watchdog.js'], outdir: path.join(resources, 'src'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  minify: true, keepNames: true, sourcemap: false, metafile: true,
  legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: 'import { createRequire as __pocketCreateRequire } from "node:module"; import { fileURLToPath as __pocketFileURLToPath } from "node:url"; import { dirname as __pocketDirname } from "node:path"; const require = __pocketCreateRequire(import.meta.url); const __filename = __pocketFileURLToPath(import.meta.url); const __dirname = __pocketDirname(__filename);' }
});
await writeFile(path.join(dist, 'bundle-analysis.json'), JSON.stringify(result.metafile, null, 2));
// Include original package license/notice texts, not only minifier-preserved comments.
const packageDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const index = input.lastIndexOf('node_modules/');
  if (index < 0) continue;
  const parts = input.slice(index + 13).split('/');
  const count = parts[0].startsWith('@') ? 2 : 1;
  packageDirs.add(path.join(root, input.slice(0, index + 13), ...parts.slice(0, count)));
}
let notices = 'Pocket Proxy — Third-party notices\nBundled dependencies retain their original licenses.\n';
for (const dir of [...packageDirs].sort()) {
  const dep = JSON.parse(await readFile(path.join(dir, 'package.json')));
  notices += `\n${'='.repeat(72)}\n${dep.name} ${dep.version} — ${dep.license || 'See package license'}\n`;
  for (const name of await readdir(dir)) {
    if (/^(licen[cs]e|copying|notice|copyright)(\.|$)/i.test(name) && (await stat(path.join(dir, name))).isFile()) notices += `\n${name}\n${await readFile(path.join(dir, name), 'utf8')}\n`;
  }
}
await writeFile(path.join(resources, 'THIRD-PARTY-NOTICES.txt'), notices);
if (onlyJS) { console.log(`JavaScript release built: ${app}`); process.exit(0); }
// Native compilation and installer creation are below; Node is never copied.
const work = path.join(root, 'build/release-native');
await mkdir(work, { recursive: true });
try {
  await copyFile(path.join(root, 'native/WebView.swift'), path.join(work, 'main.swift'));
  const target = process.arch === 'arm64' ? 'arm64-apple-macosx13.0' : 'x86_64-apple-macosx13.0';
  await exec('/usr/bin/swiftc', ['-O', '-target', target, '-D', 'RELEASE', '-module-cache-path', path.join(work, 'cache'), path.join(work, 'main.swift'), path.join(root, 'native/NodeRuntime.swift'), '-o', path.join(app, 'Contents/MacOS/PocketProxy'), '-framework', 'Cocoa', '-framework', 'WebKit'], { timeout: 180000 });
} finally { await rm(work, { recursive: true, force: true }); }
await writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PocketProxy</string>
<key>CFBundleIdentifier</key><string>local.pocketproxy.desktop</string>
<key>CFBundleName</key><string>Pocket Proxy</string>
<key>CFBundleDisplayName</key><string>Pocket Proxy</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${pkg.version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`);
await exec('/usr/bin/codesign', ['--force', '--sign', '-', app]);
async function bytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) total += entry.isDirectory() ? await bytes(path.join(dir, entry.name)) : (await stat(path.join(dir, entry.name))).size;
  return total;
}
const installedBytes = await bytes(app);
if (installedBytes >= 15_000_000) throw new Error(`Release exceeds 15 MB: ${installedBytes} bytes`);
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const dmg = path.join(dist, `Pocket-Proxy-${pkg.version}-${arch}.dmg`);
const staging = path.join(dist, '.dmg-staging');
await mkdir(staging, { recursive: true });
try {
  await cp(app, path.join(staging, 'Pocket Proxy.app'), { recursive: true });
  await symlink('/Applications', path.join(staging, 'Applications'));
  await writeFile(path.join(staging, 'Read Me.txt'), 'Pocket Proxy\n\nDrag Pocket Proxy.app to Applications, then open it.\nRequires an existing Node.js 22+ installation. No npm install or Xcode is needed.\n\nIn Connection setup, trust the certificate in Keychain Access and enable the Mac proxy.\nThis personal build is ad-hoc signed, not Apple-notarized.\n');
  await exec('/usr/bin/hdiutil', ['create', '-volname', 'Pocket Proxy', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg], { timeout: 120000 });
} finally { await rm(staging, { recursive: true, force: true }); }
const report = { version: pkg.version, arch, installedBytes, dmgBytes: (await stat(dmg)).size, nodeBundled: false, app, dmg };
await writeFile(path.join(dist, 'release-size.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
