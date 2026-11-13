// Canonical URLs. Every page here varies by search params, and the same build is
// reachable under several spellings: params in either order, the default difficulty
// stated or left out, a region or metric view of the same build, and the M+ builds
// under both /?mode=dungeons and /dungeons. Without a canonical each spelling is a
// separate page to a crawler. These builders emit one spelling per page, in the same
// shape app/sitemap.ts lists, relative so they resolve against metadataBase.
//
// Region and metric are deliberately dropped: they are views of the same build, and
// the global / default-metric page is the one to index.

import { POPULAR_SPECS, MIDNIGHT_RAIDS, getWclToken, getRaidStructure, getDungeonRoster } from './wow';

const q = (pairs: Array<[string, string | number | null | undefined]>) => {
  const parts = pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

// The raid finder. Difficulty is always stated once a class is chosen: the bare URL's
// default difficulty moves with the season, so the explicit form is the stable one.
export function raidCanonical(p: { cls?: string | null; spec?: string | null; difficulty: number; boss?: number | null; bossName?: string | null }): string {
  if (!p.cls) return '/';
  const spec = p.spec || null;
  const boss = spec && p.boss ? p.boss : null;
  return `/${q([['class', p.cls], ['spec', spec], ['difficulty', p.difficulty], ['boss', boss], ['bossName', boss ? p.bossName : null]])}`;
}

// Mythic+ builds, wherever they were reached from: /dungeons is the one home for them.
export function dungeonCanonical(p: { cls?: string | null; spec?: string | null; dungeon?: number | null; dungeonName?: string | null }): string {
  if (!p.cls) return '/dungeons';
  const spec = p.spec || null;
  const dungeon = spec && p.dungeon ? p.dungeon : null;
  return `/dungeons${q([['class', p.cls], ['spec', spec], ['dungeon', dungeon], ['dungeonName', dungeon ? p.dungeonName : null]])}`;
}

// Tier lists render the season's default difficulty at the bare URL (see sitemap.ts),
// so only the other difficulty is stated.
export function tierListCanonical(p: { role: 'dps' | 'tanks' | 'healers'; difficulty: number; defaultDifficulty: number; boss?: number | null; bossName?: string | null }): string {
  const path = p.role === 'dps' ? '/tier-list' : `/tier-list/${p.role}`;
  const boss = p.boss || null;
  return `${path}${q([['difficulty', p.difficulty === p.defaultDifficulty ? null : p.difficulty], ['boss', boss], ['bossName', boss ? p.bossName : null]])}`;
}

// ─── Names for titles ──────────────────────────────────────────────────────────
//
// Titles, canonicals and headings used to echo ?class=, ?spec=, ?bossName= and
// ?dungeonName= straight from the URL, so any text someone put in a link became an
// indexable page title on this domain. These resolve the ids against the real class
// list and the real rosters instead; anything unknown comes back empty and the page
// falls back to its generic title. Roster lookups are held in process memory (see
// memoFor in lib/wow.ts), so this costs nothing on a warm instance.

export function validClassSpec(cls: string | undefined, spec: string | undefined): { cls?: string; spec?: string } {
  const c = POPULAR_SPECS.find(p => p.class === cls);
  if (!c) return {};
  return { cls: c.class, spec: c.specs.find(s => s === spec) };
}

export async function raidBossName(bossId: number | null): Promise<string | null> {
  if (!bossId) return null;
  try {
    const zones = await getRaidStructure(await getWclToken());
    for (const zone of zones) {
      if (!(zone.name in MIDNIGHT_RAIDS)) continue;
      const boss = (zone.encounters ?? []).find(e => e.id === bossId);
      if (boss) return boss.name;
    }
  } catch {
    // WCL unavailable: the page still renders, with its generic title.
  }
  return null;
}

export async function dungeonNameFor(dungeonId: number | null): Promise<string | null> {
  if (!dungeonId) return null;
  try {
    const roster = await getDungeonRoster(await getWclToken());
    return roster.find(d => d.id === dungeonId)?.name ?? null;
  } catch {
    return null;
  }
}
