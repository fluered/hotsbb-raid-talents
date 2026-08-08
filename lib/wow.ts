import { unstable_cache } from 'next/cache';
import { normalizeTalentTree } from './talentNormalize';
import { getOrSetPersistent } from './persistentCache';
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
  const query = `query { worldData { zones { id name encounters { id name journalID } } } }`;
  const response = await wclFetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    // Was uncached — every page load re-fetched WCL's entire zone list from scratch.
    // Zone/encounter structure only changes on patch days, so 24h is safe.
    next: { revalidate: 86400 },
  });
  throwIfRateLimited(response);
  return (await response.json()).data?.worldData?.zones || [];
}

export async function getMplusEncounters(token: string, zoneId: number) {
  const query = `query { worldData { zone(id: ${zoneId}) { encounters { id name journalID } } } }`;
  const response = await wclFetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    next: { revalidate: 86400 },
  });
  throwIfRateLimited(response);
  return (await response.json()).data?.worldData?.zone?.encounters || [];
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
  const query = `
    query {
      worldData {
        encounter(id: ${bossId}) {
          characterRankings(className: "${wclClassName}", specName: "${wclSpecName}", difficulty: ${difficulty}${regionArg}${metricArg})
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
  // A 429 here was previously swallowed into an empty rankings array — indistinguishable
  // from a boss/spec combo that genuinely has no parses yet. That's exactly why a WCL
  // rate-limit exhaustion (confirmed 2026-07-26, "Too many requests... subscribe on
  // Patreon to increase their request limit") went undetected mid-batch-export: every
  // caller just saw normal-looking no_data results and had no signal to stop. Throw a
  // distinguishable error instead so callers (the export script especially) can react
  // to "we're rate-limited" differently than "this combo has no data."
  if (response.status === 429) {
    const err: any = new Error('WCL rate limit exceeded — the API key has hit its request budget for the current window.');
    err.isRateLimit = true;
    err.retryAfter = response.headers.get('retry-after');
    throw err;
  }
  return (await response.json()).data?.worldData?.encounter?.characterRankings?.rankings || [];
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
    return [...(us as any[]), ...(eu as any[])].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
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
export async function getHistoricalFightTelemetry(wclToken: string, reportCode: string, fightId: number, playerName: string) {
  const query = `
    query {
      reportData {
        report(code: "${reportCode}") {
          masterData { actors(type: "Player") { id name } }
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
  if (response.status === 429) {
    const err: any = new Error('WCL rate limit exceeded — the API key has hit its request budget for the current window.');
    err.isRateLimit = true;
    err.retryAfter = response.headers.get('retry-after');
    throw err;
  }
  try {
    const reportData = (await response.json()).data?.reportData?.report;
    const actors = reportData?.masterData?.actors || [];
    const events = reportData?.events?.data || [];
    const targetActor = actors.find((a: any) => a.name.toLowerCase() === playerName.toLowerCase());
    const matchedSourceId = targetActor ? targetActor.id : null;
    return { sourceId: matchedSourceId, event: events.find((e: any) => e.sourceID === matchedSourceId) || null };
  } catch {
    // A genuinely malformed/unexpected response body (not a rate limit) — treat as
    // "no data for this player" same as before, not worth aborting the whole batch for.
    return { sourceId: null, event: null };
  }
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
  requests: Array<{ reportCode: string; fightId: number; playerName: string }>
): Promise<Array<{ sourceId: number | null; event: any }>> {
  if (requests.length === 0) return [];
  const aliasedFields = requests.map((r, i) => `
    p${i}: report(code: "${r.reportCode}") {
      masterData { actors(type: "Player") { id name } }
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
  if (response.status === 429) {
    const err: any = new Error('WCL rate limit exceeded — the API key has hit its request budget for the current window.');
    err.isRateLimit = true;
    err.retryAfter = response.headers.get('retry-after');
    throw err;
  }
  try {
    const reportData = (await response.json()).data?.reportData ?? {};
    return requests.map((r, i) => {
      const report = reportData[`p${i}`];
      const actors = report?.masterData?.actors || [];
      const events = report?.events?.data || [];
      const targetActor = actors.find((a: any) => a.name.toLowerCase() === r.playerName.toLowerCase());
      const matchedSourceId = targetActor ? targetActor.id : null;
      return { sourceId: matchedSourceId, event: events.find((e: any) => e.sourceID === matchedSourceId) || null };
    });
  } catch {
    // A genuinely malformed/unexpected response body (not a rate limit) — treat the
    // whole batch as "no data" same as the single-player version, not worth aborting
    // the whole crawl for.
    return requests.map(() => ({ sourceId: null, event: null }));
  }
}

// Cached as a unit, keyed by the batch's own player set — so a same-session re-run of
// the same combo (the backfill selection is deterministic given the same cached
// rankings) still gets a full cache hit, exactly like per-player caching did, while a
// cold crawl still only costs one request per batch instead of one per player.
//
// Persisted in Redis (not unstable_cache) specifically because this is the expensive,
// WCL-rate-limited data — it needs to actually survive 24h regardless of how many
// deploys happen in between, not just nominally.
export function fetchTelemetryBatchCached(wclToken: string, players: any[]): Promise<any[]> {
  const requests = players.map(p => ({
    reportCode: p.report?.code as string,
    fightId: p.report?.fightID as number,
    playerName: p.name as string,
  }));
  const cacheKey = requests.map(r => `${r.reportCode}:${r.fightId}`).join(',');
  return getOrSetPersistent(
    `wcl-telemetry-batch-${cacheKey}`,
    86400,
    () => getHistoricalFightTelemetryBatch(wclToken, requests)
  );
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
    const stepSize = Math.max(need, batchSize * concurrency);
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
  layout: Array<{ nodeID: number; grantedRanks?: number; isChoice?: boolean; choiceAEntryId?: number | null; choiceBEntryId?: number | null }>
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
    if (validChoiceIds && !validChoiceIds.has(entryId)) continue;
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
        bestScore = score; talentString = loadout.talent_loadout_code; bestIsActive = isActive;
      }
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
  const wclEntries = buildImportEntries(rawTree, skeletonMap);
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
  'Sporefall': 'Sporefall',
  'VS / DR / MQD': 'Midnight',
};

export const MPLUS_ZONE_ID = 47; // Midnight Season 1
export const MPLUS_DIFFICULTY = 10; // bracket that returns high-key parses

// Splash-image lookups only. Blizzard's journal-instance IDs and WCL's CDN icon IDs
// are separate vendor ID systems with no way to derive them from a live WCL query, so
// this is the one piece of dungeon data that still needs curating by hand each season.
// A dungeon missing an entry here just falls back to a generic look — it never breaks
// the actual talent-build data, which comes from getDungeonRoster below instead.
const DUNGEON_MEDIA_OVERRIDES: Record<string, { wclCdnId?: number; blizzardInstanceId?: number }> = {
  'Windrunner Spire':          { blizzardInstanceId: 1299 },
  'Maisara Caverns':           { wclCdnId: 12874 },
  'Nexus-Point Xenas':         { wclCdnId: 12915 },
  "Algeth'ar Academy":         { blizzardInstanceId: 1201 },
  "Magisters' Terrace":        { wclCdnId: 12811, blizzardInstanceId: 1300 },
  'Pit of Saron':              { wclCdnId: 10658, blizzardInstanceId: 278 },
  'Seat of the Triumvirate':   { blizzardInstanceId: 945 },
  'Skyreach':                  { blizzardInstanceId: 476 },
};

// Discovers the current season's Mythic+ dungeon roster live from WCL instead of a
// hand-maintained ID list — the only thing that needs updating for a new M+ season is
// MPLUS_ZONE_ID above. Falls back to an empty roster (page renders with no dungeons
// listed, not a crash) if the WCL query fails.
export async function getDungeonRoster(token: string): Promise<Array<{ id: number; name: string; wclCdnId?: number; blizzardInstanceId?: number }>> {
  const encounters = await getMplusEncounters(token, MPLUS_ZONE_ID);
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
