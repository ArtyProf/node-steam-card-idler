import { ask, steamLogin, closePrompt } from './auth.js';
import { SteamIdlerManager } from './idler.js';

async function main() {
  try {
    const username = await ask('Steam Username: ');
    const password = await ask('Steam Password: ');
    const refreshToken = await steamLogin(username, password);
    const apiKeyInput = process.env.STEAM_API_KEY || await ask('Enter Steam Web API Key (optional, press Enter to skip): ');
    const apiKey = apiKeyInput && apiKeyInput.trim() !== '' ? apiKeyInput.trim() : undefined;
    const idler = new SteamIdlerManager(undefined, { apiKey, targetParallel: 20 });
    await idler.logOnWithRefresh(refreshToken!);
    await idler.start();
    console.log('Idler started. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('Fatal error:', err);
  }
}

main().finally(() => {
  // keep process alive for intervals; do not close prompt until exit
  setTimeout(() => { /* noop keep alive */ }, 0);
});