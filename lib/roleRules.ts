import { aliveWindowsOf, isAliveAt } from './analyze';
import type { FightPlayer, PlayerProfile, PoolSummary, ReportFight, TankHit } from './analyze';
import type { Finding, ReviewStat, Severity } from './analyzeRules';
import { BELOW_ALL, buffFamily, fmtClock, fmtNum, lifeWords, lowestOf, median, plural, ucFirst } from './analyzeRules';
import type { MechanicType } from './bossMechanics';
import { DEFENSIVES, defensiveKey } from './defensives';

// ─── Log review: what a tank and a healer are judged on ─────────────────────────
//
// reviewPlayer (lib/analyzeRules.ts) compares every role with the top players' casts,
// buffs and damage. That reads a tank as a damage dealer who happens to be hit a lot
// and a healer as an HPS number. This file adds the checks that belong to the role:
//
//   tanks    were the tank hits taken with mitigation running; is active mitigation
//            kept up like the top tanks keep it; damage taken per second as context;
//            what was running when they died; and a verdict that puts survival first.
//   healers  overhealing against the top healers; raid deaths that came while a raid
//            cooldown of theirs was ready; a raid cooldown never pressed; and an
//            output card that does not treat HPS as a grade.
//
// Same stance as the rest of the review: nothing here knows a spec or a boss.
//   · "Active mitigation" is DISCOVERED: a self-buff that nearly every top tank of the
//     spec carries and re-applies at least once a minute, whose aura text on Wowhead reads
//     as damage reduction (armor, block, parry, absorb…). See mitigationCandidates and
//     readsAsMitigation. The only hand-written piece is that wording test, which is about
//     how Blizzard words damage reduction, not about any class. (Found this way so far:
//     Shield Block and Ignore Pain, Ironfur, Bone Shield and Blood Shield.)
//   · A tank's own cooldowns and a healer's raid cooldowns come from lorrgs' TANK and
//     RAID_CD tags; mechanic types from DBM and the top raids (classifyAbility).
//
// Pure functions: profile + pool + the facts gathered by lib/roleData.ts in, findings
// and a few adjustments to the generic review out. Every check stays silent when its
// sample is thin, and anything that could be someone else's doing (a healer's HPS, a
// death next to a ready cooldown, a tank's damage intake) is context, not a fault.

export interface TankRoleData {
  // The spec's active mitigation, with every aura id it is logged under.
  mitigation: Array<{ name: string; ids: number[] }>;
  // lorrgs' tank cooldowns for the spec (some never show as a buff on the tank:
  // Demoralizing Shout is a debuff on the boss, so its cast time and duration cover it).
  tankSpells: Array<{ name: string; ids: number[]; duration: number }>;
  // Aura id → what it is, for the ids each hit was checked against.
  auras: Record<string, { name: string; kind: 'mitigation' | 'defensive' | 'external' }>;
  // The abilities whose hits were fetched (spell id → name); id 1 is a melee swing.
  abilities: Record<string, string>;
  // null when the events could not be read: the hit check then says nothing.
  hits: TankHit[] | null;
  // Every buff that was shaped like active mitigation, and what its tooltip said (debug).
  considered?: Array<{ name: string; mitigation: boolean }>;
}

export interface HealerRoleData {
  raidCooldowns: Array<{ name: string; ids: number[]; cooldown: number }>;
}

export interface RoleData { tank?: TankRoleData; healer?: HealerRoleData }

export const MELEE_ID = 1;
const PRESENT = 0.8; // the review's consensus share: what "the top players do" means everywhere else

const pct = (x: number) => `${Math.round(x)}%`;
const listNames = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
const orNames = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
const quartiles = (xs: number[]) => {
  const a = xs.slice().sort((x, y) => x - y);
  return { lo: a[Math.floor(a.length * 0.25)] ?? 0, hi: a[Math.min(a.length - 1, Math.floor(a.length * 0.75))] ?? 0 };
};
// Externals that are throughput, not protection (the same set analyzeRules leaves out of "an external was on you").
const NOT_PROTECTIVE = /power infusion|blessing of summer|blessing of autumn|innervate|spatial paradox/i;

// ─── Discovering active mitigation ────────────────────────────────────────────

// How Blizzard words damage reduction on an aura: armor, block, parry and dodge, absorbs,
// Ignore Pain's "ignoring 50% of damage", stagger, and "damage taken reduced". This is
// the one hand-written test here; it describes tooltip language, not a spec. It is run
// on the AURA's text ("Armor increased by…"), not the spell's: a spell tooltip lists
// every talent that touches it, and Avatar read as mitigation that way.
const MITIGATION_HARD = /\b(armor (is )?increased|increas\w+ (your )?armor|block chance|block(s|ing)? (all |every )?(melee )?attacks|parry chance|chance to parry|dodge chance|chance to dodge|absorb\w*|ignoring \d+% of (all )?damage|stagger)\b/i;
const MITIGATION_PERCENT = /\b(?:damage (?:you take|taken)(?: is)? (?:reduced|decreased)|(?:reduc|decreas)\w+ (?:all |the |your )?(?:physical |magic(?:al)? )?damage (?:you take|taken))(?: by (\d+(?:\.\d+)?)%)?/i;
// A stated reduction under 10% is a passive trickle (a talent that shaves 2–8% while you
// do your rotation), not something pressed for a hit. Wowhead prints 0% where the value
// scales with a stat, so 0 is "unknown" and still counts.
const MITIGATION_MIN_PERCENT = 10;
export function readsAsMitigation(text: string | null | undefined): boolean {
  if (!text) return false;
  if (MITIGATION_HARD.test(text)) return true;
  const m = text.match(MITIGATION_PERCENT);
  if (!m) return false;
  const stated = m[1] != null ? Number(m[1]) : 0;
  return !(stated > 0 && stated < MITIGATION_MIN_PERCENT);
}

// Re-applied at least once a minute and up at least a fifth of the fight, for the middle
// top tank: that is a short buff being maintained. A passive aura is applied once (far
// under one a minute), a two-minute cooldown is up less than a fifth of the time, and
// both have their own handling (nothing, and the defensive roster).
const MITIGATION_MIN_USES_PER_MIN = 1;
const MITIGATION_MIN_UPTIME = 20;
const MITIGATION_MAX_LOOKUPS = 16;

// Self-buffs shaped like active mitigation in the top tanks' logs. Whether each one IS
// mitigation is Wowhead's call (readsAsMitigation on its tooltip), made by the caller.
// Needs the tank pool's per-member application counts; without them, nothing.
export function mitigationCandidates(pool: PoolSummary | null | undefined): Array<{ name: string; spellId: number }> {
  if (!pool || pool.n < 5) return [];
  const out: Array<{ name: string; spellId: number; up: number }> = [];
  for (const [name, e] of Object.entries(pool.buffs)) {
    if (!e.usesPerMin || !e.spellId) continue;
    if (buffFamily(name) !== name) continue; // flasks, food, potions
    if (e.uptimePct.filter(x => x > 0).length / pool.n < PRESENT) continue;
    if (median(e.usesPerMin) < MITIGATION_MIN_USES_PER_MIN) continue;
    const up = median(e.uptimePct);
    if (up < MITIGATION_MIN_UPTIME) continue;
    out.push({ name, spellId: e.spellId, up });
  }
  return out.sort((a, b) => b.up - a.up).slice(0, MITIGATION_MAX_LOOKUPS).map(({ name, spellId }) => ({ name, spellId }));
}

// The boss abilities whose hits on this tank are worth fetching: the ones typed as a
// tank mechanic or as the hit to press a defensive for, plus melee swings.
export function tankHitAbilities(profile: PlayerProfile, kindOf: (name: string, spellId?: number) => MechanicType | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of profile.damageTaken) {
    if (/^melee$/i.test(t.name)) { out[String(MELEE_ID)] = 'Melee'; continue; }
    const kind = kindOf(t.name, t.spellId);
    if (kind !== 'tank' && kind !== 'defensive') continue;
    // A debuff the tank carries that pulses once a second logs every pulse as a hit
    // (Stone Venom on Ula'tek: 201 "hits" from two applications). Damage that shares its
    // name with a debuff on the player and lands more than twice per application is that
    // debuff ticking, not a hit mitigation is timed for.
    const debuff = profile.debuffs.find(d => d.name === t.name);
    if (debuff && t.hits > 2 * Math.max(1, debuff.count)) continue;
    for (const x of t.byId) if (x.spellId > 0 && x.hits > 0) out[String(x.spellId)] = t.name;
  }
  return out;
}

// Every aura worth knowing about at a tank hit: the discovered mitigation, the tank's
// defensive cooldowns (the hand-kept defensive names plus lorrgs' TANK-tagged spells)
// and protective externals other players put on them.
export function tankAuraPlan(profile: PlayerProfile, pool: PoolSummary | null | undefined, mitigationNames: string[], tankSpells: TankRoleData['tankSpells']): Pick<TankRoleData, 'mitigation' | 'auras'> {
  const auras: TankRoleData['auras'] = {};
  const mitigation = mitigationNames.map(name => {
    const ids = [...new Set([...(profile.buffs.find(b => b.name === name)?.ids ?? []), pool?.buffs[name]?.spellId ?? 0])].filter(x => x > 0);
    for (const id of ids) auras[String(id)] = { name, kind: 'mitigation' };
    return { name, ids };
  });
  const tankNames = new Set(tankSpells.map(s => s.name));
  for (const b of profile.buffs) {
    if (!DEFENSIVES.has(defensiveKey(b.name)) && !tankNames.has(b.name)) continue;
    for (const id of b.ids ?? [b.spellId]) if (id > 0 && !auras[String(id)]) auras[String(id)] = { name: b.name, kind: 'defensive' };
  }
  for (const s of tankSpells) for (const id of s.ids) if (id > 0 && !auras[String(id)]) auras[String(id)] = { name: s.name, kind: 'defensive' };
  for (const x of profile.externals ?? []) {
    if (NOT_PROTECTIVE.test(x.name) || !x.spellId || auras[String(x.spellId)]) continue;
    auras[String(x.spellId)] = { name: x.name, kind: 'external' };
  }
  return { mitigation, auras };
}

// ─── The role review ──────────────────────────────────────────────────────────

export interface RoleContext {
  player: FightPlayer;
  fight: ReportFight;
  profile: PlayerProfile;
  // The pool as the rules use it (same hero talents, phase-aligned), and its members on
  // this fight's difficulty, for anything measured in damage or healing.
  pool: PoolSummary | null;
  dmgIdx: number[];
  role: RoleData | null | undefined;
  kindOf: (name: string, spellId?: number) => MechanicType | undefined;
  isWipeDeath: (d: { killer: string; atSec: number }) => boolean;
  // False for an ability this player's build or gear does not have.
  canJudge: (name: string) => boolean;
  cooldowns: Record<string, number> | null | undefined;
  // The generic findings so far, for the ones a role check replaces or rewords.
  findings: readonly Finding[];
  perSec: number;
  outputRatio: number | null;
  judgeable: boolean;
  specLabel: string;
}

export interface RoleResult {
  findings: Finding[];
  stats: ReviewStat[];                       // tiles that lead the stat row
  drop: string[];                            // generic findings these replace
  patch: Record<string, Partial<Pick<Finding, 'severity' | 'title' | 'text' | 'impact' | 'cost'>>>;
  append: Record<string, string>;            // text added to an existing finding
  verdict: string | null;
  strong: boolean | null;
  poolNote: string | null;
  debug: Record<string, unknown>;
}

const empty = (): RoleResult => ({ findings: [], stats: [], drop: [], patch: {}, append: {}, verdict: null, strong: null, poolNote: null, debug: {} });

export function reviewRole(c: RoleContext): RoleResult | null {
  if (c.player.role === 'tank') return reviewTank(c);
  if (c.player.role === 'healer') return reviewHealer(c);
  return null;
}

// ─── Tanks ────────────────────────────────────────────────────────────────────

// Below four hits one uncovered hit is a quarter of the sample or more: too few to call a pattern.
const TANK_HITS_MIN = 4;
// Two or more bare hits AND a fifth of all of them: one bare hit is a swap edge or a
// global cooldown; a fifth of the tank hits with nothing running is how the pull was played.
// Measured on Mythic Ula'tek kills (raw events, 2026-11-13): the #1 Protection Warrior
// and #1 Guardian Druid had no bare hit; of 18 tanks ranked around 90th–100th, fifteen
// had 0–7% bare and three had 25–54%. The line sits in the gap between the two groups.
const TANK_BARE_MIN = 2;
const TANK_BARE_SHARE = 0.2;
// Bare hits count against the tank only where they were measurably bigger than the
// covered hits of the same ability: a tenth more got through. Under that, mitigation
// made no difference to these hits (armor against a spell) and the card is a note.
const TANK_BARE_HARDER = 1.1;
// Melee coverage is only quoted from a real sample of swings.
const TANK_MELEE_MIN = 20;
// Low uptime: under 60% of the top tanks' median, the line the generic uptime rule
// draws. On its own that is only a note: uptime follows how much of the pull a tank
// holds the boss, and the #1 Protection Warrior on Mythic Ula'tek sits at 66% of the
// pool's Ignore Pain median with 94% of tank hits covered. It becomes a fault when the
// hit check agrees (tank hits landed bare), or — where the boss has no direct tank hit
// to check — only when it is under half the median, a looser line because there is no
// second piece of evidence behind it.
const MITIGATION_LOW = 0.6;
const MITIGATION_VERY_LOW = 0.5;
const MITIGATION_MATCHED = 0.9;
// A mitigation buff the middle top tank has up under 30% of the fight is a situational
// press, not something to hold someone's uptime against.
const MITIGATION_JUDGED_UPTIME = 30;
// Damage-taken-per-second needs a handful of same-difficulty tanks to mean anything.
const DTPS_MIN_MEMBERS = 5;
// A tank is "strong" on survival; damage only has to be in the same league. 70% of the
// median rather than the 90% used for damage dealers, because the pool is the top tanks
// BY DAMAGE (the only tank ranking Warcraft Logs keeps) and a tank's damage moves with
// how much of the fight they hold the boss.
const TANK_STRONG_RATIO = 0.7;

function reviewTank(c: RoleContext): RoleResult {
  const out = empty();
  const { profile, pool } = c;
  const t = c.role?.tank;
  const aliveSec = profile.aliveMs / 1000;
  const durationSec = profile.durationMs / 1000;
  const realDeaths = profile.deaths.filter(d => !c.isWipeDeath(d));
  const mitNames = (t?.mitigation ?? []).map(m => m.name);
  const topTanks = `the top ${c.specLabel}s`;

  // What was running at a hit: the auras the event itself lists, plus a tank cooldown
  // that leaves no buff on the tank, by its cast time and lorrgs' duration (8s when
  // lorrgs gives none — the shortest of its tank cooldowns).
  const runningAt = (h: TankHit): Array<{ name: string; kind: 'mitigation' | 'defensive' | 'external' }> => {
    const seen = new Map<string, 'mitigation' | 'defensive' | 'external'>();
    for (const id of h.auras) { const a = t?.auras[String(id)]; if (a && !seen.has(a.name)) seen.set(a.name, a.kind); }
    for (const s of t?.tankSpells ?? []) {
      if (seen.has(s.name)) continue;
      if ((profile.castTimes[s.name] ?? []).some(x => x <= h.atSec && h.atSec <= x + (s.duration || 8))) seen.set(s.name, 'defensive');
    }
    return [...seen.entries()].map(([name, kind]) => ({ name, kind }));
  };

  // ── Tank hits with nothing running ──
  // Direct hits only: a ticking debuff is not something mitigation is timed for. Every
  // hit counts, in every life: only a living tank is hit.
  const hits = t?.hits ?? [];
  const direct = hits.filter(h => h.spellId !== MELEE_ID && !h.tick);
  const melee = hits.filter(h => h.spellId === MELEE_ID);
  let hitsJudged: { covered: number; total: number } | null = null;
  let hitsWarn = false;
  if (t?.hits && mitNames.length && direct.length >= TANK_HITS_MIN) {
    // A hit a shield soaked at least half of was covered too, whoever cast the shield
    // (most healer absorbs are not on lorrgs' externals list, so no aura names them).
    const judged = direct.map(h => {
      const running = runningAt(h);
      if (!running.length && h.absorbed > 0 && h.absorbed >= h.amount) running.push({ name: 'an absorb shield', kind: 'external' });
      return { h, running };
    });
    const bare = judged.filter(x => !x.running.length);
    const covered = judged.length - bare.length;
    hitsJudged = { covered, total: judged.length };
    const abilityNames = [...new Set(direct.map(h => t.abilities[String(h.spellId)]).filter(Boolean))];
    const what = abilityNames.length === 1 ? abilityNames[0] : 'tank';
    const landed = (h: TankHit) => `${fmtNum(h.amount)}${h.absorbed ? ` (${fmtNum(h.absorbed)} more absorbed)` : ''}`;
    const means = `Mitigation here means your active mitigation (${listNames(mitNames.slice(0, 3))}: the short buffs ${topTanks} keep re-applying), a defensive cooldown, an external from a healer or an absorb shield that took at least half the hit.`;
    // Did going bare cost anything? Ability by ability, the bare hits against the covered
    // hits of the same ability, on what got past mitigation (damage plus what shields
    // then absorbed). Armor does nothing against a spell: where the bare hits were no
    // bigger than the covered ones, this tank's mitigation does not work on these hits,
    // and saying "you took them bare" would blame them for nothing. Unknown (null) when
    // no ability has both kinds of hit.
    const through = (h: TankHit) => h.amount + h.absorbed;
    let bareSum = 0, bareExpected = 0, bareCompared = 0;
    for (const id of new Set(direct.map(h => h.spellId))) {
      const b = bare.filter(x => x.h.spellId === id).map(x => x.h);
      const cv = judged.filter(x => x.running.length && x.h.spellId === id).map(x => x.h);
      if (!b.length || !cv.length) continue;
      bareSum += b.reduce((s, h) => s + through(h), 0);
      bareExpected += b.length * cv.reduce((s, h) => s + through(h), 0) / cv.length;
      bareCompared += b.length;
    }
    const harder = bareCompared && bareExpected > 0 ? bareSum / bareExpected : null;
    const costNote = harder == null ? ''
      : harder >= TANK_BARE_HARDER
        ? ` They hit harder for it: ${fmtNum(bareSum / bareCompared)} got past your mitigation on average, against ${fmtNum(bareExpected / bareCompared)} for the same abilities with something running.`
        : ` They hit no harder than the covered ones (${fmtNum(bareSum / bareCompared)} against ${fmtNum(bareExpected / bareCompared)} on average), so on this boss your mitigation does little against these hits and nothing was lost.`;
    const typed = abilityNames.length > 1 ? ` Tank hits on this boss: ${listNames(abilityNames.slice(0, 4))}.` : '';
    if (bare.length >= TANK_BARE_MIN && bare.length / judged.length >= TANK_BARE_SHARE) {
      const fault = harder == null || harder >= TANK_BARE_HARDER;
      hitsWarn = fault;
      out.findings.push({
        id: 'tank-hits', severity: fault ? 'warn' : 'info', category: 'survival', impact: fault ? 62 + Math.min(15, bare.length * 2) : 32,
        // In the short version: below a death (12) and a repeated avoidable mechanic (8),
        // above the other survival notes (6) — for a tank this is the job itself.
        cost: fault ? 7 : undefined,
        title: `${bare.length} of ${judged.length} ${what} hits landed with no mitigation running`,
        text: `${means} ${bare.length === judged.length ? 'None of the hits had any of them' : `Those ${bare.length} had none of them`}: ${bare.slice(0, 6).map(x => fmtClock(x.h.atSec)).join(', ')}${bare.length > 6 ? ` and ${bare.length - 6} more` : ''}.${costNote}${typed}`,
        evidence: `${covered} of ${judged.length} hits taken with something running`,
        events: bare.slice(0, 12).map(x => ({ atSec: x.h.atSec, text: `${t.abilities[String(x.h.spellId)] ?? 'Tank hit'} for ${landed(x.h)} — no mitigation, defensive or external running` })),
      });
    } else {
      const common = new Map<string, number>();
      for (const x of judged) for (const r of x.running) common.set(r.name, (common.get(r.name) ?? 0) + 1);
      const top = [...common.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, k]) => `${n} for ${k}`);
      out.findings.push({
        id: 'tank-hits-ok', severity: 'good', category: 'survival', impact: 26,
        title: bare.length ? `${covered} of ${judged.length} ${what} hits taken with mitigation running` : `Every ${what} hit taken with mitigation running`,
        text: `${means} What was up: ${top.join(', ')} of the ${judged.length} hits.${bare.length === 1 ? ` The one without was at ${fmtClock(bare[0].h.atSec)}.` : bare.length ? ` The ${bare.length} without were at ${bare.slice(0, 5).map(x => fmtClock(x.h.atSec)).join(', ')}${bare.length > 5 ? ' and later' : ''}.` : ''}${typed}`,
      });
    }
  }

  // ── Active mitigation uptime against the top tanks ──
  const meleeCover = melee.length >= TANK_MELEE_MIN && mitNames.length
    ? melee.filter(h => runningAt(h).some(r => r.kind !== 'external')).length / melee.length : null;
  let mitigationWarn = false;
  // The buff table's uptime covers the whole pull and a dead tank carries no mitigation,
  // so it goes over the total time alive (profile.aliveMs: every life, not just the first).
  if (pool && c.judgeable && mitNames.length) {
    const rows = mitNames.map(name => {
      const e = pool.buffs[name];
      const mine = profile.buffs.find(b => b.name === name);
      return { name, med: e ? median(e.uptimePct) : 0, lowest: e ? lowestOf(e.uptimePct) : 0, mine: mine ? Math.min(100, 100 * mine.uptimeMs / profile.aliveMs) : 0, has: !!mine };
    }).filter(r => r.med >= MITIGATION_JUDGED_UPTIME && (r.has || c.canJudge(r.name))).sort((a, b) => b.med - a.med).slice(0, 3);
    if (rows.length) {
      const worst = rows.slice().sort((a, b) => a.mine / a.med - b.mine / b.med)[0];
      const low = worst.mine < MITIGATION_LOW * worst.med;
      const matched = rows.every(r => r.mine >= MITIGATION_MATCHED * r.med);
      // Without a hit check behind it: under half the median AND under every top tank (see
      // BELOW_ALL in analyzeRules), since the top tanks' own uptimes spread widely — Ignore
      // Pain runs from 37% to well over 56% among the top 30 Protection Warriors.
      const fault = low && (hitsJudged ? hitsWarn : worst.mine < MITIGATION_VERY_LOW * worst.med && worst.mine < BELOW_ALL * worst.lowest);
      mitigationWarn = fault;
      const sev: Severity = fault ? 'warn' : matched ? 'good' : 'info';
      const detail = rows.map(r => `${r.name} ${pct(r.mine)} (top tanks ${pct(r.med)})`).join(', ');
      const meleeNote = meleeCover != null ? ` ${pct(100 * meleeCover)} of the ${melee.length} melee swings that connected landed while mitigation or a defensive was running.` : '';
      out.findings.push({
        id: 'tank-mitigation', severity: sev, category: 'survival', impact: fault ? 52 : matched ? 24 : 30,
        // A real gap in a tank's main job, but an uptime figure, not a death: below the tank-hit card.
        cost: fault ? 4 : undefined,
        title: low
          ? `${worst.name} up ${pct(worst.mine)} of the time; ${topTanks} keep it up ${pct(worst.med)}`
          : matched ? 'Active mitigation kept up like the top tanks' : `Active mitigation a little under the top tanks`,
        text: `Active mitigation is read from the logs: the short defensive buffs nearly every one of ${topTanks} re-applies all fight. Yours, over the time you were alive: ${detail}.${meleeNote}${low && !fault ? ' Uptime follows how much of the pull you were the one tanking, and the tank hits themselves were covered, so this is a number to know rather than a mistake.' : low ? ' Uptime follows how much of the pull you were the one tanking, but this is further under than a tank swap explains.' : ''}`,
      });
      // The generic uptime rule would say the same thing in damage-dealer words.
      out.drop.push(...mitNames.map(n => `uptime-${n}`));
    }
  }

  // ── Damage taken per second: context ──
  let dtpsStat: ReviewStat | null = null;
  if (pool && c.judgeable && c.dmgIdx.length >= DTPS_MIN_MEMBERS && aliveSec >= 0.6 * durationSec) {
    const mine = profile.damageTaken.reduce((s, x) => s + x.total, 0) / aliveSec;
    const theirs = c.dmgIdx.map(i => Object.values(pool.taken).reduce((s, e) => s + (e.perMin[i] ?? 0), 0) / 60).filter(x => x > 0);
    if (mine > 0 && theirs.length >= DTPS_MIN_MEMBERS) {
      const med = median(theirs);
      const q = quartiles(theirs);
      dtpsStat = { label: 'Damage taken', value: `${fmtNum(mine)}/s`, note: `top tanks ~${fmtNum(med)}/s` };
      out.findings.push({
        id: 'tank-dtps', severity: 'info', category: 'survival', impact: 34,
        title: `You took ${fmtNum(mine)} damage per second; ${topTanks} take about ${fmtNum(med)}`,
        text: `The middle half of the ${theirs.length} on this difficulty take between ${fmtNum(q.lo)} and ${fmtNum(q.hi)} a second. This is context, not a grade: what a tank takes depends on how the two tanks split the boss, how many absorbs and externals the healers put on them and how long the pull runs. ${mine > q.hi ? (hitsWarn || mitigationWarn ? 'You are above their range, and the mitigation cards above are the first place to look for why.' : 'You are above their range; with your mitigation in order, that usually means you held the boss for more of the pull or had fewer absorbs on you.') : mine < q.lo ? 'You are below their range, which usually means the other tank held the boss for more of the pull.' : 'You are inside their range.'}`,
      });
    }
  }

  // ── A tank's death: what was and was not running ──
  profile.deaths.forEach((d, i) => {
    if (c.isWipeDeath(d) || !mitNames.length) return;
    const recap = profile.deathRecaps?.find(x => Math.abs(x.atSec - d.atSec) < 0.5);
    if (!recap || !recap.hits.length) return;
    const up = mitNames.filter(n => recap.aurasAtDeath.some(a => a.name === n));
    const mit = up.length ? `${listNames(up)} ${up.length === 1 ? 'was' : 'were'} up at the killing blow` : `no active mitigation (${orNames(mitNames.slice(0, 3))}) was up at the killing blow`;
    // Healing in the window is the healers' half of a tank death.
    const heal = recap.healCount === 0 ? ' Nothing was healed onto you in those ten seconds, so this death was not only yours to prevent.' : '';
    out.append[`death-${i}`] = ` As the tank: ${mit}.${heal}`;
  });

  // ── Framing: survival first ──
  const dps = `${fmtNum(c.perSec)} DPS${c.outputRatio != null && pool ? `, ${pct(100 * c.outputRatio)} of the top-${pool.n} median` : ''}`;
  const lived = realDeaths.length === 0 ? (profile.deaths.length ? 'Alive until the wipe' : 'Alive the whole pull') : ucFirst(lifeWords(profile) ?? `dead at ${fmtClock(realDeaths[0].atSec)}`);
  // Survival leads; the tank-hit card reaches the short version on its own cost (as a
  // problem) or as the strength, so it is not repeated here.
  out.verdict = `${lived}; ${dps}`;
  out.strong = realDeaths.length === 0 && !hitsWarn && !mitigationWarn && (c.outputRatio == null || c.outputRatio >= TANK_STRONG_RATIO);
  if (hitsJudged) out.stats.push({ label: 'Tank hits', value: `${hitsJudged.covered}/${hitsJudged.total}`, note: 'with mitigation up' });
  if (dtpsStat) out.stats.push(dtpsStat);
  if (pool && c.outputRatio != null) {
    const r = c.outputRatio;
    out.patch.output = {
      // Never a fault on its own: a tank behind on damage costs the raid seconds, not the kill.
      severity: r >= 0.85 ? 'good' : 'info',
      text: `Damage is a tank's second job. ${r >= 0.85 ? 'Yours is level with the best tank parses on this boss.' : 'The gap is to the tanks who do the most damage on this boss, which is how Warcraft Logs ranks tanks; it shortens the fight, but nothing in this review ranks it above staying alive and taking the tank hits well.'}${r < 0.85 && aliveSec < durationSec - 5 ? ` You were dead for ${fmtClock(durationSec - aliveSec)} of a ${fmtClock(durationSec)} pull, which is part of the gap.` : ''}`,
    };
    out.poolNote = `Tanks are compared with the top ${c.specLabel}s by damage, the only tank ranking Warcraft Logs keeps: they are strong tanks, not a list of who survives best, so the survival comparisons say what good tanks do, not what the best-surviving ones do.`;
  }
  out.debug = {
    mitigation: t?.mitigation ?? null, considered: (t?.considered ?? []).map(x => `${x.name}: ${x.mitigation ? "mitigation" : "no"}`), tankSpells: (t?.tankSpells ?? []).map(s => s.name), hitAbilities: t?.abilities ?? null,
    hits: t?.hits ? { all: t.hits.length, direct: direct.length, melee: melee.length, ticks: hits.filter(h => h.tick).length } : null,
    hitsJudged, meleeCover,
  };
  return out;
}

// ─── Healers ──────────────────────────────────────────────────────────────────

// Overheal is compared only against a handful of same-difficulty healers.
const OVERHEAL_MIN_MEMBERS = 5;
// A cooldown under half a minute is a rotational button, not a raid cooldown to hold.
const RAID_CD_MIN_SEC = 30;
// "You never used X" needs every top healer to use it and at least eight of them: the
// same bar the generic never-used rule was tuned to by leave-one-out.
const NEVER_MIN_POOL = 8;
// Healing parses come from raids that took more damage, so "strong" for a healer is
// 75% of the median, not the 90% asked of a damage dealer.
const HEALER_STRONG_RATIO = 0.75;
// The cast-rate bands of the generic rule: from 1.2 casts a minute up it is a rotational
// or situational button, whose count follows how much there was to heal.
const ROTATIONAL_CPM = 1.2;

function reviewHealer(c: RoleContext): RoleResult {
  const out = empty();
  const { profile, pool, player } = c;
  const aliveSec = profile.aliveMs / 1000;
  const durationSec = profile.durationMs / 1000;
  const realDeaths = profile.deaths.filter(d => !c.isWipeDeath(d));
  const topHealers = `the top ${c.specLabel}s`;
  const raidCds = c.role?.healer?.raidCooldowns ?? [];
  const windows = aliveWindowsOf(profile);
  const usesWhileAlive = (name: string) => (profile.castTimes[name] ?? []).filter(x => isAliveAt(windows, x)).sort((a, b) => a - b);

  // ── Overhealing ──
  const total = profile.outputTotal + (profile.overheal ?? 0);
  if (profile.overheal != null && total > 0 && c.judgeable) {
    const mine = 100 * profile.overheal / total;
    const theirs = pool?.overhealPct ? c.dmgIdx.map(i => pool.overhealPct![i] ?? 0).filter(x => x > 0) : [];
    if (theirs.length >= OVERHEAL_MIN_MEMBERS) {
      const med = median(theirs);
      const q = quartiles(theirs);
      out.stats.push({ label: 'Overheal', value: pct(mine), note: `top healers ~${pct(med)}` });
      const inLine = mine <= q.hi;
      out.findings.push({
        id: 'healer-overheal', severity: inLine ? 'good' : 'info', category: 'output', impact: inLine ? 14 : 32,
        title: inLine
          ? `Overhealing in line with the top healers: ${pct(mine)} of your healing, theirs about ${pct(med)}`
          : `${pct(mine)} of your healing was overheal; ${topHealers} run about ${pct(med)}`,
        text: `Overheal is healing that landed on a health bar that was already full. The middle half of the ${theirs.length} top healers on this difficulty sit between ${pct(q.lo)} and ${pct(q.hi)}.${inLine ? '' : ' Some of the gap is not yours: their raids took more damage, so less of their healing had nowhere to go, and a raid with more healers overheals more. The rest is casts that went to people who did not need them; the healing tab on Warcraft Logs shows which spells overhealed most.'}`,
      });
    } else {
      out.stats.push({ label: 'Overheal', value: pct(mine) });
    }
  }

  // ── Raid deaths with a raid cooldown ready ──
  // Only cooldowns pressed at least once this pull: a press is the proof they have it.
  const mineCds = raidCds.map(s => {
    const cast = profile.casts.find(x => s.ids.includes(x.spellId) || x.name === s.name);
    const times = cast ? usesWhileAlive(cast.name) : [];
    const wowhead = cast ? c.cooldowns?.[cast.name] ?? 0 : 0;
    const cd = wowhead >= RAID_CD_MIN_SEC ? wowhead : s.cooldown;
    return cast && times.length && cd >= RAID_CD_MIN_SEC ? { name: cast.name, cd, times } : null;
  }).filter((x): x is { name: string; cd: number; times: number[] } => !!x);
  if (mineCds.length) {
    // Raidmates' deaths this healer was alive for; not the wipe itself, and not a death
    // to something typed as dodgeable (no cooldown heals a missed dodge).
    const deaths = profile.raidDeaths.filter(d => d.id !== player.id && isAliveAt(windows, d.atSec) && !c.isWipeDeath(d) && c.kindOf(d.killer, d.killerSpellId) !== 'avoid');
    const rows = deaths.map(d => {
      const ready = mineCds.map(cd => {
        const last = cd.times.filter(x => x <= d.atSec).pop();
        // Ready: never pressed so far, or the last press is a full cooldown back. Talents
        // that shorten a cooldown only make this stricter than the truth.
        return last == null || d.atSec - last >= cd.cd ? { name: cd.name, last: last ?? null } : null;
      }).filter((x): x is { name: string; last: number | null } => !!x);
      return { d, ready };
    });
    const hit = rows.filter(r => r.ready.length);
    if (hit.length) {
      const names = [...new Set(hit.flatMap(r => r.ready.map(x => x.name)))];
      out.findings.push({
        id: 'healer-cds-at-deaths', severity: 'info', category: 'cooldowns', impact: 36,
        title: `${hit.length} of ${plural(deaths.length, 'raid death')} came while ${orNames(names.slice(0, 2))} was ready`,
        text: `Ready means off cooldown, going by Wowhead's cooldown and your own presses in this pull. It does not mean it would have saved anyone: a one-shot is over before a cooldown lands, and raid cooldowns are usually planned for set moments. It is worth a look where the damage was sustained and the cooldown had no later job. Deaths to dodgeable abilities and the wipe itself are left out.`,
        events: hit.slice(0, 10).map(r => ({ atSec: r.d.atSec, text: `${r.d.name} died to ${r.d.killer} — ${r.ready.map(x => `${x.name} ready (${x.last == null ? 'not used yet this pull' : `last used at ${fmtClock(x.last)}`})`).join(', ')}` })),
      });
    } else if (deaths.length >= 2) {
      out.findings.push({
        id: 'healer-cds-at-deaths', severity: 'good', category: 'cooldowns', impact: 8,
        title: `Raid cooldowns already committed at all ${deaths.length} raid deaths`,
        text: `${listNames(mineCds.map(x => x.name))} ${mineCds.length === 1 ? 'was' : 'were'} running or on cooldown each time a raidmate died, so none of those deaths happened with a raid cooldown of yours sitting ready.`,
      });
    }
  }

  // ── A raid cooldown never pressed ──
  // The generic never-used rule skips raid cooldowns (they are assignments), which left
  // a healer who never pressed one with no card at all.
  if (pool && c.judgeable && pool.n >= NEVER_MIN_POOL) {
    for (const s of raidCds) {
      const e = pool.casts[s.name];
      if (!e || e.cpm.filter(x => x > 0).length < pool.n) continue;
      if (profile.casts.some(x => x.name === s.name || s.ids.includes(x.spellId)) || profile.buffs.some(b => b.name === s.name)) continue;
      if (!c.canJudge(s.name) || c.findings.some(f => f.id === `never-${s.name}`)) continue;
      const expected = Math.max(1, Math.round(median(e.cpm) * aliveSec / 60));
      out.findings.push({
        id: `never-${s.name}`, severity: 'warn', category: 'cooldowns', impact: 58, icon: e.icon, spellId: e.spellId,
        title: `You never pressed ${s.name}`,
        text: `Every one of ${topHealers} presses it, about ${plural(expected, 'time')} in a pull this long. It is a raid cooldown, so if it was being held for a moment that never came, that is the plan's cost and not yours; otherwise it is the biggest heal you have, left unused.`,
      });
    }
  }

  // ── "Uses of N possible" on a raid cooldown, when the top healers press it no more often ──
  for (const f of c.findings) {
    if (!f.id.startsWith('uses-')) continue;
    const name = f.id.slice(5);
    if (!raidCds.some(s => s.name === name)) continue;
    const members = pool?.castStarts[name];
    if (!members) continue;
    if (median(members.map(m => m.length)) <= usesWhileAlive(name).length) out.drop.push(f.id);
  }

  // ── Cast counts of everyday heals follow the damage the raid took ──
  for (const f of c.findings) {
    if (!f.id.startsWith('low-') || f.severity !== 'warn') continue;
    const e = pool?.casts[f.id.slice(4)];
    if (!e || median(e.cpm) < ROTATIONAL_CPM) continue;
    out.patch[f.id] = { severity: 'info' };
    out.append[f.id] = ' For a healer this is a difference to look at, not a mistake: how often an everyday spell gets cast follows how much damage the raid took, and the top parses come from raids that took more.';
  }

  // ── Framing: HPS is how much there was to heal as much as how well it was healed ──
  const lived = realDeaths.length === 0 ? (profile.deaths.length ? 'alive until the wipe' : 'alive the whole pull') : lifeWords(profile) ?? `dead at ${fmtClock(realDeaths[0].atSec)}`;
  if (pool && c.outputRatio != null) {
    const r = c.outputRatio;
    out.verdict = `${fmtNum(c.perSec)} HPS, ${pct(100 * r)} of the top-${pool.n} median (HPS follows how much damage the raid takes), ${lived}`;
    out.strong = r >= HEALER_STRONG_RATIO && realDeaths.length === 0;
    out.patch.output = {
      // Never a fault on its own: the same healer parses higher in a raid that takes more damage.
      severity: r >= 0.85 ? 'good' : 'info',
      text: `${r >= 0.85 ? 'That is level with the best healing parses on this boss.' : 'Read this as context, not a grade.'} HPS measures how much there was to heal as much as how well you healed it: the top parses come from raids that took more damage, often with fewer healers sharing it. What you control is in the other cards: cooldowns, overhealing and staying alive.${r < 0.85 && aliveSec < durationSec - 5 ? ` You were dead for ${fmtClock(durationSec - aliveSec)} of a ${fmtClock(durationSec)} pull, which is part of the gap.` : ''}`,
    };
  }
  out.debug = {
    raidCooldowns: raidCds.map(s => `${s.name}@${s.cooldown}`), mineCds: mineCds.map(x => `${x.name} cd=${x.cd} at ${x.times.join('/')}`),
    overheal: profile.overheal ?? null, poolOverheal: pool?.overhealPct ? `${pool.overhealPct.filter(x => x > 0).length} of ${pool.n}, median ${median(pool.overhealPct.filter(x => x > 0))}` : null,
  };
  return out;
}
