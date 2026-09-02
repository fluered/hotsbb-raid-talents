import { unstable_cache } from 'next/cache';
import { after } from 'next/server';
import { normalizeTalentTree } from './talentNormalize';
import { getOrSetPersistent, getPersistentReadOnly, getSwrEntry, setSwrEntry, setPersistentValue, tryAcquireLock } from './persistentCache';
export { normalizeTalentTree } from './talentNormalize';

// ─── WCL request pacing ─────────────────────────────────────────────────────────

// WCL enforces a burst limit independent of its hourly points budget, but doesn't
// publish the exact threshold — community reports (WCL's own forums) put it somewhere
// around 2 requests/second before a spate of 429s and a long enforced cooldown kicks
// in, which is exactly the ~50min penalty pauses that repeatedly derailed batch export
// runs. Rather than firing as fast as possible and reacting to 429s after the fact,
// every outbound WCL request funnels through this serial queue with a minimum gap
// between them — proactively staying under the threshold instead of tripping it and
// paying a much longer cooldown. A single in-memory queue is fine here: a Vercel
// serverless invocation and the export script's Node process are each their own
// process, so there's no cross-instance coordination to worry about.
let wclRequestQueue: Promise<void> = Promise.resolve();
const MIN_WCL_REQUEST_GAP_MS = 500; // ~2 req/sec — conservative given the threshold isn't officially documented

async function paceWclRequest<T>(fn: () => Promise<T>): Promise<T> {
  const previous = wclRequestQueue;
  let release!: () => void;
  wclRequestQueue = new Promise<void>(r => { release = r; });
  await previous;
  try {
    return await fn();
  } finally {
    setTimeout(release, MIN_WCL_REQUEST_GAP_MS);
  }
}

function wclFetch(url: string, options: RequestInit): Promise<Response> {
  return paceWclRequest(() => fetch(url, options));
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function getWclToken() {
  const response = await wclFetch('https://www.warcraftlogs.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.WCL_CLIENT_ID || '',
      client_secret: process.env.WCL_CLIENT_SECRET || '',
    }),
    next: { revalidate: 3600 },
  });
  if (response.status === 429) {
    // Observed during a genuinely deep quota-exhaustion window: WCL's OAuth endpoint
    // gets swept up in the same overload as the data API. Previously surfaced as a
    // plain "Failed WCL Authentication" error, which only got 2 quick bounded retries
    // (not the unlimited pause-and-retry that rate_limited gets) — so a run that hit
    // this mid-exhaustion lost real combos to a hard failure instead of just waiting
    // it out like every other rate-limited call already does.
    const err: any = new Error('WCL OAuth rate limit exceeded — the API key has hit its request budget for the current window.');
    err.isRateLimit = true;
    err.retryAfter = response.headers.get('retry-after');
    throw err;
  }
  if (!response.ok) throw new Error('Failed WCL Authentication');
  return (await response.json()).access_token;
}

export async function getBlizzardToken(region = 'us') {
  const clientId = process.env.BNET_CLIENT_ID;
  const clientSecret = process.env.BNET_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing BNET_CLIENT_ID or BNET_CLIENT_SECRET');
  const response = await fetch(`https://${region}.battle.net/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    next: { revalidate: 3600 },
  });
  if (!response.ok) throw new Error('Blizzard OAuth failed');
  return (await response.json()).access_token;
}

// ─── WCL ──────────────────────────────────────────────────────────────────────

// A 429 here previously fell through to `.data?...` being undefined, silently
// resolving to an empty list — indistinguishable from "this zone genuinely has no
// encounters." That's exactly how a WCL rate-limit window (e.g. right after a big
// batch export) turned into a raid/dungeon page rendering with an empty, unexplained
// list instead of a clear "temporarily unavailable" state. Throw distinguishably,
// same pattern as getWclRankings.
function throwIfRateLimited(response: Response) {
  if (response.status === 429) {
    const err: any = new Error('WCL rate limit exceeded — the API key has hit its request budget for the current window.');
    err.isRateLimit = true;
    err.retryAfter = response.headers.get('retry-after');
    throw err;
  }
}

// Every WCL GraphQL response funnels through here. The 429 case was handled everywhere,
// but every OTHER failure shape — 401 (expired token), 5xx-with-JSON, or a 200 carrying
// a GraphQL `errors` payload with data: null — used to fall through the callers'
// `.data?...  || []` chains and come out looking exactly like "this combo genuinely has
// no data", which then got CACHED for 24h (Redis and unstable_cache both). One transient
// WCL hiccup could poison a combo for a full day. Throw distinguishably instead: nothing
// gets cached, and upstream retry/pause logic gets a real signal.
// Partial GraphQL errors (errors present but data non-null, e.g. one private report in
// an aliased batch) are NOT thrown — callers use whatever data did come back.
async function parseWclResponse(response: Response, context: string): Promise<any> {
  throwIfRateLimited(response);
  if (!response.ok) throw new Error(`WCL ${context} request failed: HTTP ${response.status}`);
  let json: any;
  try {
    json = await response.json();
  } catch {
    throw new Error(`WCL ${context} returned an unparseable response body`);
  }
  if (json?.errors?.length && json?.data == null) {
    throw new Error(`WCL ${context} GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`);
  }
  return json;
}

// Cheap diagnostic query (just one number back, no ranking/telemetry payload) used to
// measure real points cost around a combo's WCL work — see logPointsUsage in
// lib/metaBuild.ts. Not itself expected to meaningfully add to points/burst cost, but
// still goes through the same paced wclFetch as everything else, just in case.
export async function getWclPointsSpent(token: string): Promise<number | null> {
  const query = `query { rateLimitData { pointsSpentThisHour } }`;
  const response = await wclFetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  });
  if (!response.ok) return null;
  try {
    return (await response.json()).data?.rateLimitData?.pointsSpentThisHour ?? null;
  } catch {
    return null;
  }
}

export async function getRaidStructure(token: string) {
  const query = `query { worldData { zones { id name frozen expansion { id name } encounters { id name journalID } } } }`;
  const response = await wclFetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    // Was uncached — every page load re-fetched WCL's entire zone list from scratch.
    // Zone/encounter structure only changes on patch days, so 24h is safe.
    next: { revalidate: 86400 },
  });
  return (await parseWclResponse(response, 'zones')).data?.worldData?.zones || [];
}

export async function getMplusEncounters(token: string, zoneId: number) {
  const query = `query { worldData { zone(id: ${zoneId}) { encounters { id name journalID } } } }`;
  const response = await wclFetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    next: { revalidate: 86400 },
  });
  return (await parseWclResponse(response, 'mplus-encounters')).data?.worldData?.zone?.encounters || [];
}

// ─── Season state (self-resolving) ─────────────────────────────────────────────

// Cheapest possible "is there data here?" probe: unfiltered rankings (no class/spec,
// no combatantInfo) on one encounter. Used only by the season resolver below, which
// is itself cached — so this costs ~2 WCL points every few hours, total.
async function getUnfilteredRankingsCount(token: string, bossId: number, difficulty: number): Promise<number> {
  const query = `query { worldData { encounter(id: ${bossId}) { characterRankings(difficulty: ${difficulty}) } } }`;
  const response = await wclFetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  });
  return ((await parseWclResponse(response, 'season-probe')).data?.worldData?.encounter?.characterRankings?.rankings ?? []).length;
}

export interface SeasonState {
  mplusZoneId: number;
  seasonLabel: string;         // e.g. "Season 2" — derived from the M+ zone's own name
  expansionName: string;       // e.g. "Midnight"
  defaultRaidDifficulty: 4 | 5;
  // Non-null when a raid zone NEWER than everything in MIDNIGHT_RAIDS exists — the one
  // seasonal change that still needs a human (see MIDNIGHT_RAIDS for why raids can't
  // be auto-adopted: a season can ship several concurrent raid zones, and guessing
  // wrong either drops a real raid or mixes seasons in the tier lists).
  drift: string | null;
}

// The two decisions that used to be hand-flipped constants, resolved from live data:
//
// 1. WHICH M+ SEASON: the newest non-frozen "Mythic+ Season N" zone of the newest
//    expansion — verified to actually have parses, so a pre-staged next-season zone
//    (WCL creates them days early) can't hijack the site before its season starts.
// 2. RAID DIFFICULTY DEFAULT: Mythic doesn't open until a season's second reset, and
//    a Mythic default before then renders every raid page empty. Probe the current
//    raid's first boss: enough Mythic parses ⇒ 5, else Heroic. This retires the
//    "flip DEFAULT_RAID_DIFFICULTY when Mythic opens" ritual permanently — including
//    the flip BACK at every future season launch.
//
// Cached a few hours in Redis (shared by pages, metadata, /api/season-content and
// through it the crawl); any resolver failure falls back to the last-known constants
// below rather than taking the site down with it.
async function computeSeasonState(token: string): Promise<SeasonState> {
  const zones: any[] = await getRaidStructure(token);
  const maxExp = Math.max(...zones.map((z: any) => z.expansion?.id ?? 0));
  const current = zones.filter((z: any) => (z.expansion?.id ?? 0) === maxExp && !z.frozen);

  // M+ zone: newest by season number, activity-verified.
  const mplusCandidates = current
    .map((z: any) => ({ zone: z, season: parseInt((z.name.match(/^Mythic\+ Season (\d+)/) ?? [])[1] ?? '') }))
    .filter((c: any) => Number.isFinite(c.season))
    .sort((a: any, b: any) => b.season - a.season);
  let mplusZone = mplusCandidates[0]?.zone ?? null;
  for (const cand of mplusCandidates) {
    const firstEnc = cand.zone.encounters?.[0]?.id;
    if (firstEnc && (await getUnfilteredRankingsCount(token, firstEnc, MPLUS_DIFFICULTY)) >= 25) {
      mplusZone = cand.zone;
      break;
    }
  }
  if (!mplusZone) throw new Error('Season resolver: no Mythic+ zone found');

  // Raid difficulty: probe the configured current raid's first boss on Mythic.
  const raidZones = current.filter((z: any) => z.name in MIDNIGHT_RAIDS);
  let defaultRaidDifficulty: 4 | 5 = 4;
  const probeBoss = raidZones[0]?.encounters?.[0]?.id;
  if (probeBoss && (await getUnfilteredRankingsCount(token, probeBoss, 5)) >= 10) {
    defaultRaidDifficulty = 5;
  }

  // Drift alarm: a raid zone newer than everything configured means a new season's
  // raid exists and MIDNIGHT_RAIDS needs its one-line update.
  const maxConfiguredId = Math.max(0, ...zones.filter((z: any) => z.name in MIDNIGHT_RAIDS).map((z: any) => z.id));
  const newer = current.filter((z: any) =>
    z.id > maxConfiguredId && !(z.name in MIDNIGHT_RAIDS) && !/^Mythic\+/.test(z.name) && z.name !== 'Delves'
  );
  const drift = newer.length > 0
    ? `MIDNIGHT_RAIDS looks stale: newer raid zone(s) exist on WCL: ${newer.map((z: any) => `${z.name} (${z.id})`).join(', ')}`
    : null;

  return {
    mplusZoneId: mplusZone.id,
    seasonLabel: mplusZone.name.replace(/^Mythic\+\s*/, ''),
    expansionName: zones.find((z: any) => (z.expansion?.id ?? 0) === maxExp)?.expansion?.name ?? '',
    defaultRaidDifficulty,
    drift,
  };
}

// Last-known-good fallback if the resolver itself fails (WCL outage mid-cache-miss):
// stale season info beats an error page. Update casually, not urgently. A function,
// not a const — MPLUS_ZONE_ID is declared further down the file, so evaluating this
// at module init would hit its temporal dead zone.
function seasonFallback(): SeasonState {
  return {
    mplusZoneId: MPLUS_ZONE_ID,
    seasonLabel: 'Season 2',
    expansionName: 'Midnight',
    defaultRaidDifficulty: 4,
    drift: null,
  };
}

export async function getSeasonState(): Promise<SeasonState> {
  try {
    const token = await getWclToken();
    return await getOrSetPersistent('season-state-v1', 21600, () => computeSeasonState(token));
  } catch (err) {
    console.error('Season resolver failed, using fallback:', err);
    return seasonFallback();
  }
}

// region omitted/undefined returns ALL regions combined in one query (confirmed live:
// same cost as a single-region query, since WCL's serverRegion argument is a plain
// filter — dropping it doesn't multiply the request, it just widens what one request
// returns). That's what makes "Global" free relative to the old single-region default.
export async function getWclRankings(token: string, bossId: number, className: string, specName: string, difficulty: number, region?: string, metric?: string, noCache = false) {
  const wclClassName = className.replace(/\s+/g, '');
  const wclSpecName = specName.replace(/\s+/g, '');
  const metricArg = metric ? `, metric: ${metric}` : '';
  const regionArg = region ? `, serverRegion: "${region.toUpperCase()}"` : '';
  // includeCombatantInfo costs nothing extra (verified live 2026-08-21: same ~2 points,
  // +200ms) and returns each ranked player's talents inline — [{talentID, points}],
  // where talentID is EXACTLY the trait entry id that CombatantInfo telemetry reports
  // as its rows' `id` (verified 79/79 with matching ranks on live data). Combined with
  // the entry→node map below, this replaces the per-fight telemetry fan-out — the bulk
  // of a cold combo's ~50s and points cost — for every player whose entries are known.
  const query = `
    query {
      worldData {
        encounter(id: ${bossId}) {
          characterRankings(className: "${wclClassName}", specName: "${wclSpecName}", difficulty: ${difficulty}${regionArg}${metricArg}, includeCombatantInfo: true)
        }
      }
    }
  `;
  const response = await wclFetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    ...(noCache ? { cache: 'no-store' } : { next: { revalidate: 604800 } }),
  });
  // A 429 (and now any other error shape — see parseWclResponse) was previously
  // swallowed into an empty rankings array — indistinguishable from a boss/spec combo
  // that genuinely has no parses yet. That's exactly why a WCL rate-limit exhaustion
  // (confirmed 2026-07-26) went undetected mid-batch-export: every caller just saw
  // normal-looking no_data results and had no signal to stop.
  const rankings = (await parseWclResponse(response, 'rankings')).data?.worldData?.encounter?.characterRankings?.rankings || [];
  // Compact before it hits any cache layer — uncompacted, a 100-row entry is ~0.5MB
  // and even a first-pass compaction measured ~190KB, which at ~680 combos outgrows
  // the memory-capped Redis on its own. Kept per row: _tp = [entryId, points] pairs
  // (rows consensus can reach: top 50 + backfill margin) and _tg = positional
  // [itemId, ilvl] per gear slot (what the gear phase's slot/trinket fallback reads
  // — ids and levels only, order preserved, 0 = empty slot). Icons and bonus ids are
  // identical across players per item, so they aggregate ONCE per response into an
  // itemData dict rather than repeating per row; it rides on the returned array as a
  // non-JSON property (plain-array callers like the tier lists neither see nor pay
  // for it) and is lifted into the SWR entry explicitly by getRankingsCachedSWR.
  // Rows past the margins lose inline data and fall back to a real telemetry fetch.
  const ROWS_KEPT = 80;
  const TALENT_ROWS_KEPT = 55;
  const GEAR_ROWS_KEPT = 50;
  const itemData: Record<number, { ilvl: number; icon: string; bonusIds: number[] }> = {};
  const rows = rankings.slice(0, ROWS_KEPT).map((row: any, i: number) => {
    const { gear, talents, ...rest } = row;
    if (i < TALENT_ROWS_KEPT && Array.isArray(talents) && talents.length > 0) {
      rest._tp = talents.map((t: any) => [t.talentID, t.points]);
      if (i < GEAR_ROWS_KEPT && Array.isArray(gear)) {
        rest._tg = gear.map((g: any) => [Number(g.id) || 0, Number(g.itemLevel) || 0]);
        for (const g of gear) {
          const id = Number(g.id) || 0;
          const ilvl = Number(g.itemLevel) || 0;
          if (!id || !ilvl) continue;
          const existing = itemData[id];
          if (!existing || existing.ilvl < ilvl) {
            itemData[id] = { ilvl, icon: g.icon ?? '', bonusIds: (g.bonusIDs ?? []).map(Number) };
          }
        }
      }
    }
    return rest;
  });
  (rows as any)._itemData = itemData;
  return rows;
}

// Two region modes, matching the website/addon's toggle: 'global' (default) pools every
// region WCL has in ONE query (see getWclRankings above — dropping the filter is free,
// not 2-5x the cost); 'us-eu' fetches US and EU separately (two distinct-region queries,
// each still just their normal single-region cost) and merges+re-sorts by the ranking
// metric, since WCL has no multi-region filter to ask for "just these two" in one call.
export async function getWclRankingsForRegionMode(
  token: string, bossId: number, className: string, specName: string, difficulty: number,
  regionMode: string | undefined, metric?: string, noCache = false
) {
  if (regionMode === 'us-eu') {
    const [us, eu] = await Promise.all([
      getWclRankings(token, bossId, className, specName, difficulty, 'us', metric, noCache),
      getWclRankings(token, bossId, className, specName, difficulty, 'eu', metric, noCache),
    ]);
    const merged = [...(us as any[]), ...(eu as any[])].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
    // Merge both regions' aggregated item dicts (max ilvl wins) — see getWclRankings.
    const itemData: Record<number, { ilvl: number; icon: string; bonusIds: number[] }> = {};
    for (const src of [(us as any)._itemData, (eu as any)._itemData]) {
      for (const [id, d] of Object.entries(src ?? {}) as any) {
        if (!itemData[id as any] || itemData[id as any].ilvl < d.ilvl) itemData[id as any] = d;
      }
    }
    (merged as any)._itemData = itemData;
    return merged;
  }
  return getWclRankings(token, bossId, className, specName, difficulty, undefined, metric, noCache);
}

// A ranking entry's own server.region (lowercased) is the region whose Blizzard API can
// actually serve that specific player's profile — the site-wide region MODE (global,
// us-eu) only decides which WCL rankings get pooled, not which Blizzard endpoint a given
// player's profile lives behind. Falls back to the provided default for the rare case a
// ranking is missing server info.
export function playerRegion(player: { server?: { region?: string } }, fallback = 'us'): string {
  return (player.server?.region || fallback).toLowerCase();
}

// Blizzard's profile API (and its OAuth token) is region-locked per endpoint, with no CN
// coverage at all — a Global pool can span US/EU/KR/TW players in one page, each needing
// their own region's token. Fetches only the distinct regions actually present, once each,
// in parallel. A region whose token fetch fails (or CN, which has no Blizzard API) is
// simply absent from the returned map — callers already treat "no token for this player's
// region" as "no profile data for this player," the same as any other profile-fetch miss.
export async function getBlizzardTokensForRegions(regions: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(regions.map(r => r.toLowerCase()).filter(r => r !== 'cn')));
  const tokens = await Promise.all(unique.map(r => getBlizzardToken(r).catch(() => null)));
  const map = new Map<string, string>();
  unique.forEach((r, i) => { if (tokens[i]) map.set(r, tokens[i] as string); });
  return map;
}

// Resolves a player's own region (not the site-wide region mode) and that region's
// token, so a Global pool's EU/KR/TW players get fetched from their actual home
// region's API. A player whose region has no token (CN — no Blizzard API at all, or a
// token fetch failure) simply yields no profile data. Shared by the initial player-card
// fetch and the on-demand "load more players" action.
export function blizzardCharacterProfileFetch(
  player: any,
  tokensByRegion: Map<string, string>,
  endpoint: string,
  cacheTag: string
): Promise<any> {
  const pRegion = playerRegion(player, 'us');
  const token = tokensByRegion.get(pRegion);
  const realm = (player.server?.slug ?? player.server?.name ?? '').toLowerCase().replace(/\s+/g, '-').replace(/'/g, '');
  const name = player.name.toLowerCase();
  if (!token) return Promise.resolve(null);
  // 404 (character genuinely doesn't exist under this realm/name) is a stable fact
  // worth caching. Anything else — 5xx, network errors — is transient and must NOT
  // be cached, or a momentary hiccup gets stuck as "no data" for a full day.
  return unstable_cache(
    async () => {
      const r = await fetch(
        `https://${pRegion}.api.blizzard.com/profile/wow/character/${realm}/${name}/${endpoint}?namespace=profile-${pRegion}&locale=en_US`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Blizzard ${cacheTag} fetch failed: ${r.status}`);
      return r.json();
    },
    [`blizzard-${cacheTag}-${pRegion}-${realm}-${name}`],
    { revalidate: 86400 }
  )().catch(() => null);
}

// A 429 here previously fell through to the catch-all below and returned an ordinary-
// looking "no event" result — indistinguishable from a genuinely private/deleted
// report. During a real WCL rate-limit window mid-export, that silently shrank
// whatever combo was being processed at the time, with zero error signal anywhere
// (no thrown error, no rate_limited status — just a smaller sampleSize than it should
// have been). Now throws distinguishably, same pattern as getWclRankings, so a caller
// (the backfill selection, the API route's rate-limit handling, the export script's
// pause-and-retry) can actually react to it instead of quietly eating the data loss.
// Character names are unique per REALM, not per raid — a cross-realm group can contain
// two same-named players, and name-only matching would hand the ranked player the other
// one's CombatantInfo. When the caller knows the ranked player's server, prefer the
// actor whose server matches; fall back to name-only when server info is missing.
function matchActor(actors: any[], playerName: string, serverName?: string): any | null {
  const nameLower = playerName.toLowerCase();
  const nameMatches = actors.filter((a: any) => a.name?.toLowerCase() === nameLower);
  if (nameMatches.length > 1 && serverName) {
    const serverLower = serverName.toLowerCase();
    const exact = nameMatches.find((a: any) => (a.server || '').toLowerCase() === serverLower);
    if (exact) return exact;
  }
  return nameMatches[0] ?? null;
}

export async function getHistoricalFightTelemetry(wclToken: string, reportCode: string, fightId: number, playerName: string, serverName?: string) {
  const query = `
    query {
      reportData {
        report(code: "${reportCode}") {
          masterData { actors(type: "Player") { id name server } }
          events(fightIDs: [${fightId}], dataType: CombatantInfo, startTime: 0, endTime: 2147483647) { data }
        }
      }
    }
  `;
  const response = await wclFetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${wclToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    next: { revalidate: 86400 },
  });
  // Errors (429 and otherwise) throw distinguishably instead of degrading to a
  // normal-looking "no event" — a swallowed failure here used to get CACHED as
  // "player has no telemetry" for 24h. A null report (private/deleted) still
  // resolves to no-data below, which IS a stable fact worth caching.
  const reportData = (await parseWclResponse(response, 'telemetry')).data?.reportData?.report;
  const actors = reportData?.masterData?.actors || [];
  const events = reportData?.events?.data || [];
  const targetActor = matchActor(actors, playerName, serverName);
  const matchedSourceId = targetActor ? targetActor.id : null;
  return { sourceId: matchedSourceId, event: events.find((e: any) => e.sourceID === matchedSourceId) || null };
}

// Same data as getHistoricalFightTelemetry, but for many players in ONE HTTP request
// instead of one request each — WCL's GraphQL API allows querying the same field
// (`report`) multiple times with different arguments via aliases, so N players' fights
// become one query with N aliased sub-selections rather than N round trips. A full
// 50-player consensus sample used to cost 50 separate requests; in batches of 10 it's
// 5. That's the request *count* that's been tripping WCL's burst limit all night, not
// the underlying points cost — batching cuts it directly without changing what data
// comes back or how much of it. Kept deliberately modest-sized (see callers) since WCL
// doesn't publish a max query complexity per request, and an oversized batch risks
// getting rejected outright rather than just costing more.
async function getHistoricalFightTelemetryBatch(
  wclToken: string,
  requests: Array<{ reportCode: string; fightId: number; playerName: string; serverName?: string }>
): Promise<Array<{ sourceId: number | null; event: any }>> {
  if (requests.length === 0) return [];
  const aliasedFields = requests.map((r, i) => `
    p${i}: report(code: "${r.reportCode}") {
      masterData { actors(type: "Player") { id name server } }
      events(fightIDs: [${r.fightId}], dataType: CombatantInfo, startTime: 0, endTime: 2147483647) { data }
    }
  `).join('\n');
  const query = `query { reportData { ${aliasedFields} } }`;

  const response = await wclFetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${wclToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    next: { revalidate: 86400 },
  });
  // Whole-batch failures (429, 5xx, auth, full GraphQL rejection) throw — a swallowed
  // failure here used to resolve to all-nulls, which both cache layers then stored for
  // 24h as "these 10 players have no telemetry", silently excluding the actual top
  // ranks from every consensus computed that day. A single null aliased report among
  // many (private/deleted — a partial GraphQL error with data non-null) still resolves
  // to no-data for just that entry, which is correct and cacheable.
  const reportData = (await parseWclResponse(response, 'telemetry-batch')).data?.reportData ?? {};
  return requests.map((r, i) => {
    const report = reportData[`p${i}`];
    const actors = report?.masterData?.actors || [];
    const events = report?.events?.data || [];
    const targetActor = matchActor(actors, r.playerName, r.serverName);
    const matchedSourceId = targetActor ? targetActor.id : null;
    return { sourceId: matchedSourceId, event: events.find((e: any) => e.sourceID === matchedSourceId) || null };
  });
}

// Cached as a unit, keyed by the batch's own player set — so a same-session re-run of
// the same combo (the backfill selection is deterministic given the same cached
// rankings) still gets a full cache hit, exactly like per-player caching did, while a
// cold crawl still only costs one request per batch instead of one per player.
//
// Persisted in Redis (not unstable_cache) specifically because this is the expensive,
// WCL-rate-limited data the addon export crawl depends on — it needs to actually
// survive 24h regardless of how many deploys happen in between, not just nominally.
// Deliberately NOT used by the website's own live page rendering (see
// fetchTelemetryBatchCachedUnstable below) — Redis is a small, fixed-size store meant
// for the crawl's structured, bounded set of combos, not the much larger and more
// varied key space organic site traffic would generate.
// The cache key MUST include the player name, not just report:fight — the stored value
// is the CombatantInfo matched to that specific player's sourceID. Keyed by fights
// alone, two batches covering the same fight list for DIFFERENT players (e.g. one
// premade group topping multiple specs' leaderboards) would share an entry, attributing
// one player's build to another. v2 prefix invalidates the old name-less entries.
function telemetryBatchRequests(players: any[]) {
  return players.map(p => ({
    reportCode: p.report?.code as string,
    fightId: p.report?.fightID as number,
    playerName: p.name as string,
    serverName: (p.server?.name ?? p.server?.slug) as string | undefined,
  }));
}

function telemetryBatchKey(requests: Array<{ reportCode: string; fightId: number; playerName: string }>) {
  return requests.map(r => `${r.reportCode}:${r.fightId}:${r.playerName.toLowerCase()}`).join(',');
}

// ─── Talent entry→node map ─────────────────────────────────────────────────────

// Rankings' inline talents identify entries by trait ENTRY id; consensus (and every
// consumer downstream) works in node ids. The mapping is static game data, but no
// public API serves it (verified: Blizzard's tree JSON has node ids only, WCL has no
// trait catalog). It IS embedded in every CombatantInfo telemetry event we fetch —
// {id, nodeID} per row — so the map builds itself: seeded and extended by every real
// telemetry fetch, persisted without TTL (small — a few hundred KB across all specs;
// the headroom janitor and any eviction policy leave non-expiring keys alone).
// Players whose inline entries are all known skip the telemetry fetch entirely;
// unknown entries fall back to a real fetch, which teaches the map for next time.
const ENTRY_NODE_MAP_KEY = 'wcl-entry-node-map-v1';
const ENTRY_MAP_MEMO_MS = 5 * 60 * 1000;
let entryMapMemo: { map: Record<number, number>; at: number } | null = null;

async function loadEntryNodeMap(): Promise<Record<number, number>> {
  if (entryMapMemo && Date.now() - entryMapMemo.at < ENTRY_MAP_MEMO_MS) return entryMapMemo.map;
  const map = (await getPersistentReadOnly<Record<number, number>>(ENTRY_NODE_MAP_KEY)) ?? {};
  entryMapMemo = { map, at: Date.now() };
  return map;
}

// Read-modify-write without a lock: concurrent writers can drop each other's newest
// pairs, but the data is static and monotonic — whatever is missed is re-harvested by
// the next fetch that needs it. Await-ed by callers (Vercel post-response freeze).
async function harvestEntryNodePairs(telemetries: any[], map: Record<number, number>): Promise<void> {
  let grew = false;
  for (const t of telemetries) {
    for (const row of t?.event?.talentTree ?? []) {
      if (row?.id != null && row?.nodeID != null && map[row.id] === undefined) {
        map[row.id] = row.nodeID;
        grew = true;
      }
    }
  }
  if (grew) {
    entryMapMemo = { map, at: Date.now() };
    await setPersistentValue(ENTRY_NODE_MAP_KEY, map);
  }
}

// ─── Trait-entry → Blizzard-talent bridge ──────────────────────────────────────

// A choice node's two options are identified in TWO unrelated id spaces (verified live
// 2026-08-22 on Devourer node 108726): Blizzard's layout/profile data names them by
// "talent" catalog id (e.g. Scythe's Embrace 139052 / Duty Eternal 139048), while WCL
// telemetry reports the chosen option by trait ENTRY id (134279). Comparing across
// spaces silently never matches — which made every choice node render option A's icon
// regardless of what players actually picked, and made buildImportEntries drop choice
// picks entirely. No API serves the bridge, but any player we hold BOTH a matched
// Blizzard loadout and WCL telemetry for reveals one pair per choice node — so, like
// the entry→node map above, it teaches itself and persists without TTL.
const ENTRY_TALENT_MAP_KEY = 'wcl-entry-talent-map-v1';
let entryTalentMemo: { map: Record<number, number>; at: number } | null = null;

export async function loadEntryTalentMap(): Promise<Record<number, number>> {
  if (entryTalentMemo && Date.now() - entryTalentMemo.at < ENTRY_MAP_MEMO_MS) return entryTalentMemo.map;
  const map = (await getPersistentReadOnly<Record<number, number>>(ENTRY_TALENT_MAP_KEY)) ?? {};
  entryTalentMemo = { map, at: Date.now() };
  return map;
}

// Learns pairs from players carrying both sides: telemetry rows give (nodeID → trait
// entry id), the matched profile loadout gives (nodeID → Blizzard talent id). Only
// rows whose node appears in both are paired — and only single-entry rows (a tiered
// apex node's several sub-entries can't be attributed through the single profile id).
// Returns the merged map so the caller can translate with same-render freshness.
export async function harvestEntryTalentPairs(
  players: Array<{ telemetry?: any; profileNodes?: any[] }>
): Promise<Record<number, number>> {
  const map = await loadEntryTalentMap();
  let grew = false;
  for (const p of players) {
    const profileByNode = new Map<number, number>();
    for (const pn of p.profileNodes ?? []) {
      const talentId = pn?.tooltip?.talent?.id;
      if (pn?.id != null && talentId != null) profileByNode.set(pn.id, talentId);
    }
    if (profileByNode.size === 0) continue;
    const rowsByNode = new Map<number, any[]>();
    for (const row of p.telemetry?.event?.talentTree ?? []) {
      if (row?.id == null || row?.nodeID == null) continue;
      if (!rowsByNode.has(row.nodeID)) rowsByNode.set(row.nodeID, []);
      rowsByNode.get(row.nodeID)!.push(row);
    }
    for (const [nodeID, rows] of rowsByNode) {
      if (rows.length !== 1) continue;
      const talentId = profileByNode.get(nodeID);
      if (talentId != null && map[rows[0].id] === undefined) {
        map[rows[0].id] = talentId;
        grew = true;
      }
    }
  }
  if (grew) {
    entryTalentMemo = { map, at: Date.now() };
    await setPersistentValue(ENTRY_TALENT_MAP_KEY, map);
  }
  return map;
}

// Trait-space entry ids → Blizzard-talent-space where the bridge knows the pair;
// unknown ids pass through (the UI then falls back to its status-quo option-A default).
export function translateEntryIds(
  entryIds: Record<number, number>,
  bridge: Record<number, number>
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [nodeId, entryId] of Object.entries(entryIds)) {
    out[Number(nodeId)] = bridge[entryId] ?? entryId;
  }
  return out;
}

// Rebuild a telemetry-shaped record from a ranking row's compacted inline talents
// (see getWclRankings) — same {event: {talentTree, gear}} shape the real fetch
// produces, so every downstream consumer (normalize, consensus, hero-tree detection,
// wclItemData) is oblivious to the source. Returns null unless EVERY entry maps — a
// partially-mapped tree would silently misrepresent the build, so partial means
// "fetch for real" (which also teaches the map the missing entries).
function synthesizeTelemetryFromInline(player: any, map: Record<number, number>): any | null {
  const pairs: Array<[number, number]> | undefined = player?._tp;
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const talentTree: Array<{ nodeID: number; rank: number; id: number }> = [];
  for (const [entryId, points] of pairs) {
    const nodeID = map[entryId];
    if (nodeID === undefined) return null;
    talentTree.push({ nodeID, rank: points, id: entryId });
  }
  // Positional gear rows carry ids and item levels only — the slot/trinket fallback
  // needs exactly that; icons/bonus ids come from the combo-level itemData instead.
  const gear = Array.isArray(player?._tg)
    ? player._tg.map(([id, ilvl]: [number, number]) => ({ id, itemLevel: ilvl }))
    : [];
  return { sourceId: null, event: { talentTree, gear } };
}

// Shared front for both telemetry cache flavors: synthesize what the entry map can
// cover, fetch only the remainder (per-player, preserving input order), and teach the
// map from whatever was fetched.
async function fetchTelemetryBatchSmart(
  players: any[],
  innerFetch: (subset: any[]) => Promise<any[]>
): Promise<any[]> {
  const map = await loadEntryNodeMap();
  const out: any[] = new Array(players.length).fill(null);
  const fetchIdx: number[] = [];
  players.forEach((p, i) => {
    const synthesized = synthesizeTelemetryFromInline(p, map);
    if (synthesized) out[i] = synthesized;
    else fetchIdx.push(i);
  });
  if (fetchIdx.length > 0) {
    const fetched = await innerFetch(fetchIdx.map(i => players[i]));
    fetchIdx.forEach((playerIdx, j) => { out[playerIdx] = fetched[j] ?? null; });
    await harvestEntryNodePairs(fetched, map);
  }
  return out;
}

export function fetchTelemetryBatchCached(wclToken: string, players: any[]): Promise<any[]> {
  return fetchTelemetryBatchSmart(players, (subset) => {
    const requests = telemetryBatchRequests(subset);
    return getOrSetPersistent(
      `wcl-telemetry-batch-v2-${telemetryBatchKey(requests)}`,
      // 6h, down from 24h: since inline-talent synthesis, these entries exist mostly
      // to bootstrap the entry→node map — written once, rarely re-read — and they were
      // the second-largest memory consumer on the capped instance.
      21600,
      () => getHistoricalFightTelemetryBatch(wclToken, requests)
    );
  });
}

// Same batching, cached via unstable_cache instead of Redis — for the website's own
// live page rendering. Redis is intentionally reserved for the addon export crawl (see
// fetchTelemetryBatchCached above); organic site traffic can span far more distinct
// combos than the crawl's fixed 720, and sharing the same small Redis instance between
// both is exactly what filled it to its memory ceiling in practice.
//
// It does READ Redis first, though: the keys are content-addressed identically to the
// crawl's, so whenever the weekly crawl (or an SWR background refresh) already paid for
// this exact batch, the website reuses it for free — reads can't grow the instance.
export async function fetchTelemetryBatchCachedUnstable(wclToken: string, players: any[]): Promise<any[]> {
  return fetchTelemetryBatchSmart(players, async (subset) => {
    const requests = telemetryBatchRequests(subset);
    const key = `wcl-telemetry-batch-v2-${telemetryBatchKey(requests)}`;
    const fromCrawl = await getPersistentReadOnly<any[]>(key);
    if (fromCrawl != null) return fromCrawl;
    return unstable_cache(
      () => getHistoricalFightTelemetryBatch(wclToken, requests),
      [key],
      { revalidate: 86400 }
    )();
  });
}

// ─── Rankings: serve-stale-while-revalidate ────────────────────────────────────

// The rankings entry is what makes a combo page render instantly or in ~55s: it names
// the top players, and everything downstream (telemetry, profiles) keys off them.
// Hard-expiring it (the old model) handed the full cold rebuild to the first visitor
// per combo per day. Instead: serve whatever exists (up to STALE_TTL old) immediately,
// and past FRESH_SECONDS kick a post-response refresh that also re-warms telemetry for
// the new top players — so the follow-up visitor is warm end to end. Meta data being
// up to a day or three behind is invisible in practice; a 55-second page is not.
//
// Memory budget: rankings entries are ~40KB. The 3-day ceiling (vs the telemetry
// caches' 24h) is deliberate — the instance runs near its noeviction memory limit,
// and rankings are the only entries worth keeping longer.
const RANKINGS_FRESH_SECONDS = 86400;
const RANKINGS_STALE_TTL_SECONDS = 3 * 86400;
const RANKINGS_REFRESH_LOCK_SECONDS = 600;

export interface CachedRankings {
  rankings: any[];
  // Aggregated {itemId: {ilvl, icon, bonusIds}} across the top rows' inline gear —
  // seeds BossContent's wclItemData without per-row icon/bonus duplication.
  itemData?: Record<number, { ilvl: number; icon: string; bonusIds: number[] }>;
  fetchedAt: number;
}

export async function getRankingsCachedSWR(
  wclToken: string,
  bossId: number,
  className: string,
  spec: string,
  difficulty: number,
  region: string,
  metric: string | undefined,
  opts?: { forceFresh?: boolean }
): Promise<CachedRankings> {
  // v7: rows carry compacted inline talents (_tp) + positional gear (_tg); icon/bonus
  // data is aggregated once into itemData — see getWclRankings.
  const key = `wcl-rankings-v7-${bossId}-${className}-${spec}-${difficulty}-${region}-${metric ?? 'dps'}`;
  const compute = async (): Promise<CachedRankings> => {
    const rows = await getWclRankingsForRegionMode(wclToken, bossId, className, spec, difficulty, region, metric, true);
    return { rankings: rows, itemData: (rows as any)._itemData, fetchedAt: Date.now() };
  };

  if (!opts?.forceFresh) {
    const hit = await getSwrEntry<CachedRankings>(key);
    if (hit) {
      if (hit.ageSeconds >= RANKINGS_FRESH_SECONDS) {
        after(() => refreshRankingsInBackground(key, compute, wclToken));
      }
      return hit.value;
    }
  }

  const fresh = await compute();
  await setSwrEntry(key, fresh, RANKINGS_STALE_TTL_SECONDS);
  return fresh;
}

async function refreshRankingsInBackground(
  key: string,
  compute: () => Promise<CachedRankings>,
  wclToken: string
): Promise<void> {
  // One refresher per key: concurrent stale hits all schedule this, only one runs.
  if (!(await tryAcquireLock(`${key}:refresh-lock`, RANKINGS_REFRESH_LOCK_SECONDS))) return;
  try {
    const fresh = await compute();
    await setSwrEntry(key, fresh, RANKINGS_STALE_TTL_SECONDS);
    // Warm telemetry for the refreshed top players through the website's own cache
    // path (unstable_cache — deliberately NOT the Redis writer, see the memory note
    // above), so the next visitor's render is cache-hit end to end.
    if (fresh.rankings.length > 0) {
      await selectPlayersWithValidTelemetry(
        fresh.rankings,
        Math.min(fresh.rankings.length, 50),
        (players: any[]) => fetchTelemetryBatchCachedUnstable(wclToken, players),
        { batchSize: 10, concurrency: 5 }
      );
    }
  } catch (err) {
    // Stale keeps serving; the next stale hit after the lock expires retries.
    console.error('SWR rankings background refresh failed:', err);
  }
}

// ─── Blizzard ─────────────────────────────────────────────────────────────────

// Run at most `limit` async tasks concurrently, preserving result order.
export async function mapConcurrent<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Fetches telemetry starting from the top-ranked players and, whenever a fetch comes
// back empty (private log, deleted report, a transient WCL hiccup), keeps going into
// the next-ranked candidates to backfill — so the final valid sample actually reaches
// `targetCount` whenever the ranking pool is large enough to support it, instead of
// silently settling for "49 of 50" any time exactly one fetch fails. Returns paired
// (player, telemetry) entries in rank order; only ever fetches as many extra candidates
// as needed to cover the shortfall, not the whole remaining pool.
//
// Fetches happen in WCL-request-sized chunks (batchSize) rather than one request per
// player — each chunk becomes a single aliased WCL query (see
// getHistoricalFightTelemetryBatch) — with up to `concurrency` chunks in flight at
// once, so the actual request rate stays at concurrency chunks/interval rather than
// concurrency players/interval.
export async function selectPlayersWithValidTelemetry<P>(
  rankings: P[],
  targetCount: number,
  fetchBatch: (players: P[]) => Promise<any[]>,
  opts: { batchSize?: number; concurrency?: number } = {}
): Promise<Array<{ player: P; telemetry: any }>> {
  const batchSize = opts.batchSize ?? 10;
  const concurrency = opts.concurrency ?? 5;
  const selected: Array<{ player: P; telemetry: any }> = [];
  let nextIdx = 0;
  while (selected.length < targetCount && nextIdx < rankings.length) {
    const need = targetCount - selected.length;
    // Round the shortfall up to whole WCL batches, but never fetch more batches than
    // needed — a 1-player shortfall used to trigger a full batchSize*concurrency (50
    // player) step, 5 real WCL requests to fill one slot.
    const stepSize = Math.ceil(need / batchSize) * batchSize;
    const stepEnd = Math.min(nextIdx + stepSize, rankings.length);
    const stepPlayers = rankings.slice(nextIdx, stepEnd);
    nextIdx = stepEnd;

    const chunks: P[][] = [];
    for (let i = 0; i < stepPlayers.length; i += batchSize) chunks.push(stepPlayers.slice(i, i + batchSize));

    const chunkResults = await mapConcurrent(chunks, concurrency, async (chunk) => ({ chunk, telemetries: await fetchBatch(chunk) }));
    for (const { chunk, telemetries } of chunkResults) {
      for (let i = 0; i < chunk.length; i++) {
        const telemetry = telemetries[i];
        const tree = normalizeTalentTree((telemetry as any)?.event?.talentTree || []);
        if (tree.length > 0) selected.push({ player: chunk[i], telemetry });
      }
    }
  }
  return selected.slice(0, targetCount);
}

// No fetch here previously had a timeout — an unresponsive Blizzard connection could
// hang far longer than any backoff math would suggest, bounded only by the platform's
// own default socket timeout. A hard per-attempt timeout guarantees a ceiling.
async function fetchWithTimeout(url: string, headers: Record<string, string>, timeoutMs: number, revalidate: number) {
  return fetch(url, { headers, next: { revalidate }, signal: AbortSignal.timeout(timeoutMs) });
}

// A talent's spellId should always resolve to an icon — Blizzard has art for every real
// spell — so unlike a character profile lookup, there's no legitimate "doesn't exist"
// case here. But this runs concurrently (mapConcurrent) across every node in a tree, so
// retry cost here is a multiplier on the whole page's time budget, not just this one
// fetch — kept deliberately tight (2 attempts, short timeout) rather than generous.
export async function getSpellIconUrl(spellId: number, accessToken: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(
        `https://us.api.blizzard.com/data/wow/media/spell/${spellId}?namespace=static-us`,
        { 'Authorization': `Bearer ${accessToken}` }, 3000, 604800
      );
      if (res.ok) return (await res.json()).assets?.[0]?.value ?? '';
      if (res.status === 404) return '';
    } catch {}
    if (attempt === 0) await new Promise(r => setTimeout(r, 300));
  }
  return '';
}

// Hero talent tree portraits come from a dedicated Blizzard media endpoint
// (data.hero_talent_trees[].media.key.href), same pattern as getSpellIconUrl.
// Genuinely 404s for brand-new content until Blizzard uploads the asset —
// that's a real "not available yet" rather than a transient error. This one isn't
// inside the per-node concurrent fan-out (one call per hero tree, not per node), so
// it can afford to be a bit more patient than getSpellIconUrl.
async function getHeroTreeIconUrl(mediaHref: string | undefined, accessToken: string): Promise<string> {
  if (!mediaHref) return '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(mediaHref, { 'Authorization': `Bearer ${accessToken}` }, 4000, 604800);
      if (res.ok) return (await res.json()).assets?.[0]?.value ?? '';
      if (res.status === 404) return '';
    } catch {}
    if (attempt < 2) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
  }
  return '';
}

// Confirmed working (unlike the Blizzard media endpoint above, which currently 404s for
// this content): warcraft.wiki.gg reliably hosts hero-talent portrait art at this exact
// naming pattern, for both established and brand-new hero trees. Verifies existence via
// a real fetch rather than trusting the guessed URL blindly, since the naming convention
// could plausibly miss for less common/oddly-named trees.
async function getWikiHeroTreeIconUrl(name: string): Promise<string> {
  const slug = name.toLowerCase().replace(/\s+/g, '_');
  const url = `https://warcraft.wiki.gg/images/Hero_talent_${slug}.png`;
  try {
    const res = await fetch(url, { next: { revalidate: 604800 } });
    return res.ok ? url : '';
  } catch {
    return '';
  }
}

export async function getTalentTreeLayout(treeId: number, specId: number, accessToken: string) {
  const url = `https://us.api.blizzard.com/data/wow/talent-tree/${treeId}/playable-specialization/${specId}?namespace=static-us&locale=en_US`;
  const response = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` }, next: { revalidate: 86400 } });
  if (!response.ok) throw new Error(`Talent tree fetch failed: ${response.status}`);
  const data = await response.json();

  // Nodes that appear in multiple hero trees are shared (gateway nodes) — assign null so they
  // don't contaminate hero-tree detection when building the consensus build.
  const heroNodeTreeMap = new Map<number, number | null>();
  for (const ht of (data.hero_talent_trees || [])) {
    for (const n of (ht.hero_talent_nodes || [])) {
      heroNodeTreeMap.set(n.id, heroNodeTreeMap.has(n.id) ? null : ht.id);
    }
  }
  const heroNodeIds = new Set(heroNodeTreeMap.keys());
  const heroTreeNames: Array<{ id: number; name: string; imageUrl: string }> = await Promise.all(
    (data.hero_talent_trees || []).map(async (ht: any) => {
      // Blizzard's own media endpoint first (best when available), then the community
      // wiki (confirmed reliable for both new and established hero trees), then a hero
      // node's own spell icon as a last resort if neither source has this specific tree.
      let imageUrl = await getHeroTreeIconUrl(ht.media?.key?.href, accessToken);
      if (!imageUrl) imageUrl = await getWikiHeroTreeIconUrl(ht.name);
      if (!imageUrl) {
        const firstNode = (ht.hero_talent_nodes || [])[0];
        const firstRank = firstNode?.ranks?.[0];
        const choices: any[] = firstRank?.choice_of_tooltips ?? [];
        const tooltip = firstRank?.tooltip ?? choices[0];
        const spellId = tooltip?.spell_tooltip?.spell?.id;
        if (spellId) imageUrl = await getSpellIconUrl(spellId, accessToken);
      }
      return { id: ht.id, name: ht.name, imageUrl };
    })
  );

  // Primary source for hero nodes: spec_talent_nodes (Blizzard naturally filters these to the
  // spec's available hero trees). Fall back to hero_talent_trees nodes directly for specs where
  // spec_talent_nodes doesn't include hero nodes at all (e.g. Augmentation Evoker).
  const heroNodesFromSpec = (data.spec_talent_nodes || []).filter((n: any) => heroNodeIds.has(n.id));
  const heroNodeSource: any[] = heroNodesFromSpec.length > 0
    ? heroNodesFromSpec.map((n: any) => ({
        ...n,
        _section: 'hero',
        _heroTreeId: heroNodeTreeMap.get(n.id) ?? null,
      }))
    : (() => {
        const seenIds = new Set<number>();
        const allNodes: any[] = [];
        for (const ht of (data.hero_talent_trees || [])) {
          for (const n of (ht.hero_talent_nodes || [])) {
            if (seenIds.has(n.id)) continue;
            seenIds.add(n.id);
            allNodes.push({ ...n, _section: 'hero', _heroTreeId: heroNodeTreeMap.get(n.id) ?? null });
          }
        }
        // When two nodes share the same visual position (same display_row + display_col),
        // keep tree-specific (non-null treeId) over shared gateway (null treeId).
        // Among same-priority nodes at the same position, keep the first encountered.
        const takenPos = new Set<string>();
        const nodes: any[] = [];
        for (const pass of [false, true]) { // false = tree-specific first, true = shared gateway
          for (const node of allNodes) {
            if ((node._heroTreeId === null) !== pass) continue;
            const key = `${node.display_row},${node.display_col}`;
            if (!takenPos.has(key)) { takenPos.add(key); nodes.push(node); }
          }
        }
        return nodes;
      })();

  const allRawUnsorted = [
    ...(data.class_talent_nodes || []).map((n: any) => ({ ...n, _section: 'class', _heroTreeId: null })),
    ...heroNodeSource,
    ...(data.spec_talent_nodes || []).filter((n: any) => !heroNodeIds.has(n.id)).map((n: any) => ({
      ...n,
      _section: 'spec',
      _heroTreeId: null,
    })),
  ];
  // Blizzard occasionally lists the same node in both class_talent_nodes and hero_talent_trees.
  // Deduplicate by ID, preferring the most specific section: hero > spec > class.
  const sectionPriority = (s: string) => s === 'hero' ? 2 : s === 'spec' ? 1 : 0;
  const bestById = new Map<number, any>();
  for (const n of allRawUnsorted) {
    const existing = bestById.get(n.id);
    if (!existing || sectionPriority(n._section) > sectionPriority(existing._section)) {
      bestById.set(n.id, n);
    }
  }
  const allRaw = [...bestById.values()];

  // Higher concurrency than most mapConcurrent uses in this file — this fans out to
  // Blizzard (generous per-app rate limits), not WCL (the service that actually needed
  // throttling). Fewer sequential waves means a lower worst-case total time for the tree.
  const mapped = await mapConcurrent(allRaw, 25, async (node: any) => {
    const firstRank = node.ranks?.[0];
    const choices: any[] = firstRank?.choice_of_tooltips ?? [];
    const isChoice = choices.length >= 2;
    const tooltip = firstRank?.tooltip ?? choices[0];
    const spellTooltip = tooltip?.spell_tooltip;
    const spellId = spellTooltip?.spell?.id;
    const name = tooltip?.talent?.name ?? '';
    const iconUrl = spellId ? await getSpellIconUrl(spellId, accessToken) : '';

    let choiceB: { name: string; spellId: number | null; iconUrl: string; description: string; castTime: string; range: string; cost: string; cooldown: string } | null = null;
    const choiceAEntryId: number | null = isChoice ? (choices[0]?.talent?.id ?? null) : null;
    const choiceBEntryId: number | null = isChoice ? (choices[1]?.talent?.id ?? null) : null;
    if (isChoice) {
      const ttB = choices[1]?.spell_tooltip;
      const spellIdB = ttB?.spell?.id ?? null;
      choiceB = {
        name: choices[1]?.talent?.name ?? '',
        spellId: spellIdB,
        iconUrl: spellIdB ? await getSpellIconUrl(spellIdB, accessToken) : '',
        description: (ttB?.description ?? '').replace(/\|n/gi, '\n'),
        castTime: ttB?.cast_time ?? '',
        range: ttB?.range ?? '',
        cost: ttB?.power_cost ?? '',
        cooldown: ttB?.cooldown ?? '',
      };
    }

    // Sum of default_points across ranks — the handful of nodes that are auto-granted
    // (e.g. starting stances, hero-tree root passives) rather than purchased with a
    // point. Needed to correctly split ranksGranted vs ranksPurchased when building
    // C_ClassTalents.ImportLoadout entries straight from WCL telemetry.
    const grantedRanks = (node.ranks ?? []).reduce((s: number, r: any) => s + (r.default_points || 0), 0);

    return {
      nodeID: node.id,
      row: node.display_row,
      column: node.display_col,
      section: node._section as 'class' | 'hero' | 'spec',
      heroTreeId: node._heroTreeId as number | null,
      name,
      maxRanks: node.ranks?.length ?? 1,
      grantedRanks,
      spellId: spellId ?? null,
      iconUrl,
      description: (spellTooltip?.description ?? '').replace(/\|n/gi, '\n'),
      castTime: spellTooltip?.cast_time ?? '',
      range: spellTooltip?.range ?? '',
      cost: spellTooltip?.power_cost ?? '',
      cooldown: spellTooltip?.cooldown ?? '',
      isChoice,
      choiceAEntryId,
      choiceBEntryId,
      choiceB,
    };
  });

  return { layout: mapped.filter(n => n.name || n.iconUrl), heroTreeNames };
}

// Cached wrapper — keyed by treeId+specId so token rotation doesn't bust it.
// 24h TTL: a talent tree's visual layout only changes on WoW patches (~every 6-8 weeks),
// but individual entry IDs (choiceAEntryId/choiceBEntryId etc.) can and do get
// regenerated by an ordinary hotfix without touching the layout at all — this is the
// data buildImportEntries validates choice-node picks against, so a week-long TTL here
// meant a week-long window where that validation itself could be trusting stale IDs.
// Each node's own icon fetch already retries internally; if a handful still come back
// with no icon after that, retry just *those* nodes rather than the whole tree — a retry
// cost that scales with the (usually tiny) straggler count instead of total tree size.
// Re-running the entire computation on any single miss was tried and reverted: it
// multiplies the page's worst-case time by the retry count, which risks the whole page
// timing out to avoid what's normally a couple of blank icons.
export function getCachedTalentLayout(treeId: number, specId: number, accessToken: string) {
  return unstable_cache(
    async () => {
      const result = await getTalentTreeLayout(treeId, specId, accessToken);
      const stragglers = result.layout
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => (n.spellId && !n.iconUrl) || (n.choiceB?.spellId && !n.choiceB.iconUrl));
      if (stragglers.length === 0) return result;

      await mapConcurrent(stragglers, 10, async ({ n, i }) => {
        if (n.spellId && !n.iconUrl) {
          const iconUrl = await getSpellIconUrl(n.spellId, accessToken);
          if (iconUrl) result.layout[i] = { ...result.layout[i], iconUrl };
        }
        const node = result.layout[i];
        if (node.choiceB?.spellId && !node.choiceB.iconUrl) {
          const iconUrl = await getSpellIconUrl(node.choiceB.spellId, accessToken);
          if (iconUrl) result.layout[i] = { ...node, choiceB: { ...node.choiceB, iconUrl } };
        }
      });
      return result;
    },
    [`talent-layout-v8-${treeId}-${specId}`],
    { revalidate: 86400 }
  )();
}

export async function getTalentTreeId(specName: string, className: string, accessToken: string): Promise<{ treeId: number; specId: number } | null> {
  const specId = SPEC_IDS[className]?.[specName];
  if (!specId) return null;
  const response = await fetch('https://us.api.blizzard.com/data/wow/talent-tree/index?namespace=static-us&locale=en_US', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    next: { revalidate: 604800 },
  });
  if (!response.ok) throw new Error(`Talent tree index failed: ${response.status}`);
  const trees: any[] = (await response.json()).spec_talent_trees || [];
  const match = trees.find((t: any) => {
    const m = t.key?.href?.match(/playable-specialization\/(\d+)/);
    return m && parseInt(m[1]) === specId;
  });
  if (!match) return null;
  const hrefMatch = match.key?.href?.match(/talent-tree\/(\d+)\/playable-specialization\/(\d+)/);
  if (!hrefMatch) return null;
  return { treeId: parseInt(hrefMatch[1]), specId: parseInt(hrefMatch[2]) };
}

// ─── Consensus Helpers ────────────────────────────────────────────────────────

export interface WclImportEntry {
  nodeID: number;
  ranksGranted: number;
  ranksPurchased: number;
  selectionEntryID: number;
}

// Builds C_ClassTalents.ImportLoadout-ready entries directly from one player's raw WCL
// CombatantInfo telemetry (nodeID + entry id + rank per row), cross-referenced against
// the spec's static tree layout for grantedRanks. Entirely independent of Blizzard's
// character-profile API — works for any region, including ones (like CN) where that
// API isn't reachable at all. Verified via a real in-game reconstruction test: staged
// output matched the source player's actual build exactly.
//
// WCL telemetry is a permanent historical record — it reports whatever entry ID was
// valid when that fight happened, forever, even after Blizzard later renumbers a node's
// entries (this does happen: hotfixes can regenerate a talent's entry ID without
// changing the tree's visual layout). A top-ranked-by-score parse can easily be older
// than the most recent such change, especially early in a season. For a two-option
// CHOICE node this is actively dangerous, not just cosmetic: a stale ID doesn't error
// out in a live client, it can resolve to whatever entry now occupies that number —
// silently importing the WRONG option (e.g. "Profound Rebuttal" instead of "Strength
// of Spirit"). So for choice nodes, the resolved ID is validated against the layout's
// own (current) choiceAEntryId/choiceBEntryId — an ID that matches neither is dropped
// entirely rather than exported, since a missing point the player fills in manually is
// far better than one silently wrong. Non-choice nodes have no such ambiguous "wrong
// twin" to fall into, so they're left unvalidated.
export function buildImportEntries(
  raw: Array<{ nodeID: number; rank: number; id?: number }>,
  layout: Array<{ nodeID: number; grantedRanks?: number; isChoice?: boolean; choiceAEntryId?: number | null; choiceBEntryId?: number | null }>,
  // The trait entry→node map (see loadEntryNodeMap): since 12.1 split the id spaces,
  // WCL's trait entry ids never match the layout's Blizzard-talent choice ids, so the
  // choice-set check alone rejected every legitimate choice pick. An id this map
  // confirms belongs to this exact node is current-and-correct by construction —
  // the same stale-id protection the choice-set check wanted, in the right space.
  entryNodeMap?: Record<number, number>
): WclImportEntry[] {
  const grantedByNode = new Map<number, number>();
  const choiceIdsByNode = new Map<number, Set<number>>();
  for (const n of layout) {
    grantedByNode.set(n.nodeID, n.grantedRanks ?? 0);
    if (n.isChoice) {
      const ids = new Set<number>();
      if (n.choiceAEntryId != null) ids.add(n.choiceAEntryId);
      if (n.choiceBEntryId != null) ids.add(n.choiceBEntryId);
      if (ids.size > 0) choiceIdsByNode.set(n.nodeID, ids);
    }
  }

  const byNode = new Map<number, Array<{ rank: number; id?: number }>>();
  for (const t of raw) {
    if (!byNode.has(t.nodeID)) byNode.set(t.nodeID, []);
    byNode.get(t.nodeID)!.push({ rank: t.rank, id: t.id });
  }

  const entries: WclImportEntry[] = [];
  for (const [nodeID, rows] of byNode) {
    const validChoiceIds = choiceIdsByNode.get(nodeID);
    const distinctIds = new Set(rows.map(r => r.id));
    if (rows.length > 1 && distinctIds.size > 1) {
      // Apex/tiered node: each row is a separate sub-entry with its OWN independent
      // rank counter (verified live: a real client's C_Traits.GetEntryInfo confirms a
      // single sub-entry can itself hold more than 1 rank, e.g. Tigereye Brew's second
      // entry maxRanks=2) — so row.rank is that specific entry's ranksPurchased, not a
      // uniform 1 per row (which undercounts whenever an entry holds >1 point). Group
      // by id first (max rank per id) in case the same entry appears in more than one
      // row.
      const maxById = new Map<number, number>();
      for (const row of rows) {
        if (row.id == null) continue;
        maxById.set(row.id, Math.max(maxById.get(row.id) ?? 0, row.rank));
      }
      for (const [entryId, rank] of maxById) {
        entries.push({ nodeID, ranksGranted: 0, ranksPurchased: rank, selectionEntryID: entryId });
      }
      continue;
    }
    const achievedRank = Math.max(...rows.map(r => r.rank));
    const granted = Math.min(achievedRank, grantedByNode.get(nodeID) ?? 0);
    const purchased = achievedRank - granted;
    const entryId = rows[0].id;
    if (entryId == null) continue;
    if (validChoiceIds && !validChoiceIds.has(entryId) && entryNodeMap?.[entryId] !== nodeID) continue;
    entries.push({ nodeID, ranksGranted: granted, ranksPurchased: purchased, selectionEntryID: entryId });
  }
  return entries;
}

export function computeConsensus(
  telemetries: Array<Array<{ nodeID: number; rank: number }>>,
  threshold = 0.5
): Map<number, number> {
  if (telemetries.length === 0) return new Map();
  const freq = new Map<number, Map<number, number>>();
  for (const tel of telemetries) {
    for (const { nodeID, rank } of tel) {
      if (!freq.has(nodeID)) freq.set(nodeID, new Map());
      const rm = freq.get(nodeID)!;
      rm.set(rank, (rm.get(rank) ?? 0) + 1);
    }
  }
  const result = new Map<number, number>();
  const N = telemetries.length;
  for (const [nodeID, rankMap] of freq) {
    let bestRank = 0, bestCount = 0;
    for (const [rank, count] of rankMap) {
      if (count > bestCount) { bestCount = count; bestRank = rank; }
    }
    if (bestCount / N >= threshold) result.set(nodeID, bestRank);
  }
  return result;
}

export function getActiveHeroTreeId(talentNodes: Array<{ nodeID: number; rank: number }>, layout: any[]): number | null {
  const active = new Set(talentNodes.map(t => t.nodeID));
  for (const node of layout) {
    if (node.section === 'hero' && node.heroTreeId != null && active.has(node.nodeID)) return node.heroTreeId;
  }
  return null;
}

export function makeTelemetry(nodeMap: Map<number, number>) {
  return { event: { talentTree: Array.from(nodeMap.entries()).map(([nodeID, rank]) => ({ nodeID, rank })) } };
}

export function computeFrequencyPct(telemetries: Array<Array<{ nodeID: number; rank: number }>>): Record<number, number> {
  const counts = new Map<number, number>();
  const N = telemetries.length;
  for (const tel of telemetries) {
    const seen = new Set<number>();
    for (const { nodeID } of tel) {
      if (!seen.has(nodeID)) { counts.set(nodeID, (counts.get(nodeID) ?? 0) + 1); seen.add(nodeID); }
    }
  }
  const result: Record<number, number> = {};
  for (const [nodeID, count] of counts) result[nodeID] = Math.round((count / N) * 100);
  return result;
}

// computeFrequencyPct only answers "did they take this node at all" — for a multi-rank
// node that collapses "everyone went 4/4" and "half stopped at 3/4 to afford something
// else" into the same 100%. This answers the more useful question for those nodes: what
// share of the sample landed on each specific rank.
export function computeRankDistribution(
  telemetries: Array<Array<{ nodeID: number; rank: number }>>
): Record<number, Record<number, number>> {
  const counts = new Map<number, Map<number, number>>();
  const N = telemetries.length;
  for (const tel of telemetries) {
    for (const { nodeID, rank } of tel) {
      if (!counts.has(nodeID)) counts.set(nodeID, new Map());
      const byRank = counts.get(nodeID)!;
      byRank.set(rank, (byRank.get(rank) ?? 0) + 1);
    }
  }
  const result: Record<number, Record<number, number>> = {};
  for (const [nodeID, byRank] of counts) {
    result[nodeID] = {};
    for (const [rank, count] of byRank) result[nodeID][rank] = Math.round((count / N) * 100);
  }
  return result;
}

// Matches a player's WCL fight telemetry against their Blizzard profile's saved
// loadouts to pick which one (if any) they were actually using during the fight, and
// extracts that loadout's structured node list. Deliberately uses Math.max/small
// sequential rank values here (not the apex/tiered distinct-entry-count logic used
// elsewhere) — Blizzard's PROFILE API reports plain sequential ranks for these nodes,
// so matching against that ground truth needs the same representation, not the WCL-
// telemetry-specific fix. Shared by the initial player-card fetch and the on-demand
// "load more players" action so they can never drift apart.
export function deriveTalentStringAndProfileNodes(
  telemetryData: any,
  profileData: any,
  specId: number
): { talentString: string | null; profileNodes: any[] } {
  const fightTalents: Array<{ nodeID: number; rank: number }> = telemetryData?.event?.talentTree || [];
  const fightMap = new Map<number, number>();
  for (const t of fightTalents as any[]) {
    fightMap.set(t.nodeID, Math.max(fightMap.get(t.nodeID) ?? 0, t.rank));
  }

  const fightSpec = profileData?.specializations?.find(
    (sp: any) => sp.specialization?.id === specId
  );

  let talentString: string | null = null;
  if (fightSpec) {
    // A profile's "active" loadout reflects whatever the player has selected right
    // now, at fetch time — not necessarily what they had equipped during this fight,
    // which may be old and long since respecced away from. Always score every saved
    // loadout against the fight's actual telemetry and take the best match; `is_active`
    // only breaks ties between equally-good matches, never bypasses scoring outright.
    let bestScore = -1;
    let bestNodeCount = 0;
    let bestIsActive = false;
    for (const loadout of fightSpec.loadouts ?? []) {
      if (!loadout.talent_loadout_code) continue;
      const nodes = [
        ...(loadout.selected_class_talents ?? []),
        ...(loadout.selected_spec_talents ?? []),
        ...(loadout.selected_hero_talents ?? []),
      ];
      let score = 0;
      for (const node of nodes) {
        if (fightMap.get(node.id) === node.rank) score++;
      }
      const isActive = !!loadout.is_active;
      if (score > bestScore || (score === bestScore && isActive && !bestIsActive)) {
        bestScore = score; bestNodeCount = nodes.length; talentString = loadout.talent_loadout_code; bestIsActive = isActive;
      }
    }
    // "Best of the saved loadouts" is not the same as "the build they actually played" —
    // a player who fully respecced since the fight still produces a best match, just a
    // bad one, and its copyable string would disagree with the fight build shown on
    // screen. Below a reasonable agreement floor, no string at all (Copy hides) beats a
    // confidently wrong one. 80%: true matches agree on nearly every node (small slack
    // for granted-node/representation differences); wholesale respecs fall well under.
    if (bestScore >= 0 && (bestNodeCount === 0 || bestScore < bestNodeCount * 0.8)) {
      talentString = null;
    }
  }
  const selectedLoadout = fightSpec?.loadouts?.find((l: any) => l.talent_loadout_code === talentString) ?? null;
  const profileNodes: any[] = selectedLoadout ? [
    ...(selectedLoadout.selected_class_talents ?? []),
    ...(selectedLoadout.selected_spec_talents ?? []),
    ...(selectedLoadout.selected_hero_talents ?? []),
  ] : [];

  return { talentString, profileNodes };
}

// How closely one player's fight matches the node-level majority consensus — counts
// nodes where the player's actual pick+rank agrees with cMap. Used to find the single
// real player whose build is the best stand-in for "the meta build."
export function scorePlayerTree(tree: any[], cMap: Map<number, number>): number {
  const rankMap = new Map<number, number>();
  for (const t of normalizeTalentTree(tree)) rankMap.set(t.nodeID, t.rank);
  let score = 0;
  for (const [nodeID, rank] of cMap) {
    if (rankMap.get(nodeID) === rank) score++;
  }
  return score;
}

export interface MetaBuildPick {
  player: any;
  telemetry: any;
  wclEntries: WclImportEntry[] | null;
  entryIds: Record<number, number>;
  talentString: string | null;
}

// Finds the single real player — across the FULL consensus pool, not just whichever
// slice happened to get an eager Blizzard-profile fetch — whose raw WCL telemetry is
// closest to cMap, and derives the "meta build" entirely from that player's actual
// fight data. entryIds/wclEntries come straight from buildImportEntries (already
// proven accurate) and cost nothing extra. talentString is resolved for this exact same
// player only (reusing already-fetched profileData if present, else fetched on demand) —
// deliberately no fallback to a lower-scoring candidate: a fallback player's talentString
// could genuinely disagree with the entryIds/wclEntries shown on screen (both anchored to
// the true best match), which is exactly the kind of mismatch this function exists to
// eliminate. When this exact player's profile isn't fetchable, talentString is simply
// null and the Copy button doesn't render — never a possibly-inconsistent string.
export async function resolveMetaBuildPick(
  pool: Array<{ player: any; telemetry: any; profileData?: any }>,
  cMap: Map<number, number>,
  skeletonMap: Array<{ nodeID: number; grantedRanks?: number }>,
  specId: number,
  blizzardTokensByRegion: Map<string, string>
): Promise<MetaBuildPick | null> {
  let bestScore = -1;
  let best: (typeof pool)[number] | null = null;
  for (const entry of pool) {
    const raw = entry.telemetry?.event?.talentTree;
    if (!raw?.length) continue;
    const score = scorePlayerTree(raw, cMap);
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  if (!best) return null;

  const rawTree = best.telemetry.event.talentTree;
  const wclEntries = buildImportEntries(rawTree, skeletonMap, await loadEntryNodeMap());
  const entryIds: Record<number, number> = {};
  for (const e of wclEntries) entryIds[e.nodeID] = e.selectionEntryID;

  let profileData = best.profileData;
  if (!profileData) {
    profileData = await blizzardCharacterProfileFetch(best.player, blizzardTokensByRegion, 'specializations', 'spec');
  }
  const { talentString } = deriveTalentStringAndProfileNodes(best.telemetry, profileData, specId);

  return {
    player: best.player,
    telemetry: best.telemetry,
    wclEntries: wclEntries.length > 0 ? wclEntries : null,
    entryIds,
    talentString,
  };
}

// ─── Static Data ──────────────────────────────────────────────────────────────

export const MIDNIGHT_RAIDS: Record<string, string> = {
  'The Venomous Abyss': 'The Venomous Abyss',
};

// Raid difficulty default and the current M+ zone are no longer hand-flipped
// constants — getSeasonState() resolves both from live WCL data (Mythic-parse probe;
// newest active "Mythic+ Season N" zone). MPLUS_ZONE_ID survives only as the
// resolver's disaster fallback.
export const MPLUS_ZONE_ID = 55; // Midnight Season 2 — fallback only, see getSeasonState
export const MPLUS_DIFFICULTY = 10; // bracket that returns high-key parses

// Splash-image lookups only. Blizzard's journal-instance IDs and WCL's CDN icon IDs
// are separate vendor ID systems with no way to derive them from a live WCL query, so
// this is the one piece of dungeon data that still needs curating by hand each season.
// A dungeon missing an entry here just falls back to a generic look — it never breaks
// the actual talent-build data, which comes from getDungeonRoster below instead.
const DUNGEON_MEDIA_OVERRIDES: Record<string, { wclCdnId?: number; blizzardInstanceId?: number }> = {
  // Season 2 (verified 2026-08-18: every tile exists, wclCdnId only where the CDN 200s)
  'Altar of Fangs':            { wclCdnId: 12993, blizzardInstanceId: 1322 },
  'Den of Nalorakk':           { wclCdnId: 12825, blizzardInstanceId: 1311 },
  "Kings' Rest":               { blizzardInstanceId: 1041 },
  'Murder Row':                { wclCdnId: 12813, blizzardInstanceId: 1304 },
  'Ruby Life Pools':           { blizzardInstanceId: 1202 },
  'Temple of Sethraliss':      { blizzardInstanceId: 1030 },
  'The Blinding Vale':         { wclCdnId: 12859, blizzardInstanceId: 1309 },
  'Voidscar Arena':            { wclCdnId: 12923, blizzardInstanceId: 1313 },
};

// Discovers the current season's Mythic+ dungeon roster live from WCL instead of a
// hand-maintained ID list — the only thing that needs updating for a new M+ season is
// MPLUS_ZONE_ID above. Falls back to an empty roster (page renders with no dungeons
// listed, not a crash) if the WCL query fails.
export async function getDungeonRoster(token: string): Promise<Array<{ id: number; name: string; wclCdnId?: number; blizzardInstanceId?: number }>> {
  const encounters = await getMplusEncounters(token, (await getSeasonState()).mplusZoneId);
  return encounters.map((enc: any) => ({
    id: enc.id,
    name: enc.name,
    ...DUNGEON_MEDIA_OVERRIDES[enc.name],
  }));
}

export const SPEC_IDS: Record<string, Record<string, number>> = {
  'Death Knight':  { 'Blood': 250, 'Frost': 251, 'Unholy': 252 },
  'Demon Hunter':  { 'Havoc': 577, 'Vengeance': 581, 'Devourer': 1480 },
  'Druid':         { 'Balance': 102, 'Feral': 103, 'Guardian': 104, 'Restoration': 105 },
  'Evoker':        { 'Devastation': 1467, 'Preservation': 1468, 'Augmentation': 1473 },
  'Hunter':        { 'Beast Mastery': 253, 'Marksmanship': 254, 'Survival': 255 },
  'Mage':          { 'Arcane': 62, 'Fire': 63, 'Frost': 64 },
  'Monk':          { 'Brewmaster': 268, 'Mistweaver': 270, 'Windwalker': 269 },
  'Paladin':       { 'Holy': 65, 'Protection': 66, 'Retribution': 70 },
  'Priest':        { 'Discipline': 256, 'Holy': 257, 'Shadow': 258 },
  'Rogue':         { 'Assassination': 259, 'Outlaw': 260, 'Subtlety': 261 },
  'Shaman':        { 'Elemental': 262, 'Enhancement': 263, 'Restoration': 264 },
  'Warlock':       { 'Affliction': 265, 'Demonology': 266, 'Destruction': 267 },
  'Warrior':       { 'Arms': 71, 'Fury': 72, 'Protection': 73 },
};

export const POPULAR_SPECS = [
  { class: 'Death Knight', specs: ['Blood', 'Frost', 'Unholy'], color: 'text-[#C41E3A]', border: 'border-[#C41E3A]/50', activeBg: 'bg-[#C41E3A]/10' },
  { class: 'Demon Hunter', specs: ['Havoc', 'Vengeance', 'Devourer'], color: 'text-[#A330C9]', border: 'border-[#A330C9]/50', activeBg: 'bg-[#A330C9]/10' },
  { class: 'Druid', specs: ['Balance', 'Feral', 'Guardian', 'Restoration'], color: 'text-[#FF7D0A]', border: 'border-[#FF7D0A]/50', activeBg: 'bg-[#FF7D0A]/10' },
  { class: 'Evoker', specs: ['Augmentation', 'Devastation', 'Preservation'], color: 'text-[#33937F]', border: 'border-[#33937F]/50', activeBg: 'bg-[#33937F]/10' },
  { class: 'Hunter', specs: ['Beast Mastery', 'Marksmanship', 'Survival'], color: 'text-[#ABD473]', border: 'border-[#ABD473]/50', activeBg: 'bg-[#ABD473]/10' },
  { class: 'Mage', specs: ['Arcane', 'Fire', 'Frost'], color: 'text-[#3FC7EB]', border: 'border-[#3FC7EB]/50', activeBg: 'bg-[#3FC7EB]/10' },
  { class: 'Monk', specs: ['Brewmaster', 'Mistweaver', 'Windwalker'], color: 'text-[#00FF96]', border: 'border-[#00FF96]/50', activeBg: 'bg-[#00FF96]/10' },
  { class: 'Paladin', specs: ['Holy', 'Protection', 'Retribution'], color: 'text-[#F48CBA]', border: 'border-[#F48CBA]/50', activeBg: 'bg-[#F48CBA]/10' },
  { class: 'Priest', specs: ['Discipline', 'Holy', 'Shadow'], color: 'text-white', border: 'border-white/30', activeBg: 'bg-white/5' },
  { class: 'Rogue', specs: ['Assassination', 'Outlaw', 'Subtlety'], color: 'text-[#FFF468]', border: 'border-[#FFF468]/50', activeBg: 'bg-[#FFF468]/10' },
  { class: 'Shaman', specs: ['Elemental', 'Enhancement', 'Restoration'], color: 'text-[#0070DE]', border: 'border-[#0070DE]/50', activeBg: 'bg-[#0070DE]/10' },
  { class: 'Warlock', specs: ['Affliction', 'Demonology', 'Destruction'], color: 'text-[#8787ED]', border: 'border-[#8787ED]/50', activeBg: 'bg-[#8787ED]/10' },
  { class: 'Warrior', specs: ['Arms', 'Fury', 'Protection'], color: 'text-[#C69B6D]', border: 'border-[#C69B6D]/50', activeBg: 'bg-[#C69B6D]/10' },
];

export const ENCHANT_SLOT_LABELS: Record<string, string> = {
  'MAIN_HAND': 'Weapon', 'OFF_HAND': 'Weapon',
  'FINGER_1': 'Rings', 'FINGER_2': 'Rings',
  'BACK': 'Cloak',
  'CHEST': 'Chest',
  'WRIST': 'Bracers',
  'FEET': 'Boots',
  'LEGS': 'Legs',
};

export const ENCHANT_SLOT_ORDER = ['Weapon', 'Rings', 'Cloak', 'Chest', 'Bracers', 'Boots', 'Legs'];

export const HEALER_SPECS: Array<{ class: string; spec: string }> = [
  { class: 'Druid', spec: 'Restoration' },
  { class: 'Evoker', spec: 'Preservation' },
  { class: 'Monk', spec: 'Mistweaver' },
  { class: 'Paladin', spec: 'Holy' },
  { class: 'Priest', spec: 'Discipline' },
  { class: 'Priest', spec: 'Holy' },
  { class: 'Shaman', spec: 'Restoration' },
];

export const TANK_SPECS: Array<{ class: string; spec: string }> = [
  { class: 'Death Knight', spec: 'Blood' },
  { class: 'Demon Hunter', spec: 'Vengeance' },
  { class: 'Druid', spec: 'Guardian' },
  { class: 'Monk', spec: 'Brewmaster' },
  { class: 'Paladin', spec: 'Protection' },
  { class: 'Warrior', spec: 'Protection' },
];

export const DPS_SPECS: Array<{ class: string; spec: string }> = [
  { class: 'Death Knight', spec: 'Frost' },
  { class: 'Death Knight', spec: 'Unholy' },
  { class: 'Demon Hunter', spec: 'Havoc' },
  { class: 'Demon Hunter', spec: 'Devourer' },
  { class: 'Druid', spec: 'Balance' },
  { class: 'Druid', spec: 'Feral' },
  { class: 'Evoker', spec: 'Augmentation' },
  { class: 'Evoker', spec: 'Devastation' },
  { class: 'Hunter', spec: 'Beast Mastery' },
  { class: 'Hunter', spec: 'Marksmanship' },
  { class: 'Hunter', spec: 'Survival' },
  { class: 'Mage', spec: 'Arcane' },
  { class: 'Mage', spec: 'Fire' },
  { class: 'Mage', spec: 'Frost' },
  { class: 'Monk', spec: 'Windwalker' },
  { class: 'Paladin', spec: 'Retribution' },
  { class: 'Priest', spec: 'Shadow' },
  { class: 'Rogue', spec: 'Assassination' },
  { class: 'Rogue', spec: 'Outlaw' },
  { class: 'Rogue', spec: 'Subtlety' },
  { class: 'Shaman', spec: 'Elemental' },
  { class: 'Shaman', spec: 'Enhancement' },
  { class: 'Warlock', spec: 'Affliction' },
  { class: 'Warlock', spec: 'Demonology' },
  { class: 'Warlock', spec: 'Destruction' },
  { class: 'Warrior', spec: 'Arms' },
  { class: 'Warrior', spec: 'Fury' },
];

export const CLASS_IDS: Record<string, number> = {
  'Death Knight': 6, 'Demon Hunter': 12, 'Druid': 11, 'Evoker': 13,
  'Hunter': 3, 'Mage': 8, 'Monk': 10, 'Paladin': 2, 'Priest': 5,
  'Rogue': 4, 'Shaman': 7, 'Warlock': 9, 'Warrior': 1,
};
