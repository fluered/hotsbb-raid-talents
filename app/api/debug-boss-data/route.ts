import { NextRequest } from 'next/server';
import { getWclToken, getRaidStructure, MIDNIGHT_RAIDS } from '../../../lib/wow';

export async function GET(request: NextRequest) {
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

  const wclClass = cls.replace(/\s+/g, '');
  const wclSpec = spec.replace(/\s+/g, '');

  const results = await Promise.all(
    encounters.map(async enc => {
      const query = `
        query {
          worldData {
            encounter(id: ${enc.id}) {
              characterRankings(className: "${wclClass}", specName: "${wclSpec}", difficulty: ${difficulty}, serverRegion: "US")
            }
          }
        }
      `;
      try {
        const res = await fetch('https://www.warcraftlogs.com/api/v2/client', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
          cache: 'no-store',
        });
        const json = await res.json();
        const rankings = json.data?.worldData?.encounter?.characterRankings?.rankings ?? [];
        return { bossId: enc.id, boss: enc.name, zone: enc.zone, us: rankings.length, topDps: rankings[0]?.amount ?? null };
      } catch (e) {
        return { bossId: enc.id, boss: enc.name, zone: enc.zone, us: 'error', topDps: null };
      }
    })
  );

  return Response.json({ class: cls, spec, difficulty, encounters: results });
}
