import readline from 'node:readline';
import { LoginSession, EAuthTokenPlatformType } from 'steam-session';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

export function ask(query: string): Promise<string> {
  return new Promise(resolve => rl.question(query, resolve));
}

export function closePrompt() {
  rl.close();
}

export async function steamLogin(username: string, password: string, existingRefreshToken?: string): Promise<string> {
  if (existingRefreshToken) return existingRefreshToken;
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  let authenticated = false;
  session.on('authenticated', () => { authenticated = true; });
  session.on('timeout', () => { if (!authenticated) throw new Error('Login timed out.'); });
  session.on('error', (err: any) => { throw err; });

  const result = await session.startWithCredentials({ accountName: username, password });

  if (result.actionRequired && result.validActions) {
    let needsDeviceConfirmation = false;
    let needsPermissionRequest = false;
    for (const action of result.validActions) {
      if (action.type === 3) needsDeviceConfirmation = true;
      if (action.type === 4) needsPermissionRequest = true;
    }
    if (needsDeviceConfirmation && needsPermissionRequest) {
      console.log('Steam Guard Mobile: Approve login AND permission request on your device.');
      await ask('Press Enter after approving both in your Steam mobile app...');
    } else if (needsDeviceConfirmation) {
      console.log('Steam Guard Mobile: Approve login on your device.');
      await ask('Press Enter after approval...');
    } else if (needsPermissionRequest) {
      console.log('Steam Mobile: Approve permission request (Allow).');
      await ask('Press Enter after approval...');
    }
    if (needsDeviceConfirmation || needsPermissionRequest) {
      if (!authenticated) {
        await new Promise<void>((resolve, reject) => {
          const onAuth = () => { cleanup(); resolve(); };
          const onTimeout = () => { cleanup(); reject(new Error('Login timed out.')); };
            const onError = (err: any) => { cleanup(); reject(err); };
          function cleanup() {
            session.off('authenticated', onAuth);
            session.off('timeout', onTimeout);
            session.off('error', onError);
          }
          session.on('authenticated', onAuth);
          session.on('timeout', onTimeout);
          session.on('error', onError);
        });
      }
    }
    for (const action of result.validActions) {
      if (action.type === 1) {
        const code = await ask('Enter mobile authenticator code: ');
        await session.submitSteamGuardCode(code);
      } else if (action.type === 2) {
        const code = await ask('Enter email code: ');
        await session.submitSteamGuardCode(code);
      } else if (![3,4].includes(action.type)) {
        throw new Error('Unsupported Steam Guard action: ' + action.type);
      }
    }
  }
  if (!session.refreshToken) throw new Error('No refresh token received.');
  return session.refreshToken;
}
