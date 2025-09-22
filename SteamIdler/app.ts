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
		refreshToken = await steamLogin(username, password);
		await new Promise<void>((resolve, reject) => {
			const client = new SteamUser();
			client.logOn({ refreshToken });
			client.on('loggedOn', async () => {
				console.log('Logged in to Steam! Gathering games with card drops (Web API)...');
				try {
					const apiKey = process.env.STEAM_API_KEY || await ask('Enter Steam Web API Key (or leave blank for manual appIDs): ');
					let appIdsToIdle: number[] = [];
					if (apiKey && apiKey.trim() !== '' && client.steamID) {
						const steamId64 = client.steamID.getSteamID64();
						const badgesUrl = `https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamId64}`;
						console.log('Requesting badges (key hidden) ...');
						const resp = await fetch(badgesUrl, { headers: { 'user-agent': 'SteamIdler/1.0' } });
						if (!resp.ok) throw new Error('GetBadges HTTP ' + resp.status);
						const data = await resp.json();
						const badges = data?.response?.badges;
						if (!Array.isArray(badges)) {
							console.log('No badges array in response. Response keys:', Object.keys(data?.response || {}));
						} else {
							console.log(`Badges returned: ${badges.length}`);
						}
						if (Array.isArray(badges)) {
							let countWithCards = 0;
							for (const badge of badges) {
								if (badge && typeof badge.appid === 'number' && badge.appid > 0 && badge.cards_remaining > 0) {
									appIdsToIdle.push(badge.appid);
									countWithCards++;
								}
							}
								console.log(`Badges with remaining cards: ${countWithCards}`);
								if (countWithCards === 0) {
									console.log('Explanation: Web API only shows remaining drops for games with an active badge entry. Unplayed card-enabled games appear as zero. Running heuristic discovery of unplayed card-capable titles (category 29)...');
								}
							}

							// Heuristic discovery if no direct badge drops found
							if (appIdsToIdle.length === 0) {
								try {
									console.log('Heuristic: Fetching owned games...');
									const ownedUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamId64}&include_played_free_games=1&include_appinfo=1`;
									const ownedResp = await fetch(ownedUrl, { headers: { 'user-agent': 'SteamIdler/1.0' } });
									if (!ownedResp.ok) throw new Error('GetOwnedGames HTTP ' + ownedResp.status);
									const ownedData = await ownedResp.json();
									const games = ownedData?.response?.games;
									if (Array.isArray(games)) {
										console.log(`Owned games: ${games.length}`);
										const neverPlayed = games.filter((g: any) => g.playtime_forever === 0 && typeof g.appid === 'number');
										console.log(`Never played games: ${neverPlayed.length}`);
										const MAX_PROBE = 60;
										const subset = neverPlayed.slice(0, MAX_PROBE);
										console.log(`Probing first ${subset.length} never-played games for trading card support (category 29)...`);
										const concurrency = 5;
										let idx = 0;
										const found: number[] = [];
										async function probe(appid: number) {
											const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=categories`;
											try {
												const r = await fetch(url, { headers: { 'user-agent': 'SteamIdler/1.0' } });
												if (!r.ok) return;
												const j = await r.json();
												const entry = j?.[appid];
												if (entry && entry.success && entry.data && Array.isArray(entry.data.categories)) {
													if (entry.data.categories.some((c: any) => c && c.id === 29)) {
														found.push(appid);
													}
												}
											} catch {/* ignore individual errors */}
										}
										async function runBatch(): Promise<void> {
											const batch: Promise<void>[] = [];
											for (let i = 0; i < concurrency && idx < subset.length; i++, idx++) {
												batch.push(probe(subset[idx].appid));
											}
											if (batch.length === 0) return;
											await Promise.all(batch);
											if (idx < subset.length) await runBatch();
										}
										await runBatch();
										console.log(`Heuristic: Found ${found.length} candidate unplayed card-capable games.`);
										if (found.length > 0) {
											appIdsToIdle = found.slice(0, 32); // respect display limit
											console.log('Heuristic list will be idled.');
										}
									} else {
										console.log('Owned games list missing or malformed.');
									}
								} catch (heurErr) {
									console.log('Heuristic discovery error:', heurErr instanceof Error ? heurErr.message : heurErr);
								}
							}
						if (appIdsToIdle.length === 0) {
							console.log('No games with card drops via Web API.');
							const fallback = await ask('Enter appIDs manually (comma separated) or press Enter to exit: ');
							if (fallback.trim() !== '') {
								appIdsToIdle = fallback.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
							}
						}
					} else {
						const manual = await ask('Enter appIDs to idle (comma separated): ');
						appIdsToIdle = manual.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
					}
					if (appIdsToIdle.length === 0) {
						console.log('Nothing to idle. Exiting.');
						resolve();
						return;
					}
					// De-duplicate & optionally limit concurrent idling size (Steam typically shows up to ~32)
					appIdsToIdle = Array.from(new Set(appIdsToIdle)).slice(0, 32);
					client.gamesPlayed(appIdsToIdle);
					console.log('Idling games:', appIdsToIdle.join(', '));
					resolve();
				} catch (e) {
					console.error('Failed to collect card-drop games:', e);
					reject(e);
				}
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