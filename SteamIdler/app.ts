

import SteamUser from 'steam-user';
import readline from 'node:readline';
import { LoginSession, EAuthTokenPlatformType } from 'steam-session';


const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

function ask(query: string): Promise<string> {
	return new Promise(resolve => rl.question(query, resolve));
}




async function delay(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}







async function steamLogin(username: string, password: string, refreshToken?: string): Promise<string | undefined> {
	// If refreshToken is provided, skip session login
	if (refreshToken) return refreshToken;

	const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
	let authenticated = false;
	session.on('authenticated', () => {
		authenticated = true;
	});
	session.on('timeout', () => {
		if (!authenticated) throw new Error('Login timed out.');
	});
	session.on('error', (err: any) => {
		throw err;
	});

	const result = await session.startWithCredentials({
		accountName: username,
		password: password
	});

	if (result.actionRequired && result.validActions) {
		// Collect all required actions
		let needsDeviceConfirmation = false;
		let needsPermissionRequest = false;
		for (const action of result.validActions) {
			if (action.type === 3) needsDeviceConfirmation = true;
			if (action.type === 4) needsPermissionRequest = true;
		}

		if (needsDeviceConfirmation && needsPermissionRequest) {
			console.log('Steam Guard Mobile: Please approve the login request AND the permission request ("Allow") on your mobile device.');
			await ask('Press Enter after you have approved both requests in your Steam app...');
		} else if (needsDeviceConfirmation) {
			console.log('Steam Guard Mobile: Please approve the login request on your mobile device.');
			await ask('Press Enter after you have approved the login on your phone...');
		} else if (needsPermissionRequest) {
			console.log('Steam is requesting additional permission ("Allow" or "Not Now").');
			await ask('Please approve the permission request in your Steam app, then press Enter to continue...');
		}

		// Wait for authentication if not already done
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

		// Handle TOTP and EmailCode
		for (const action of result.validActions) {
			if (action.type === 1) { // DeviceCode (TOTP)
				const code = await ask('Enter the code from your Steam mobile app: ');
				await session.submitSteamGuardCode(code);
			} else if (action.type === 2) { // EmailCode
				const code = await ask('Enter the code sent to your email: ');
				await session.submitSteamGuardCode(code);
			} else if (![3,4].includes(action.type)) {
				throw new Error('Unsupported Steam Guard action: ' + action.type);
			}
		}
	}

	if (!session.refreshToken) throw new Error('No refresh token received.');
	return session.refreshToken;
}


async function main() {
	const username = await ask('Steam Username: ');
	const password = await ask('Steam Password: ');
	let refreshToken: string | undefined = undefined;
	try {
		// Try to load refresh token from file (optional, not implemented here)
		refreshToken = await steamLogin(username, password);
		// Optionally, save refreshToken to disk for future use
		const appIdsInput = await ask('Enter appIDs to idle (comma separated, e.g. 730,440): ');
		const appIdsToIdle = appIdsInput.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
		if (appIdsToIdle.length === 0) {
			console.log('No valid appIDs entered. Exiting.');
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const client = new SteamUser();
			client.logOn({ refreshToken });
			client.on('loggedOn', () => {
				console.log('Logged in to Steam! Starting card idling...');
				client.gamesPlayed(appIdsToIdle);
				console.log('Idling games:', appIdsToIdle.join(', '));
				resolve();
			});
			client.on('error', (err: any) => {
				console.error('Steam-user error:', err);
				reject(err);
			});
		});
	} catch (err) {
		console.error('Failed to login:', err);
	} finally {
		rl.close();
	}
}

main();