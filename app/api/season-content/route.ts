import { NextRequest, NextResponse } from 'next/server';
import { getWclToken, getDungeonRoster, getRaidStructure, MIDNIGHT_RAIDS } from '../../../lib/wow';
import { isAuthorizedInternalCaller } from '../../../lib/internalAuth';

export const dynamic = 'force-dynamic';

// Single source of truth for "what content is in the current season" — the same live
// WCL zone queries the website's own pages already use (getDungeonRoster, getRaidStructure
// filtered by MIDNIGHT_RAIDS), exposed as one small endpoint so the batch export script
// can build its combo list dynamically instead of hardcoding encounter IDs that go stale
// the moment a new season's dungeon/raid pool rotates in. A new season only ever needs
// MPLUS_ZONE_ID and MIDNIGHT_RAIDS (both in lib/wow.ts) updated to the new zone
// id/name(s) — everything downstream, including this route and the export script,
// picks it up automatically.
export async function GET(request: NextRequest) {
  if (!isAuthorizedInternalCaller(request)) {
    return NextResponse.json({ status: 'error', message: 'Not found' }, { status: 404 });
  }

  try {
    const token = await getWclToken();
    const [dungeons, zones] = await Promise.all([
      getDungeonRoster(token),
      getRaidStructure(token),
    ]);

    const raidBosses = zones
      .filter((z: any) => z.name in MIDNIGHT_RAIDS)
      .flatMap((z: any) =>
        (z.encounters ?? []).map((enc: any) => ({ id: enc.id, name: enc.name, zone: z.name }))
      );

    return NextResponse.json(
      {
        status: 'ok',
        dungeons: dungeons.map(d => ({ id: d.id, name: d.name })),
        raidBosses,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400' } }
    );
  } catch (e: any) {
    if (e?.isRateLimit) {
      return NextResponse.json(
        { status: 'rate_limited', message: e.message, retryAfter: e.retryAfter ?? null },
        { status: 429 }
      );
    }
    return NextResponse.json({ status: 'error', message: e?.message ?? String(e) }, { status: 500 });
  }
}
