import { unstable_cache } from 'next/cache';
import { scorePlayerTree } from '../app/BossContent';
import {
  getWclToken, getBlizzardToken, getWclRankings, getHistoricalFightTelemetry,
  getTalentTreeId, getCachedTalentLayout,
  computeConsensus, getActiveHeroTreeId, makeTelemetry, computeFrequencyPct,
} from './wow';

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
  const { bossId, className, spec, difficulty, region = 'us', metric } = params;

  const [wclToken, blizzardToken] = await Promise.all([getWclToken(), getBlizzardToken(region)]);

  const [treeInfo, rankingsResult] = await Promise.all([
    getTalentTreeId(spec, className, blizzardToken),
    unstable_cache(
      async () => ({ rankings: await getWclRankings(wclToken, bossId, className, spec, difficulty, region, metric, true), fetchedAt: Date.now() }),
      [`wcl-rankings-${bossId}-${className}-${spec}-${difficulty}-${region}-${metric ?? 'dps'}`],
      { revalidate: 21600 }
    )(),
  ]);
  if (!treeInfo) return { status: 'spec_not_found' };

  const { layout: skeletonMap, heroTreeNames: allHeroTreeNames } = await getCachedTalentLayout(treeInfo.treeId, treeInfo.specId, blizzardToken);
  const rawRankings = rankingsResult.rankings;
  if (rawRankings.length === 0) return { status: 'no_data' };

  const CONSENSUS_N = Math.min(rawRankings.length, 50);
  const DISPLAY_N = Math.min(rawRankings.length, 25);

  const allTelemetryData = await Promise.all(
    rawRankings.slice(0, CONSENSUS_N).map((player: any) =>
      unstable_cache(
        async () => getHistoricalFightTelemetry(wclToken, player.report?.code, player.report?.fightID, player.name),
        [`wcl-telemetry-${player.report?.code}-${player.report?.fightID}`],
        { revalidate: 21600 }
      )()
    )
  );
  const blizzardProfiles = await Promise.all(
    rawRankings.slice(0, DISPLAY_N).map(async (player: any) => {
      const realm = (player.server?.slug ?? player.server?.name ?? '').toLowerCase().replace(/\s+/g, '-').replace(/'/g, '');
      const name = player.name.toLowerCase();
      return unstable_cache(
        async () => {
          try {
            const r = await fetch(
              `https://${region}.api.blizzard.com/profile/wow/character/${realm}/${name}/specializations?namespace=profile-${region}&locale=en_US`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` } }
            );
            return r.ok ? r.json() : null;
          } catch { return null; }
        },
        [`blizzard-spec-${region}-${realm}-${name}`],
        { revalidate: 21600 }
      )();
    })
  );

  const detailedRankingsBase = rawRankings.slice(0, CONSENSUS_N).map((player: any, idx: number) => {
    const telemetryData = allTelemetryData[idx];
    const profileData = blizzardProfiles[idx];
    const fightTalents: Array<{ nodeID: number; rank: number }> = telemetryData?.event?.talentTree || [];
    const fightMap = new Map<number, number>();
    for (const t of fightTalents as any[]) {
      fightMap.set(t.nodeID, Math.max(fightMap.get(t.nodeID) ?? 0, t.rank));
    }

    const fightSpec = profileData?.specializations?.find(
      (sp: any) => sp.specialization?.id === treeInfo.specId
    );

    let talentString: string | null = null;
    if (fightSpec) {
      const activeLoadout = (fightSpec.loadouts ?? []).find(
        (l: any) => l.is_active && l.talent_loadout_code
      );
      if (activeLoadout) {
        talentString = activeLoadout.talent_loadout_code;
      } else {
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
    }
    const selectedLoadout = fightSpec?.loadouts?.find((l: any) => l.talent_loadout_code === talentString) ?? null;
    const profileNodes: any[] = selectedLoadout ? [
      ...(selectedLoadout.selected_class_talents ?? []),
      ...(selectedLoadout.selected_spec_talents ?? []),
      ...(selectedLoadout.selected_hero_talents ?? []),
    ] : [];

    return { ...player, telemetry: telemetryData, talentString, profileNodes };
  });

  const allFightTrees = allTelemetryData.map(t => (t?.event?.talentTree || []) as Array<{ nodeID: number; rank: number }>);
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

  const metaTalentString = pickTalentString(detailedRankingsBase, consensusMap);
  const variants: MetaBuildVariant[] = [{
    id: null,
    name: 'Overall',
    count: validTrees.length,
    talentString: metaTalentString,
    frequencyPct: metaFrequencyPct,
    entryIds: entryIdsFor(metaTalentString, detailedRankingsBase),
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
