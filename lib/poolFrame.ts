import type { FightPhase, PoolSummary } from './analyze';

// ─── Like for like: putting the top-player pool in this pull's frame ────────────
//
// Two adjustments made to the pool before any rule reads it, both so a difference
// the rules report is a difference in play and not in circumstances:
//
// 1. Same hero talents. Hero trees change which buttons exist and when they are
//    pressed; a player is compared with the top players on their own tree when there
//    are enough of them.
// 2. Phase by phase. The top logs are faster kills, so by the clock everything after
//    the first phase happens "earlier" for them. Each top player's press is restated
//    as "this far into phase N" and placed that far into phase N of THIS pull.
//
// Pure functions over PoolSummary: every per-member array is indexed by member.

const pickAt = <T>(xs: T[] | undefined, idx: number[], empty: T): T[] => idx.map(i => xs?.[i] ?? empty);

// The pool restricted to some of its members (by index). Names nobody in the subset
// has are dropped, so "does any top player press this" keeps meaning the subset.
export function subsetPool(pool: PoolSummary, idx: number[], heroTree?: number | null): PoolSummary {
  const some = (xs: number[]) => xs.some(x => x > 0);
  const casts: PoolSummary['casts'] = {};
  for (const [name, e] of Object.entries(pool.casts)) {
    const cpm = pickAt(e.cpm, idx, 0);
    if (some(cpm)) casts[name] = { ...e, cpm };
  }
  const castStarts: PoolSummary['castStarts'] = {};
  for (const [name, starts] of Object.entries(pool.castStarts)) {
    const s = idx.map(i => starts[i] ?? []);
    if (s.some(x => x.length)) castStarts[name] = s;
  }
  const buffs: PoolSummary['buffs'] = {};
  for (const [name, e] of Object.entries(pool.buffs)) {
    const uptimePct = pickAt(e.uptimePct, idx, 0);
    if (some(uptimePct)) buffs[name] = { ...e, uptimePct, atPull: pickAt(e.atPull, idx, 0), starts: idx.map(i => e.starts[i] ?? []), ...(e.usesPerMin ? { usesPerMin: pickAt(e.usesPerMin, idx, 0) } : {}) };
  }
  const taken: PoolSummary['taken'] = {};
  for (const [name, e] of Object.entries(pool.taken)) taken[name] = { ...e, perMin: pickAt(e.perMin, idx, 0), hitsPerMin: pickAt(e.hitsPerMin, idx, 0) };
  const debuffs: PoolSummary['debuffs'] = {};
  for (const [name, e] of Object.entries(pool.debuffs)) debuffs[name] = { ...e, perMin: pickAt(e.perMin, idx, 0) };
  const hero = heroTree ? pool.heroTalents?.[String(heroTree)] : undefined;
  return {
    ...pool,
    n: idx.length,
    durations: pickAt(pool.durations, idx, 0),
    output: pickAt(pool.output, idx, 0),
    activePct: pickAt(pool.activePct, idx, 0),
    ...(pool.overhealPct ? { overhealPct: pickAt(pool.overhealPct, idx, 0) } : {}),
    memberDifficulty: pickAt(pool.memberDifficulty, idx, pool.difficulty),
    lustSec: idx.map(i => pool.lustSec[i] ?? null),
    memberPhases: pool.memberPhases ? idx.map(i => pool.memberPhases![i] ?? []) : undefined,
    memberHeroTree: pool.memberHeroTree ? pickAt(pool.memberHeroTree, idx, 0) : undefined,
    ...(hero ? { talentN: hero.talentN, talentNodeCount: hero.talentNodeCount, talentEntryCount: hero.talentEntryCount } : {}),
    casts, castStarts, buffs, taken, debuffs,
  };
}

// The members on one hero tree, when there are enough of them to stand as a pool of
// their own and they are not simply everyone. null: compare with the whole pool.
const HERO_MIN_MEMBERS = 8;
export function sameHeroMembers(pool: PoolSummary, heroTree: number | null | undefined): number[] | null {
  if (!heroTree || !pool.memberHeroTree) return null;
  const idx = pool.memberHeroTree.map((h, i) => (h === heroTree ? i : -1)).filter(i => i >= 0);
  return idx.length >= HERO_MIN_MEMBERS && idx.length < pool.n ? idx : null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

// One top player's clock → this pull's clock. Phases are matched in order for as long
// as both pulls go through the same ones; a time in a phase this pull never reached,
// or further into a phase than this pull stayed in it, has no counterpart (null).
function makeWarp(theirs: FightPhase[], mine: FightPhase[]): ((t: number) => number | null) | null {
  let shared = 0;
  while (shared < theirs.length && shared < mine.length && theirs[shared].id === mine[shared].id) shared++;
  if (shared === 0) return null;
  return (t: number) => {
    let p = 0;
    while (p + 1 < theirs.length && theirs[p + 1].atSec <= t) p++;
    if (p >= shared) return null;
    const at = mine[p].atSec + (t - theirs[p].atSec);
    const end = p + 1 < mine.length ? mine[p + 1].atSec : Infinity;
    return at < end ? r1(at) : null;
  };
}

// Every top player's cooldown presses, buff windows and Bloodlust restated on this
// pull's phases. `aligned` is false (and the pool is returned untouched) for a
// single-phase boss, or when most of the pool carries no phase marks.
export function alignPoolToPhases(pool: PoolSummary, mine: FightPhase[] | undefined): { pool: PoolSummary; aligned: boolean } {
  const theirs = pool.memberPhases;
  if (!theirs || !mine || mine.length < 2) return { pool, aligned: false };
  const warps = theirs.map(tp => (tp.length >= 2 ? makeWarp(tp, mine) : null));
  if (warps.filter(Boolean).length < pool.n * 0.6) return { pool, aligned: false };
  const move = (times: number[], i: number) => {
    const w = warps[i];
    if (!w) return times;
    return times.map(w).filter((x): x is number => x != null).sort((a, b) => a - b);
  };
  const castStarts: PoolSummary['castStarts'] = {};
  for (const [name, starts] of Object.entries(pool.castStarts)) castStarts[name] = starts.map(move);
  const buffs: PoolSummary['buffs'] = {};
  for (const [name, e] of Object.entries(pool.buffs)) buffs[name] = { ...e, starts: e.starts.map(move) };
  const lustSec = pool.lustSec.map((t, i) => (t == null ? null : warps[i] ? warps[i]!(t) : t));
  return { pool: { ...pool, castStarts, buffs, lustSec }, aligned: true };
}
