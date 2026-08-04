import { unstable_cache } from 'next/cache';
import { scorePlayerTree } from '../app/BossContent';
import {
  getWclToken, getBlizzardToken, getWclRankingsForRegionMode, getHistoricalFightTelemetry,
  getTalentTreeId, getCachedTalentLayout, playerRegion, getBlizzardTokensForRegions,
  computeConsensus, getActiveHeroTreeId, makeTelemetry, computeFrequencyPct,
  mapConcurrent, normalizeTalentTree, buildImportEntries, type WclImportEntry,
  deriveTalentStringAndProfileNodes, blizzardCharacterProfileFetch, selectPlayersWithValidTelemetry,
} from './wow';

// WCL enforces a burst rate limit independent of its overall points budget. Firing
// all of a job's telemetry/profile lookups at once (up to 50+25 requests) reliably
// trips it, so those fan-outs are capped rather than run via unbounded Promise.all.
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

export async function getMetaBuild(params: {
  bossId: number;
  className: string;
  spec: string;
  difficulty: number;
  region?: string;
  metric?: string;
}): Promise<MetaBuildOutcome> {
  const { bossId, className, spec, difficulty, region = 'global', metric } = params;

  // Static game data (talent tree layout) is identical across regions — a fixed 'us'
  // token authenticates it regardless of which rankings region mode is selected.
  const [wclToken, staticBlizzardToken] = await Promise.all([getWclToken(), getBlizzardToken('us')]);

  const [treeInfo, rankingsResult] = await Promise.all([
    getTalentTreeId(spec, className, staticBlizzardToken),
    unstable_cache(
      async () => ({ rankings: await getWclRankingsForRegionMode(wclToken, bossId, className, spec, difficulty, region, metric, true), fetchedAt: Date.now() }),
      [`wcl-rankings-v4-${bossId}-${className}-${spec}-${difficulty}-${region}-${metric ?? 'dps'}`],
      { revalidate: 86400 }
    )(),
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
    (player: any) =>
      unstable_cache(
        async () => getHistoricalFightTelemetry(wclToken, player.report?.code, player.report?.fightID, player.name),
        [`wcl-telemetry-${player.report?.code}-${player.report?.fightID}`],
        { revalidate: 86400 }
      )(),
    WCL_FANOUT_CONCURRENCY
  );
  const consensusRankings = consensusSelection.map(s => s.player);
  const allTelemetryData = consensusSelection.map(s => s.telemetry);

  // A Global (or US+EU) pool can span players from several regions, each needing their
  // own region's Blizzard token — DISPLAY_N covers every profile fetch below (this is
  // the only one talent-only meta builds need; no equip/stats/media here).
  const blizzardTokensByRegion = await getBlizzardTokensForRegions(
    consensusRankings.slice(0, DISPLAY_N).map((p: any) => playerRegion(p, 'us'))
  );

  const blizzardProfiles = await mapConcurrent(
    consensusRankings.slice(0, DISPLAY_N),
    WCL_FANOUT_CONCURRENCY,
    (player: any) => blizzardCharacterProfileFetch(player, blizzardTokensByRegion, 'specializations', 'spec')
  );

  const detailedRankingsBase = consensusRankings.map((player: any, idx: number) => {
    const telemetryData = allTelemetryData[idx];
    const profileData = blizzardProfiles[idx];
    const { talentString, profileNodes } = deriveTalentStringAndProfileNodes(telemetryData, profileData, treeInfo.specId);
    return { ...player, telemetry: telemetryData, talentString, profileNodes };
  });

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

  function pickTalentString(pool: any[], cMap: Map<number, number>): string | null {
    let bestScore = -1;
    for (const player of pool) {
      if (!player.talentString) continue;
      const score = scorePlayerTree(player.telemetry?.event?.talentTree || [], cMap);
      if (score > bestScore) bestScore = score;
    }
    const freq = new Map<string, number>();
    for (const player of pool) {
      if (!player.talentString) continue;
      if (scorePlayerTree(player.telemetry?.event?.talentTree || [], cMap) === bestScore) {
        freq.set(player.talentString, (freq.get(player.talentString) ?? 0) + 1);
      }
    }
    let best: string | null = null;
    for (const [str, count] of freq) {
      if (count > (freq.get(best ?? '') ?? 0)) best = str;
    }
    return best;
  }

  function entryIdsFor(talentString: string | null, pool: any[]): Record<number, number> {
    const metaPlayer = pool.find((p: any) => p.talentString === talentString && p.profileNodes?.length > 0);
    const entryIds: Record<number, number> = {};
    for (const node of metaPlayer?.profileNodes ?? []) {
      const entryId = node.tooltip?.talent?.id;
      if (entryId != null) entryIds[node.id] = entryId;
    }
    return entryIds;
  }

  // Same "closest-matching real player" approach as pickTalentString, but scored
  // against every player's raw WCL telemetry directly rather than requiring a
  // Blizzard-profile-derived talentString — so it still works for players whose
  // profile isn't fetchable (private, or a region Blizzard's API doesn't cover, e.g.
  // CN). Builds entries straight from that player's telemetry once picked.
  function pickWclEntries(pool: any[], cMap: Map<number, number>): WclImportEntry[] | null {
    let bestScore = -1;
    let bestPlayer: any = null;
    for (const player of pool) {
      const raw = player.telemetry?.event?.talentTree;
      if (!raw?.length) continue;
      const score = scorePlayerTree(raw, cMap);
      if (score > bestScore) { bestScore = score; bestPlayer = player; }
    }
    if (!bestPlayer) return null;
    const entries = buildImportEntries(bestPlayer.telemetry.event.talentTree, skeletonMap);
    return entries.length > 0 ? entries : null;
  }

  const metaTalentString = pickTalentString(detailedRankingsBase, consensusMap);
  const variants: MetaBuildVariant[] = [{
    id: null,
    name: 'Overall',
    count: validTrees.length,
    talentString: metaTalentString,
    frequencyPct: metaFrequencyPct,
    entryIds: entryIdsFor(metaTalentString, detailedRankingsBase),
    wclEntries: pickWclEntries(detailedRankingsBase, consensusMap),
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
    const pool = detailedRankingsBase.filter((p: any) =>
      getActiveHeroTreeId(p.telemetry?.event?.talentTree || [], skeletonMap) === id
    );
    const htTalentString = pickTalentString(pool, htMap);
    variants.push({
      id, name, count: pool.length,
      talentString: htTalentString,
      frequencyPct: htFrequencyPct,
      entryIds: entryIdsFor(htTalentString, pool),
      wclEntries: pickWclEntries(pool, htMap),
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
