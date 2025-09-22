import SteamUser from 'steam-user';
import { ask } from './auth.js';

interface BadgeInfo { appid: number; cards_remaining?: number; }

interface DiscoveryOptions {
  apiKey?: string | undefined;
  targetParallel: number; // desired number of simultaneous games
  heuristicMaxProbe?: number; // max store probes per cycle
  heuristicConcurrency?: number;
}

const DEFAULT_OPTIONS: DiscoveryOptions = {
  targetParallel: 20,
  heuristicMaxProbe: 120,
  heuristicConcurrency: 6
};

export class SteamIdlerManager {
  private client: any; // steam-user lacks full TS types; use any
  private steamId64?: string;
  private running: boolean = false;
  private currentIds: Set<number> = new Set();
  private options: DiscoveryOptions;
  private refreshIntervalMs = 30 * 60 * 1000; // 30 minutes
  private intervalHandle?: NodeJS.Timeout;

  constructor(client?: any, options?: Partial<DiscoveryOptions>) {
    this.client = client || new SteamUser();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async logOnWithRefresh(refreshToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.logOn({ refreshToken });
      this.client.once('loggedOn', () => {
        if (this.client.steamID) this.steamId64 = this.client.steamID.getSteamID64();
        console.log('Logged in as ' + this.steamId64);
        resolve();
      });
  this.client.once('error', (err: any) => reject(err));
    });
  }

  private async fetchBadges(apiKey: string): Promise<BadgeInfo[]> {
    if (!this.steamId64) return [];
    const url = `https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${encodeURIComponent(apiKey)}&steamid=${this.steamId64}`;
    const resp = await fetch(url, { headers: { 'user-agent': 'SteamIdler/1.0' } });
    if (!resp.ok) throw new Error('GetBadges HTTP ' + resp.status);
    const json = await resp.json();
    const badges = json?.response?.badges;
    if (!Array.isArray(badges)) return [];
    return badges.filter((b: any) => b && typeof b.appid === 'number');
  }

  private async fetchOwned(apiKey: string): Promise<any[]> {
    if (!this.steamId64) return [];
    const ownedUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${this.steamId64}&include_played_free_games=1&include_appinfo=1`;
    const ownedResp = await fetch(ownedUrl, { headers: { 'user-agent': 'SteamIdler/1.0' } });
    if (!ownedResp.ok) throw new Error('GetOwnedGames HTTP ' + ownedResp.status);
    const ownedData = await ownedResp.json();
    const games = ownedData?.response?.games;
    if (!Array.isArray(games)) return [];
    return games;
  }

  private async heuristicUnplayedCardGames(apiKey: string, minNeeded: number): Promise<number[]> {
    const owned = await this.fetchOwned(apiKey);
    const neverPlayed = owned.filter(g => g.playtime_forever === 0 && typeof g.appid === 'number');
    if (neverPlayed.length === 0) return [];
    const found: number[] = [];
    const concurrency = this.options.heuristicConcurrency || 5;
    const maxProbe = this.options.heuristicMaxProbe || 120;
    const subset = neverPlayed.slice(0, maxProbe);
    let idx = 0;
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
      } catch { /* ignore */ }
    }
    async function runBatch(): Promise<void> {
      const batch: Promise<void>[] = [];
      for (let i = 0; i < concurrency && idx < subset.length; i++, idx++) {
        batch.push(probe(subset[idx].appid));
      }
      if (!batch.length) return;
      await Promise.all(batch);
      if (idx < subset.length && found.length < minNeeded) await runBatch();
    }
    await runBatch();
    return found;
  }

  private chooseNextGames(candidates: number[], limit: number): number[] {
    const chosen: number[] = [];
    for (const id of candidates) {
      if (!this.currentIds.has(id)) {
        chosen.push(id);
        if (chosen.length >= limit) break;
      }
    }
    return chosen;
  }

  private async discoverGames(): Promise<number[]> {
    const apiKey = this.options.apiKey;
    let direct: number[] = [];
    if (apiKey) {
      try {
        const badges = await this.fetchBadges(apiKey);
        const withRemaining = badges.filter(b => (b.cards_remaining || 0) > 0).map(b => b.appid);
        console.log(`Badges with remaining: ${withRemaining.length}`);
        direct = withRemaining;
        if (direct.length < this.options.targetParallel) {
          console.log('Attempting heuristic to reach target parallel games...');
          const need = this.options.targetParallel - direct.length;
          const heur = await this.heuristicUnplayedCardGames(apiKey, need);
          // merge keeping order: direct first
          const merged = [...direct, ...heur.filter(id => !direct.includes(id))];
          direct = merged;
          console.log(`Heuristic contributed: ${heur.length}, total candidates now ${direct.length}`);
        }
      } catch (err) {
        console.log('Discovery error (badges/heuristic):', err instanceof Error ? err.message : err);
      }
    }
    if (!apiKey && direct.length === 0) {
      const manual = await ask('Enter appIDs to idle (comma separated): ');
      direct = manual.split(',').map(s => parseInt(s.trim(),10)).filter(n => !isNaN(n));
    }
    return Array.from(new Set(direct));
  }

  private applyIdling() {
    const list = Array.from(this.currentIds.values()).slice(0, 32); // Steam display practical limit
    this.client.gamesPlayed(list);
    console.log('Now idling:', list.join(', '));
  }

  private async refreshBadgeStatus() {
    if (!this.options.apiKey || !this.steamId64) return;
    try {
      const badges = await this.fetchBadges(this.options.apiKey);
      const remainingSet = new Set<number>();
      for (const b of badges) {
        if ((b.cards_remaining || 0) > 0) remainingSet.add(b.appid);
      }
      // Remove games no longer in remaining set (completed drops) IF they ever had remaining
      const before = this.currentIds.size;
      for (const id of Array.from(this.currentIds)) {
        // If a game previously had remaining but now not in remainingSet, consider it complete
        if (!remainingSet.has(id)) {
          this.currentIds.delete(id);
        }
      }
      const after = this.currentIds.size;
      if (after !== before) {
        console.log(`Completed games removed: ${before - after}`);
      }
      // Top up to targetParallel
      if (this.currentIds.size < (this.options.targetParallel || 20)) {
        console.log('Topping up game list after removals...');
        const newlyDiscovered = await this.discoverGames();
        const needed = (this.options.targetParallel || 20) - this.currentIds.size;
        const chosen = this.chooseNextGames(newlyDiscovered, needed);
        for (const id of chosen) this.currentIds.add(id);
      }
      this.applyIdling();
    } catch (e) {
      console.log('Refresh badge status error:', e instanceof Error ? e.message : e);
    }
  }

  startLoop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = setInterval(() => {
      console.log('--- Periodic badge re-check ---');
      this.refreshBadgeStatus();
    }, this.refreshIntervalMs);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const candidates = await this.discoverGames();
    if (!candidates.length) {
      console.log('No candidates discovered. Exiting idler.');
      return;
    }
    const initial = this.chooseNextGames(candidates, this.options.targetParallel || 20);
    for (const id of initial) this.currentIds.add(id);
    this.applyIdling();
    this.startLoop();
  }

  stop() {
    this.running = false;
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.currentIds.clear();
    this.client.gamesPlayed([]);
  }
}
