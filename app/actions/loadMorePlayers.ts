'use server';

import {
  getWclToken, getBlizzardToken, getRankingsCachedSWR, getTalentTreeId,
  fetchTelemetryBatchCachedUnstable, playerRegion, getBlizzardTokensForRegions,
  mapConcurrent, deriveTalentStringAndProfileNodes, blizzardCharacterProfileFetch,
  normalizeTalentTree, harvestEntryTalentPairs,
} from '../../lib/wow';

const WCL_FANOUT_CONCURRENCY = 5;

// Powers the "Load more players" button on a boss/dungeon page. The initial server
// render only fetches full profile data (talentString + character portrait) for the
// first 5 players — everyone else beyond that only exists as WCL rankings + telemetry
// (already fetched regardless, needed for the consensus computation) until someone
// actually asks to see more.
//
// Selection works by EXCLUSION, not by raw index: the visible list is the
// telemetry-filtered, backfilled selection (see selectPlayersWithValidTelemetry), so
// its positions don't line up with raw ranking indices — slicing rawRankings at
// "number already shown" used to re-serve players the page already displays whenever
// any early candidate had been dropped for invalid telemetry. The client sends the
// identity of every player it's showing; we walk the rankings in order, skip those,
// and telemetry-validate the rest exactly like the initial selection does.
export async function loadMorePlayers(params: {
  bossId: number;
  className: string;
  spec: string;
  difficulty: number;
  region?: string;
  metric?: string;
  exclude: Array<{ code: string; fightId: number; name: string }>;
  count: number;
}) {
  const { bossId, className, spec, difficulty, region, metric, exclude, count } = params;

  const [wclToken, staticBlizzardToken] = await Promise.all([getWclToken(), getBlizzardToken('us')]);
  const treeInfo = await getTalentTreeId(spec, className, staticBlizzardToken);
  if (!treeInfo) return { players: [] };

  // Same shared SWR entry the page itself rendered from — so "Load more" pages
  // through the exact ranking list the visitor is already looking at, and its rows
  // carry the compacted inline talents that let telemetry synthesize below.
  const rawRankings = (await getRankingsCachedSWR(wclToken, bossId, className, spec, difficulty, region ?? 'global', metric)).rankings;

  const excludeKeys = new Set(exclude.map(e => `${e.code}:${e.fightId}:${e.name.toLowerCase()}`));
  // Small overscan so a candidate with invalid telemetry (private/deleted log) doesn't
  // shrink the returned page — mirrors the initial render's backfill behavior without
  // an unbounded scan.
  const candidates = (rawRankings as any[])
    .filter((p: any) => !excludeKeys.has(`${p.report?.code}:${p.report?.fightID}:${(p.name ?? '').toLowerCase()}`))
    .slice(0, count + 3);
  if (candidates.length === 0) return { players: [] };

  // One order-preserving batch call replaces the old per-player fetch fan-out: rows
  // with known inline talents synthesize without any network, and the rest go through
  // the same batched, cached path the page render uses.
  const telemetries = await fetchTelemetryBatchCachedUnstable(wclToken, candidates).catch(() => candidates.map(() => null));

  const keep: Array<{ player: any; telemetry: any }> = [];
  for (let i = 0; i < candidates.length && keep.length < count; i++) {
    const telemetry = telemetries[i];
    if (normalizeTalentTree(telemetry?.event?.talentTree || []).length > 0) {
      keep.push({ player: candidates[i], telemetry });
    }
  }
  if (keep.length === 0) return { players: [] };

  const blizzardTokensByRegion = await getBlizzardTokensForRegions(
    keep.map(({ player }) => playerRegion(player, 'us'))
  );

  const players = await mapConcurrent(keep, WCL_FANOUT_CONCURRENCY, async ({ player, telemetry }) => {
    const [profileData, mediaData] = await Promise.all([
      blizzardCharacterProfileFetch(player, blizzardTokensByRegion, 'specializations', 'spec'),
      blizzardCharacterProfileFetch(player, blizzardTokensByRegion, 'character-media', 'media'),
    ]);

    const { talentString, profileNodes } = deriveTalentStringAndProfileNodes(telemetry, profileData, treeInfo.specId);
    const renderUrl = mediaData?.assets?.find((a: any) => a.key === 'avatar')?.value ?? null;

    // _tp/_tg are server-side cache compaction — never ship them to the client.
    const { _tp, _tg, ...playerClean } = player;
    return { ...playerClean, telemetry, talentString, renderUrl, profileNodes };
  });

  // Same choice-node mechanism as the initial render (see BossContent): learn bridge
  // pairs from these players' profiles, then attach each player's per-node chosen
  // entry (Blizzard-talent space) so their card renders the option they actually took.
  const bridge = await harvestEntryTalentPairs(players);
  for (const p of players as any[]) {
    const ids: Record<number, number> = {};
    for (const row of p.telemetry?.event?.talentTree ?? []) {
      if (row?.nodeID != null && row?.id != null) ids[row.nodeID] = bridge[row.id] ?? row.id;
    }
    p.entryIds = ids;
  }
  return { players };
}
