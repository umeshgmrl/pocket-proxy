// Remains alive if the main process is killed, to restore its saved Mac proxy.
import { MacProxy } from './macos.js';
const mac = new MacProxy(process.argv[2]);
let clean = false;
process.on('message', message => { if (message === 'clean-exit') { clean = true; process.exit(0); } });
process.on('disconnect', async () => {
  if (clean) return;
  try { await mac.restore(); }
  catch (error) { console.error('Pocket Proxy recovery:', error.message, '\nRestart the app to retry restoration.'); }
  process.exit(0);
});
