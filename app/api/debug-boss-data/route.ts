import { NextRequest } from 'next/server';
import { getWclToken, getRaidStructure, getWclRankings, MIDNIGHT_RAIDS } from '../../../lib/wow';
import { isAuthorizedInternalCaller } from '../../../lib/internalAuth';

export async function GET(request: NextRequest) {
  // Debug-only route, but it fires one uncached WCL rankings query PER ENCOUNTER per
  // hit — exactly the quota-burning pattern the meta-build route had to be gated
  // against after a crawler drained the WCL budget. Same gate applies here.
  if (!isAuthorizedInternalCaller(request)) {
    return Response.json({ status: 'forbidden' }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const cls = searchParams.get('class') ?? 'Hunter';
  const spec = searchParams.get('spec') ?? 'Beast Mastery';
  const difficulty = parseInt(searchParams.get('difficulty') ?? '5');

  const token = await getWclToken();
  const zones = await getRaidStructure(token);

  const encounters: Array<{ id: number; name: string; zone: string }> = zones
    .filter((z: any) => z.name in MIDNIGHT_RAIDS)
    .flatMap((z: any) =>
      (z.encounters ?? []).map((enc: any) => ({ id: enc.id, name: enc.name, zone: z.name }))
    );

  // Through getWclRankings rather than a raw fetch so these queries respect the shared
  // WCL request pacing queue like every other call site.
  const results = await Promise.all(
    encounters.map(async enc => {
      try {
        const rankings: any[] = await getWclRankings(token, enc.id, cls, spec, difficulty, 'us', undefined, true);
        return { bossId: enc.id, boss: enc.name, zone: enc.zone, us: rankings.length, topDps: rankings[0]?.amount ?? null };
      } catch (e) {
        return { bossId: enc.id, boss: enc.name, zone: enc.zone, us: 'error', topDps: null };
      }
    })
  );

  return Response.json({ class: cls, spec, difficulty, encounters: results });
}
