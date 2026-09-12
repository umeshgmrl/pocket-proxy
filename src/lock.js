import { open, readFile, unlink, stat } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
// Cross-process restoration lock: the watchdog and a restarted app can overlap.
export async function withFileLock(file, operation) {
  let handle;
  const deadline = Date.now() + 190000;
  while (!handle) {
    try { handle = await open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(file, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') { await unlink(file); continue; } }
        } else if (Date.now() - (await stat(file)).mtimeMs > 5000) { await unlink(file); continue; }
      } catch (probe) { if (probe.code === 'ENOENT') continue; throw probe; }
      if (Date.now() > deadline) throw new Error('Proxy restoration is busy in another process. Retry after its authorization dialog finishes.');
      await setTimeout(200);
    }
  }
  try { return await operation(); }
  finally { await handle.close(); await unlink(file).catch(() => {}); }
}
