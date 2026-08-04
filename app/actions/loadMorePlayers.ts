'use server';

import { unstable_cache } from 'next/cache';
import {
  getWclToken, getBlizzardToken, getWclRankingsForRegionMode, getTalentTreeId,
  getHistoricalFightTelemetry, playerRegion, getBlizzardTokensForRegions,
  mapConcurrent, deriveTalentStringAndProfileNodes, blizzardCharacterProfileFetch,
} from '../../lib/wow';

const WCL_FANOUT_CONCURRENCY = 5;

// Powers the "Load more players" button on a boss/dungeon page. The initial server
// render only fetches full profile data (talentString + character portrait) for the
// first 5 players — everyone else beyond that only exists as WCL rankings + telemetry
// (already fetched regardless, needed for the consensus computation) until someone
// actually asks to see more. This fetches exactly one additional batch's worth of the
// two Blizzard calls that were deferred, reusing the exact same cached primitives (and
// the exact same talentString-derivation logic) as the initial render, so there's no
// risk of the two paths drifting apart.
export async function loadMorePlayers(params: {
  bossId: number;
  className: string;
  spec: string;
  difficulty: number;
  region?: string;
  metric?: string;
  startIdx: number;
  count: number;
}) {
  const { bossId, className, spec, difficulty, region, metric, startIdx, count } = params;

  const [wclToken, staticBlizzardToken] = await Promise.all([getWclToken(), getBlizzardToken('us')]);
  const treeInfo = await getTalentTreeId(spec, className, staticBlizzardToken);
  if (!treeInfo) return { players: [] };

  const rawRankings = await unstable_cache(
    async () => getWclRankingsForRegionMode(wclToken, bossId, className, spec, difficulty, region, metric, true),
    [`wcl-rankings-v4-${bossId}-${className}-${spec}-${difficulty}-${region}-${metric}`],
    { revalidate: 86400 }
  )();

  const slice = (rawRankings as any[]).slice(startIdx, startIdx + count);
  if (slice.length === 0) return { players: [] };

  const blizzardTokensByRegion = await getBlizzardTokensForRegions(
    slice.map((p: any) => playerRegion(p, 'us'))
  );

  const players = await mapConcurrent(slice, WCL_FANOUT_CONCURRENCY, async (player: any) => {
    const [telemetryData, profileData, mediaData] = await Promise.all([
      unstable_cache(
        async () => getHistoricalFightTelemetry(wclToken, player.report?.code, player.report?.fightID, player.name),
        [`wcl-telemetry-${player.report?.code}-${player.report?.fightID}`],
        { revalidate: 86400 }
      )(),
      blizzardCharacterProfileFetch(player, blizzardTokensByRegion, 'specializations', 'spec'),
      blizzardCharacterProfileFetch(player, blizzardTokensByRegion, 'character-media', 'media'),
    ]);

    const { talentString, profileNodes } = deriveTalentStringAndProfileNodes(telemetryData, profileData, treeInfo.specId);
    const renderUrl = mediaData?.assets?.find((a: any) => a.key === 'avatar')?.value ?? null;

    return { ...player, telemetry: telemetryData, talentString, renderUrl, profileNodes };
  });

  return { players };
}
