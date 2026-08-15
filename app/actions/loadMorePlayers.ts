'use server';

import { unstable_cache } from 'next/cache';
import {
  getWclToken, getBlizzardToken, getWclRankingsForRegionMode, getTalentTreeId,
  getHistoricalFightTelemetry, playerRegion, getBlizzardTokensForRegions,
  mapConcurrent, deriveTalentStringAndProfileNodes, blizzardCharacterProfileFetch,
  normalizeTalentTree,
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

  const rawRankings = await unstable_cache(
    async () => getWclRankingsForRegionMode(wclToken, bossId, className, spec, difficulty, region, metric, true),
    [`wcl-rankings-v4-${bossId}-${className}-${spec}-${difficulty}-${region}-${metric}`],
    { revalidate: 86400 }
  )();

  const excludeKeys = new Set(exclude.map(e => `${e.code}:${e.fightId}:${e.name.toLowerCase()}`));
  // Small overscan so a candidate with invalid telemetry (private/deleted log) doesn't
  // shrink the returned page — mirrors the initial render's backfill behavior without
  // an unbounded scan.
  const candidates = (rawRankings as any[])
    .filter((p: any) => !excludeKeys.has(`${p.report?.code}:${p.report?.fightID}:${(p.name ?? '').toLowerCase()}`))
    .slice(0, count + 3);
  if (candidates.length === 0) return { players: [] };

  // Telemetry key includes the player name: the fetched value is the CombatantInfo
  // matched to THAT player's sourceID, so keying by report+fight alone let two
  // same-fight players (common — co-raiders on one kill) share a cache entry and one
  // rendered with the other's talents.
  const telemetries = await mapConcurrent(candidates, WCL_FANOUT_CONCURRENCY, (player: any) =>
    unstable_cache(
      async () => getHistoricalFightTelemetry(wclToken, player.report?.code, player.report?.fightID, player.name, player.server?.name),
      [`wcl-telemetry-${player.report?.code}-${player.report?.fightID}-${(player.name ?? '').toLowerCase()}`],
      { revalidate: 86400 }
    )().catch(() => null)
  );

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

    return { ...player, telemetry, talentString, renderUrl, profileNodes };
  });

  return { players };
}
