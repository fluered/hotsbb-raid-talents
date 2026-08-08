import {
  getWclToken, getBlizzardToken, getWclRankingsForRegionMode, fetchTelemetryBatchCached,
  getTalentTreeId, getCachedTalentLayout, playerRegion, getBlizzardTokensForRegions,
  computeConsensus, getActiveHeroTreeId, computeFrequencyPct, getWclPointsSpent,
  mapConcurrent, normalizeTalentTree, type WclImportEntry,
  blizzardCharacterProfileFetch, selectPlayersWithValidTelemetry,
  resolveMetaBuildPick,
} from './wow';
import { getOrSetPersistent, logPointsUsage } from './persistentCache';

// WCL enforces a burst rate limit independent of its overall points budget. Firing
// all of a job's telemetry/profile lookups at once (up to 50+25 requests) reliably
// trips it, so those fan-outs are capped rather than run via unbounded Promise.all.
// Telemetry itself is additionally batched (see fetchTelemetryBatchCached) — this
// concurrency now caps how many WCL-request-sized batches run at once, not how many
// individual players' fetches run at once.
const WCL_FANOUT_CONCURRENCY = 5;

// Talent-only meta build export — mirrors BossContent's phase-1 consensus computation
// (same caching keys, same CONSENSUS_N/DISPLAY_N split) but skips gear/player rendering
// entirely. Used by the /api/meta-build route that the companion addon (and any future
// batch-export script) pulls from.

export interface MetaBuildVariant {
  id: number | null;
  name: string;
  count: number;
  talentString: string | null;
  frequencyPct: Record<number, number>;
  entryIds: Record<number, number>;
  // Built straight from WCL telemetry (no Blizzard character-profile dependency), so
  // it's available even for players/regions where talentString/entryIds can't be
  // (e.g. CN). The addon imports from this directly via C_ClassTalents.ImportLoadout,
  // skipping the string encode/decode round-trip entirely.
  wclEntries: WclImportEntry[] | null;
}

export interface MetaBuildResult {
  className: string;
  spec: string;
  bossId: number;
  difficulty: number;
  region: string;
  sampleSize: number;
  fetchedAt: number;
  variants: MetaBuildVariant[]; // first entry is always {id: null, name: 'Overall'}
}

export type MetaBuildOutcome =
  | { status: 'ok'; data: MetaBuildResult }
  | { status: 'spec_not_found' }
  | { status: 'no_data' }
  | { status: 'insufficient_data'; sampleSize: number };

// Diagnostic wrapper: measures real WCL points cost around a single combo's work
// (points-before vs points-after, via the cheap rateLimitData query) and logs it —
// see logPointsUsage. Temporary instrumentation to get real numbers instead of
// reasoning from indirect signals like pause counts; safe to remove once we have
// enough data from a crawl or two. Both points checks are awaited (not fire-and-
// forget) deliberately: Vercel can freeze/tear down a serverless function immediately
// after it returns a response, so unawaited background work after the real return has
// no guarantee of ever actually running — confirmed live, the first version of this
// logged zero entries despite requests succeeding normally.
export async function getMetaBuild(params: {
  bossId: number;
  className: string;
  spec: string;
  difficulty: number;
  region?: string;
  metric?: string;
}): Promise<MetaBuildOutcome> {
  const comboLabel = `${params.className}/${params.spec} vs ${params.bossId} (${params.difficulty})`;
  let debugBeforeErr: string | null = null;
  const wclToken = await getWclToken();
  const pointsBefore = await getWclPointsSpent(wclToken).catch((e) => { debugBeforeErr = String(e); return null; });

  const result = await getMetaBuildInner(params, wclToken);

  let pointsAfter: number | null = null;
  let delta: number | null = null;
  let debugAfterErr: string | null = null;
  let debugLogErr: string | null = null;
  let debugLogWrote = false;
  if (pointsBefore != null) {
    pointsAfter = await getWclPointsSpent(wclToken).catch((e) => { debugAfterErr = String(e); return null; });
    delta = pointsAfter != null && pointsAfter >= pointsBefore ? pointsAfter - pointsBefore : null;
    try {
      await logPointsUsage({ combo: comboLabel, points: delta, ts: Date.now() });
      debugLogWrote = true;
    } catch (e) {
      debugLogErr = String(e);
    }
  }
  (result as any)._debugPoints = { pointsBefore, pointsAfter, delta, debugBeforeErr, debugAfterErr, debugLogErr, debugLogWrote };
  return result;
}

async function getMetaBuildInner(
  params: {
    bossId: number;
    className: string;
    spec: string;
    difficulty: number;
    region?: string;
    metric?: string;
  },
  wclToken: string
): Promise<MetaBuildOutcome> {
  const { bossId, className, spec, difficulty, region = 'global', metric } = params;

  // Static game data (talent tree layout) is identical across regions — a fixed 'us'
  // token authenticates it regardless of which rankings region mode is selected.
  const staticBlizzardToken = await getBlizzardToken('us');

  const [treeInfo, rankingsResult] = await Promise.all([
    getTalentTreeId(spec, className, staticBlizzardToken),
    getOrSetPersistent(
      `wcl-rankings-v4-${bossId}-${className}-${spec}-${difficulty}-${region}-${metric ?? 'dps'}`,
      86400,
      async () => ({ rankings: await getWclRankingsForRegionMode(wclToken, bossId, className, spec, difficulty, region, metric, true), fetchedAt: Date.now() })
    ),
  ]);
  if (!treeInfo) return { status: 'spec_not_found' };

  const { layout: skeletonMap, heroTreeNames: allHeroTreeNames } = await getCachedTalentLayout(treeInfo.treeId, treeInfo.specId, staticBlizzardToken);
  const rawRankings = rankingsResult.rankings;
  if (rawRankings.length === 0) return { status: 'no_data' };

  const CONSENSUS_N = Math.min(rawRankings.length, 50);
  const DISPLAY_N = Math.min(rawRankings.length, 25);

  // Guarantees the consensus sample actually reaches CONSENSUS_N players whenever the
  // ranking pool is large enough to support it — backfilling past rank 50 for any
  // individual fetch that comes back empty, rather than silently reporting a smaller
  // sample. Mirrors BossContent.tsx's website path exactly, so the two never diverge.
  const consensusSelection = await selectPlayersWithValidTelemetry(
    rawRankings,
    CONSENSUS_N,
    (players: any[]) => fetchTelemetryBatchCached(wclToken, players),
    { batchSize: 10, concurrency: WCL_FANOUT_CONCURRENCY }
  );
  const consensusRankings = consensusSelection.map(s => s.player);
  const allTelemetryData = consensusSelection.map(s => s.telemetry);

  // A Global (or US+EU) pool can span players from several regions, each needing their
  // own region's Blizzard token. Covers the full consensus sample, not just the eagerly-
  // profiled DISPLAY_N slice below, so resolveMetaBuildPick can always fetch on demand
  // for whichever real player actually wins the "closest to consensus" match — even
  // when that's someone outside the eager batch.
  const blizzardTokensByRegion = await getBlizzardTokensForRegions(
    consensusRankings.map((p: any) => playerRegion(p, 'us'))
  );

  const blizzardProfiles = await mapConcurrent(
    consensusRankings.slice(0, DISPLAY_N),
    WCL_FANOUT_CONCURRENCY,
    (player: any) => blizzardCharacterProfileFetch(player, blizzardTokensByRegion, 'specializations', 'spec')
  );

  const pickPool = consensusRankings.map((player: any, idx: number) => ({
    player,
    telemetry: allTelemetryData[idx],
    profileData: blizzardProfiles[idx],
  }));

  const allFightTrees = allTelemetryData.map(t => normalizeTalentTree(t?.event?.talentTree || []));
  const validTrees = allFightTrees.filter(t => t.length > 0);
  if (validTrees.length < 3) return { status: 'insufficient_data', sampleSize: validTrees.length };

  const usedHeroTreeIds = new Set<number>();
  for (const tel of validTrees) {
    const treeId = getActiveHeroTreeId(tel, skeletonMap);
    if (treeId != null) usedHeroTreeIds.add(treeId);
  }
  const heroTreeNames = allHeroTreeNames.filter(ht => usedHeroTreeIds.has(ht.id));

  const consensusMap = computeConsensus(validTrees, 0.5);
  const metaFrequencyPct = computeFrequencyPct(validTrees);

  const overallPick = await resolveMetaBuildPick(pickPool, consensusMap, skeletonMap, treeInfo.specId, blizzardTokensByRegion);
  const variants: MetaBuildVariant[] = [{
    id: null,
    name: 'Overall',
    count: validTrees.length,
    talentString: overallPick?.talentString ?? null,
    frequencyPct: metaFrequencyPct,
    entryIds: overallPick?.entryIds ?? {},
    wclEntries: overallPick?.wclEntries ?? null,
  }];

  const heroGroups = new Map<number, Array<Array<{ nodeID: number; rank: number }>>>();
  for (const tel of validTrees) {
    const treeId = getActiveHeroTreeId(tel, skeletonMap);
    if (treeId != null) {
      if (!heroGroups.has(treeId)) heroGroups.set(treeId, []);
      heroGroups.get(treeId)!.push(tel);
    }
  }

  for (const { id, name } of heroTreeNames) {
    const group = heroGroups.get(id) ?? [];
    if (group.length < 2) continue;
    const htMap = computeConsensus(group, 0.5);
    const htFrequencyPct = computeFrequencyPct(group);
    const pool = pickPool.filter((p) =>
      getActiveHeroTreeId(p.telemetry?.event?.talentTree || [], skeletonMap) === id
    );
    const htPick = await resolveMetaBuildPick(pool, htMap, skeletonMap, treeInfo.specId, blizzardTokensByRegion);
    variants.push({
      id, name, count: pool.length,
      talentString: htPick?.talentString ?? null,
      frequencyPct: htFrequencyPct,
      entryIds: htPick?.entryIds ?? {},
      wclEntries: htPick?.wclEntries ?? null,
    });
  }

  return {
    status: 'ok',
    data: {
      className, spec, bossId, difficulty, region,
      sampleSize: validTrees.length,
      fetchedAt: rankingsResult.fetchedAt,
      variants,
    },
  };
}
