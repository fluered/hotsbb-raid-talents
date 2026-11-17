import { DIFFICULTY_LABELS, type Role } from './analyze';
import { fmtClock, median, plural } from './analyzeRules';
import { countWord, timesWord } from './summary';
import type { NightReview } from './nightReview';

// ─── One player's night: every pull of one boss, seen from one character ───────
//
// A pure reading of the night review the page has already built (lib/nightReview.ts):
// its per-pull detail carries every death, avoidable hit and healthstone, so this view
// costs no Warcraft Logs request of its own. The rules are the night's rules: deaths
// "before the wipe", hits up to the wipe, major and minor defensives.

// Fewer pulls than this is not a rate: a player who stood in for two pulls is shown
// their pulls but compared with nobody, and is left out of the median.
const MIN_PULLS_FOR_RATE = 3;
// "Above the median player" is said only when the gap is half again and at least two
// events: one death either way over a night is chance.
const RATIO_WORTH_SAYING = 1.5;
const MIN_GAP_EVENTS = 2;
// "Before your next pull": a pattern is something that happened to this player on
// several pulls. Two deaths to one ability with the same button unused is already a
// habit for one player (the raid's block asks for three across everyone); a mechanic
// counts from three pulls and a third of the pulls they were in, as on the raid's page.
const STEP_MIN_DEATHS = 2;
const STEP_MIN_HIT_PULLS = 3;
const STEP_MIN_HIT_SHARE = 1 / 3;
const STEP_MAX = 3;
// A pull with only hits against a pull with a death: the night's own four to one.
const STEP_HIT_WEIGHT = 0.25;

export const playerNightHref = (code: string, g: { encounterID: number; difficulty: number }, playerId: number) =>
  `/analyze?report=${code}&view=night&boss=${g.encounterID}&difficulty=${g.difficulty}&player=${playerId}`;

export interface PlayerNightPull {
  fightId: number;
  n: number;
  kill: boolean;
  pct: number;
  durationSec: number;
  present: boolean;
  // The player's death in this pull (the one before the wipe when there are several).
  death: { atSec: number; killer: string; counted: boolean; first: boolean; instant: boolean; judged: boolean; major: string[]; minor: string[]; healthstone: boolean; potion: boolean } | null;
  // Uses in the pull; null when the cast data is missing.
  healthstone: number | null;
  potion: number | null;
  hits: number;
  hitNames: Array<{ name: string; times: number }>;
  // A death before the wipe weighs four hits, dying first two more (the night's own weights).
  score: number;
}

export interface PlayerNightCompare {
  label: string;
  value: string;
  // The median player's figure, in the same unit; null when there is nobody to compare with.
  median: string | null;
  verdict: 'worse' | 'better' | null;
}

export interface PlayerNightMechanic {
  key: string;
  name: string;
  icon: string;
  spellId: number;
  times: number;
  pulls: number;
  damage: number;
  // Place among the players it hit (1 = hit most often), and how many it hit.
  rank: number;
  of: number;
  assigned: boolean;
}

export interface PlayerNight {
  code: string;
  encounterID: number;
  difficulty: number;
  bossName: string;
  player: { id: number; name: string; className: string; role: Role | null };
  summary: string;
  stats: Array<{ label: string; value: string; note?: string }>;
  pulls: PlayerNightPull[];
  pullsPresent: number;
  compare: PlayerNightCompare[];
  // How many players the medians are taken over.
  comparedWith: number;
  mechanics: PlayerNightMechanic[];
  mechanicsKnown: boolean;
  ready: { judged: number; withMajor: number; names: Array<{ name: string; count: number }>; minorOnly: number; minorNames: Array<{ name: string; count: number }> } | null;
  bestWorst: { best: PlayerNightPull; worst: PlayerNightPull; text: string } | null;
  // "Before your next pull": this player's own patterns as instructions, most pulls first.
  nextPull: PlayerNightStep[];
}

export interface PlayerNightStep { text: string; evidence: string; weight: number }

const perPull = (n: number) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
const tallyNames = (names: string[]) => {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
};

// How one pull went for the player, as a clause: "died first at 0:48 to Vile Flood".
export function pullOutcome(p: PlayerNightPull): string {
  if (!p.present) return 'not in this pull';
  if (!p.death) return p.kill ? 'alive at the kill' : 'alive to the wipe';
  if (!p.death.counted) return `died in the wipe at ${fmtClock(p.death.atSec)}`;
  return `died ${p.death.first ? 'first ' : ''}at ${fmtClock(p.death.atSec)} to ${p.death.killer}`;
}

export function buildPlayerNight(night: NightReview, playerId: number): PlayerNight | null {
  const row = night.players.find(p => p.id === playerId);
  if (!row) return null;
  const d = night.detail;
  const rosterKnown = Object.keys(d.present).length > 0;
  // The night's own list: mechanics most of the raid takes each time are nobody's hits.
  const listed = night.mechanics.filter(m => !m.raidWide);
  const nameOf = new Map(listed.map(m => [m.key, m.name]));
  const isPresent = (fightId: number, id: number) => !rosterKnown || (d.present[fightId] ?? []).includes(id);

  const pullsOf = (id: number): PlayerNightPull[] => night.pulls.map(p => {
    const deaths = d.deaths.filter(x => x.fightId === p.fightId && x.playerId === id).sort((a, b) => a.atSec - b.atSec);
    const death = deaths.find(x => x.counted) ?? deaths[0] ?? null;
    const hits = d.hits.filter(h => h[1] === id && h[2] === p.fightId);
    const heal = d.heals.find(h => h[0] === p.fightId && h[1] === id);
    const times = hits.reduce((s, h) => s + h[3], 0);
    return {
      fightId: p.fightId, n: p.n, kill: p.kill, pct: p.pct, durationSec: p.durationSec,
      present: isPresent(p.fightId, id) || deaths.length > 0 || hits.length > 0,
      death: death && { atSec: death.atSec, killer: death.killer, counted: death.counted, first: death.first, instant: death.instant, judged: death.judged, major: death.major, minor: death.minor, healthstone: death.healthstone, potion: death.potion },
      healthstone: d.healsKnown ? heal?.[2] ?? 0 : null,
      potion: d.healsKnown ? heal?.[3] ?? 0 : null,
      hits: times,
      hitNames: hits.map(h => ({ name: nameOf.get(h[0]) ?? h[0], times: h[3] })).sort((a, b) => b.times - a.times),
      score: (death?.counted ? 4 : 0) + (death?.first ? 2 : 0) + times,
    };
  });

  const pulls = pullsOf(playerId);
  const mine = pulls.filter(p => p.present);
  const n = mine.length;
  if (!n) return null;

  // ── Totals, and the same totals for everyone else (for the median player) ──
  const totalsOf = (ps: PlayerNightPull[]) => {
    const here = ps.filter(p => p.present);
    return {
      pulls: here.length,
      deaths: here.filter(p => p.death?.counted).length,
      firsts: here.filter(p => p.death?.first).length,
      hits: here.reduce((s, p) => s + p.hits, 0),
      healthstone: here.filter(p => (p.healthstone ?? 0) > 0).length,
      potion: here.filter(p => (p.potion ?? 0) > 0).length,
    };
  };
  const me = totalsOf(pulls);
  const others = night.players.filter(p => p.id !== playerId).map(p => totalsOf(pullsOf(p.id))).filter(t => t.pulls >= MIN_PULLS_FOR_RATE);
  // A median of fewer than five other players is a handful of people, not "the raid".
  const comparable = n >= MIN_PULLS_FOR_RATE && others.length >= 5;
  const hitsKnown = listed.length > 0;
  type Key = 'deaths' | 'firsts' | 'hits' | 'healthstone' | 'potion';
  const line = (label: string, key: Key, opts: { lowerIsBetter: boolean | null; unit: string }): PlayerNightCompare => {
    const mineRate = me[key] / n;
    const value = `${me[key]} ${opts.unit} · ${perPull(mineRate)} a pull`;
    if (!comparable) return { label, value, median: null, verdict: null };
    const med = median(others.map(t => t[key] / t.pulls));
    let verdict: PlayerNightCompare['verdict'] = null;
    // The gap in events over this player's own pulls, so a long night and a short one read alike.
    const gap = Math.abs(mineRate - med) * n;
    if (opts.lowerIsBetter != null && gap >= MIN_GAP_EVENTS) {
      const above = mineRate >= RATIO_WORTH_SAYING * med && mineRate > med;
      const below = med >= RATIO_WORTH_SAYING * mineRate && med > mineRate;
      if (above) verdict = opts.lowerIsBetter ? 'worse' : 'better';
      else if (below) verdict = opts.lowerIsBetter ? 'better' : 'worse';
    }
    return { label, value, median: `${perPull(med)} a pull`, verdict };
  };
  const compare: PlayerNightCompare[] = [
    line('Deaths before the wipes', 'deaths', { lowerIsBetter: true, unit: `in ${plural(n, 'pull')}` }),
    line('First to die', 'firsts', { lowerIsBetter: true, unit: me.firsts === 1 ? 'time' : 'times' }),
  ];
  if (hitsKnown) compare.push(line('Avoidable hits', 'hits', { lowerIsBetter: true, unit: me.hits === 1 ? 'time' : 'times' }));
  // More healthstones is not "better" in itself (it can mean more damage taken): stated, never judged.
  if (d.healsKnown && night.healing && (night.healing.warlockPulls > 0 || night.healing.healthstone.uses > 0)) compare.push(line('Healthstone used', 'healthstone', { lowerIsBetter: null, unit: `of ${plural(n, 'pull')}` }));
  if (d.healsKnown) compare.push(line('Healing potion used', 'potion', { lowerIsBetter: null, unit: `of ${plural(n, 'pull')}` }));

  // ── Deaths with a defensive ready ──
  const judgedDeaths = mine.filter(p => p.death?.counted && p.death.judged).map(p => p.death!);
  const knowsMajor = night.readyDeaths != null && row.readyDeaths != null;
  const withMajor = judgedDeaths.filter(x => x.major.length);
  const minorOnly = judgedDeaths.filter(x => !x.major.length && x.minor.length);
  const ready: PlayerNight['ready'] = night.readyDeaths && judgedDeaths.length
    ? { judged: knowsMajor ? judgedDeaths.length : 0, withMajor: withMajor.length, names: tallyNames(withMajor.flatMap(x => x.major)), minorOnly: minorOnly.length, minorNames: tallyNames(minorOnly.flatMap(x => x.minor)) }
    : null;

  // ── Their mechanics ──
  const mechanics: PlayerNightMechanic[] = listed.flatMap(m => {
    const i = m.players.findIndex(p => p.id === playerId);
    if (i < 0) return [];
    const p = m.players[i];
    // Tied players share the better place.
    const rank = m.players.findIndex(x => x.times === p.times) + 1;
    return [{ key: m.key, name: m.name, icon: m.icon, spellId: m.spellId, times: p.times, pulls: p.pulls, damage: p.damage, rank, of: m.players.length, assigned: !!m.assigned?.ids.includes(playerId) }];
  }).sort((a, b) => Number(a.assigned) - Number(b.assigned) || b.pulls - a.pulls || b.times - a.times);

  // ── Best pull against worst pull ──
  // Said only when both exist and the comparison is fair: a rough pull (a death before
  // the wipe, or four hits' worth), and a spotless one that lasted at least as long, so
  // "clean" cannot just mean "short".
  let bestWorst: PlayerNight['bestWorst'] = null;
  const worst = mine.slice().sort((a, b) => b.score - a.score || a.durationSec - b.durationSec)[0];
  if (worst && worst.score >= 4) {
    const best = mine.filter(p => p.score === 0 && !p.death && p.durationSec >= worst.durationSec).sort((a, b) => b.durationSec - a.durationSec)[0];
    if (best) {
      const rough = [pullOutcome(worst), worst.death?.counted && worst.death.major.length ? `with ${worst.death.major.join(' and ')} ready` : '', worst.hits ? `after ${plural(worst.hits, 'avoidable hit')}` : ''].filter(Boolean).join(', ');
      bestWorst = {
        best, worst,
        text: `Cleanest: pull ${best.n} (${fmtClock(best.durationSec)}, ${best.kill ? 'the kill' : `${Math.round(best.pct)}% left`}), ${hitsKnown ? 'no avoidable hits and ' : ''}${pullOutcome(best)}. Roughest: pull ${worst.n} (${fmtClock(worst.durationSec)}), ${rough}.`,
      };
    }
  }

  // ── Before your next pull ──
  // The same four-to-one ranking as the raid's block, over this player's pulls only.
  const words = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const pullWords = (ps: PlayerNightPull[]) => `${ps.length === 1 ? 'pull' : 'pulls'} ${words(ps.map(p => String(p.n)))}`;
  const sameAbility = (mech: string, killer: string) => mech.split(' (from ')[0].split(' / ').some(part => part.trim().toLowerCase() === killer.toLowerCase());
  const steps: PlayerNightStep[] = [];
  // Deaths a button could have changed: counted, and not an instant kill.
  const stoppable = mine.filter(p => p.death?.counted && !p.death.instant);
  const covered = new Set<PlayerNightPull>();
  for (const { name: killer } of tallyNames(stoppable.map(p => p.death!.killer))) {
    const to = stoppable.filter(p => p.death!.killer === killer && p.death!.major.length > 0);
    if (to.length < STEP_MIN_DEATHS || /^melee$/i.test(killer) || killer === 'unknown damage') continue;
    const button = tallyNames(to.flatMap(p => p.death!.major))[0];
    const avoidable = !!night.killers.find(k => k.name === killer)?.avoidable;
    for (const p of to) covered.add(p);
    steps.push({
      weight: to.length,
      text: avoidable ? `Stay out of ${killer}, and press ${button.name} when it does catch you.` : `Press ${button.name} for ${killer}.`,
      evidence: `It killed you on ${pullWords(to)}${button.count === to.length ? (to.length === 2 ? ', both times' : ', every time') : `, ${button.count} of those times`} with ${button.name} ready and unpressed.${night.when[killer] ? ` Across the raid it lands ${night.when[killer]}.` : ''}`,
    });
  }
  // Deaths with a major defensive unused that no single ability explains.
  const loose = stoppable.filter(p => p.death!.major.length > 0 && !covered.has(p));
  if (loose.length >= STEP_MIN_DEATHS) {
    const button = tallyNames(loose.flatMap(p => p.death!.major))[0];
    steps.push({
      weight: loose.length,
      text: `Press ${button.name} before you drop: do not die with it ready.`,
      evidence: `You died with ${button.count === loose.length ? 'it' : 'a major defensive'} ready and unpressed on ${pullWords(loose)} (${words(loose.map(p => `${p.death!.killer} at ${fmtClock(p.death!.atSec)}`).slice(0, 4))}).`,
    });
  }
  for (const m of mechanics.filter(x => !x.assigned && x.pulls >= STEP_MIN_HIT_PULLS && x.pulls >= STEP_MIN_HIT_SHARE * n).slice(0, 2)) {
    const killed = mine.filter(p => p.death?.counted && sameAbility(m.name, p.death.killer)).length;
    steps.push({
      weight: killed + STEP_HIT_WEIGHT * Math.max(0, m.pulls - killed),
      text: `Watch ${m.name}.`,
      evidence: `It caught you on ${m.pulls} of your ${n} pulls (${m.times}× in all)${m.of > 1 && m.rank === 1 ? `, more often than any of the other ${m.of - 1} players it hit` : ''}${killed ? `, and killed you on ${killed}` : ''}.`,
    });
  }
  // Healthstone and healing potion: said when deaths keep coming with neither used.
  const stonesAround = !!night.healing && night.healing.warlockPulls > 0;
  const dry = stoppable.filter(p => !p.death!.healthstone && !p.death!.potion);
  if (d.healsKnown && dry.length >= STEP_MIN_DEATHS && dry.length >= stoppable.length / 2) {
    steps.push({
      weight: STEP_HIT_WEIGHT * dry.length,
      text: stonesAround ? 'Press your healthstone or a healing potion when you are low.' : 'Press a healing potion when you are low.',
      evidence: `At ${dry.length} of your ${stoppable.length} deaths before the wipes ${stonesAround ? 'neither' : 'no potion'} had been used in that pull; you used ${stonesAround ? `a healthstone on ${me.healthstone} and ` : ''}a healing potion on ${me.potion} of your ${n} pulls.`,
    });
  }
  const nextPull = steps.sort((a, b) => b.weight - a.weight).slice(0, STEP_MAX);

  // ── The short version ──
  const diff = DIFFICULTY_LABELS[night.difficulty] ?? '';
  const parts: string[] = [];
  const cmp = (key: Key) => compare.find(c => c.label === ({ deaths: 'Deaths before the wipes', firsts: 'First to die', hits: 'Avoidable hits', healthstone: 'Healthstone used', potion: 'Healing potion used' } as const)[key]);
  parts.push(`${row.name} was in ${n === night.pulls.length ? `all ${n}` : `${n} of ${night.pulls.length}`} pulls of ${diff} ${night.bossName}.`);
  const deathCmp = cmp('deaths');
  if (me.deaths === 0) parts.push(`Never died before a wipe${deathCmp?.median && deathCmp.verdict === 'better' ? ` (the median player: ${deathCmp.median})` : ''}.`);
  else {
    const first = me.firsts ? `, the first to die on ${me.firsts === me.deaths ? (me.deaths === 1 ? 'it' : 'all of them') : me.firsts}` : '';
    parts.push(`Died before the wipe on ${me.deaths} of them${first}${deathCmp?.verdict === 'worse' ? `: ${perPull(me.deaths / n)} a pull against the median player's ${deathCmp.median!.replace(' a pull', '')}` : ''}.`);
    const killers = tallyNames(mine.filter(p => p.death?.counted).map(p => p.death!.killer));
    if (killers[0] && killers[0].count >= 2) parts.push(`${killers[0].name} killed them ${timesWord(killers[0].count)}.`);
    if (ready && ready.judged && ready.withMajor) parts.push(`At ${ready.withMajor === ready.judged ? (ready.judged === 1 ? 'that death' : `all ${ready.judged} of those deaths`) : `${ready.withMajor} of ${ready.judged} deaths`} a major defensive was ready and unpressed (${ready.names.slice(0, 2).map(x => x.name).join(', ')}).`);
  }
  if (hitsKnown) {
    const hitCmp = cmp('hits');
    const top = mechanics.find(m => !m.assigned);
    if (me.hits === 0) parts.push('No avoidable hits all night.');
    else parts.push(`${countWord(me.hits, 'avoidable hit').replace(/^./, c => c.toUpperCase())}${hitCmp?.verdict ? `, ${perPull(me.hits / n)} a pull against the median player's ${hitCmp.median!.replace(' a pull', '')}` : ''}${top && top.pulls >= 2 ? `; most often ${top.name} (${top.times}× over ${plural(top.pulls, 'pull')})` : ''}.`);
  }

  const stats: PlayerNight['stats'] = [
    { label: 'Pulls', value: String(n), note: `of ${night.pulls.length}` },
    { label: 'Deaths', value: String(me.deaths), note: 'before the wipes' },
    { label: 'Died first', value: String(me.firsts), note: me.firsts === 1 ? 'pull' : 'pulls' },
    { label: 'Avoidable', value: hitsKnown ? String(me.hits) : '—', note: 'hits' },
    { label: 'Def. ready', value: ready && ready.judged ? `${ready.withMajor} of ${ready.judged}` : '—', note: 'deaths, major' },
  ];

  return {
    code: night.code, encounterID: night.encounterID, difficulty: night.difficulty, bossName: night.bossName,
    player: { id: row.id, name: row.name, className: row.className, role: row.role },
    summary: parts.join(' '), stats, pulls, pullsPresent: n, compare, comparedWith: comparable ? others.length : 0,
    mechanics, mechanicsKnown: hitsKnown, ready, bestWorst, nextPull,
  };
}
