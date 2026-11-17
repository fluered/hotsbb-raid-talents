import { unstable_cache } from 'next/cache';
import { getWclToken, getBlizzardToken, getRaidStructure, getSeasonState, MIDNIGHT_RAIDS, RAID_JOURNAL_ID_FALLBACK, DPS_SPECS, POPULAR_SPECS } from './wow';
import { getBossKnowledge, lookupJournal, normalizeName, readJournal, wardFor, MECHANIC_WORDS, type BossKnowledge, type MechanicType } from './bossMechanics';
import { getPersistentManyReadOnly } from './persistentCache';
import type { WclRankingRow } from './wclTypes';
import type { PoolSummary, RaidMechanicStats } from './analyze';

// Data for the per-boss landing pages (/boss/[slug]). Nothing here is written by hand
// and nothing here asks Warcraft Logs for anything on a page view: every number is
// read from what the rest of the site has already cached.
//
//   - Spec rankings and kill times: the finder's rankings entries in Redis (the same
//     `wcl-rankings-v7-…` entries getRankingsCachedSWR serves the build pages from).
//   - What top raids take: the Log Review's `analyze-raidmech-v1-…` entry, when a
//     review of this boss has built one.
//   - Bloodlust timing: the Log Review's per-spec pools (`analyze-pool-v21-…`), when any
//     exist for this boss.
//   - Mechanics: getBossKnowledge (DBM, BigWigs, the journal), its own Redis caches.
//
// All of it is READ-ONLY: a boss page never builds a pool or a rankings entry. A
// section with nothing cached is left out of the page.

// ─── Roster ───────────────────────────────────────────────────────────────────

export interface RaidBoss {
  id: number;
  name: string;
  slug: string;
  zoneName: string;
  journalId: number | null;
}

export const bossSlug = (name: string) =>
  name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// The current raids' bosses in raid order. Names and slugs come from the roster, so a
// URL can only ever select a boss, never name one.
export async function getRaidBosses(): Promise<RaidBoss[]> {
  const zones = await getRaidStructure(await getWclToken());
  return zones
    .filter(z => z.name in MIDNIGHT_RAIDS)
    .flatMap(z => (z.encounters ?? []).map(e => ({ id: e.id, name: e.name, slug: bossSlug(e.name), zoneName: z.name, journalId: e.journalID ?? null })));
}

export const bossHref = (slug: string, difficulty: number, defaultDifficulty: number) =>
  `/boss/${slug}${difficulty === defaultDifficulty ? '' : `?difficulty=${difficulty}`}`;

// ─── Numbers from the caches ──────────────────────────────────────────────────

export interface BossSpecRank { cls: string; spec: string; avg: number; n: number }

export interface BossKillTimes { kills: number; medianSec: number; p25Sec: number; p75Sec: number }

export interface BossMechRow { name: string; spellId: number; icon: string; share: number; tankShare: number }

export interface BossLust { kills: number; onPull: number; laterMedianSec: number | null; specs: string[] }

export interface BossStats {
  // DPS specs with a cached rankings entry of five parses or more, best first.
  specs: BossSpecRank[];
  specsTotal: number;
  rankingsAt: number | null;      // when the oldest entry used was fetched
  killTimes: BossKillTimes | null;
  mech: { n: number; fetchedAt: number; rows: BossMechRow[] } | null;
  lust: BossLust | null;
}

const TOP_PARSES = 50;
// A Bloodlust inside the first seconds is "on the pull" however the raid counted it in.
const LUST_ON_PULL_SEC = 15;
const MIN_KILLS = 10;

// Keys as their owners write them: getRankingsCachedSWR (lib/wow.ts), getRaidMechanicStats
// and getPoolSummary (lib/analyze.ts). A version bump there empties the matching section
// here until this is bumped too; nothing breaks.
const rankingsKey = (bossId: number, cls: string, spec: string, difficulty: number) => `wcl-rankings-v7-${bossId}-${cls}-${spec}-${difficulty}-global-dps`;
const raidMechKey = (bossId: number, difficulty: number) => `analyze-raidmech-v1-${bossId}-${difficulty}`;
const poolKey = (bossId: number, cls: string, spec: string, difficulty: number) => `analyze-pool-v21-${bossId}-${cls}-${spec}-${difficulty}`;

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

interface StoredRankings { __at?: number; v?: { rankings?: WclRankingRow[]; fetchedAt?: number } }

async function readBossStats(bossId: number, difficulty: number): Promise<BossStats> {
  const allSpecs = POPULAR_SPECS.flatMap(c => c.specs.map(spec => ({ class: c.class, spec })));
  const keys = [
    raidMechKey(bossId, difficulty),
    ...DPS_SPECS.map(s => rankingsKey(bossId, s.class, s.spec, difficulty)),
    ...allSpecs.map(s => poolKey(bossId, s.class, s.spec, difficulty)),
  ];
  const values = await getPersistentManyReadOnly(keys);
  // Redis unreachable: thrown so the wrapper below does not keep an empty page for an hour.
  if (!values) throw new Error('boss page: cache unavailable');
  const mechRaw = values[0] as RaidMechanicStats | null;
  const rankingValues = values.slice(1, 1 + DPS_SPECS.length) as Array<StoredRankings | null>;
  const poolValues = values.slice(1 + DPS_SPECS.length) as Array<PoolSummary | null>;

  // Spec rankings: the tier list's own measure (average of the top 50 parses, five or
  // more needed), and the length of the kills those parses came from.
  const specs: BossSpecRank[] = [];
  const killMs = new Map<string, number>();
  let rankingsAt: number | null = null;
  rankingValues.forEach((entry, i) => {
    const rows = entry?.v?.rankings;
    if (!Array.isArray(rows)) return;
    const top = rows.slice().sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, TOP_PARSES);
    for (const r of top) {
      if (r.report?.code && r.report.fightID && r.duration && r.duration > 0) killMs.set(`${r.report.code}-${r.report.fightID}`, r.duration);
    }
    if (top.length < 5) return;
    const avg = Math.round(mean(top.map(r => r.amount ?? 0)));
    if (avg <= 0) return;
    specs.push({ cls: DPS_SPECS[i].class, spec: DPS_SPECS[i].spec, avg, n: top.length });
    const at = entry?.__at ?? entry?.v?.fetchedAt ?? null;
    if (at && (rankingsAt == null || at < rankingsAt)) rankingsAt = at;
  });
  specs.sort((a, b) => b.avg - a.avg);

  const durations = [...killMs.values()].map(ms => ms / 1000).sort((a, b) => a - b);
  const killTimes: BossKillTimes | null = durations.length >= MIN_KILLS
    ? { kills: durations.length, medianSec: quantile(durations, 0.5), p25Sec: quantile(durations, 0.25), p75Sec: quantile(durations, 0.75) }
    : null;

  // Share of the raid hit by each ability, averaged over the sampled kills. Auto-attacks
  // say nothing about the fight.
  const mechRows: BossMechRow[] = mechRaw && mechRaw.n > 0
    ? Object.entries(mechRaw.abilities ?? {})
      .filter(([name, a]) => name !== 'Melee' && a.spellId > 1 && a.share.length > 0)
      .map(([name, a]) => ({ name, spellId: a.spellId, icon: a.icon, share: mean(a.share), tankShare: mean(a.tankShare) }))
      .sort((a, b) => b.share - a.share)
    : [];

  // Bloodlust: one reading per kill. Several pool members can come from the same kill
  // (and several specs' pools share kills), so readings are keyed by the fight.
  const lustByKill = new Map<string, number>();
  const lustSpecs: string[] = [];
  poolValues.forEach((pool, i) => {
    if (!pool || !Array.isArray(pool.lustSec)) return;
    const aligned = pool.fights?.length === pool.lustSec.length;
    let used = 0;
    pool.lustSec.forEach((sec, j) => {
      if (sec == null || pool.memberDifficulty?.[j] !== difficulty) return;
      const f = aligned ? pool.fights[j] : null;
      lustByKill.set(f ? `${f.code}-${f.fightId}` : `${i}-${j}`, sec);
      used++;
    });
    if (used) lustSpecs.push(`${allSpecs[i].spec} ${allSpecs[i].class}`);
  });
  const lustTimes = [...lustByKill.values()];
  const later = lustTimes.filter(s => s > LUST_ON_PULL_SEC).sort((a, b) => a - b);
  const lust: BossLust | null = lustTimes.length >= MIN_KILLS
    ? { kills: lustTimes.length, onPull: lustTimes.length - later.length, laterMedianSec: later.length ? quantile(later, 0.5) : null, specs: lustSpecs }
    : null;

  return {
    specs,
    specsTotal: DPS_SPECS.length,
    rankingsAt,
    killTimes,
    mech: mechRows.length && mechRaw ? { n: mechRaw.n, fetchedAt: mechRaw.fetchedAt, rows: mechRows } : null,
    lust,
  };
}

// One MGET and some arithmetic, kept an hour in the data cache so a warm view does not
// pull the rankings entries (about 0.7 MB for a boss) out of Redis again.
export async function getBossStats(bossId: number, difficulty: number): Promise<BossStats | null> {
  try {
    return await unstable_cache(() => readBossStats(bossId, difficulty), [`boss-page-stats-v1-${bossId}-${difficulty}`], { revalidate: 3600 })();
  } catch (err) {
    console.error('boss page: stats unavailable', err);
    return null;
  }
}

// ─── Mechanics at a glance ────────────────────────────────────────────────────

// `reading`: what the site takes the ability to be, for the ones no addon types — read
// from the journal's wording, shown so a wrong reading can be seen and reported.
export interface BossMechanic { name: string; spellId: number; alt: string | null; description: string; reading?: string | null }
export interface BossMechanicGroup { type: MechanicType; items: BossMechanic[] }
export interface BossFailureNote { name: string; spellId: number; note: string; mythicOnly: boolean }

export interface BossMechanics {
  overview: string | null;
  groups: BossMechanicGroup[];
  // Abilities the journal lists that no addon label covers.
  other: BossMechanic[];
  // BigWigs' own sentences on the debuffs that mark a failed mechanic.
  failures: BossFailureNote[];
  // Every ability name the journal or an addon lists for this boss, normalised: what
  // tells a boss ability in a damage table from a player's own trinket or spell.
  abilityNames: string[];
  sources: { dbm: boolean; journal: boolean; bigwigs: boolean };
}

// The order a raider reads them in: what to do with your feet first.
export const MECHANIC_ORDER: MechanicType[] = ['avoid', 'soak', 'spread', 'gather', 'interrupt', 'dispel', 'add', 'fixate', 'targeted', 'debuff', 'tank', 'defensive', 'raidwide'];

const DESCRIPTION_MAX = 230;
function shorten(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= DESCRIPTION_MAX) return t;
  const cutAt = t.lastIndexOf(' ', DESCRIPTION_MAX - 1);
  return `${t.slice(0, cutAt > 120 ? cutAt : DESCRIPTION_MAX - 1).replace(/[,;:.]$/, '')}…`;
}

// What every source says about a boss, for the mechanics audit (app/api/debug-mechanics).
export async function getBossSources(boss: RaidBoss, difficulty: number): Promise<{ knowledge: BossKnowledge; raidStats: RaidMechanicStats | null }> {
  const [season, blizzToken] = await Promise.all([getSeasonState(), getBlizzardToken()]);
  const journalId = boss.journalId || RAID_JOURNAL_ID_FALLBACK[boss.id] || null;
  const [knowledge, values] = await Promise.all([
    getBossKnowledge({ expansionName: season.expansionName, zoneName: boss.zoneName, bossName: boss.name, blizzToken, encounterId: boss.id, journalId }),
    getPersistentManyReadOnly([raidMechKey(boss.id, difficulty)]),
  ]);
  return { knowledge, raidStats: (values?.[0] as RaidMechanicStats | null) ?? null };
}

async function readBossMechanics(boss: RaidBoss): Promise<BossMechanics> {
  const [season, blizzToken] = await Promise.all([getSeasonState(), getBlizzardToken()]);
  // Warcraft Logs reports journal id 0 for this whole raid, and finding the encounter by
  // name comes back empty for some bosses (Nymrissa Wavecaller, Kith'ix), so the id table
  // the addon export uses fills in. The Log Review's loadBossKnowledge passes the 0 as it
  // is and therefore reads a different (name-matched) journal entry.
  const journalId = boss.journalId || RAID_JOURNAL_ID_FALLBACK[boss.id] || null;
  const k = await getBossKnowledge({ expansionName: season.expansionName, zoneName: boss.zoneName, bossName: boss.name, blizzToken, encounterId: boss.id, journalId });
  // Every source failed (each fails quietly inside getBossKnowledge): thrown, so the
  // wrapper below retries on the next view instead of keeping an empty list.
  if (!k.sources.dbm && !k.sources.journal && !k.sources.bigwigs) throw new Error('boss page: no mechanic sources');
  const bossKey = normalizeName(boss.name);

  const byType = new Map<MechanicType, BossMechanic[]>();
  const seen = new Set<string>();
  for (const l of k.labels) {
    // The raid's labels come as one list; only this boss's own module, and only the
    // abilities DBM both names and types.
    if (normalizeName(l.boss) !== bossKey || !l.name || l.type === 'unknown') continue;
    const key = normalizeName(l.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const item: BossMechanic = { name: l.name, spellId: l.spellId, alt: l.alt ?? null, description: shorten(lookupJournal(k, l.name, l.spellId)?.description ?? '') };
    byType.set(l.type, [...(byType.get(l.type) ?? []), item]);
  }
  const groups = MECHANIC_ORDER.filter(t => byType.has(t)).map(type => ({ type, items: byType.get(type)! }));

  // The journal's own list for whatever DBM has no warning for. k.journal also carries
  // other bosses' DBM abilities, which is why this is cut to entries with journal text
  // that are not another module's label.
  const foreign = new Set(k.labels.filter(l => normalizeName(l.boss) !== bossKey && l.name).map(l => normalizeName(l.name)));
  const other = k.sources.journal
    ? k.journal
      .filter(j => j.name && j.description && !seen.has(normalizeName(j.name)) && !foreign.has(normalizeName(j.name)))
      .map(j => {
        const ward = wardFor(k, j.name, j.spellId);
        const read = readJournal(k, j.name, j.spellId);
        const reading = ward ? `answered by ${ward.name}${ward.pct ? ` (${ward.pct}% off)` : ''}, not a defensive` : read ? MECHANIC_WORDS[read.type] : null;
        return { name: j.name, spellId: j.spellId, alt: null, description: shorten(j.description), reading };
      })
    : [];

  const failures = k.notes
    .filter(n => n.source === 'BigWigs' && n.name && /debuff will apply|if you|if your|fail/i.test(n.note))
    .map(n => ({ name: n.name.replace(/[,\s]+$/, ''), spellId: n.spellId, note: n.note, mythicOnly: n.mythicOnly }));

  const abilityNames = [...new Set([
    ...(k.sources.journal ? k.journal.filter(j => j.name && !foreign.has(normalizeName(j.name))).map(j => normalizeName(j.name)) : []),
    ...seen,
    ...k.notes.filter(n => n.source === 'BigWigs' && n.name).map(n => normalizeName(n.name)),
  ])];

  return { overview: k.overview, groups, other, failures, abilityNames, sources: { dbm: groups.length > 0, journal: k.sources.journal, bigwigs: failures.length > 0 } };
}

// getBossKnowledge is three Redis reads of raid-sized entries; the page needs a few
// kilobytes of them. Kept six hours in the data cache. A failure is not cached.
export async function getBossMechanics(boss: RaidBoss): Promise<BossMechanics | null> {
  try {
    return await unstable_cache(() => readBossMechanics(boss), [`boss-page-mechanics-v3-${boss.id}`], { revalidate: 6 * 3600 })();
  } catch (err) {
    console.error('boss page: mechanics unavailable', err);
    return null;
  }
}
