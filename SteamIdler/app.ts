

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






async function steamLogin(username: string, password: string): Promise<void> {
	// Step 1: Authenticate with steam-session
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
		for (const action of result.validActions) {
			if (action.type === 3) { // DeviceConfirmation
				console.log('Steam Guard Mobile: Please approve the login request on your mobile device.');
				await ask('Press Enter after you have approved the login on your phone...');
				// Wait for authenticated event
				await new Promise<void>((resolve, reject) => {
					session.on('authenticated', () => resolve());
					session.on('timeout', () => reject(new Error('Login timed out.')));
					session.on('error', (err: any) => reject(err));
				});
			} else if (action.type === 1) { // DeviceCode (TOTP)
				const code = await ask('Enter the code from your Steam mobile app: ');
				await session.submitSteamGuardCode(code);
			} else if (action.type === 2) { // EmailCode
				const code = await ask('Enter the code sent to your email: ');
				await session.submitSteamGuardCode(code);
			} else {
				throw new Error('Unsupported Steam Guard action: ' + action.type);
			}
		}
	}

	// Step 2: Use refresh token to log in with steam-user
	const refreshToken = session.refreshToken;
	if (!refreshToken) throw new Error('No refresh token received.');

	await new Promise<void>((resolve, reject) => {
		const client = new SteamUser();
		client.logOn({
			refreshToken
		});
		client.on('loggedOn', () => {
			console.log('Logged in to Steam! Starting card idling...');
			const appIdsToIdle = [730]; // Example: CS:GO (730). Add more appIDs as needed
			client.gamesPlayed(appIdsToIdle);
			console.log('Idling games:', appIdsToIdle.join(', '));
			resolve();
		});
		client.on('error', (err: any) => {
			console.error('Steam-user error:', err);
			reject(err);
		});
	});
}

async function main() {
	const username = await ask('Steam Username: ');
	const password = await ask('Steam Password: ');
	try {
		await steamLogin(username, password);
	} catch (err) {
		console.error('Failed to login:', err);
	} finally {
		rl.close();
	}
}

main();