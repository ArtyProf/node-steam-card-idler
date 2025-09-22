# SteamIdler

Automates idling multiple Steam games in parallel, prioritizing those with remaining trading card drops by parsing community badge pages when the public Web API does not expose remaining counts.

## Core Features
- TypeScript + Node.js implementation
- Steam refresh token login (via [`steam-session`](https://www.npmjs.com/package/steam-session) / [`steam-user`](https://www.npmjs.com/package/steam-user))
- Automatic capture of web session cookies for community badge parsing
- Prioritizes games by remaining card drops
- Parallel idling target (default 20) with periodic badge refresh (30 min)
- Broad fallback scan (optional) for card-capable titles if no remaining info detected
- Lightweight store category cache to avoid repeating card-capability lookups

## Dependencies
Runtime:
- [`steam-user`](https://www.npmjs.com/package/steam-user) – Steam client interaction (logon, gamesPlayed, webSession cookies)
- [`steam-session`](https://www.npmjs.com/package/steam-session) – Modern authentication & refresh token flow (handles Steam Guard)

Dev:
- `typescript` – Build
- `@types/node` – Type definitions

## Installation
```bash
git clone https://github.com/ArtyProf/node-steam-card-idler.git
cd SteamIdler
npm install
npm run build
npm start
```

### Package Manager Links / Alternatives
- npm: https://www.npmjs.com/
- Yarn: https://yarnpkg.com/
- pnpm: https://pnpm.io/

You can use any Node package manager you prefer.

Using Yarn:
```bash
yarn install
yarn build
yarn start
```

Using pnpm:
```bash
pnpm install
pnpm run build
pnpm start
```
## Running
When starting you will be prompted for:
1. Steam username
2. Steam password
3. Steam Guard (approve via mobile app)
4. `STEAM_API_KEY` (REQUIRED) – Steam Web API key (get one at https://steamcommunity.com/dev/apikey)

Set the key via environment variable before launching:

PowerShell:
```powershell
$env:STEAM_API_KEY="YOURKEY"; npm start
```

Bash / Linux / macOS:
```bash
export STEAM_API_KEY="YOURKEY"
npm start
```

## Configuration
Primary adjustable setting: parallel idling target (default 20) passed to the `SteamIdlerManager` constructor. Future improvement: external config file.

Environment variable:
- `STEAM_API_KEY` (required): Enables Web API calls for owned games & badges retrieval.

Generated files:
- `store-category-cache.json` – Persists per-app card capability (Steam store category id 29) to reduce API calls.

## How Remaining Drops Are Determined
Steam's public `GetBadges` API often omits remaining card drop counts for some accounts. When counts are missing, the app fetches the Steam Community badge pages using captured web session cookies and parses each badge block to infer remaining drops via one of:
1. Direct text `(N) card drops remaining`
2. Difference between `Card drops earned` and `Card drops received`
3. Explicit `No card drops remaining` marker

The resulting remaining counts are merged onto badge entries and sorted (highest remaining first) to pick the initial idling set.

## Broad Mode Fallback
If no badges with remaining drops are found, the app enables a broad scanning mode which checks owned games for trading card capability (store category 29). This provides a list of candidate games even when remaining counts are undiscoverable.

## Development Style ("Vibe Coding" Note)
This project evolved iteratively (“vibe coding”)—features were added experimentally, refined through live runs, and obsolete heuristics were removed once robust community badge parsing was in place. The code favors pragmatic functionality over premature abstraction.

## Roadmap Ideas
- Global error / unhandled rejection logging to diagnose early termination
- External config file for intervals & parallel targets
- Rotational cycling strategy when more than targetParallel have remaining drops
- Optional verbose / silent logging modes

## Disclaimer
Use responsibly and in accordance with Steam's Terms of Service. There is no guarantee of safety from rate limits or policy changes; parsing HTML is inherently brittle.
