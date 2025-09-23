import SteamUser from 'steam-user';
import { ask } from './auth.js';
import fs from 'node:fs';
import path from 'node:path';

// Timestamp all logs with [HH:MM:SS]
const __origLog = console.log.bind(console);
console.log = (...args: any[]) => {
  const d = new Date();
  const ts = d.toTimeString().split(' ')[0];
  __origLog(`[${ts}]`, ...args);
};

interface BadgeInfo { appid: number; cards_remaining?: number | undefined; }
interface CommunityBadgeInfo extends BadgeInfo { hours_on_record?: number | undefined; }

interface DiscoveryOptions {
  apiKey?: string | undefined;
  targetParallel: number; // desired number of simultaneous games
}

const DEFAULT_OPTIONS: DiscoveryOptions = {
  targetParallel: 20,
};

export class SteamIdlerManager {
  private client: any; // steam-user lacks full TS types; use any
  private steamId64?: string;
  private running: boolean = false;
  private currentIds: Set<number> = new Set();
  private options: DiscoveryOptions;
  private refreshIntervalMs = 20 * 60 * 1000; // 20 minutes (was 30)
  private intervalHandle?: NodeJS.Timeout;
  private everRemaining: Set<number> = new Set(); // games that have shown remaining at least once
  private refreshToken?: string; // store for reconnect
  private reconnecting: boolean = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private connecting: boolean = false; // track active logOn attempt
  private connectivityMonitor?: NodeJS.Timeout;
  private storeCategoryCache: Map<number, boolean> = new Map(); // appid -> hasCards
  private broadMode: boolean = false;
  private webCookies: string[] = [];
  private sessionId?: string;
  private cacheFile = path.resolve(process.cwd(), 'store-category-cache.json');
  private pendingPostCookieDiscovery: boolean = false;
  private restartMonitor?: NodeJS.Timeout; // unused now

  constructor(client?: any, options?: Partial<DiscoveryOptions>) {
    this.client = client || new SteamUser();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async logOnWithRefresh(refreshToken: string): Promise<void> {
    this.refreshToken = refreshToken;
    return new Promise((resolve, reject) => {
      this.connecting = true;
      // Enable built-in auto relogin so we don't spam manual attempts
      try { if (typeof this.client.setOption === 'function') this.client.setOption('autoRelogin', true); } catch { /* ignore */ }
      this.client.logOn({ refreshToken });
      this.client.removeAllListeners('webSession');
      this.client.on('webSession', (sessionId: string, cookies: string[]) => {
        this.sessionId = sessionId;
        this.webCookies = cookies || [];
        console.log('Obtained web session cookies for community badge fetch.');
        if (this.pendingPostCookieDiscovery) {
          this.pendingPostCookieDiscovery = false;
          // If we have not started idling, we will retry full discovery later in start();
          if (this.running && this.currentIds.size === 0) {
            this.discoverGames().then(list => {
              const needed = (this.options.targetParallel||20) - this.currentIds.size;
              const add = this.chooseNextGames(list, needed);
              for (const id of add) this.currentIds.add(id);
              if (add.length) this.applyIdling();
            }).catch(()=>{});
          }
        }
      });
      this.client.once('loggedOn', () => {
        if (this.client.steamID) this.steamId64 = this.client.steamID.getSteamID64();
        console.log('Logged in as ' + this.steamId64);
        this.connecting = false;
        this.reconnectAttempts = 0;
        // Proactively request web cookies if not yet received
        try { if (!this.webCookies.length && typeof this.client.webLogOn === 'function') this.client.webLogOn(); } catch { /* ignore */ }
        resolve();
      });
      this.client.once('error', (err: any) => reject(err));
    });
  }

  private async waitForCookies(timeoutMs: number): Promise<void> {
    if (this.webCookies.length) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      const handler = () => { clearTimeout(timer); resolve(); };
      this.client.once('webSession', handler);
    });
  }

  private async fetchCommunityBadges(): Promise<CommunityBadgeInfo[]> {
    if (!this.webCookies.length) return [];
    const cookiesHeader = this.webCookies.join('; ');
  const results: CommunityBadgeInfo[] = [];
    let page = 1;
    let lastCount = 0;
    while (page <= 10) { // safety page cap
      const url = `https://steamcommunity.com/my/badges?l=english&p=${page}`; // full HTML page
      let text: string;
      try {
        const resp = await fetch(url, { headers: { 'cookie': cookiesHeader, 'user-agent': 'SteamIdler/1.0' } });
        if (!resp.ok) break;
        text = await resp.text();
      } catch { break; }
      // Removed HTML debug dump (previously wrote debug-badges-page1.html)
      // Extract anchors linking to gamecards
      const anchorRegex = /<a[^>]+href="https:\/\/steamcommunity.com\/id\/[^"]+\/gamecards\/(\d+)\/"[^>]*><\/a>/g;
      const anchors: { appid: number; index: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = anchorRegex.exec(text)) !== null) {
        const idStr = m[1];
        if (!idStr) continue;
        const appidParsed = parseInt(idStr, 10);
        if (!isNaN(appidParsed)) anchors.push({ appid: appidParsed, index: m.index });
      }
      if (!anchors.length) break;
      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        if (!anchor) continue;
        const appid = anchor.appid;
        const index = anchor.index;
        const nextAnchor = i + 1 < anchors.length ? anchors[i+1] : undefined;
        const end = nextAnchor ? nextAnchor.index : index + 4000;
        const slice = text.slice(index, Math.min(end, index + 8000));
  let remaining: number | undefined;
  let hours: number | undefined;
        if (/No card drops remaining/i.test(slice)) {
          remaining = 0;
        } else {
          const direct = /(\d+)\s+card drops? remaining/i.exec(slice);
          if (direct && direct[1]) {
            const v = parseInt(direct[1], 10); if (!isNaN(v)) remaining = v;
          } else {
            const earned = /Card drops earned:\s*(\d+)/i.exec(slice);
            const received = /Card drops received:\s*(\d+)/i.exec(slice);
            if (earned && received && earned[1] && received[1]) {
              const e = parseInt(earned[1],10); const r = parseInt(received[1],10);
              if (!isNaN(e) && !isNaN(r) && e >= r) {
                const diff = e - r; remaining = diff > 0 ? diff : 0;
              }
            }
          }
        }
        const hoursMatch = /([0-9]+(?:\.[0-9]+)?)\s*hrs?\s+on\s+record/i.exec(slice);
        if (hoursMatch && hoursMatch[1]) {
          const hv = parseFloat(hoursMatch[1]);
          if (!isNaN(hv)) hours = hv;
        }
        results.push({ appid, cards_remaining: remaining, hours_on_record: hours });
      }
      if (results.length === lastCount) break; // no new entries added
      lastCount = results.length;
      page++;
    }
    // Basic summary (debug HTML dump removed)
    const pos = results.filter(r => typeof r.cards_remaining === 'number' && r.cards_remaining! > 0).length;
    const zero = results.filter(r => r.cards_remaining === 0).length;
    const hoursTagged = results.filter(r => typeof r.hours_on_record === 'number').length;
    console.log(`Community parse summary: totalBadges=${results.length} withRemaining=${pos} zeroRemaining=${zero} hoursTagged=${hoursTagged}`);
    return results;
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

  private async scanAllCardCapable(apiKey: string, limitNeeded: number): Promise<number[]> {
    const owned = await this.fetchOwned(apiKey);
    if (!owned.length) return [];
    // attempt to load cache once per run
    if (this.storeCategoryCache.size === 0 && fs.existsSync(this.cacheFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.cacheFile,'utf-8'));
        if (raw && typeof raw === 'object') {
          for (const [k,v] of Object.entries(raw)) {
            const idNum = parseInt(k,10); if (!isNaN(idNum)) this.storeCategoryCache.set(idNum, !!v);
          }
          console.log(`Loaded store category cache entries: ${this.storeCategoryCache.size}`);
        }
      } catch { /* ignore */ }
    }
    const never = owned.filter(g => g.playtime_forever === 0);
    const low = owned.filter(g => g.playtime_forever > 0 && g.playtime_forever < 30);
    const rest = owned.filter(g => g.playtime_forever >= 30);
    const ordered = [...never, ...low, ...rest];
  const concurrency = 6;
  const overallCap = 1200 * 2;
    const found: number[] = [];
    let idx = 0;
    const cache = this.storeCategoryCache;
    async function probe(appid: number) {
      if (cache.has(appid)) { if (cache.get(appid)) found.push(appid); return; }
      const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=categories`;
      try {
        const r = await fetch(url, { headers: { 'user-agent': 'SteamIdler/1.0' } });
        if (!r.ok) { cache.set(appid, false); return; }
        const j = await r.json();
        const entry = j?.[appid];
        if (entry && entry.success && entry.data && Array.isArray(entry.data.categories)) {
          const hasCards = entry.data.categories.some((c: any) => c && c.id === 29);
          cache.set(appid, !!hasCards);
          if (hasCards) found.push(appid);
        } else {
          cache.set(appid, false);
        }
      } catch { cache.set(appid, false); }
    }
    async function runBatch(): Promise<void> {
      const batch: Promise<void>[] = [];
      for (let i = 0; i < concurrency && idx < ordered.length && idx < overallCap; i++, idx++) {
        batch.push(probe(ordered[idx].appid));
      }
      if (!batch.length) return;
      await Promise.all(batch);
      if (found.length < limitNeeded && idx < ordered.length && idx < overallCap) await runBatch();
    }
    await runBatch();
    // persist cache after scan
    try {
      const obj: Record<number, boolean> = {} as any;
      for (const [id,val] of cache.entries()) obj[id] = val;
      fs.writeFileSync(this.cacheFile, JSON.stringify(obj));
    } catch { /* ignore */ }
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
        let badges = await this.fetchBadges(apiKey);
        // If API badges show no remaining fields, attempt community badge scrape for accurate remaining counts
        const apiRemainingCount = badges.filter(b => {
          const anyRem = (b as any).cards_remaining ?? (b as any).card_drop_remaining ?? (b as any).card_drop_count;
          return typeof anyRem === 'number' && anyRem > 0;
        }).length;
        if (apiRemainingCount === 0) {
          if (this.webCookies.length) {
            console.log('Attempting community badge remaining detection via steamcommunity AJAX...');
            const communityBadges = await this.fetchCommunityBadges();
            if (communityBadges.length) {
              // Merge community remaining info onto API badges where possible
              const map = new Map<number, BadgeInfo>();
              for (const b of badges) map.set(b.appid, b);
              for (const cb of communityBadges) {
                const existing = map.get(cb.appid) || { appid: cb.appid } as any;
                if (typeof cb.cards_remaining === 'number') (existing as any).cards_remaining = cb.cards_remaining;
                if (typeof (cb as any).hours_on_record === 'number') (existing as any).hours_on_record = (cb as any).hours_on_record;
                map.set(cb.appid, existing as any);
              }
              badges = Array.from(map.values());
              console.log(`Community badge scan merged. Badges now ${badges.length}`);
            } else {
              console.log('Community badge scan returned no data.');
            }
          } else {
            console.log('No web cookies yet; deferring community badge scan until cookies available.');
            this.pendingPostCookieDiscovery = true;
          }
        }
        const withRemainingDetailed = badges.filter(b => {
          const anyRem = (b as any).cards_remaining ?? (b as any).card_drop_remaining ?? (b as any).card_drop_count;
          return typeof anyRem === 'number' && anyRem > 0;
        }).map(b => ({
          appid: b.appid,
          remaining: (b as any).cards_remaining ?? (b as any).card_drop_remaining ?? (b as any).card_drop_count,
          hours: (b as any).hours_on_record
        }));
        // Sort: highest hours_on_record first, then remaining drops desc, then appid
        withRemainingDetailed.sort((a,b) => {
          const hA = typeof a.hours === 'number' ? a.hours : -1;
          const hB = typeof b.hours === 'number' ? b.hours : -1;
          if (hB !== hA) return hB - hA;
          const rA = a.remaining || 0;
          const rB = b.remaining || 0;
          if (rB !== rA) return rB - rA;
          return a.appid - b.appid;
        });
        direct = withRemainingDetailed.map(x => x.appid);
        if (withRemainingDetailed.length) {
          const topPreview = withRemainingDetailed.slice(0,5).map(x => `${x.appid}:${x.hours??'?' }h rem=${x.remaining}`).join(' | ');
          console.log(`Badges with remaining: ${withRemainingDetailed.length}. Top (hours-first): ${topPreview}`);
        } else {
          console.log('Badges with remaining: 0');
        }
        if (direct.length === 0) {
          if (!this.broadMode) {
            this.broadMode = true;
            console.log('No remaining drops detected in badges: broad card-capable scan mode ENABLED.');
          }
        }
        if (direct.length < this.options.targetParallel && this.broadMode) {
          const stillNeed = this.options.targetParallel - direct.length;
          console.log(`Broad mode full library scan for additional ${stillNeed} candidates...`);
          const extra = await this.scanAllCardCapable(apiKey, stillNeed);
          for (const id of extra) if (!direct.includes(id)) direct.push(id);
          console.log(`Broad mode added ${extra.length}; total candidates now ${direct.length}`);
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

  // (Removed legacy playtime & baseline persistence logic)

  private async scheduleCommunityHoursRestarts(providedBadges?: CommunityBadgeInfo[]) {
    if (!this.webCookies.length) return;
    const threshold = 2; // absolute hours_on_record > 2 triggers restart every recheck
    let badges: CommunityBadgeInfo[] = providedBadges || [];
    if (!badges.length) {
      try { badges = await this.fetchCommunityBadges(); } catch { return; }
    }
    if (!badges.length) return;
    const restartIds: number[] = [];
    for (const b of badges) {
      if (typeof b.hours_on_record === 'number' && b.hours_on_record > threshold && this.currentIds.has(b.appid)) restartIds.push(b.appid);
    }
    if (!restartIds.length) {
      console.log('No restart candidates (no game >2h).');
      return;
    }
    const fullList = Array.from(this.currentIds.values()).slice(0,32);
    const without = fullList.filter(id => !restartIds.includes(id));
    console.log(`Restarting (hours>2) ${restartIds.length} games: ${restartIds.join(', ')}`);
    try { this.client.gamesPlayed(without); } catch { /* ignore */ }
    setTimeout(() => {
      try {
        this.client.gamesPlayed(fullList);
        console.log('Restart cycle complete for:', restartIds.join(', '));
      } catch { /* ignore */ }
    }, 3000);
  }


  private async refreshBadgeStatus() {
    if (!this.options.apiKey || !this.steamId64) return;
    try {
      const badges = await this.fetchBadges(this.options.apiKey);
      // Fetch community badges once for both remaining parsing (already integrated earlier) and restart evaluation
      let communityBadges: CommunityBadgeInfo[] = [];
      if (this.webCookies.length) {
        try { communityBadges = await this.fetchCommunityBadges(); } catch { /* ignore */ }
      }
      const remainingSet = new Set<number>();
      for (const b of badges) {
        const remRaw = (b as any).cards_remaining ?? (b as any).card_drop_remaining ?? (b as any).card_drop_count;
        if (typeof remRaw === 'number' && remRaw > 0) {
          remainingSet.add(b.appid);
          this.everRemaining.add(b.appid);
        }
      }
      // Only remove games that previously had remaining and now disappeared
      const before = this.currentIds.size;
      for (const id of Array.from(this.currentIds)) {
        if (this.everRemaining.has(id) && !remainingSet.has(id)) {
          this.currentIds.delete(id);
        }
      }
      const after = this.currentIds.size;
      if (after !== before) console.log(`Completed games removed: ${before - after}`);
      // Top up to targetParallel
      if (this.currentIds.size < (this.options.targetParallel || 20)) {
        console.log('Topping up game list after removals...');
        const newlyDiscovered = await this.discoverGames();
        const needed = (this.options.targetParallel || 20) - this.currentIds.size;
        const chosen = this.chooseNextGames(newlyDiscovered, needed);
        for (const id of chosen) this.currentIds.add(id);
  // Start times persistence removed (using playtime baselines instead)
      }
      this.applyIdling();
  // Restart any game whose community badge hours exceed 2h
      await this.scheduleCommunityHoursRestarts(communityBadges);
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
    // Separate restart monitor (every 10 minutes) to catch long sessions even if badge fetch fails
    if (this.restartMonitor) clearInterval(this.restartMonitor);
    // (Removed separate elapsed-time restart monitor; playtime restarts happen during refresh or explicit call.)
    // Setup disconnect handling once
    this.client.removeAllListeners('disconnected');
    this.client.on('disconnected', (eresult: any, msg: any) => {
      console.log('Disconnected from Steam (autoRelogin active). EResult:', eresult, msg || '');
      this.connecting = false;
      // Let autoRelogin handle reconnect; fallback timer if still offline later
      setTimeout(() => {
        if (!this.client.steamID && !this.connecting) {
          console.log('Still disconnected, attempting single manual reconnect...');
          this.manualReconnect();
        }
      }, 15000);
    });
    this.client.removeAllListeners('error');
    this.client.on('error', (err: any) => {
      console.log('Client error:', err?.message || err);
      this.connecting = false;
    });

    if (this.connectivityMonitor) clearInterval(this.connectivityMonitor);
    // Lightweight 10s monitor to ensure we always try to restore idling after network returns
    this.connectivityMonitor = setInterval(() => {
      const connected = !!this.client.steamID;
      if (!connected) {
        if (!this.connecting) {
          // attempt a quiet manual reconnect every 10s if offline
          this.manualReconnect();
        }
      }
    }, 10000);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // wait briefly for cookies to improve likelihood we can do community scan first pass
  // (baseline persistence removed)
    await this.waitForCookies(4000);
    const candidates = await this.discoverGames();
    if (!candidates.length) {
      console.log('No candidates discovered. Exiting idler.');
      return;
    }
    const initial = this.chooseNextGames(candidates, this.options.targetParallel || 20);
    for (const id of initial) this.currentIds.add(id);
    // (No baseline initialization needed)
    this.applyIdling();
    this.startLoop();
  }

  stop() {
    this.running = false;
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.currentIds.clear();
    this.client.gamesPlayed([]);
    if (this.restartMonitor) clearInterval(this.restartMonitor);
  }

  // Manual fallback if autoRelogin fails silently
  private manualReconnect() {
    if (!this.refreshToken) return;
    if (this.connecting) return;
    if ((this.client as any)._loggingOn) return; // internal guard
    try {
      this.client.logOn({ refreshToken: this.refreshToken });
      this.client.once('loggedOn', () => {
        this.connecting = false;
        this.reconnectAttempts = 0;
        if (this.client.steamID) this.steamId64 = this.client.steamID.getSteamID64();
        console.log('Manual reconnect succeeded. Restoring idling list...');
        this.applyIdling();
        // Baselines remain; playtime delta continues accumulating.
      });
    } catch (e: any) {
      const msg = e?.message || '';
      if (msg.includes('Already attempting')) {
        this.connecting = true; // another attempt is in progress
      } else {
        console.log('Manual reconnect immediate error:', msg);
        this.connecting = false;
      }
    }
  }
}
