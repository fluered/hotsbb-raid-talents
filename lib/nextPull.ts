import type { FightPlayer, PlayerProfile, PoolSummary, ReportFight } from './analyze';
import type { BossCastMark, DefensiveRow, Finding, TimingDetail } from './analyzeRules';
import { BELOW_ALL, buffFamily, fmtClock, fmtNum, median } from './analyzeRules';
import type { MechanicType } from './bossMechanics';
import { DEFENSIVES, TWO_STEP, defensiveKey, defensivesAt, isMovement, isUtility } from './defensives';

// ─── Log review: the next pull ─────────────────────────────────────────────────
//
// The rest of the review says what happened. This says what to do about it on the next
// attempt: up to three instructions, each one a button and a moment with the line of
// evidence behind it, and a defensive plan for the fight (which of the player's
// defensives goes on which damage).
//
// Same stance as lib/analyzeRules.ts: nothing here knows a spec or a boss. Two kinds of
// action, held to different bars:
//
//   facts    a death and what would have covered it, and whatever the strict rules
//            already flagged (a cooldown never pressed, tank hits taken bare, an
//            avoidable hit no top player takes as much of). Always eligible.
//   targets  the top players' TYPICAL numbers (their median and middle half) offered as
//            something to aim for: a cast rate, when and how often a cooldown is pressed,
//            a hit most of them cover with a defensive, an avoidable hit most of them do
//            not take. Only offered when the player's output is below every top player's
//            (see `targetsOpen`), and only where the player is clearly outside the middle
//            half. Worded "aim for", never as a mistake.
//
// The test for this file is the same leave-one-out one (scripts/review-selfcheck.mjs
// prints each top player's plan): a top player's plan must be "nothing to change", or prep.
//
// Pure functions: reviewPlayer hands over what it already worked out.

export interface PlanSpell { name: string; spellId: number; icon: string }
export type PlanPart =
  | { t: 'text'; v: string }
  | ({ t: 'spell' } & PlanSpell)
  | { t: 'time'; v: string };

export type ActionKind = 'death' | 'avoid' | 'mitigation' | 'defensive' | 'cooldown' | 'timing' | 'activity' | 'rate' | 'prep';

export interface NextPullAction {
  id: string;
  kind: ActionKind;
  // The instruction, in pieces so the page can link the spells and set the moments in chips.
  parts: PlanPart[];
  evidence: string;
  icon: string;
  spellId: number;
  score: number;
}

export interface DefensivePlanRow {
  ability: PlanSpell;
  // 'cover': damage that is meant to be taken, with a defensive planned for it.
  // 'skip':  the same kind of damage, which the top players cover with a button of theirs,
  //          where nothing of this player's is free.
  // 'dodge': damage to step out of — never given a defensive.
  kind: 'cover' | 'skip' | 'dodge';
  // When it landed in this pull (seconds), and how much of the health bar a burst took.
  times: number[];
  sizePct: number | null;
  assign: Array<{ spell: PlanSpell; times: number[]; cooldownSec: number; charges: number }>;
  // What the top players do at these moments, when their clocks can be read against this pull's.
  poolNote: string | null;
  // The moments in this pull that had nothing running.
  bare: number[];
}

export interface DefensivePlan { rows: DefensivePlanRow[]; note: string }

export interface NextPull {
  actions: NextPullAction[];
  // When there is no action about how the pull was played: the line that says so.
  clean: string | null;
  defensivePlan: DefensivePlan | null;
  debug: Record<string, unknown>;
}

// A timeline row as reviewPlayer holds it (its TimelineRowInternal fits).
export interface PlanRow {
  name: string; poolName: string; icon: string; spellId: number;
  kind: 'cooldown' | 'buff'; origin: string;
  mine: Array<[number, number]>;
  used?: number; possible?: number | null; cooldownSec?: number | null;
  poolUseRatios?: number[];
  timing?: TimingDetail;
}

export interface NextPullContext {
  player: FightPlayer;
  fight: ReportFight;
  profile: PlayerProfile;
  // The pool as the rules use it: same hero talents, placed on this pull's phases.
  pool: PoolSummary | null;
  phaseAligned: boolean;
  dmgIdx: number[];
  phases: Array<{ name: string; fromSec: number; toSec: number }>;
  bossCasts: BossCastMark[];
  windows: Array<[number, number]>;
  judgeable: boolean;
  kindOf: (name: string, spellId?: number) => MechanicType | undefined;
  isWipeDeath: (d: { killer: string; atSec: number }) => boolean;
  // False for a button this player's talents or gear do not give them.
  canPress: (name: string) => boolean;
  buildDiffers: boolean;
  defensives: DefensiveRow[];
  defUses: Record<string, number[]>;
  defCd: Record<string, number | undefined>;
  defCharges: Record<string, number>;
  defBands: Record<string, Array<[number, number]>>;
  // Wowhead's tooltip text by defensive name, for telling a button that prevents damage
  // from one that heals it back (see preventsDamage).
  spellTexts: Record<string, string>;
  perSec: number;
  rows: PlanRow[];
  findings: readonly Finding[];
  // Casting gaps of six seconds or more that no intermission explains.
  gaps: Array<{ from: number; to: number; why: string | null }>;
  activePct: number;
  myPotions: number;
  poolPotions: number[];
  prePotShare: number | null;
  // Consumable families nearly every top player has at the pull and this player did not.
  missingAtPull: Array<{ label: string; have: number; n: number }>;
  // The tank's active mitigation, by name (empty for other roles).
  mitigationNames: string[];
  debug: boolean;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

// A burst is damage inside five seconds: about what one press of a short defensive covers.
const BURST_SEC = 5;
// Under two fifths of a health bar in five seconds is ordinary healing load, not a moment
// to plan a cooldown for (measured on Mythic Nek'zali and Vel'thara pulls: the background
// raid damage alone runs 20–45% per five seconds; the named hits stand at 50% and up).
const BURST_MIN_SHARE = 0.4;
// The eight biggest bursts of a pull are as many as a player has defensive presses for.
const BURST_MAX = 8;
// Bursts led by the same ability within twelve seconds are one moment: one press covers both.
const BURST_MERGE_SEC = 12;
// A top player "presses it for this" when the press is within ten seconds before the
// damage (their clocks are placed on this pull's phases, which is good to a few seconds).
const POOL_NEAR_BEFORE = 10;
const POOL_NEAR_AFTER = 6;
// Half the top players pressing the same defensive at a moment is a plan, not chance: a
// one-minute button pressed on cooldown falls in a 16-second window about a quarter of the time.
const POOL_PRESS_SHARE = 0.5;
// Nothing is said about the top players NOT pressing a defensive at a moment. It was
// tried ("3 of 29 press anything around Vessel of Awakening") and checked against the
// top eight Retribution Paladins' raw events on Mythic Nek'zali, 2026-11-16: four are
// never hit by it, it lands anywhere from 2:07 to 4:05 in the others' kills, and three of
// those four had a defensive up when it did. Their press times are known, their hit times
// are not (no request is spent per top player), so a concentration of presses at a point
// of the fight is evidence, and the lack of one is not. The same check on the positive
// claim held: all 21 Mother's Wrath hits on the top eight Protection Warriors on Mythic
// Vel'thara had Shield Wall pressed for them.
// "Clearly below the middle half": a tenth under its lower edge, since a cast or two
// either way moves a rate that much in one pull.
const BELOW_MIDDLE = 0.9;
// A press is "late" for a target when it is fifteen seconds past the late edge of the
// middle half: less is a couple of globals and the slack in placing phases on phases.
const LATE_SEC = 15;
// An avoidable hit earns a place in the plan when it happened twice, cost a real share of
// the damage taken, or took half a health bar: one clip for a percent or two is not worth
// one of three lines.
const AVOID_MIN_VISITS = 2;
const AVOID_MIN_SHARE = 0.03;
const AVOID_MIN_HEALTH = 0.5;
// Ticks more than three seconds apart are two visits to the same patch, not one.
const VISIT_GAP_SEC = 3;
// A cooldown "sat unused" when it was ready for half a minute: less is waiting for a window.
const IDLE_MIN_SEC = 30;
const MAX_ACTIONS = 3;

// How Blizzard words a button that stops damage before it lands (reduction, absorbs,
// immunity, avoidance, redirection), as against one that heals it back afterwards. Like
// readsAsMitigation in lib/roleRules.ts this describes tooltip language, not a class: a
// heal (Lay on Hands, Exhilaration) is pressed after the hit and cannot be planned for
// one, a reduction can. Unknown text counts as plannable.
// Checked against Wowhead's text for 57 class defensives (2026-11-16): the heals it leaves
// out are Lay on Hands, Frenzied Regeneration, Renewal, Renewing Blaze, Exhilaration,
// Desperate Prayer, Crimson Vial, Last Stand, Death Pact and Bitter Immunity.
const PREVENTS = /\b(reduc\w+ (all |the |your )?(physical |magic(al)? |spell )?damage|damage (you take|taken)( is)? (reduced|decreased)|less damage|absorb(s|ing|ed)?\b(?! incoming healing)|immun\w+ to (all |physical |magic\w* )?damage|magic immunity|protect\w+ you from|armor|dodge|parry|deflect\w*|reflect\w*|redirect\w*|stagger\w*|shield(s|ing)? you|attacks to miss)/i;
export function preventsDamage(text: string | null | undefined): boolean {
  return !text || PREVENTS.test(text);
}
// A defensive whose tooltip only speaks of magic (Anti-Magic Shell, Cloak of Shadows) or
// only of physical damage and avoidance (Blessing of Protection, Evasion) is not planned
// for a hit of the other school. Warcraft Logs gives each ability's school; 1 is physical.
const ALL_DAMAGE = /\ball damage\b|\bdamage taken by\b|all spells and attacks/i;
export function coversSchool(text: string | null | undefined, school: number | undefined): boolean {
  if (!text || !school || ALL_DAMAGE.test(text)) return true;
  const magic = /\bmagic(al)? (damage|immunity|effects)\b|harmful spells|spell cast on you/i.test(text);
  const physical = /\bphysical (damage|attacks)\b|\bdodge\b|\bparry\b|\bmelee\b/i.test(text);
  if (magic && !physical) return school !== 1;
  if (physical && !magic) return (school & 1) === 1;
  return true;
}

const quartiles = (xs: number[]) => {
  const a = xs.slice().sort((x, y) => x - y);
  return { lo: a[Math.floor(a.length * 0.25)] ?? 0, hi: a[Math.min(a.length - 1, Math.floor(a.length * 0.75))] ?? 0 };
};
const T = (v: string): PlanPart => ({ t: 'text', v });
const C = (v: string): PlanPart => ({ t: 'time', v });
const listWords = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const clockList = (ts: number[], max = 4) => listWords([...ts.slice(0, max).map(fmtClock), ...(ts.length > max ? [`${ts.length - max} more`] : [])]);
const rate = (x: number) => (x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
// A rate as a target: whole casts from five a minute up, one decimal below.
const target = (x: number) => (x >= 5 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
const cdWords = (s: number) => s >= 60 ? `${Number.isInteger(s / 60) ? s / 60 : (s / 60).toFixed(1)}-min` : `${Math.round(s)}-sec`;
const round5 = (x: number) => Math.max(5, Math.round(x / 5) * 5);
const ucFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Charges recover one at a time from the moment of use: can every press in `uses` be made?
export function pressesFeasible(uses: number[], cooldownSec: number, charges: number): boolean {
  let have = Math.max(1, charges);
  const max = have;
  let nextAt: number | null = null;
  for (const u of uses.slice().sort((a, b) => a - b)) {
    while (have < max && nextAt != null && nextAt <= u) { have++; nextAt = have < max ? nextAt + cooldownSec : null; }
    if (have === 0) return false;
    have--;
    if (nextAt == null) nextAt = u + cooldownSec;
  }
  return true;
}

export function planText(parts: PlanPart[], bold: (s: string) => string = s => s): string {
  return parts.map(p => (p.t === 'spell' ? bold(p.name) : p.v)).join('');
}

// ─── The plan ─────────────────────────────────────────────────────────────────

export function buildNextPull(c: NextPullContext): NextPull {
  const { profile, pool, player } = c;
  const durationSec = profile.durationMs / 1000;
  const aliveMinutes = Math.max(profile.aliveMs, 1000) / 60000;
  const lastAliveSec = c.windows[c.windows.length - 1]?.[1] ?? durationSec;
  const specs = `${player.spec} ${player.className}s`;
  const debug: Record<string, unknown> = {};

  const spellOf = (name: string): PlanSpell => {
    const d = c.defensives.find(r => r.name === name);
    if (d && (d.spellId || d.icon)) return { name, spellId: d.spellId, icon: d.icon };
    const cast = profile.casts.find(x => x.name === name) ?? profile.buffs.find(x => x.name === name);
    if (cast) return { name, spellId: cast.spellId, icon: cast.icon };
    const p = pool?.casts[name] ?? pool?.buffs[name];
    if (p) return { name, spellId: p.spellId, icon: p.icon };
    const row = c.rows.find(r => r.name === name || r.poolName === name);
    return { name, spellId: row?.spellId ?? 0, icon: row?.icon ?? '' };
  };
  const S = (name: string): PlanPart => ({ t: 'spell', ...spellOf(name) });
  const bossSpell = (name: string): PlanSpell => {
    const t = profile.damageTaken.find(x => x.name === name);
    const d = profile.deaths.find(x => x.killer === name);
    return { name, spellId: t?.spellId ?? d?.killerSpellId ?? 0, icon: t?.icon ?? d?.killerIcon ?? '' };
  };
  const B = (name: string): PlanPart => ({ t: 'spell', ...bossSpell(name) });

  // How many of the top players on this difficulty take any damage from an ability.
  const dmgN = c.dmgIdx.length;
  const takers = (name: string) => (pool?.taken[name] ? c.dmgIdx.filter(i => (pool.taken[name].perMin[i] ?? 0) > 0).length : 0);
  // Meant to be taken (so a defensive can be planned for it), to be stepped out of, or neither.
  const categoryOf = (name: string, spellId?: number): 'cover' | 'dodge' | 'other' => {
    if (/^melee$/i.test(name)) return 'other'; // a tank's swings are active mitigation's job
    const kind = c.kindOf(name, spellId);
    // Labelled a dodge, but judged against this spec's top players: most of them never
    // take it (a dodge), nearly all of them do (for this role it is part of the fight —
    // Caustic Waves on Vel'thara hits all 30 top Protection Warriors), or neither.
    if (kind === 'avoid') return !pool || dmgN < 3 || takers(name) / dmgN <= 0.3 ? 'dodge' : takers(name) / dmgN >= 0.8 ? 'cover' : 'other';
    if (kind === 'raidwide' || kind === 'defensive' || kind === 'soak' || kind === 'targeted') return 'cover';
    if (kind === 'tank') return player.role === 'tank' ? 'cover' : 'other';
    if (kind && kind !== 'unknown') return 'other';
    if (!pool || dmgN < 3) return 'other';
    const share = takers(name) / dmgN;
    return share >= 0.6 ? 'cover' : share <= 0.3 ? 'dodge' : 'other';
  };

  // Are the top players' clocks comparable with this pull's at this second?
  const secondPhaseAt = (c.fight.phases ?? [])[1]?.atSec ?? Infinity;
  const poolClockOk = (atSec: number) => !!pool && (c.phaseAligned || atSec < secondPhaseAt);
  const poolPresses = (name: string): number[][] => pool?.castStarts[name] ?? pool?.buffs[name]?.starts ?? [];
  const poolDefensiveNames = pool ? [...new Set([...Object.keys(pool.castStarts), ...Object.keys(pool.buffs)].filter(n => DEFENSIVES.has(defensiveKey(n))))] : [];
  const near = (ts: number[], atSec: number) => ts.some(t => t >= atSec - POOL_NEAR_BEFORE && t <= atSec + POOL_NEAR_AFTER);
  const poolNear = (name: string, atSec: number) => poolPresses(name).filter(ts => near(ts, atSec)).length;
  const poolNearAny = (atSec: number) => pool ? Array.from({ length: pool.n }, (_, i) => poolDefensiveNames.some(n => near(poolPresses(n)[i] ?? [], atSec))).filter(Boolean).length : 0;

  // Protective auras on the player by id: their own defensives, and externals that protect.
  const protective = new Map<number, string>();
  for (const b of profile.buffs) if (DEFENSIVES.has(defensiveKey(b.name))) for (const id of b.ids ?? [b.spellId]) protective.set(id, b.name);
  for (const x of profile.externals ?? []) if (!/power infusion|blessing of summer|blessing of autumn|innervate|spatial paradox/i.test(x.name)) protective.set(x.spellId, x.name);
  const state = (atSec: number) => defensivesAt(atSec, c.defensives.map(r => r.name), c.defUses, c.defCd, c.defCharges, c.defBands);
  // A button for after the hit: a healthstone, a healing potion, or a defensive whose
  // tooltip is a heal. Never planned for a moment; offered at a death as "when you drop low".
  const isReactive = (name: string) => name === 'Healthstone' || name === 'Healing potion' || !preventsDamage(c.spellTexts[name]);

  // On a wipe the closing seconds are the raid dying, not something to plan around or to
  // hold against anyone: everything from just before the last run of deaths (five or more,
  // each within five seconds of the next) is left out, else the last ten seconds.
  const lostAt = c.fight.kill ? Infinity : (() => {
    const deaths = profile.raidDeaths.map(d => d.atSec).sort((a, b) => b - a);
    let run = 0;
    while (run + 1 < deaths.length && deaths[run] - deaths[run + 1] <= 5) run++;
    return run + 1 >= 5 ? deaths[run] - 3 : durationSec - 10;
  })();

  // ── The defensive plan ──
  const defensivePlan = ((): DefensivePlan | null => {
    const hits = profile.hits;
    const maxHp = profile.maxHp ?? 0;
    if (!hits?.length || !(maxHp > 0)) return null;
    const byId = new Map<number, string>();
    for (const t of profile.damageTaken) for (const x of t.byId) byId.set(x.spellId, t.name);
    const named = hits.map(h => ({ ...h, name: byId.get(h.spellId) ?? '', size: h.amount + h.absorbed })).filter(h => h.name && h.atSec < lostAt);
    const schoolOf = new Map(profile.damageTaken.map(t => [t.name, t.school]));
    const cat = new Map<string, 'cover' | 'dodge' | 'other'>();
    for (const t of profile.damageTaken) cat.set(t.name, categoryOf(t.name, t.spellId));

    // Bursts: the heaviest five seconds of coverable damage, taken one at a time.
    let left = named.filter(h => cat.get(h.name) === 'cover');
    const bursts: Array<{ t: number; end: number; total: number; lead: string }> = [];
    while (bursts.length < BURST_MAX && left.length) {
      let best: { t: number; end: number; total: number; by: Map<string, number> } | null = null;
      for (let a = 0; a < left.length; a++) {
        let total = 0, end = left[a].atSec;
        const by = new Map<string, number>();
        for (let b = a; b < left.length && left[b].atSec - left[a].atSec <= BURST_SEC; b++) { total += left[b].size; end = left[b].atSec; by.set(left[b].name, (by.get(left[b].name) ?? 0) + left[b].size); }
        if (!best || total > best.total) best = { t: left[a].atSec, end, total, by };
      }
      if (!best || best.total < BURST_MIN_SHARE * maxHp) break;
      const lead = [...best.by.entries()].sort((x, y) => y[1] - x[1])[0][0];
      bursts.push({ t: best.t, end: best.end, total: best.total, lead });
      const from = best.t - 3, to = best.t + BURST_SEC + 3;
      left = left.filter(h => h.atSec < from || h.atSec > to);
    }
    bursts.sort((a, b) => a.t - b.t);
    // One moment per press: bursts of the same ability close together are merged.
    const moments: typeof bursts = [];
    for (const b of bursts) {
      const prev = moments.filter(m => m.lead === b.lead).pop();
      if (prev && b.t - prev.t <= BURST_MERGE_SEC) { prev.end = Math.max(prev.end, b.end); prev.total = Math.max(prev.total, b.total); } else moments.push({ ...b });
    }
    // What was running on the player through a moment: an aura the hits themselves list,
    // or a defensive pressed just before (one that leaves no buff behind).
    const ranAt = (m: { t: number; end: number }): string[] => {
      const names = new Set<string>();
      for (const h of named) if (h.atSec >= m.t && h.atSec <= m.end) for (const id of h.auras) { const n = protective.get(id); if (n) names.add(n); }
      for (const r of c.defensives) {
        if ((c.defBands[r.name] ?? []).some(([s, e]) => s <= m.end && e >= m.t)) names.add(r.name);
        else if (!(c.defBands[r.name] ?? []).length && (c.defUses[r.name] ?? []).some(u => u >= m.t - 8 && u <= m.end)) names.add(r.name);
      }
      return [...names];
    };

    const groups = new Map<string, typeof moments>();
    for (const m of moments) (groups.get(m.lead) ?? groups.set(m.lead, []).get(m.lead)!).push(m);
    const n = pool?.n ?? 0;
    // What the top players do at each group of moments: the defensive most of them press there.
    const evidence = (lead: string, ms: typeof moments) => {
      const readable = ms.filter(m => poolClockOk(m.t));
      const avg = (f: (m: { t: number }) => number) => readable.length && n ? readable.reduce((sum, m) => sum + f(m), 0) / readable.length / n : null;
      const theirs = poolDefensiveNames.map(name => ({ name: defensiveKey(name), share: avg(m => poolNear(name, m.t)) ?? 0 })).sort((a, b) => b.share - a.share)[0];
      const theyPress = !!theirs && theirs.share >= POOL_PRESS_SHARE;
      return { lead, ms, theirs, theyPress, size: Math.max(...ms.map(m => m.total)) };
    };
    // Moments the top players cover come first (most agreed first), then the rest by size,
    // so a cooldown goes where the evidence is before it goes where the damage is.
    const ordered = [...groups.entries()].map(([lead, ms]) => evidence(lead, ms)).sort((a, b) => Number(b.theyPress) - Number(a.theyPress) || (a.theyPress ? b.theirs.share - a.theirs.share : b.size - a.size));
    const candidates = c.defensives.filter(r => r.cooldownSec != null && r.cooldownSec > 0 && !isReactive(r.name) && !TWO_STEP.has(r.name));
    const planned: Record<string, number[]> = {};
    const rows: DefensivePlanRow[] = [];
    for (const { lead, ms, theirs, theyPress } of ordered) {
      const times = ms.map(m => m.t);
      // The press goes with the boss's cast when lorrgs marks one just before the damage.
      const pressAt = (m: { t: number }) => c.bossCasts.filter(b => b.name === lead && b.atSec <= m.t + 1 && b.atSec >= m.t - 10).pop()?.atSec ?? m.t;
      const assign: DefensivePlanRow['assign'] = [];
      {
        let open = ms.slice().sort((a, b) => b.total - a.total); // the heaviest moment gets its press first
        for (let pass = 0; pass < 2 && open.length; pass++) {
          // The top players' own choice first, when half of them make it and this player has
          // the button; otherwise whatever covers the most of these moments. Among equals, a
          // burst worth a whole health bar gets the longest cooldown (the one proxy for the
          // strongest button that needs no list) and anything smaller the shortest one free.
          const scored = candidates.filter(r => !assign.some(a => a.spell.name === r.name) && ((theyPress && theirs.name === r.name) || coversSchool(c.spellTexts[r.name], schoolOf.get(lead)))).map(r => {
            const got: number[] = [];
            for (const m of open) if (pressesFeasible([...(planned[r.name] ?? []), ...got, pressAt(m)], r.cooldownSec ?? 0, r.charges)) got.push(pressAt(m));
            return { r, got, theirs: theyPress && theirs.name === r.name };
          }).filter(x => x.got.length);
          const big = Math.max(...open.map(m => m.total)) >= maxHp ? 1 : -1;
          scored.sort((a, b) => Number(b.theirs) - Number(a.theirs) || b.got.length - a.got.length || big * ((b.r.cooldownSec ?? 0) - (a.r.cooldownSec ?? 0)));
          const pick = scored[0];
          if (!pick) break;
          (planned[pick.r.name] ??= []).push(...pick.got);
          assign.push({ spell: { name: pick.r.name, spellId: pick.r.spellId, icon: pick.r.icon }, times: pick.got.slice().sort((a, b) => a - b), cooldownSec: pick.r.cooldownSec ?? 0, charges: pick.r.charges });
          open = open.filter(m => !pick.got.includes(pressAt(m)));
        }
      }
      // Either the press most of them make here, or — for damage most of them never take —
      // that fact, which says the moment itself can be avoided.
      const hit = takers(lead);
      const poolNote = theyPress
        ? `${Math.round(theirs.share * n)} of the ${n} top ${specs} press ${theirs.name} at ${ms.length === 1 ? 'this point' : 'these points'} of the fight`
        : pool && dmgN >= 3 && hit / dmgN < 0.6 ? `only ${hit} of the ${dmgN} top ${specs} on this difficulty take any damage from it` : null;
      rows.push({
        ability: bossSpell(lead), kind: assign.length ? 'cover' : 'skip', times,
        sizePct: Math.round(100 * median(ms.map(m => m.total)) / maxHp),
        assign, poolNote, bare: ms.filter(m => !ranAt(m).length).map(m => m.t),
      });
      // A moment with neither a free button nor a press of the top players' to point at is not a row.
      if (!assign.length && !theyPress) rows.pop();
    }
    // Damage to step out of: listed so nobody plans a cooldown for it.
    const dodge = profile.damageTaken.filter(t => cat.get(t.name) === 'dodge').map(t => {
      const ts = named.filter(h => h.name === t.name).map(h => h.atSec);
      return { t, visits: ts.filter((x, i) => i === 0 || x - ts[i - 1] > VISIT_GAP_SEC) };
    }).filter(x => x.visits.length && x.t.total >= BURST_MIN_SHARE * maxHp).sort((a, b) => b.t.total - a.t.total).slice(0, 2);
    for (const d of dodge) rows.push({ ability: bossSpell(d.t.name), kind: 'dodge', times: d.visits, sizePct: Math.round(100 * d.t.total / maxHp), assign: [], poolNote: null, bare: [] });
    if (c.debug) debug.damage = { maxHp, hits: hits.length, complete: profile.hitsComplete ?? null, moments: moments.map(m => `${fmtClock(m.t)} ${m.lead} ${Math.round(100 * m.total / maxHp)}% ran=${ranAt(m).join('/') || '-'} poolAny=${poolClockOk(m.t) ? poolNearAny(m.t) : '?'}`), categories: [...cat.entries()].map(([k, v]) => `${k}: ${v}`), reactive: c.defensives.filter(r => isReactive(r.name)).map(r => r.name) };
    // Thin data: nothing to plan a press for and nothing the top players can be quoted on.
    if (!rows.some(r => r.kind === 'cover')) return null;
    // For scale: how often the middle top player presses each planned defensive in a kill.
    const perKill = (name: string) => {
      const e = Object.entries(pool?.casts ?? {}).find(([k]) => defensiveKey(k) === name)?.[1];
      return e && pool ? Math.round(median(e.cpm.map((x, i) => x * (pool.durations[i] ?? 0) / 60000))) : null;
    };
    const used = [...new Set(rows.flatMap(r => r.assign.map(a => a.spell.name)))].map(name => ({ name, k: perKill(name) })).filter((x): x is { name: string; k: number } => x.k != null).slice(0, 3);
    const scale = used.length ? ` For scale, the middle top ${specs.replace(/s$/, '')} presses ${listWords(used.map(x => `${x.name} ${x.k === 1 ? 'once' : `${x.k} times`}`))} in a kill.` : '';
    const reached = !c.fight.kill ? `This pull was a wipe at ${fmtClock(durationSec)}, so the plan only covers the fight up to there. ` : '';
    const complete = profile.hitsComplete === false ? ' Only the first part of the pull\'s damage could be read.' : '';
    return {
      rows,
      note: `${reached}Each moment is one of the heaviest ${BURST_SEC}-second stretches of unavoidable damage you took in this pull (${Math.round(100 * BURST_MIN_SHARE)}% of your health or more), named after the ability that did most of it. Times are this pull's and move with the phases. A defensive is only given presses its cooldown allows, and buttons that heal rather than prevent are left for when you drop low.${scale}${complete}`,
    };
  })();

  // ── Actions ──
  const actions: NextPullAction[] = [];
  const push = (a: Omit<NextPullAction, 'icon' | 'spellId'> & { spell: { spellId: number; icon: string } }) => {
    const { spell, ...rest } = a;
    actions.push({ ...rest, icon: spell.icon, spellId: spell.spellId });
  };

  // Typical-number targets are for a player whose output is below every top player's, by
  // the margin the strict rules use for "below all of them" (BELOW_ALL). A player inside
  // their range gets the same result a different way, and telling them to press something
  // more often would be a nitpick; it is also what keeps a top player's own plan clean.
  const lowestOutput = pool ? Math.min(...pool.output.filter(x => x > 0)) : 0;
  const targetsOpen = !!pool && pool.output.length >= 3 && lowestOutput > 0 && c.perSec < BELOW_ALL * lowestOutput;

  // 1. What killed the player, and what would have covered it.
  const realDeaths = profile.deaths.filter(d => !c.isWipeDeath(d));
  const coveredKillers = new Set<string>();
  realDeaths.slice(0, 1).forEach(d => {
    const where = categoryOf(d.killer, d.killerSpellId);
    const recap = profile.deathRecaps?.find(x => Math.abs(x.atSec - d.atSec) < 0.5);
    const recapTotal = recap ? recap.hits.reduce((s, h) => s + h.amount, 0) : 0;
    const recapWords = recap && recap.hits.length ? `You took ${fmtNum(recapTotal)} in the ten seconds before it${recap.healCount ? '' : ', and no healing landed'}.` : '';
    coveredKillers.add(d.killer);
    if (where === 'dodge') {
      push({
        id: `death-${d.killer}`, kind: 'death', score: 100, spell: bossSpell(d.killer),
        parts: [T('Step out of '), B(d.killer), T(' — it killed you at '), C(fmtClock(d.atSec)), T('.')],
        evidence: pool && dmgN >= 3 ? `${takers(d.killer) === 0 ? `None of the ${dmgN}` : `Only ${takers(d.killer)} of the ${dmgN}`} top ${specs} on this difficulty take any damage from it.` : recapWords,
      });
      return;
    }
    const st = state(d.atSec);
    const running = st.active.length > 0 || (recap?.aurasAtDeath ?? []).some(a => DEFENSIVES.has(defensiveKey(a.name)));
    const planRow = defensivePlan?.rows.find(r => r.kind === 'cover' && r.ability.name === d.killer);
    const real = st.available.filter(name => !isReactive(name) && !TWO_STEP.has(name));
    const best = planRow?.assign.map(a => a.spell.name).find(name => real.includes(name)) ?? real.slice().sort((a, b) => (c.defCd[b] ?? 0) - (c.defCd[a] ?? 0))[0];
    // Buttons for after the hit that were still unused: class heals first, then the stone, then a potion.
    const order = (name: string) => (name === 'Healing potion' ? 2 : name === 'Healthstone' ? 1 : 0);
    const heals = st.available.filter(isReactive).sort((a, b) => order(a) - order(b));
    const heal = heals[0];
    if (best && !running) {
      push({
        id: `death-${d.killer}`, kind: 'death', score: 100, spell: spellOf(best),
        parts: [T('Press '), S(best), T(' for '), B(d.killer), T(' — it killed you at '), C(fmtClock(d.atSec)), T(` with ${best} ready and no defensive running.`)],
        evidence: `${recapWords}${heals.length ? ` Your ${listWords(heals.slice(0, 2))} ${heals.length === 1 ? 'was' : 'were'} unused too.` : ''}`.trim(),
      });
    } else if (!running && !heal && st.onCooldown.length && where === 'cover') {
      const used = st.onCooldown.slice().sort((a, b) => Math.min(...a.usedAgoSec) - Math.min(...b.usedAgoSec))[0];
      const ago = Math.min(...used.usedAgoSec);
      push({
        id: `death-${d.killer}`, kind: 'death', score: 100, spell: spellOf(used.name),
        parts: [T('Hold '), S(used.name), T(' for '), B(d.killer), T(': you pressed it at '), C(fmtClock(d.atSec - ago)), T(', and it was still on cooldown when '), B(d.killer), T(' killed you at '), C(fmtClock(d.atSec)), T('.')],
        evidence: recapWords,
      });
    } else if (heal) {
      push({
        id: `death-${d.killer}`, kind: 'death', score: 100, spell: spellOf(heal),
        parts: [T(heal === 'Healthstone' || heal === 'Healing potion' ? 'Use your ' : 'Press '), S(heal), T(' when you drop low — it was still unused when '), B(d.killer), T(' killed you at '), C(fmtClock(d.atSec)), T('.')],
        evidence: `${recapWords}${running ? ' A defensive was already running, so this was the button left.' : ''}`.trim(),
      });
    }
  });

  // 2. A tank's hits with nothing running (the strict tank-hit card, turned forward).
  const tankHits = c.findings.find(f => f.id === 'tank-hits' && f.severity === 'warn');
  if (tankHits?.events?.length && c.mitigationNames.length) {
    const what = [...new Set(tankHits.events.map(e => e.text.split(' for ')[0]))].filter(name => name && name !== 'Tank hit').slice(0, 2);
    const mits = c.mitigationNames.slice(0, 2);
    const parts: PlanPart[] = [T('Have '), ...mits.flatMap((m, i) => [...(i ? [T(' or ')] : []), S(m)]), T(' running for ')];
    parts.push(...(what.length ? what.flatMap((w, i) => [...(i ? [T(' and ')] : []), B(w)]) : [T('the tank hits')]));
    parts.push(T(' — it landed with nothing up at '), C(clockList(tankHits.events.map(e => e.atSec))), T('.'));
    push({ id: 'tank-hits', kind: 'mitigation', score: 90, spell: spellOf(mits[0]), parts, evidence: `${tankHits.title}.` });
  }

  // 3. Avoidable hits, with their times.
  if (profile.hits?.length && pool && dmgN >= 3) {
    const totalTaken = profile.damageTaken.reduce((s, t) => s + t.total, 0) || 1;
    const maxHp = profile.maxHp ?? 0;
    const hit = profile.damageTaken.filter(t => categoryOf(t.name, t.spellId) === 'dodge').map(t => {
      const ids = new Set(t.byId.map(x => x.spellId));
      const ts = profile.hits!.filter(h => ids.has(h.spellId) && h.atSec < lostAt).map(h => h.atSec);
      const theirs = c.dmgIdx.map(i => pool.taken[t.name]?.perMin[i] ?? 0);
      const mine = t.total / aliveMinutes;
      return {
        t, visits: ts.filter((x, i) => i === 0 || x - ts[i - 1] > VISIT_GAP_SEC), share: t.total / totalTaken,
        // More of it than any top player takes (a fact), or more than their middle half (a target).
        beyondAll: mine > Math.max(0, ...theirs) / BELOW_ALL,
        beyondMiddle: mine > quartiles(theirs).hi / BELOW_MIDDLE,
      };
    }).filter(x => x.visits.length);
    const dodges = hit.filter(x => !coveredKillers.has(x.t.name)
      && (x.beyondAll || (targetsOpen && x.beyondMiddle))
      && (x.visits.length >= AVOID_MIN_VISITS || x.share >= AVOID_MIN_SHARE || (maxHp > 0 && x.t.total >= AVOID_MIN_HEALTH * maxHp)));
    dodges.sort((a, b) => b.t.total - a.t.total);
    dodges.slice(0, 2).forEach((x, i) => {
      const only = hit.length === 1 && x.visits.length === 1;
      push({
        id: `avoid-${x.t.name}`, kind: 'avoid', spell: bossSpell(x.t.name),
        score: (x.visits.length >= 2 ? 80 : 62) + Math.min(8, Math.round(100 * x.share)) - i,
        parts: only
          ? [T('Step out of '), B(x.t.name), T(' — it is the one avoidable thing that hit you, at '), C(fmtClock(x.visits[0])), T('.')]
          : [T('Step out of '), B(x.t.name), T(` — it caught you ${x.visits.length === 1 ? 'at' : `${x.visits.length} times, at`} `), C(clockList(x.visits)), T('.')],
        evidence: `${fmtNum(x.t.total)} damage, ${Math.round(100 * x.share)}% of everything you took. ${takers(x.t.name) ? `${takers(x.t.name)} of the ${dmgN}` : `None of the ${dmgN}`} top ${specs} on this difficulty ${takers(x.t.name) === 1 ? 'takes' : 'take'} any${x.beyondAll && takers(x.t.name) ? ', and none as much' : ''}.`,
      });
    });
  }

  // 4. Damage the top players cover with a defensive, taken with nothing running.
  if (targetsOpen) for (const r of defensivePlan?.rows ?? []) {
    if (r.kind !== 'cover' || coveredKillers.has(r.ability.name) || !r.bare.length) continue;
    const d = r.assign[0].spell.name;
    const theirs = r.poolNote?.includes(` press ${d} at th`) ?? false;
    // Without the top players' clocks to go by, only what DBM itself marks as the hit to
    // press a defensive for, and only when it took half a health bar.
    const typed = !r.times.some(poolClockOk) && c.kindOf(r.ability.name, r.ability.spellId) === 'defensive' && (r.sizePct ?? 0) >= 50;
    if (!theirs && !typed) continue;
    const ready = r.bare.filter(t => state(t).available.includes(d));
    if (!ready.length) continue;
    push({
      id: `cover-${r.ability.name}`, kind: 'defensive', score: 70 + Math.min(9, ready.length * 3), spell: spellOf(d),
      parts: [T('Press '), S(d), T(' for '), { t: 'spell', ...r.ability }, T(' — it hit you at '), C(clockList(ready)), T(` last pull with no defensive running and ${d} ready.`)],
      evidence: `${r.poolNote ? `${ucFirst(r.poolNote)}. ` : 'Deadly Boss Mods marks it as the hit to press a defensive for. '}It took about ${r.sizePct}% of your health in ${BURST_SEC} seconds.`,
    });
  }

  // 5. Cooldowns: never pressed (the strict card, turned forward), then — as targets —
  // pressed less often or later than the middle half of the top players. The strict
  // timing and usage cards stay cards: leave-one-out on 18 top parses (2026-11-16) had
  // them on three top players (a third Raise Dead 93 seconds late on the #1 Blood Death
  // Knight, a trinket held 53 seconds on the #3 Havoc), which is fine as a note under
  // "Fix these first" and too much as an instruction at the top of the page.
  if (c.judgeable) {
    for (const f of c.findings) {
      if (!f.id.startsWith('never-') || (f.severity !== 'bad' && f.severity !== 'warn')) continue;
      const name = f.id.slice(6);
      if (!c.canPress(name)) continue;
      const first = c.rows.find(r => r.poolName === name || r.name === name)?.timing?.presses[0];
      push({
        id: f.id, kind: 'cooldown', score: 66, spell: spellOf(name),
        parts: first ? [T('Press '), S(name), T(' — top players first press it around '), C(fmtClock(first.med)), T(', and you never did.')] : [T('Press '), S(name), T(' — it was never used this pull.')],
        evidence: f.text,
      });
    }
    const cooldownRows = c.rows.filter(r => r.kind === 'cooldown' && r.origin !== 'potion' && r.origin !== 'external' && c.canPress(r.poolName) && !TWO_STEP.has(r.poolName) && !actions.some(a => a.id === `never-${r.poolName}` || a.id === `never-${r.name}`));
    const usage: NextPullAction[] = [];
    for (const r of cooldownRows) {
      const used = r.used ?? 0, possible = r.possible ?? 0, cd = r.cooldownSec ?? 0;
      const ratios = r.poolUseRatios ?? [];
      if (!possible || !cd || used >= possible || ratios.length < 5) continue;
      if (!targetsOpen || used / possible >= BELOW_MIDDLE * quartiles(ratios).lo) continue;
      // Where it sat ready longest: from a press plus its cooldown to the next press (or the end).
      const presses = r.mine.map(([s]) => s).sort((a, b) => a - b);
      const idle = [...presses.map((p, i) => ({ from: p + cd, to: presses[i + 1] ?? lastAliveSec })), ...(presses.length ? [] : [{ from: 0, to: lastAliveSec }])]
        .filter(x => x.to - x.from >= IDLE_MIN_SEC).sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
      if (!idle) continue;
      const untilEnd = idle.to >= lastAliveSec - 1;
      usage.push({
        id: `uses-${r.name}`, kind: 'cooldown', score: 58 + Math.min(8, 3 * (possible - used)), icon: r.icon, spellId: r.spellId,
        parts: used === 0
          ? [T('Press '), { t: 'spell', name: r.name, spellId: r.spellId, icon: r.icon }, T(' — it was never used this pull, and its cooldown allowed '), C(`${possible} presses`), T('.')]
          : [T('Press '), { t: 'spell', name: r.name, spellId: r.spellId, icon: r.icon }, T(' every time it is ready — it sat unused from '), C(fmtClock(idle.from)), ...(untilEnd ? [T(' to the end.')] : [T(' to '), C(fmtClock(idle.to)), T('.')])],
        evidence: `You: ${used} of the ${possible} presses its ${cdWords(cd)} cooldown allowed. The middle top player makes ${Math.round(100 * median(ratios))}% of theirs.`,
      });
    }
    usage.sort((a, b) => b.score - a.score);
    actions.push(...usage.slice(0, 1));

    const phaseAt = (t: number) => c.phases.find(p => t >= p.fromSec && t < p.toSec) ?? null;
    const isBreak = (name: string) => /intermission|transition/i.test(name);
    const shortPhase = (name: string) => name.replace(/\s*[:(].*$/, '').trim() || name;
    const timing: NextPullAction[] = [];
    for (const r of cooldownRows) {
      if (actions.some(a => a.id === `uses-${r.name}`)) continue;
      if (!targetsOpen) continue;
      const spell: PlanPart = { t: 'spell', name: r.name, spellId: r.spellId, icon: r.icon };
      let pick: NextPullAction | null = null;
      for (const p of r.timing?.presses ?? []) {
        const ph = c.phaseAligned ? phaseAt(p.med) : null;
        const inPhase = !!ph && ph.fromSec > 1;
        const into = ph ? p.med - ph.fromSec : 0;
        const phaseChip = ph ? (into < 8 ? shortPhase(ph.name) : `${round5(into)} seconds into ${shortPhase(ph.name)}`) : '';
        const where: PlanPart[] = inPhase ? [T(into < 8 ? ' at the start of ' : ' about '), C(phaseChip)] : [T(' around '), C(fmtClock(p.med))];
        const holdFor: PlanPart[] = inPhase ? [T(into < 8 ? ' for the start of ' : ' until about '), C(phaseChip)] : [T(' until around '), C(fmtClock(p.med))];
        const middle = `The middle half of top ${specs} press it between ${fmtClock(p.lo)} and ${fmtClock(p.hi)}${inPhase && ph ? ` on your pull's clock (${shortPhase(ph.name)} began at ${fmtClock(ph.fromSec)})` : ''}.`;
        let cand: NextPullAction | null = null;
        if (p.mineAt != null && !p.blocked && p.mineAt - p.hi >= LATE_SEC) {
          const late = Math.round(p.mineAt - p.med);
          cand = {
            id: `timing-${r.name}`, kind: 'timing', score: 50 + Math.min(10, late / 6), icon: r.icon, spellId: r.spellId,
            parts: [T('Press '), spell, ...where, T(': yours came at '), C(fmtClock(p.mineAt)), T(`, ${late} seconds after the top players'.`)],
            evidence: middle,
          };
        } else if (p.mineAt == null && p.blocked && p.heldBy != null && p.share >= 0.8) {
          // The cooldown was not back because of a press the top players do not make there.
          const myPh = phaseAt(p.heldBy);
          const during = myPh && ph && myPh.name !== ph.name ? `, during ${isBreak(myPh.name) ? 'the intermission' : shortPhase(myPh.name)},` : '';
          cand = {
            id: `timing-${r.name}`, kind: 'timing', score: 56, icon: r.icon, spellId: r.spellId,
            parts: [T('Hold '), spell, ...holdFor, T(': yours came at '), C(fmtClock(p.heldBy)), T(`${during} and was still on cooldown when the top players press theirs.`)],
            evidence: middle,
          };
        } else if (p.mineAt == null && !p.blocked && p.everyone && p.med <= (r.timing?.aliveSec ?? 0) - 15) {
          cand = {
            id: `timing-${r.name}`, kind: 'timing', score: 54, icon: r.icon, spellId: r.spellId,
            parts: [T('Press '), spell, ...where, T(' — every top player has pressed it by then, and yours never came.')],
            evidence: middle,
          };
        }
        if (cand && (!pick || cand.score > pick.score)) pick = cand;
      }
      if (pick) timing.push(pick);
    }
    timing.sort((a, b) => b.score - a.score);
    actions.push(...timing.slice(0, 1));
  }

  // 6. Typical numbers as targets: time spent casting, then cast rates.
  if (pool && c.judgeable && targetsOpen) {
    const active = quartiles(pool.activePct);
    if (c.activePct < active.lo - 2) {
      const gap = c.gaps.filter(g => !g.why || !/^you were (dead|already dead)/.test(g.why)).sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
      if (gap) {
        push({
          id: 'activity', kind: 'activity', score: 48 + Math.min(10, Math.round(active.lo - c.activePct) / 2), spell: { spellId: 0, icon: '' },
          parts: [T('Keep a cast going from '), C(`${fmtClock(gap.from)} to ${fmtClock(gap.to)}`), T(` — ${Math.round(gap.to - gap.from)} seconds with nothing cast, your longest gap${gap.why ? ` (${gap.why})` : ''}.`)],
          evidence: `Aim for about ${Math.round(median(pool.activePct))}% of the pull spent casting (you: ${Math.round(c.activePct)}%). The middle half of top ${specs} sit between ${Math.round(active.lo)}% and ${Math.round(active.hi)}%.`,
        });
      }
    }
    // A healer's cast counts follow the damage the raid took; they are not a target.
    if (player.role !== 'healer') {
      const whileAlive = (ts: number[]) => ts.filter(t => c.windows.some(([a, b]) => t >= a - 0.5 && t <= b + 0.5)).length;
      const rates: Array<{ name: string; mine: number; med: number; lo: number; hi: number; short: number }> = [];
      for (const [name, e] of Object.entries(pool.casts)) {
        if (buffFamily(name) !== name || /healthstone/i.test(name) || DEFENSIVES.has(defensiveKey(name)) || isUtility(name) || isMovement(name)) continue;
        const present = e.cpm.filter(x => x > 0);
        if (present.length / pool.n < 0.8 || !c.canPress(name)) continue;
        const med = median(e.cpm);
        if (med < 1.2) continue; // a cooldown: its presses are counted against the cooldown above
        const mineCount = profile.castTimes[name] ? whileAlive(profile.castTimes[name]) : profile.casts.find(x => x.name === name)?.total ?? 0;
        if (mineCount === 0) continue; // never pressed is a build or a never-used card, not a rate
        const mine = mineCount / aliveMinutes;
        const q = quartiles(present);
        if (mine < BELOW_MIDDLE * q.lo) rates.push({ name, mine, med, lo: q.lo, hi: q.hi, short: (med - mine) / med });
      }
      rates.sort((a, b) => b.short - a.short || b.med - a.med);
      if (c.debug) debug.rates = rates.map(r => `${r.name}: ${rate(r.mine)} vs ${rate(r.med)} [${rate(r.lo)}–${rate(r.hi)}]`);
      rates.slice(0, 2).forEach((r, i) => {
        push({
          id: `rate-${r.name}`, kind: 'rate', score: 44 - 6 * i + Math.min(5, Math.round(10 * r.short)), spell: spellOf(r.name),
          parts: [T('Aim for about '), C(target(r.med)), T(' '), S(r.name), T(` a minute (you: ${target(r.mine)}).`)],
          evidence: `The middle half of top ${specs} sit between ${target(r.lo)} and ${target(r.hi)}.${c.buildDiffers ? ' Your talents differ from most of theirs, so take the number as a guide.' : ''}`,
        });
      });
    }
  }

  // 7. Prep: potions and what was missing at the pull.
  if (pool && c.judgeable && c.poolPotions.length) {
    const med = Math.round(median(c.poolPotions));
    if (med >= 1 && c.myPotions < med) {
      const minePre = profile.buffs.some(b => buffFamily(b.name) === 'potion' && b.atPull);
      const wantPre = (c.prePotShare ?? 0) >= 0.5 && !minePre;
      // The top players' potions in combat (a pre-pull one is not in the log's casts), and
      // the first of those this player has no potion of their own for.
      const open = c.rows.find(r => r.origin === 'potion')?.timing?.presses.find(p => p.mineAt == null) ?? null;
      const wantLater = !!open && c.myPotions + (wantPre ? 1 : 0) < med;
      if (wantPre || wantLater) {
        const withLust = !!open && profile.lustSec != null && Math.abs(profile.lustSec - open.med) <= 20;
        const parts: PlanPart[] = [T('Use a combat potion')];
        if (wantPre) parts.push(T(' on the pull'));
        if (wantLater && open) parts.push(T(wantPre ? ' and one ' : ' '), ...(open.med <= 10 ? [T('in your opener, around '), C(fmtClock(open.med))] : withLust ? [T('with Bloodlust ('), C(fmtClock(profile.lustSec ?? open.med)), T(')')] : [T('around '), C(fmtClock(open.med))]));
        parts.push(T('.'));
        const potion = profile.casts.find(x => buffFamily(x.name) === 'potion') ?? Object.entries(pool.casts).filter(([name]) => buffFamily(name) === 'potion').map(([, e]) => e)[0];
        push({
          id: 'potions', kind: 'prep', score: 30, spell: { spellId: potion?.spellId ?? 0, icon: potion?.icon ?? '' }, parts,
          evidence: `You used ${c.myPotions}; the middle top player uses ${med}${c.prePotShare != null ? `, and ${Math.round(100 * c.prePotShare)}% of them have one running at the pull` : ''}.`,
        });
      }
    }
  }
  if (c.missingAtPull.length) {
    const m = c.missingAtPull;
    push({
      id: 'missing-at-pull', kind: 'prep', score: 34, spell: { spellId: 0, icon: '' },
      parts: [T('Have '), C(listWords(m.map(x => x.label))), T(' running before the pull.')],
      evidence: `${ucFirst(listWords(m.map(x => `${x.have} of ${x.n} top players have ${x.label}`)))} at 0:00; you did not.`,
    });
  }

  actions.sort((a, b) => b.score - a.score);
  // Three lines, and no more than two of one kind.
  const picked: NextPullAction[] = [];
  for (const a of actions) {
    if (picked.length >= MAX_ACTIONS) break;
    if (picked.filter(p => p.kind === a.kind).length >= 2) continue;
    picked.push(a);
  }
  const played = picked.filter(a => a.kind !== 'prep');
  const good = c.findings.filter(f => f.severity === 'good' && /^(timing-good|uses-good|clean-mechanics|tank-hits-ok|matched-casts|defensive-usage-ok)$/.test(f.id)).map(f => f.title.replace(/\.$/, ''));
  // With nothing to plan: say so, without contradicting the cards further down the page.
  const cards = c.findings.filter(f => (f.severity === 'bad' || f.severity === 'warn') && f.category !== 'prep' && f.category !== 'gear' && f.id !== 'output').length;
  const clean = played.length ? null
    : cards ? `No change of plan for the next pull${targetsOpen ? '' : ': your numbers are already in the top players\' range'}. What is under "Fix these first" is fine-tuning.`
    : `Nothing to change in how you played this pull — keep doing this.${good.length ? ` ${good.slice(0, 2).join('. ')}.` : ''}`;
  if (c.debug) Object.assign(debug, { targetsOpen, candidates: actions.map(a => `${Math.round(a.score)} ${a.id} | ${planText(a.parts)} || ${a.evidence}`) });
  return { actions: picked, clean, defensivePlan, debug };
}

// ─── Plain text ───────────────────────────────────────────────────────────────

export const approxTimes = (ts: number[], max = 5) => `≈${ts.slice(0, max).map(fmtClock).join(', ')}${ts.length > max ? '…' : ''}`;
export const cooldownWords = cdWords;

// "Divine Protection each time (1-min cooldown), then Divine Shield at 4:10 (5-min cooldown)".
export function assignWords(r: DefensivePlanRow): string {
  return r.assign.map(a => `${a.spell.name}${r.times.length > 1 ? (a.times.length === r.times.length ? ' each time' : ` at ${a.times.map(fmtClock).join(', ')}`) : ''} (${cdWords(a.cooldownSec)} cooldown${a.charges > 1 ? `, ${a.charges} charges` : ''})`).join(', then ');
}

export function defensiveRowText(r: DefensivePlanRow): string {
  const head = `${r.ability.name} (${approxTimes(r.times)})`;
  const what = r.kind === 'dodge' ? 'step out of it, no defensive' : r.kind === 'skip' ? 'nothing of yours is free for it' : assignWords(r);
  return `${head}: ${[what, r.poolNote].filter(Boolean).join(' — ')}`;
}
