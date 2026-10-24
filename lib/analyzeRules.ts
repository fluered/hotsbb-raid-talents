import type { FightPlayer, PlayerProfile, PoolSummary, RaidMechanicStats, ReportFight } from './analyze';
import { DIFFICULTY_LABELS, GEAR_SLOT_NAMES } from './analyze';
import { lookupJournal, lookupLabel, MECHANIC_WORDS, type BossKnowledge, type MechanicType } from './bossMechanics';
import { BASELINE_BY_CLASS, DEFENSIVES, REPLACED_BY, TWO_STEP, isMovement, isUtility, noChargeModel, chargesFromTalents, defensiveKey, defensivesAt, minReuseGap, wastedDoublePresses } from './defensives';
import { LORRGS_CREDIT, MAJOR_CD_SEC, MAJOR_UNDER_60, type MajorSpell } from './lorrgsSpells';
import { timesWord } from './summary';

// ─── Log review: the rules ─────────────────────────────────────────────────────
//
// Pure functions: a player's fight profile + the top-player pool in, plain-English
// findings out. Nothing here knows about any specific spec or boss — every judgement
// is "how far is this player from what the top players measurably do". Thresholds
// are deliberately loose (60% of the pool's median, 2× the pool's damage taken…) so
// the page says a few true things rather than many arguable ones.

export type Severity = 'bad' | 'warn' | 'good' | 'info';
export type Category = 'survival' | 'mechanics' | 'cooldowns' | 'rotation' | 'buffs' | 'prep' | 'gear' | 'build' | 'uptime' | 'utility' | 'output';

export interface Finding {
  // Optional timestamped list shown under the card (a death's last ten seconds).
  events?: Array<{ atSec: number; text: string }>;
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  text: string;
  evidence?: string;
  icon?: string;
  spellId?: number;
  explain?: string; // Blizzard's journal description of the ability, when known
  href?: string;
  hrefLabel?: string;
  impact: number; // sort weight within a severity; roughly "how much is this costing"
}

export interface ReviewStat { label: string; value: string; note?: string }

export interface TimelineRow {
  name: string;
  icon: string;
  spellId: number;
  // 'cooldown': a cast with a Wowhead cooldown (or an item's use effect, or potions);
  // 'buff': a long self-buff window with no cast of its own, shown as it happened.
  kind: 'cooldown' | 'buff';
  mine: Array<[number, number]>; // seconds from pull
  pool: number[];                // every pool member's activation starts, flattened
  poolN: number;
  // Median time of the top players' 1st, 2nd, 3rd… press, only where they agree (their
  // middle half lands inside TIMING_BAND_SEC) — drawn as markers on the row.
  medians: number[];
  // The same presses with the middle half of the top players around each median, drawn
  // as a band. k is the press index (0 = first).
  bands: Array<{ k: number; med: number; lo: number; hi: number }>;
  // How this player's presses compare with those medians; null when there is nothing to judge.
  verdict: { text: string; kind: 'good' | 'warn' | 'info' } | null;
}

export interface Timeline {
  durationSec: number;
  aliveSec: number;
  rows: TimelineRow[];
  // Fight phases and intermissions, for the bands behind the rows.
  phases: Array<{ name: string; fromSec: number; toSec: number }>;
}

export interface DefensiveRow {
  name: string;
  spellId: number;
  icon: string;
  cooldownSec: number | null;
  charges: number;
  used: number;
  possible: number | null; // roughly how many presses the fight allowed
}

export interface Review {
  headline: string;
  summary: string;
  // The verdict sentence for the short version (the page recomposes the summary once
  // the boss-mechanic cards are in).
  verdict: string;
  stats: ReviewStat[];
  findings: Finding[];
  timeline: Timeline | null;
  defensives: DefensiveRow[];
  poolNote: string | null;
  sourcesNote: string | null;
  debug: Record<string, unknown>;
}

// Talent node id → the talent name(s) on that node (both names for a choice node),
// from the Blizzard layout the finder already caches; plus where to send people for
// the consensus build.
export interface TalentContext {
  nodeNames: Record<string, string[]>;
  // trait entry id → the one talent name it selects (choice nodes only, where known)
  entryNames: Record<string, string>;
  // talent name → its tooltip text, for reading "gains an additional charge"
  descriptionsByName: Record<string, string>;
  buildsHref: string;
}

export interface ReviewInput {
  player: FightPlayer;
  fight: ReportFight;
  profile: PlayerProfile;
  pool: PoolSummary | null;
  talents?: TalentContext | null;
  boss?: BossKnowledge | null;
  raidStats?: RaidMechanicStats | null;
  // Defensive cooldown lengths by buff name (Wowhead), for "died with X available".
  cooldowns?: Record<string, number> | null;
  // Charges by name from Wowhead's tooltip ("2 Charges"); talent text can add one.
  charges?: Record<string, number> | null;
  // The player's equipped trinkets with their on-use data (Wowhead item tooltips).
  trinkets?: Array<{ name: string; itemId: number; slot: number; onUse: boolean; cooldownSec: number | null; useSpellId: number | null; useSpellName: string | null; effectNames: string[] }> | null;
  // Effect data for the items the top players wear, keyed by item name.
  poolItemUses?: Record<string, { useSpellId: number | null; useSpellName: string | null; effectNames: string[] }> | null;
  // lorrgs' major cooldowns for this spec (null when lorrgs could not be read), and the
  // spells lorrgs tags as not major (defensive, movement, another role's raid cooldown).
  majorSpells?: MajorSpell[] | null;
  notMajorSpells?: MajorSpell[] | null;
  // What the boss did to this player, by the second (from the Wipefest-defined
  // mechanics): the context that explains a gap in casting or a late cooldown.
  context?: { mechanicEvents: Array<{ atSec: number; text: string }>; phases?: Array<{ name: string; fromSec: number; toSec: number }> } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function median(xs: number[]): number {
  const a = xs.slice().sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtNum(n: number): string {
  if (!isFinite(n)) return '0';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (x: number) => `${Math.round(x)}%`;
export const ucFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const listNames = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
const countPresent = (xs: number[]) => xs.filter(x => x > 0).length;
const fmtCdWords = (s: number) => s >= 60 ? `${Number.isInteger(s / 60) ? s / 60 : (s / 60).toFixed(1)}-minute` : `${s}-second`;

const SEVERITY_ORDER: Record<Severity, number> = { bad: 0, warn: 1, good: 2, info: 3 };
// Debuffs every raid carries that say nothing about mechanics.
const IGNORED_DEBUFFS = /^(exhaustion|sated|temporal displacement|insanity|fatigued|dampening|recently (benefited|received)|weakened soul|forbearance|mark of the (wild|flame))$/i;
// A death that took a big chunk of the raid with it inside a few seconds is the wipe
// mechanic firing (enrage, failed raid-wide check), not an individual mistake.
const WIPE_DEATHS_MIN = 5;
const WIPE_WINDOW_SEC = 3;
const MIN_JUDGE_SECONDS = 45;  // below this much time alive, rotation/uptime can't be judged
const CONSENSUS = 0.8;         // share of the pool that must do something before it's "what top players do"

// Consumables come in many flavours with different names (every food gives a
// different "Well Fed", every flask its own buff). Comparing a player's food to the
// pool's food has to happen at the family level or every different meal reads as
// "missing". Everything else keeps its own name.
// Potion names discovered from Wowhead at review time (see registerPotionNames).
const KNOWN_POTIONS = new Set<string>();
export function registerPotionNames(names: Iterable<string>): void { for (const n of names) KNOWN_POTIONS.add(n); }

export function buffFamily(name: string): string {
  if (KNOWN_POTIONS.has(name)) return 'potion';
  if (/well fed/i.test(name)) return 'food';
  if (/^(flask|phial) of/i.test(name) || /\bflask\b/i.test(name)) return 'flask';
  if (/healing potion|mana potion|rejuvenating/i.test(name)) return name;
  if (/^potion of|\bpotion$/i.test(name)) return 'potion';
  if (/augment(ed)? rune|\brune of\b.*(power|might|intellect|cunning)/i.test(name)) return 'rune';
  if (/^vantus rune/i.test(name)) return 'vantus';
  return name;
}
const FAMILY_LABEL: Record<string, string> = { food: 'a food buff', flask: 'a flask', potion: 'a combat potion', rune: 'an augment rune', vantus: 'a Vantus rune' };
const familyLabel = (family: string, exampleName: string) => FAMILY_LABEL[family] ?? exampleName;

// What a boss ability IS: DBM's label first, then the whole-raid pattern in the top
// logs (nobody takes it ⇒ avoid; everybody ⇒ raid-wide; only tanks ⇒ tank). "Soak"
// needs DBM to say so: a few top raiders clipped by a dodge looks identical to an
// assigned soak. null when neither source knows.
export function classifyAbility(boss: BossKnowledge | null | undefined, raidStats: RaidMechanicStats | null | undefined, name: string, spellId?: number): { type: MechanicType; via: 'dbm' | 'logs' } | null {
  const rs = raidStats?.abilities[name];
  const share = rs && rs.share.length >= 2 ? median(rs.share) : null;
  const tank = rs && rs.share.length >= 2 ? median(rs.tankShare) : null;
  // Only the tanks take it in top logs: a tank mechanic, whatever else it looks like.
  if (share != null && tank != null && tank >= 0.9 && share <= 0.25) return { type: 'tank', via: 'logs' };
  const label = lookupLabel(boss, name, spellId);
  if (label && label.type !== 'unknown') {
    // DBM warns about the dodgeable part of some abilities that still hit everyone
    // (a tail sweep with a knockback). If top raids all take it, it is base damage.
    if ((label.type === 'avoid' || label.type === 'spread' || label.type === 'fixate') && share != null && share >= 0.6) return { type: 'raidwide', via: 'logs' };
    return { type: label.type, via: 'dbm' };
  }
  if (share != null && rs) {
    // Nobody in the top raids takes it ⇒ a dodge. Someone takes it in EVERY top raid,
    // but only a few ⇒ it picks a target (a grab, a mark): being that target is not a
    // mistake, and the hits that follow are not avoidable damage.
    const everyFight = rs.share.every(x => x > 0);
    if (share <= 0.05 && !everyFight) return { type: 'avoid', via: 'logs' };
    if (share <= 0.2 && everyFight) return { type: 'targeted', via: 'logs' };
    if (share <= 0.1) return { type: 'avoid', via: 'logs' };
    if (share >= 0.6) return { type: 'raidwide', via: 'logs' };
  }
  return null;
}

// ─── The review ───────────────────────────────────────────────────────────────

export function reviewPlayer({ player, fight, profile, pool: poolIn, talents, boss, raidStats, cooldowns, charges, trinkets, poolItemUses, majorSpells, notMajorSpells, context }: ReviewInput): Review {
  const mechanicEvents = (context?.mechanicEvents ?? []).slice().sort((a, b) => a.atSec - b.atSec);
  // Every cast this player made, in order — the raw material for "what were you doing then".
  const allCastTimes = Object.values(profile.castTimes).flat().sort((a, b) => a - b);
  const movementCasts = Object.entries(profile.castTimes).filter(([n]) => isMovement(n)).flatMap(([n, ts]) => ts.map(t => ({ t, name: n }))).sort((a, b) => a.t - b.t);
  // What the log says this player was doing around a moment: dead, hit by a mechanic,
  // moving, or simply not casting.
  const phases = context?.phases ?? [];
  const whatHappened = (fromSec: number, toSec: number, aliveSecLimit: number): string | null => {
    if (aliveSecLimit < fromSec) return 'you were already dead';
    // An intermission the whole raid sits through is not this player's downtime.
    const inter = phases.find(p => /intermission|transition/i.test(p.name) && Math.min(p.toSec, toSec) - Math.max(p.fromSec, fromSec) >= 0.5 * (toSec - fromSec));
    if (inter) return `the intermission (${inter.name.replace(/^Intermission:?s*/i, '').trim()}) ran ${fmtClock(inter.fromSec)}–${fmtClock(inter.toSec)}`;
    const hit = mechanicEvents.find(e => e.atSec >= fromSec - 3 && e.atSec <= toSec);
    if (hit) {
      const span = hit.text.match(/^\S+ had (.+?): (\d+:\d+) → (\d+:\d+)/);
      if (span) return `you were carrying ${span[1]} from ${span[2]} to ${span[3]}`;
      return `${hit.text.replace(/^\S+ (hit by|gained|dispelled|interrupted|soaked)/, (_, v) => (v === 'hit by' ? 'you were hit by' : `you ${v}`)).replace(/^\S+: .*$/, 'you were in a mechanic window').replace(/ \(\d[^)]*absorbed\)/, '').replace(/ \d+ times? for /, ' for ')} at ${fmtClock(hit.atSec)}`;
    }
    const move = movementCasts.find(m => m.t >= fromSec - 2 && m.t <= toSec);
    if (move) return `you used ${move.name} at ${fmtClock(move.t)}`;
    return null;
  };
  const pool = poolIn && poolIn.n >= 3 ? poolIn : null;
  const findings: Finding[] = [];
  // Damage numbers only compare like with like: members on this fight's difficulty when
  // there are at least three, otherwise everyone (casts, buffs and consumables don't
  // depend on difficulty and always use the whole pool).
  const sameDiffIdx = pool ? pool.memberDifficulty.map((d, i) => (d === fight.difficulty ? i : -1)).filter(i => i >= 0) : [];
  const dmgIdx = sameDiffIdx.length >= 3 ? sameDiffIdx : pool ? pool.memberDifficulty.map((_, i) => i) : [];
  const dmgSlice = (xs: number[]) => dmgIdx.map(i => xs[i] ?? 0);
  const dmgN = dmgIdx.length;
  const durationSec = profile.durationMs / 1000;
  const aliveSec = profile.aliveMs / 1000;
  const aliveMinutes = Math.max(profile.aliveMs, 1000) / 60000;
  const judgeable = aliveSec >= MIN_JUDGE_SECONDS;
  const specLabel = `${player.spec} ${player.className}`;
  const topWordFull = pool ? `the top ${pool.n} ${specLabel}s on this boss` : 'top players';
  // Said in full once (the output card); everywhere else "the top players" reads better.
  const topWord = 'the top players';
  const outputWord = player.role === 'healer' ? 'healing' : 'damage';
  const killerNames = new Set(profile.deaths.map(d => d.killer));
  const myFamiliesAtPull = new Set(profile.buffs.filter(b => b.atPull).map(b => buffFamily(b.name)));
  const myItemNames = new Set((profile.gear?.slots ?? []).map(g => g.name).filter(Boolean));
  const poolItemNames = new Set(pool?.itemNames ?? []);
  // A cast that is an item's on-use effect ("Empowering Venom" is the Vial), mapped
  // back to the item so ownership can be checked. Falls back to cast name == item name.
  const itemForCast = (castName: string): string | null => {
    for (const [itemName, u] of Object.entries(poolItemUses ?? {})) if ((u.useSpellName && u.useSpellName === castName) || u.effectNames?.includes(castName)) return itemName;
    for (const t of trinkets ?? []) if (t.useSpellName === castName || t.effectNames?.includes(castName)) return t.name;
    return poolItemNames.has(castName) ? castName : null;
  };
  // True when the cast belongs to an item this player does not own.
  const unownedItemCast = (castName: string): boolean => {
    const item = itemForCast(castName);
    return !!item && !myItemNames.has(item);
  };
  const myCast = (name: string) => profile.casts.find(c => c.name === name)?.total ?? 0;
  const myBuff = (name: string) => profile.buffs.find(b => b.name === name);

  // What a boss ability IS: DBM's label first, then the whole-raid pattern in the top
  // logs (nobody takes it ⇒ avoid; everybody ⇒ raid-wide; only tanks ⇒ tank; a
  // consistent few ⇒ soak). null when neither source knows.
  const classify = (name: string, spellId?: number) => classifyAbility(boss, raidStats, name, spellId);
  const explain = (name: string, spellId?: number): string | undefined => {
    const j = lookupJournal(boss, name, spellId);
    return j?.description ? j.description : undefined;
  };
  const isUnavoidableType = (t: MechanicType | undefined) => t === 'raidwide' || t === 'defensive' || (t === 'tank' && player.role === 'tank');

  // Talent names the player took vs the share of the pool taking each name. Lets an
  // ability the player never cast be recognised as "not talented" rather than "forgot".
  const talentNames = (() => {
    if (!talents || !pool || !profile.talentNodes || pool.talentN < 3) return null;
    const mine = new Set<string>();
    for (const [node, entry] of profile.talentNodes) {
      const picked = talents.entryNames[String(entry)];
      if (picked) mine.add(picked);
      else for (const n of talents.nodeNames[String(node)] ?? []) mine.add(n);
    }
    // Share per name: entry-level where the bridge map resolves a choice, node-level
    // otherwise (a node with one talent on it is unambiguous anyway).
    const share: Record<string, number> = {};
    const resolvedNames = new Set(Object.values(talents.entryNames));
    for (const [entry, count] of Object.entries(pool.talentEntryCount)) {
      const n = talents.entryNames[entry];
      if (n) share[n] = Math.max(share[n] ?? 0, count / pool.talentN);
    }
    for (const [id, count] of Object.entries(pool.talentNodeCount)) {
      const names = talents.nodeNames[id] ?? [];
      for (const n of names) {
        if (names.length > 1 && resolvedNames.has(n)) continue; // choice node handled above
        share[n] = Math.max(share[n] ?? 0, count / pool.talentN);
      }
    }
    return { mine, share };
  })();
  const talentDiffNames = talentNames
    ? Object.entries(talentNames.share).filter(([n, sh]) => sh >= CONSENSUS && !talentNames.mine.has(n)).map(([n]) => n)
    : [];
  // More than five consensus talents missing = a different build, and "you never used X"
  // for abilities that build grants is a build choice, not a mistake. Up to five off is
  // near-meta: those players keep their individual findings.
  const buildDiffers = talentDiffNames.length > 5;
  const missingByBuild: string[] = [];
  const talentGaps: string[] = [];
  const isTalentGap = (name: string) => {
    if (!talentNames) return false;
    // Casting it or carrying its buff proves the talent, whatever the mapping says.
    if (profile.casts.some(c => c.name === name) || profile.buffs.some(b => b.name === name)) return false;
    if ((talentNames.share[name] ?? 0) >= CONSENSUS && !talentNames.mine.has(name)) {
      if (!talentGaps.includes(name)) talentGaps.push(name);
      return true;
    }
    return false;
  };

  // The player's defensive roster: what they pressed, what the top players of the
  // spec press, and what their talents grant — minus anything their build lacks.
  // Cooldown from Wowhead, else the shortest re-use gap seen; charges from talent
  // text ("gains an additional charge") or from usage (two presses inside one
  // cooldown). Uses are exact cast times, with buff windows as a fallback.
  const defensiveNames = new Set<string>();
  const defSpell: Record<string, { spellId: number; icon: string }> = {};
  const noteDef = (name: string, spellId: number, icon: string) => {
    const k = defensiveKey(name);
    if (!DEFENSIVES.has(k) || isTalentGap(k)) return;
    defensiveNames.add(k);
    if (!defSpell[k] || (!defSpell[k].spellId && spellId)) defSpell[k] = { spellId, icon: defSpell[k]?.icon || icon };
  };
  for (const c of profile.casts) noteDef(c.name, c.spellId, c.icon);
  for (const b of profile.buffs) noteDef(b.name, b.spellId, b.icon);
  if (pool) {
    // A defensive a third of the top players of the spec press exists for the spec.
    for (const [name, starts] of Object.entries(pool.castStarts)) if (countPresent(starts.map(s => s.length)) / pool.n >= 0.3) noteDef(name, pool.casts[name]?.spellId ?? 0, pool.casts[name]?.icon ?? '');
    for (const [name, e] of Object.entries(pool.buffs)) if (DEFENSIVES.has(name) && countPresent(e.uptimePct) / pool.n >= 0.3) noteDef(name, e.spellId, e.icon);
  }
  if (talentNames) for (const n of talentNames.mine) if (DEFENSIVES.has(n)) noteDef(n, 0, '');
  for (const n of BASELINE_BY_CLASS[player.className] ?? []) noteDef(n, 0, '');
  noteDef('Healthstone', 0, '');
  for (const [orig, repl] of Object.entries(REPLACED_BY)) if (defensiveNames.has(repl)) defensiveNames.delete(orig);
  const defUses: Record<string, number[]> = {};
  for (const [name, times] of Object.entries(profile.castTimes)) {
    const k = defensiveKey(name);
    if (defensiveNames.has(k)) (defUses[k] ??= []).push(...times);
  }
  const defBands: Record<string, Array<[number, number]>> = {};
  for (const k of defensiveNames) {
    defBands[k] = myBuff(k)?.bands ?? [];
    if (!defUses[k]?.length && defBands[k].length) defUses[k] = defBands[k].map(([s]) => s);
  }
  const takenDescs = talentNames && talents ? [...talentNames.mine].map(n => talents.descriptionsByName[n] ?? '').filter(Boolean) : [];
  const defCd: Record<string, number | undefined> = {};
  const defCharges: Record<string, number> = {};
  for (const k of defensiveNames) {
    const poolStarts = pool?.castStarts[k] ?? pool?.buffs[k]?.starts ?? [];
    defCd[k] = cooldowns?.[k] ?? minReuseGap([...poolStarts, defUses[k] ?? []]);
    // Facts only: Wowhead's "N Charges" on the spell, or talent text granting one more.
    // Presses are not evidence — cooldown-reduction talents make them look like charges.
    defCharges[k] = noChargeModel(k) ? 1 : Math.max(charges?.[k] ?? 1, chargesFromTalents(k, takenDescs));
  }
  const defensiveNote = (atSec: number): string => {
    if (!defensiveNames.size) return '';
    const st = defensivesAt(atSec, [...defensiveNames], defUses, defCd, defCharges, defBands);
    const parts: string[] = [];
    if (st.available.length) parts.push(`You had ${listNames(st.available.slice(0, 3))} available.`);
    if (st.active.length) parts.push(`${listNames(st.active.slice(0, 2))} ${st.active.length === 1 ? 'was' : 'were'} active, so it went through a defensive.`);
    if (st.onCooldown.length && !st.available.length) {
      const c = st.onCooldown.sort((a, b) => Math.min(...a.usedAgoSec) - Math.min(...b.usedAgoSec))[0];
      parts.push(c.charges >= 2
        ? `${c.name} had both charges spent (${c.usedAgoSec.map(x => `${x}s`).join(' and ')} earlier).`
        : `${c.name} had been used ${c.usedAgoSec[0]}s earlier and was still on cooldown.`);
    }
    return parts.length ? ' ' + parts.join(' ') : '';
  };
  const defensiveRows: DefensiveRow[] = [...defensiveNames].map(k => {
    const cd = k === 'Healing potion' ? null : defCd[k] != null ? Math.round(defCd[k]! * 10) / 10 : null;
    const used = defUses[k]?.length ?? 0;
    let possible = cd ? defCharges[k] + Math.floor(aliveSec / cd) : null;
    if (k === 'Healing potion') possible = 1;
    if (k === 'Healthstone' && possible != null) possible = Math.min(3, possible);
    return { name: k, spellId: defSpell[k]?.spellId ?? 0, icon: defSpell[k]?.icon ?? '', cooldownSec: cd, charges: defCharges[k], used, possible };
  }).sort((a, b) => (b.possible ?? 0) - (a.possible ?? 0) || b.used - a.used);

  // Combat potions, counted from the potion buffs themselves — WCL's potionUse field
  // on playerDetails doesn't count them reliably (a top parse with two Potion of
  // Recklessness buffs reported 0).
  const myPotions = profile.buffs.filter(b => buffFamily(b.name) === 'potion').reduce((s, b) => s + b.uses, 0);
  // How many of the top players had a potion running at the pull (their buff tables).
  const poolPrePotShare: number | null = pool
    ? Array.from({ length: pool.n }, (_, i) => Object.entries(pool.buffs).some(([n, e]) => buffFamily(n) === 'potion' && (e.atPull[i] ?? 0) > 0)).filter(Boolean).length / pool.n
    : null;
  const poolPotions: number[] = pool
    ? Array.from({ length: pool.n }, (_, i) =>
        Object.entries(pool.buffs).filter(([name]) => buffFamily(name) === 'potion').reduce((s, [, e]) => s + (e.starts[i]?.length ?? 0), 0))
    : [];

  // ── Survival ──
  const isWipeDeath = (d: { killer: string; atSec: number }) =>
    !fight.kill && profile.raidDeaths.filter(r => r.killer === d.killer && Math.abs(r.atSec - d.atSec) <= WIPE_WINDOW_SEC).length >= WIPE_DEATHS_MIN;
  const realDeaths = profile.deaths.filter(d => !isWipeDeath(d));
  const wipeKillers = new Set(profile.deaths.filter(isWipeDeath).map(d => d.killer));
  if (realDeaths.length === 0) {
    findings.push({
      id: 'alive', severity: 'good', category: 'survival', impact: 20,
      title: profile.deaths.length ? 'Alive until the wipe call' : 'You stayed alive the whole fight',
      text: fight.kill
        ? 'No deaths on the kill. Everything below is about squeezing more out of a pull you already survived.'
        : profile.deaths.length
          ? `You only died when ${profile.deaths[0].killer} took the raid with you. Nothing before that killed you, so this pull ending was not on you.`
          : 'No deaths before the wipe, which means this pull ending was not on you.',
    });
  }
  profile.deaths.forEach((d, i) => {
    if (isWipeDeath(d)) {
      const n = profile.raidDeaths.filter(r => r.killer === d.killer && Math.abs(r.atSec - d.atSec) <= WIPE_WINDOW_SEC).length;
      findings.push({
        id: `wipe-${i}`, severity: 'info', category: 'survival', impact: 45, icon: d.killerIcon, spellId: d.killerSpellId,
        title: `${d.killer} at ${fmtClock(d.atSec)} was the wipe`,
        text: `${n} of the raid died to it inside the same few seconds. That is the fight ending, not something you did.`,
      });
      return;
    }
    const poolEntry = pool?.taken[d.killer];
    const frac = pool && poolEntry ? countPresent(dmgSlice(poolEntry.perMin)) / dmgN : null;
    const taken = profile.damageTaken.find(t => t.name === d.killer);
    let verdict = '';
    const kind = classify(d.killer, d.killerSpellId)?.type;
    if (kind === 'avoid') verdict = ` ${ucFirst(d.killer)} is ${MECHANIC_WORDS.avoid}, so this death was avoidable.`;
    else if (kind === 'raidwide') verdict = ' Everyone takes this hit, so it comes down to having a defensive, a healthstone or a heal lined up for it.';
    else if (kind === 'defensive') verdict = ' This is the hit you are meant to press a defensive for.';
    else if (kind === 'soak') verdict = ' That is soak damage, meant to be shared; worth checking how many shared it with you.';
    else if (kind === 'tank') verdict = player.role === 'tank' ? ' A tank hit, so mitigation or an external for it.' : ' That is a tank mechanic. If you were not meant to be in it, that is the fix.';
    else if (kind === 'spread') verdict = ' A spread mechanic: too close to someone else when it went off.';
    else if (kind === 'gather') verdict = ' A share mechanic: not enough people stacked to split it.';
    else if (kind === 'fixate') verdict = ' A fixate, and it caught up with you.';
    else if (kind === 'targeted') verdict = ' It targets someone every pull, so this is about surviving it once it is on you: a defensive, a healthstone, or the raid dealing with it faster.';
    else if (pool && (frac == null || frac <= 0.3)) verdict = ` Most of ${topWord} never take damage from it at all, so this one is avoidable.`;
    else if (pool && frac != null && frac >= 0.7) verdict = ' Everyone takes this hit, so it comes down to having a defensive, a healthstone or a heal lined up for it.';
    const recap = profile.deathRecaps?.find(x => Math.abs(x.atSec - d.atSec) < 0.5) ?? null;
    let recapText = '';
    let recapEvents: Array<{ atSec: number; text: string }> | undefined;
    if (recap && recap.hits.length) {
      const total = recap.hits.reduce((s, h) => s + h.amount, 0);
      const absorbed = recap.hits.reduce((s, h) => s + h.absorbed, 0);
      const byAbility = new Map<string, number>();
      for (const h of recap.hits) byAbility.set(h.name, (byAbility.get(h.name) ?? 0) + h.amount);
      const top = [...byAbility.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, v]) => `${n} ${fmtNum(v)}`);
      const defUp = recap.aurasAtDeath.filter(a => DEFENSIVES.has(defensiveKey(a.name))).map(a => a.name);
      recapText = ` Last 10 seconds: ${plural(recap.hits.length, 'hit')} for ${fmtNum(total)}${absorbed ? ` (${fmtNum(absorbed)} absorbed)` : ''}, ${top.join(', ')}; ${recap.healCount ? `${fmtNum(recap.healing)} healed in ${plural(recap.healCount, 'heal')}` : 'no healing landed'}.${defUp.length ? ` ${listNames(defUp)} ${defUp.length === 1 ? 'was' : 'were'} up at the killing blow.` : ''}`;
      recapEvents = [
        ...recap.hits.map(h => ({ atSec: h.atSec, text: `${h.name} for ${fmtNum(h.amount)}${h.absorbed ? ` (${fmtNum(h.absorbed)} absorbed)` : ''}${h.overkill ? ` — killing blow, ${fmtNum(h.overkill)} over` : ''}${h.source ? ` from ${h.source}` : ''}` })),
        ...(recap.healCount ? [{ atSec: d.atSec, text: `${fmtNum(recap.healing)} healing received in the window (${recap.healCount} heals)` }] : []),
      ].sort((a, b) => a.atSec - b.atSec);
    }
    const others = d.otherHitters.length ? `, with ${listNames(d.otherHitters)} on top` : '';
    // Two spells can share the killer's name (the explosion and a pulsing aura): say so
    // rather than adding them up into one implausible count.
    const parts = (taken?.byId ?? []).filter(x => x.hits > 0).map(x => ({ ...x, avg: x.total / x.hits })).sort((a, b) => b.avg - a.avg);
    const hitNote = !taken || taken.hits <= 1 ? ''
      : parts.length > 1 && parts[1].avg < 0.25 * parts[0].avg
        ? ` The big hits landed ${timesWord(parts[0].hits)} for ${fmtNum(parts[0].total)}; the other ${plural(parts.slice(1).reduce((s, x) => s + x.hits, 0), 'hit')} were small pulses from a second spell with the same name.`
        : ` It hit you ${timesWord(taken.hits)} in total.`;
    const lead = d.killerDamage > 0
      ? `${d.killer} did ${fmtNum(d.killerDamage)} of the ${fmtNum(d.totalRecent)} damage you took in the seconds before you died${others}.`
      : `${d.killer} landed the killing blow after you had already taken ${fmtNum(d.totalRecent)} in a few seconds${others}.`;
    findings.push({
      id: `death-${i}`, severity: 'bad', category: 'survival', impact: 100 - i * 5, icon: d.killerIcon, spellId: d.killerSpellId,
      title: `Died at ${fmtClock(d.atSec)} to ${d.killer}`,
      text: (`${lead}${hitNote}${verdict}${defensiveNote(d.atSec)}`) + recapText,
      events: recapEvents,
      explain: explain(d.killer, d.killerSpellId),
      evidence: `${plural(defUses['Healthstone']?.length ?? player.healthstoneUse, 'healthstone')} used in the fight`,
    });
  });

  // How the pull ended, from the whole raid's deaths. On a wipe the order matters
  // (who went first and to what); on a kill it's just context.
  if (profile.raidDeaths.length > 0) {
    const first = profile.raidDeaths.find(r => !wipeKillers.has(r.killer)) ?? profile.raidDeaths[0];
    const mine = profile.raidDeaths.findIndex(d => d.id === player.id);
    const within = profile.raidDeaths.filter(d => d.atSec - first.atSec <= 15).length;
    const youWereFirst = first.id === player.id;
    let text: string;
    if (!fight.kill) {
      text = `${youWereFirst ? 'You were' : `${first.name} was`} the first to die, at ${fmtClock(first.atSec)} to ${first.killer}`
        + (within > 1 ? `, and ${plural(within - 1, 'more death')} followed inside fifteen seconds.` : '.')
        + (mine > 0 ? ` You were death number ${mine + 1} of ${profile.raidDeaths.length}.` : mine < 0 ? ' You outlived everyone who died.' : '');
    } else {
      text = `${plural(profile.raidDeaths.length, 'player')} died on the kill` + (youWereFirst ? ', you first' : mine >= 0 ? ', you among them' : ', not you') + `. First was ${first.name} at ${fmtClock(first.atSec)} to ${first.killer}.`;
    }
    findings.push({
      id: 'raid-deaths', severity: 'info', category: 'survival', impact: 50,
      title: fight.kill ? `${plural(profile.raidDeaths.length, 'death')} in the raid on this kill` : 'How the pull ended',
      text,
    });
  }

  // ── Charges pressed on top of each other ──
  for (const k of defensiveNames) {
    if ((defCharges[k] ?? 1) < 2 || noChargeModel(k)) continue;
    const wasted = wastedDoublePresses(defUses[k] ?? [], defBands[k]);
    if (!wasted.length) continue;
    const w = wasted[0];
    findings.push({
      id: `double-${k}`, severity: 'warn', category: 'survival', impact: 42, icon: defSpell[k]?.icon, spellId: defSpell[k]?.spellId,
      title: `${k} pressed twice within ${w.gapSec}s at ${fmtClock(w.atSec)}`,
      text: `The second press landed while the first was still running, so the overlap was wasted. ${wasted.length > 1 ? `Happened ${plural(wasted.length, 'time')} this pull.` : ''}`.trim(),
    });
  }

  // ── Defensive usage over the pull ──
  if (pool && judgeable) {
    const judged = defensiveRows.filter(r => r.possible != null && (r.cooldownSec ?? 0) >= 60 && r.name !== 'Healthstone' && r.name !== 'Healing potion');
    const possible = judged.reduce((s, r) => s + (r.possible ?? 0), 0);
    const used = judged.reduce((s, r) => s + Math.min(r.used, r.possible ?? r.used), 0);
    if (possible >= 3) {
      const ratio = used / possible;
      const detail = judged.slice(0, 3).map(r => `${r.name} ${r.used}/${r.possible}`).join(', ');
    // What the top players do with the same button, measured: median casts of it per pull.
    const poolDefensiveNote = (() => {
      if (!pool) return '';
      for (const r of judged) {
        const e = pool.casts[r.name];
        if (!e || countPresent(e.cpm) < pool.n * 0.5) continue;
        const theirs = median(e.cpm.filter(x => x > 0)) * (durationSec / 60);
        return ` ${ucFirst(topWord)} press ${r.name} about ${plural(Math.round(theirs), 'time')} in a pull this long.`;
      }
      return '';
    })();
      if (ratio < 0.4) {
        findings.push({
          id: 'defensive-usage', severity: 'warn', category: 'survival', impact: 36,
          title: `Defensives mostly unused: ${used} of about ${possible} possible presses`,
          text: `Possible presses come from each ability's cooldown and the time you were alive. Yours: ${detail}.${poolDefensiveNote}`,
        });
      } else if (ratio >= 0.7) {
        findings.push({
          id: 'defensive-usage-ok', severity: 'good', category: 'survival', impact: 12,
          title: `Defensives used well: ${used} of about ${possible} possible presses`,
          text: detail,
        });
      }
    }
  }

  // ── Mechanics: avoidable damage ──
  let avoidableTotal = 0;
  if (pool) {
    const totalTaken = profile.damageTaken.reduce((s, t) => s + t.total, 0) || 1;
    const mech: Finding[] = [];
    const soaks: string[] = [];
    for (const t of profile.damageTaken) {
      if (killerNames.has(t.name)) continue;             // already covered by the death
      if (wipeKillers.has(t.name)) continue;
      if (/^melee$/i.test(t.name)) continue;
      const kind = classify(t.name, t.spellId)?.type;
      if (isUnavoidableType(kind)) {
        // Unavoidable by definition; only worth a word if you took far more than the top players.
        const e = pool.taken[t.name];
        const med = e ? median(dmgSlice(e.perMin)) : 0;
        const userPerMin = t.total / aliveMinutes;
        if (med > 0 && userPerMin > 2 * med && t.total / totalTaken >= 0.03) {
          mech.push({
            id: `over-${t.name}`, severity: 'warn', category: 'mechanics', icon: t.icon, spellId: t.spellId, explain: explain(t.name, t.spellId),
            impact: 40 + Math.min(15, Math.round(userPerMin / med)),
            title: `Too much damage from ${t.name}`,
            text: kind === 'defensive'
              ? `DBM flags ${t.name} as the hit to press a defensive for, and you took ${(userPerMin / med).toFixed(1)}× what ${topWord} take from it.`
              : `Everyone takes ${t.name}, but you took ${(userPerMin / med).toFixed(1)}× what ${topWord} take from it.`,
            evidence: `${fmtNum(userPerMin)} per minute vs ${fmtNum(med)} for top players`,
          });
        }
        continue;
      }
      if (kind === 'soak') { if (t.hits + t.ticks > 0) soaks.push(`${t.name} ${plural(t.hits || t.ticks, 'time')}`); continue; }
      if (kind === 'targeted') continue; // it picked you; the damage that follows is the mechanic, not a mistake
      const share = t.total / totalTaken;
      if (share < 0.005) continue;                        // noise: under half a percent of what you took
      const e = pool.taken[t.name];
      const frac = e ? countPresent(dmgSlice(e.perMin)) / dmgN : 0;
      const landed = t.hits > 0 ? `hit you ${plural(t.hits, 'time')}` : `ticked on you ${plural(t.ticks, 'time')}`;
      if (frac <= 0.3) {
        const who = e ? `Only ${countPresent(dmgSlice(e.perMin))} of ${dmgN}` : `None of the ${dmgN}`;
        const count = t.hits + t.ticks;
        avoidableTotal += t.total;
        const what = kind === 'tank'
          ? ` ${t.name} is a tank mechanic. If you were not meant to be in it, that is the whole fix.`
          : kind === 'spread' ? ` ${ucFirst(t.name)} is ${MECHANIC_WORDS.spread}: you were too close to someone when it went off.`
          : kind === 'gather' ? ` ${ucFirst(t.name)} is ${MECHANIC_WORDS.gather}: it hurts when too few people share it.`
          : kind === 'fixate' ? ` ${ucFirst(t.name)} is ${MECHANIC_WORDS.fixate}: keep moving when it is on you.`
          : kind === 'avoid' ? ' That is a mechanic to step out of, not one to heal through.'
          : ` That is a mechanic to step out of, not one to heal through.${t.hits >= 10 || (t.hits === 0 && t.ticks >= 20) ? ' If you were assigned to soak it, ignore this one.' : ''}`;
        mech.push({
          id: `avoid-${t.name}`, severity: count >= 3 && share >= 0.02 ? 'bad' : 'warn', category: 'mechanics', icon: t.icon, spellId: t.spellId, explain: explain(t.name, t.spellId),
          impact: 55 + Math.min(20, count * 2) + Math.round(25 * share),
          title: `${t.name} ${landed}`,
          text: `${who} top ${specLabel}s on this boss took any damage from ${t.name}.${what}`,
          evidence: `${fmtNum(t.total)} damage taken${t.source ? ` from ${t.source}` : ''}, ${pct(100 * share)} of everything that hit you`,
        });
      } else {
        const userPerMin = t.total / aliveMinutes;
        const med = median(dmgSlice(e.perMin));
        if (med > 0 && userPerMin > 2 * med && share >= 0.03) {
          mech.push({
            id: `over-${t.name}`, severity: 'warn', category: 'mechanics', icon: t.icon, spellId: t.spellId, explain: explain(t.name, t.spellId),
            impact: 45 + Math.min(15, Math.round(userPerMin / med)),
            title: `Too much damage from ${t.name}`,
            text: `You took ${(userPerMin / med).toFixed(1)}× what ${topWord} take from ${t.name}. They take some of it too; the difference is how long or how often you were in it.`,
            evidence: `${fmtNum(userPerMin)} per minute vs ${fmtNum(med)} for top players`,
          });
        }
      }
    }
    // Debuffs the top players never pick up: a failed mechanic the game tagged you with.
    const takenNames = new Set(profile.damageTaken.map(t => t.name));
    for (const d of profile.debuffs) {
      if (d.count <= 0 || IGNORED_DEBUFFS.test(d.name) || takenNames.has(d.name) || killerNames.has(d.name) || wipeKillers.has(d.name)) continue;
      const e = pool.debuffs[d.name];
      const frac = e ? countPresent(dmgSlice(e.perMin)) / dmgN : 0;
      if (frac > 0.3) continue;
      const kind = classify(d.name, d.spellId)?.type;
      if (kind === 'soak' || isUnavoidableType(kind) || kind === 'debuff' || kind === 'targeted') continue;
      // With a journal for this boss, only its own debuffs count — a priest's own Angelic
      // Bulwark proc or an evoker's Rescue on you is not a mechanic.
      if (boss?.sources.journal && !lookupJournal(boss, d.name, d.spellId) && !lookupLabel(boss, d.name, d.spellId)) continue;
      const who = e ? `Only ${countPresent(dmgSlice(e.perMin))} of ${dmgN}` : `None of the ${dmgN}`;
      mech.push({
        id: `debuff-${d.name}`, severity: 'warn', category: 'mechanics', icon: d.icon, spellId: d.spellId, explain: explain(d.name, d.spellId),
        impact: 38 + Math.min(15, d.count * 3),
        title: `Picked up ${d.name} ${plural(d.count, 'time')}`,
        text: `${who} top ${specLabel}s on this boss ever had this debuff. The description below says what it is.`,
      });
    }
    mech.sort((a, b) => b.impact - a.impact);
    findings.push(...mech.slice(0, 5));
    if (soaks.length) {
      findings.push({
        id: 'soaks', severity: 'good', category: 'mechanics', impact: 14,
        title: `Soaked ${listNames(soaks.slice(0, 3))}`,
        text: 'Soak damage is damage someone had to take. That it was you is a job done, not a mistake.',
      });
    }
    if (mech.length === 0 && realDeaths.length === 0) {
      findings.push({
        id: 'clean-mechanics', severity: 'good', category: 'mechanics', impact: 25,
        title: 'Clean on mechanics',
        text: `Nothing hit you that ${topWord} manage to avoid.`,
      });
    }
  }

  // ── Cooldowns & rotation ──
  const reportedCasts = new Set<string>();
  const reportedNever = new Set<string>();
  if (pool && judgeable) {
    const low: Finding[] = [];
    const matched: Array<{ name: string; med: number }> = [];
    for (const [name, e] of Object.entries(pool.casts)) {
      if (buffFamily(name) !== name || /healthstone/i.test(name)) continue; // consumables are judged as a family below
      if (DEFENSIVES.has(defensiveKey(name))) continue;   // defensives have their own section; top players skip them when not needed
      if (isUtility(name)) continue; // interrupts, dispels, taunts are raid assignments — see the raid summary
      if (isMovement(name)) continue; // movement is pressed when the fight demands it
      const present = countPresent(e.cpm);
      if (present / pool.n < CONSENSUS) continue;    // not a consensus button
      const med = median(e.cpm);
      if (med < 0.1) continue;                        // too rare to judge from one fight
      const expected = med * aliveMinutes;
      if (expected < 1) continue;
      // An on-use trinket the player doesn't own isn't a mistake.
      if (unownedItemCast(name)) continue;
      if (isTalentGap(name)) continue;
      const mine = myCast(name);
      const myCpm = mine / aliveMinutes;
      const band: 'cooldown' | 'situational' | 'rotation' = med < 1.2 ? 'cooldown' : med < 3 ? 'situational' : 'rotation';
      const category: Category = band === 'rotation' ? 'rotation' : 'cooldowns';
      const whileAlive = aliveSec < durationSec - 5 ? ' in the time you were alive' : ' in a fight this long';
      const ownedItem = !!itemForCast(name) && !unownedItemCast(name);
      if (mine === 0 && buildDiffers && !ownedItem) { missingByBuild.push(name); continue; }
      if (mine > 0 && buildDiffers && myCpm < 0.15 * med && !ownedItem) { missingByBuild.push(name); continue; }
      // "You never used X" is only said when EVERY top player uses X. Leave-one-out over
      // 39 specs' top tens showed that at 80% consensus a top player gets told this 80
      // times (choice talents, gear effects, situational buttons); at 100% never.
      if (mine === 0 && (present < pool.n || pool.n < 8)) continue;
      if (mine === 0) {
        low.push({
          id: `never-${name}`, severity: 'bad', category, icon: e.icon, spellId: e.spellId, impact: band === 'cooldown' ? 75 : band === 'situational' ? 60 : 65,
          title: `You never used ${name}`,
          text: `${present === pool.n ? 'Every one' : `${present} of ${pool.n}`} of ${topWord} uses it, about ${plural(Math.round(expected), 'time')}${whileAlive}.`,
        });
      } else if (myCpm < 0.6 * med) {
        const text = band === 'cooldown'
          ? `${ucFirst(topWord)} press it about ${Math.round(expected)} times in a pull this long; you pressed it ${plural(mine, 'time')}.`
          : band === 'situational'
            ? `${ucFirst(topWord)} lean on ${name} a lot more than you did. Worth watching a top log to see what they use it for.`
            : `You cast ${name} ${pct(100 * (1 - myCpm / med))} less often than ${topWord}.`;
        low.push({
          id: `low-${name}`, severity: buildDiffers && band !== 'cooldown' ? 'info' : 'warn', category, icon: e.icon, spellId: e.spellId,
          impact: (band === 'cooldown' ? 50 : band === 'situational' ? 35 : 45) + Math.round(10 * (1 - myCpm / med)),
          title: `${name}: ${plural(mine, 'cast')}, top players get about ${Math.round(expected)}`,
          text: buildDiffers && band !== 'cooldown' ? `${ucFirst(topWord)} run a different build, so their ${name} count is a reference, not a target for yours.` : text,
          evidence: `${myCpm.toFixed(1)} per minute vs ${med.toFixed(1)} for top players`,
        });
      } else if (myCpm >= 0.9 * med) {
        matched.push({ name, med });
      }
    }
    low.sort((a, b) => b.impact - a.impact);
    for (const f of low.slice(0, 6)) { reportedCasts.add(f.id.replace(/^(never|low)-/, '')); if (f.id.startsWith('never-')) reportedNever.add(f.id.replace(/^never-/, '')); }
    findings.push(...low.slice(0, 6));
    if (matched.length >= 2) {
      const names = matched.sort((a, b) => b.med - a.med).slice(0, 3).map(m => m.name);
      findings.push({
        id: 'matched-casts', severity: 'good', category: 'rotation', impact: 22,
        title: `${listNames(names)} used as often as the top players`,
        text: `Your cast counts on ${matched.length === names.length ? 'those' : `${matched.length} buttons including those`} matched ${topWord}. Keep that up.`,
      });
    }
  } else if (pool && !judgeable) {
    findings.push({
      id: 'too-short', severity: 'info', category: 'rotation', impact: 40,
      title: `Only ${fmtClock(aliveSec)} alive, too little to judge your rotation`,
      text: 'Cooldown and uptime comparisons need a minute or so of play. Review a longer pull for those.',
    });
  }

  // ── Your own on-use trinkets ──
  const onUseTrinkets = (trinkets ?? []).filter(t => t.onUse);
  if (judgeable) {
    for (const t of onUseTrinkets) {
      const cast = profile.casts.find(c => (t.useSpellId && c.spellId === t.useSpellId) || c.name === t.useSpellName || c.name === t.name);
      const uses = cast ? (profile.castTimes[cast.name]?.length ?? cast.total) : 0;
      // Never used, but no top player's log shows this effect being cast either: it may
      // not log as a cast at all. Say nothing rather than something wrong.
      if (uses === 0 && !(t.useSpellName && pool?.casts[t.useSpellName]) && !pool?.casts[t.name]) continue;
      const possible = t.cooldownSec ? 1 + Math.floor(aliveSec / t.cooldownSec) : null;
      const icon = cast?.icon ?? '';
      if (uses === 0) {
        findings.push({
          id: `trinket-${t.itemId}`, severity: 'bad', category: 'cooldowns', impact: 62, icon, spellId: t.useSpellId ?? undefined,
          title: `You never used ${t.name}`,
          text: `Your ${t.slot === 12 || t.slot === 13 ? 'trinket' : (GEAR_SLOT_NAMES[t.slot] ?? 'item').toLowerCase()} has an on-use effect${t.cooldownSec ? ` on a ${fmtCdWords(t.cooldownSec)} cooldown` : ''}, which is ${possible ? `about ${plural(possible, 'use')}` : 'several uses'} in a fight this long. Macro it to a cooldown if remembering it is the problem.`,
        });
      } else if (possible && uses < possible * 0.6) {
        findings.push({
          id: `trinket-${t.itemId}`, severity: 'warn', category: 'cooldowns', impact: 44, icon, spellId: cast?.spellId,
          title: `${t.name}: ${plural(uses, 'use')}, about ${possible} possible`,
          text: `A ${fmtCdWords(t.cooldownSec!)} on-use effect allows about ${possible} presses in a pull this long. Yours sat idle for most of it.`,
        });
      } else {
        findings.push({
          id: `trinket-ok-${t.itemId}`, severity: 'good', category: 'cooldowns', impact: 10, icon, spellId: cast?.spellId,
          title: `${t.name} used ${uses}×${possible ? ` of about ${possible}` : ''}`,
          text: 'On-use item pressed on cooldown.',
        });
      }
    }
  }

  // ── Timeline of major cooldowns and potions, plus opener timing ──
  // No rows for things this player cannot press: items they do not own, talents they skipped.
  const hasAbility = (name: string) => (profile.castTimes[name]?.length ?? 0) > 0 || !!myBuff(name);
  // A major cooldown: lorrgs lists it for the spec (by spell id, or by name when the
  // log's id differs) — its word beats the hand lists, so The Hunt counts and a healer's
  // Healing Tide Totem counts — or Wowhead's tooltip states a cooldown of a minute or
  // more, or it is Bestial Wrath. Never a defensive or consumable; never something
  // lorrgs tags as movement, defensive or another role's raid cooldown; otherwise never
  // utility or movement.
  const majorIds = new Set((majorSpells ?? []).flatMap(m => m.ids));
  const majorNames = new Set((majorSpells ?? []).map(m => m.name.toLowerCase()));
  const notMajorIds = new Set((notMajorSpells ?? []).flatMap(m => m.ids));
  const notMajorNames = new Set((notMajorSpells ?? []).map(m => m.name.toLowerCase()));
  const isMajorCooldown = (name: string, spellId: number): boolean => {
    const lower = name.toLowerCase();
    if (DEFENSIVES.has(defensiveKey(name)) || buffFamily(name) !== name) return false;
    if ((spellId > 0 && notMajorIds.has(spellId)) || notMajorNames.has(lower)) return false;
    if ((spellId > 0 && majorIds.has(spellId)) || majorNames.has(lower)) return true;
    if (isUtility(name) || isMovement(name)) return false;
    return (cooldowns?.[name] ?? 0) >= MAJOR_CD_SEC || MAJOR_UNDER_60.has(name);
  };
  const timeline = pool
    ? buildTimeline(profile, pool, durationSec, aliveSec,
        name => unownedItemCast(name) || isTalentGap(name) || (!hasAbility(name) && !reportedNever.has(name)) || (cooldowns?.[name] ?? minReuseGap(pool.castStarts[name] ?? []) ?? 0) < 20,
        name => itemForCast(name) ?? name,
        name => !!itemForCast(name),
        onUseTrinkets.map(t => ({ label: t.name, castName: t.useSpellName ?? t.name, spellId: t.useSpellId ?? 0, cooldownSec: t.cooldownSec ?? 0 })),
        cooldowns ?? {}, isMajorCooldown)
    : null;
  // ── Cooldown timing: each press against the top players' median for that press ──
  // For every major cooldown row, the top players' 1st, 2nd, 3rd… presses are compared
  // as a distribution. Where their middle half agrees to within TIMING_BAND_SEC, the
  // median is the "right time" (it tracks the phase or damage window everyone waits
  // for); a press outside that band, or a press that never came while the top players
  // had pressed again, is worth a word. Where they do not agree, nothing is judged.
  if (pool && judgeable && timeline) {
    const timing: Finding[] = [];
    let judgedRows = 0, onTimeRows = 0;
    for (const row of timeline.rows) {
      // Was the buff behind this button up at the pull (pre-cast) for the top players, and for this player?
      const buffKey = Object.keys(pool.buffs).find(b => baseName(b) === baseName(row.poolName));
      const preCast = buffKey
        ? { pool: countPresent(pool.buffs[buffKey].atPull) / pool.n >= 0.5, mine: !!profile.buffs.find(b => b.name === buffKey)?.atPull }
        : null;
      const j = judgeTiming(row, aliveSec, preCast);
      row.medians = j.medians;
      row.bands = j.bands;
      // Pre-pull potions happen before the log's events start, so the pool's "first" potion
      // is really its second. The row's verdict comes from a fact the log does hold: was
      // a potion buff already running at the pull, for this player and for the top players.
      if (row.origin === 'potion') {
        const poolPre = Object.entries(pool.buffs).filter(([n]) => buffFamily(n) === 'potion').reduce((s, [, e]) => s + countPresent(e.atPull), 0) / pool.n;
        const minePre = profile.buffs.some(b => buffFamily(b.name) === 'potion' && b.atPull);
        if (poolPre >= 0.5) row.verdict = minePre ? { kind: 'good', text: 'pre-potted, like the top players' } : { kind: 'warn', text: `no pre-pot; ${Math.round(100 * poolPre)}% of top players do` };
        else if (minePre) row.verdict = { kind: 'info', text: 'pre-potted' };
        continue;
      }
      row.verdict = j.verdict;
      if (!j.verdict) continue;
      if (isTalentGap(row.poolName) || unownedItemCast(row.poolName) || TWO_STEP.has(row.poolName)) continue;
      judgedRows++;
      if (j.verdict.kind === 'good') { onTimeRows++; continue; }
      if (j.verdict.kind !== 'warn' || !j.finding) continue;
      reportedCasts.add(row.name);
      let why = '';
      const worstAt = j.worstAt;
      if (worstAt && worstAt.mine > worstAt.med) {
        const w = whatHappened(worstAt.med, Math.min(worstAt.mine, worstAt.med + 15), aliveSec);
        // A press delayed while nothing was cast at all is a different story from one
        // delayed by a mechanic.
        const idle = !w && !allCastTimes.some(t => t >= worstAt.med && t <= worstAt.med + 6);
        why = w ? ` At the top players' time, ${w}.` : idle ? ` Nothing at all was cast for the 6 seconds after the top players' time, so something was keeping you from casting.` : ' You were casting normally at the time, so it was held rather than blocked.';
      }
      timing.push({
        id: `timing-${row.name}`, severity: 'warn', category: 'cooldowns', icon: row.icon, spellId: row.spellId,
        impact: j.finding.impact,
        title: j.finding.title,
        text: why ? `${ucFirst(why.trim())} ${ucFirst(topWord)} ${j.finding.text}` : `${ucFirst(topWord)} ${j.finding.text}`,
      });
    }
    timing.sort((a, b) => b.impact - a.impact);
    findings.push(...timing.slice(0, 3));
    if (judgedRows >= 2 && onTimeRows === judgedRows) {
      findings.push({
        id: 'timing-good', severity: 'good', category: 'cooldowns', impact: 0,
        title: 'Major cooldowns on time',
        text: `Every press of your major cooldowns landed inside the window where ${topWord} press theirs (see the markers on the timeline).`,
      });
    }
  }

  if (pool && judgeable && timeline) {
    const late: Finding[] = [];
    for (const row of timeline.rows) {
      const firsts = (pool.castStarts[row.poolName] ?? pool.buffs[row.poolName]?.starts ?? []).filter(s => s.length).map(s => s[0]);
      if (firsts.length < pool.n * CONSENSUS) continue;
      const firstMed = median(firsts);
      if (firstMed > 20) continue;                                     // not an opener button
      if (reportedCasts.has(row.name)) continue;                       // already called out via the timing check
      if (TWO_STEP.has(row.name)) continue;                             // the release half of Stasis is not an opener
      if (unownedItemCast(row.name)) continue;
      if (isTalentGap(row.name)) continue;
      const myFirst = row.mine[0]?.[0];
      if (myFirst == null && buildDiffers && !myBuff(row.name) && !profile.castTimes[row.name]) { missingByBuild.push(row.name); continue; }
      if (myFirst == null) {
        late.push({
          id: `nocd-${row.name}`, severity: 'warn', category: 'cooldowns', icon: row.icon, spellId: row.spellId, impact: 48,
          title: `${row.name} never came up`,
          text: `${ucFirst(topWord)} have it running by ${fmtClock(firstMed)}. Yours never appeared in this pull.`,
        });
      } else if (myFirst > firstMed + 10) {
        late.push({
          id: `late-${row.name}`, severity: 'warn', category: 'cooldowns', icon: row.icon, spellId: row.spellId, impact: 38,
          title: `Late start on ${row.name}: ${fmtClock(myFirst)} vs ${fmtClock(firstMed)}`,
          text: `${ucFirst(topWord)} open with it. A late first press pushes every later press back by the same amount.`,
        });
      }
    }
    findings.push(...late.slice(0, 3));
  }

  // ── Buffs: consumables at the pull, pre-pull casts, uptime ──
  if (pool) {
    const missingPersistent: string[] = [];   // flask/food/rune: up ~all fight for the pool
    const missingPrePull: string[] = [];      // things top players cast before the pull timer ends
    const flagged = new Set<string>();
    const seenFamilies = new Set<string>();
    for (const [name, e] of Object.entries(pool.buffs)) {
      if (countPresent(e.atPull) / pool.n < CONSENSUS) continue;
      if (isUtility(name)) continue;
      const family = buffFamily(name);
      if (seenFamilies.has(family)) continue;
      seenFamilies.add(family);
      if (unownedItemCast(name) || isMovement(name)) continue;
      if (isTalentGap(name)) continue;
      if (myFamiliesAtPull.has(family)) continue;
      flagged.add(name);
      if (family in FAMILY_LABEL) missingPersistent.push(familyLabel(family, name));
      else if (pool.casts[name]) missingPrePull.push(name); // a proc the top players happen to carry in is not something to pre-cast
    }
    if (missingPersistent.length) {
      findings.push({
        id: 'missing-at-pull', severity: 'warn', category: 'prep', impact: 40 + Math.min(15, missingPersistent.length * 3),
        title: `Missing from the start: ${missingPersistent.slice(0, 4).join(', ')}${missingPersistent.length > 4 ? ` and ${missingPersistent.length - 4} more` : ''}`,
        text: `Nearly all of ${topWord} had ${missingPersistent.length === 1 ? 'this' : 'these'} running for the whole fight.`,
      });
    } else {
      findings.push({
        id: 'buffed', severity: 'good', category: 'prep', impact: 15,
        title: 'Flask, food and runes all up',
        text: `Every consumable ${topWord} had running at the pull, you had too.`,
      });
    }
    if (missingPrePull.length) {
      findings.push({
        id: 'pre-pull', severity: 'warn', category: 'cooldowns', impact: 30,
        title: `Not pre-cast: ${missingPrePull.slice(0, 3).join(', ')}${missingPrePull.length > 3 ? ` and ${missingPrePull.length - 3} more` : ''}`,
        text: `${ucFirst(topWord)} cast ${missingPrePull.length === 1 ? 'this' : 'these'} on the pull timer so ${missingPrePull.length === 1 ? 'it is' : 'they are'} already running at 0:00. Yours ${missingPrePull.length === 1 ? 'was' : 'were'} not up when the fight started.`,
      });
    }

    if (judgeable) {
      const lowUptime: Finding[] = [];
      for (const [name, e] of Object.entries(pool.buffs)) {
        if (flagged.has(name) || countPresent(e.uptimePct) / pool.n < CONSENSUS) continue;
        const med = median(e.uptimePct);
        if (med < 40) continue;
        if (unownedItemCast(name) || isMovement(name) || isUtility(name)) continue; // a teleport circle on the floor or a raid buff is not personal uptime
        if (isTalentGap(name)) continue;
        const family = buffFamily(name);
        const mineAll = family === name ? [myBuff(name)].filter((b): b is NonNullable<typeof b> => !!b) : profile.buffs.filter(b => buffFamily(b.name) === family);
        const myPct = mineAll.length ? Math.min(100, 100 * Math.max(...mineAll.map(b => b.uptimeMs)) / profile.aliveMs) : 0;
        if (myPct < 0.6 * med) {
          const isConsumable = family in FAMILY_LABEL;
          if (!isConsumable && !mineAll.length && buildDiffers) { missingByBuild.push(name); continue; }
          lowUptime.push({
            id: `uptime-${name}`, severity: 'warn', category: isConsumable ? 'prep' : 'buffs', icon: e.icon, spellId: e.spellId,
            impact: 40 + Math.round(20 * (1 - myPct / med)),
            title: isConsumable
              ? `${ucFirst(familyLabel(family, name))} ${mineAll.length ? `only up ${pct(myPct)} of the fight` : 'missing'}`
              : `${name} uptime: ${pct(myPct)} vs about ${pct(med)}`,
            text: isConsumable
              ? `${ucFirst(topWord)} have one running ${pct(med)} of the fight.`
              : `${ucFirst(topWord)} keep ${name} up for ${pct(med)} of the fight.${mineAll.length ? '' : ' You never had it at all in this pull.'}`,
          });
        }
      }
      lowUptime.sort((a, b) => b.impact - a.impact);
      findings.push(...lowUptime.slice(0, 4));
    }
  }

  // ── Uptime (active time) ──
  const myActivePct = Math.min(100, 100 * profile.activeTimeMs / profile.aliveMs);
  if (pool && judgeable) {
    const med = median(pool.activePct);
    if (myActivePct < med - 5) {
      const idleSec = Math.round((med - myActivePct) / 100 * aliveSec);
      findings.push({
        id: 'active', severity: 'warn', category: 'uptime', impact: 55 + Math.min(20, Math.round(med - myActivePct)),
        title: `Active ${pct(myActivePct)} of the time, top players about ${pct(med)}`,
        text: `That is roughly ${plural(idleSec, 'second')} more without a cast than ${topWord} over the pull. The downtime card below says where the gaps were.`,
      });
    } else {
      findings.push({
        id: 'active-ok', severity: 'good', category: 'uptime', impact: 18,
        title: `Uptime matched the top players (${pct(myActivePct)} vs ${pct(med)})`,
        text: 'You kept casting through the movement.',
      });
    }
  } else if (!pool && judgeable && profile.raid.length > 1) {
    const raidMed = median(profile.raid.map(r => 100 * r.activeTime / profile.durationMs));
    findings.push({
      id: 'active-raid', severity: myActivePct < raidMed - 5 ? 'warn' : 'info', category: 'uptime', impact: 30,
      title: `Active ${pct(myActivePct)} of the fight, your raid averaged ${pct(raidMed)}`,
      text: 'Without top-parse data for this spec and difficulty, your own raid is the comparison here.',
    });
  }

  // ── Potions ──
  if (pool && judgeable && poolPotions.length) {
    const med = median(poolPotions);
    if (med >= 1 && myPotions < med) {
      findings.push({
        id: 'potions', severity: 'warn', category: 'prep', impact: 30,
        title: `${plural(myPotions, 'combat potion')} used, top players use ${Math.round(med)}`,
        text: `${ucFirst(topWord)} use about ${Math.round(med)} a pull${poolPrePotShare != null ? `, and ${poolPrePotShare >= 0.5 ? `${Math.round(100 * poolPrePotShare)}% of them` : poolPrePotShare > 0 ? `only ${Math.round(100 * poolPrePotShare)}% of them` : 'none of them'} have one running at the pull` : ''}.`,
      });
    } else if (med >= 1) {
      const poolPotionNames = Object.entries(pool.buffs).filter(([n]) => buffFamily(n) === 'potion').map(([n, e]) => ({ n, present: countPresent(e.uptimePct) }));
      const meta = poolPotionNames.find(x => x.present / pool.n >= CONSENSUS);
      const mineNames = profile.buffs.filter(b => buffFamily(b.name) === 'potion').map(b => b.name);
      if (meta && !mineNames.includes(meta.n)) {
        findings.push({
          id: 'potions-type', severity: 'info', category: 'prep', impact: 20,
          title: `Potions used, just not the one top players use`,
          text: `You used ${listNames([...new Set(mineNames)])}. ${meta.present} of ${pool.n} top players use ${meta.n} on this boss.`,
        });
      } else {
        findings.push({
          id: 'potions-ok', severity: 'good', category: 'prep', impact: 10,
          title: `${plural(myPotions, 'combat potion')} used`,
          text: 'Potion usage matched the top players.',
        });
      }
    }
  }

  // ── Gear: enchants where the top players have them ──
  if (pool && pool.gearN >= 3 && profile.gear) {
    const missing: string[] = [];
    let missingOil = false;
    for (const g of profile.gear.slots) {
      if (pool.enchantBySlot[g.slot] / pool.gearN >= CONSENSUS && !g.enchanted) missing.push(GEAR_SLOT_NAMES[g.slot] ?? `slot ${g.slot}`);
      if (pool.tempBySlot[g.slot] / pool.gearN >= CONSENSUS && !g.temp) missingOil = true;
    }
    const uniq = [...new Set(missing)];
    if (uniq.length || missingOil) {
      const parts: string[] = [];
      if (uniq.length) parts.push(`no enchant on ${listNames(uniq)}`);
      if (missingOil) parts.push('no weapon oil or stone');
      findings.push({
        id: 'gear', severity: 'warn', category: 'gear', impact: 35 + uniq.length * 3,
        title: ucFirst(parts.join(', ')),
        text: `Nearly every one of ${topWord} has these.`,
      });
    } else {
      findings.push({
        id: 'gear-ok', severity: 'good', category: 'gear', impact: 8,
        title: 'Enchants all in place',
        text: 'Every slot the top players enchant, you have enchanted too.',
      });
    }
  }

  // ── Build: abilities missing because the talents behind them aren't taken ──
  if (talentNames && talents && pool) {
    const abilities = [...new Set([...talentGaps, ...missingByBuild])];
    if (!buildDiffers && !abilities.length) {
      findings.push({
        id: 'build-meta', severity: 'good', category: 'build', impact: 16,
        title: talentDiffNames.length ? `Running the meta build, ${plural(talentDiffNames.length, 'pick')} off` : 'Running the meta build',
        text: `Your talents match what ${topWord} take${talentDiffNames.length ? `, apart from ${listNames(talentDiffNames)}` : ''}.`,
        href: talents.buildsHref, hrefLabel: 'Compare with the consensus build',
      });
    }
    if (buildDiffers || abilities.length) {
      findings.push({
        id: 'build', severity: 'info', category: 'build', impact: 44,
        title: buildDiffers ? `Your build isn't the meta build for this boss` : `Your build skips ${listNames(talentGaps.slice(0, 3))}`,
        text: `${plural(talentDiffNames.length, 'talent pick')} differ${talentDiffNames.length === 1 ? 's' : ''} from ${topWord}${talentGaps.length ? `, including ${listNames(talentGaps.slice(0, 3))}` : ''}.${abilities.length ? ` Abilities they use that never appear in your log: ${listNames(abilities.slice(0, 5))}${abilities.length > 5 ? ` and ${abilities.length - 5} more` : ''}.` : ''} That is a build choice, not a mistake. The consensus build is one click away if you want to compare.`,
        href: talents.buildsHref, hrefLabel: 'See the consensus build for this boss',
      });
    }
  }

  // ── Utility ──
  if (profile.interrupts > 0 || profile.dispels > 0) {
    const parts = [];
    if (profile.interrupts > 0) parts.push(plural(profile.interrupts, 'interrupt'));
    if (profile.dispels > 0) parts.push(plural(profile.dispels, 'dispel'));
    findings.push({
      id: 'utility', severity: 'good', category: 'utility', impact: 12,
      title: `${parts.join(' and ')} landed`,
      text: 'Counted from your interrupt and dispel events.',
    });
  }

  // ── Downtime, from the casts themselves ──
  // Active time is a table figure. The cast events say where the gaps were, and the
  // boss-mechanic events say what was happening in them.
  {
    const GAP_MIN = 6;
    const gaps: Array<{ from: number; to: number; why: string | null }> = [];
    const casts = allCastTimes.filter(t => t <= aliveSec);
    for (let i = 1; i < casts.length; i++) {
      const from = casts[i - 1], to = casts[i];
      if (to - from >= GAP_MIN) gaps.push({ from, to, why: whatHappened(from, to, aliveSec) });
    }
    if (casts.length && casts[0] >= GAP_MIN) gaps.unshift({ from: 0, to: casts[0], why: whatHappened(0, casts[0], aliveSec) });
    const own = gaps.filter(g => !/^the intermission/.test(g.why ?? ''));
    const totalGap = own.reduce((s, g) => s + (g.to - g.from), 0);
    const explained = own.filter(g => g.why).reduce((s, g) => s + (g.to - g.from), 0);
    const share = aliveSec > 0 ? totalGap / aliveSec : 0;
    if (judgeable && casts.length >= 10) {
      const longest = own.slice().sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 3);
      const interNote = gaps.length > own.length ? ` ${plural(gaps.length - own.length, 'gap')} during an intermission left out.` : '';
      const describe = (g: { from: number; to: number; why: string | null }) => `${fmtClock(g.from)}–${fmtClock(g.to)} (${Math.round(g.to - g.from)}s${g.why ? `, ${g.why}` : ''})`;
      if (!own.length) {
        findings.push({ id: 'downtime', severity: 'good', category: 'uptime', impact: 12, title: `No casting gap longer than ${GAP_MIN} seconds`, text: 'From the first cast to the last, the log never shows you idle for six seconds or more.' });
      } else {
        const severity = share >= 0.12 && totalGap >= 15 ? 'warn' : totalGap >= 10 ? 'info' : 'good';
        findings.push({
          id: 'downtime', severity, category: 'uptime', impact: severity === 'warn' ? 40 : 14,
          title: `${Math.round(totalGap)}s with nothing cast, in ${plural(own.length, 'gap')} of ${GAP_MIN}s or more`,
          text: `${pct(100 * share)} of the time you were alive. Longest: ${longest.map(describe).join('; ')}.${explained ? ` ${pct(100 * explained / totalGap)} of it lines up with a mechanic or movement in the log; the rest has no explanation in the events.` : ' None of it lines up with a mechanic hit or a movement ability in the log.'}${interNote}`,
          events: gaps.map(g => ({ atSec: g.from, text: `${Math.round(g.to - g.from)}s gap until ${fmtClock(g.to)}${g.why ? ` — ${g.why}` : ''}` })),
        });
      }
    }
  }

  // ── Resource waste ──
  // "waste" on a resourcechange event is what the game discarded because the bar was
  // full: generation that never became a cast.
  for (const w of (profile.resourceWaste ?? []).slice(0, 2)) {
    if (w.gained < 100) continue;
    const share = w.wasted / w.gained;
    if (share < 0.03) {
      findings.push({ id: `resource-${w.type}`, severity: 'good', category: 'rotation', impact: 10, title: `${w.name} spent cleanly: ${pct(100 * share)} wasted`, text: `${fmtNum(w.wasted)} of ${fmtNum(w.gained)} ${w.name} generated went over the cap.` });
      continue;
    }
    findings.push({
      id: `resource-${w.type}`, severity: share >= 0.2 ? 'warn' : 'info', category: 'rotation', impact: share >= 0.2 ? 34 : 16,
      title: `${pct(100 * share)} of ${w.name} wasted at the cap`,
      text: `${fmtNum(w.wasted)} of the ${fmtNum(w.gained)} ${w.name} you generated was thrown away because the bar was already full. Resource over the cap is generation that never became a cast.`,
    });
  }

  // ── Output ──
  const perSec = profile.outputTotal / (profile.durationMs / 1000);
  const metricLabel = player.role === 'healer' ? 'HPS' : 'DPS';
  const stats: ReviewStat[] = [
    { label: metricLabel, value: fmtNum(perSec) },
    { label: 'Active', value: pct(myActivePct), note: aliveSec < durationSec - 5 ? 'while alive' : undefined },
    { label: 'Deaths', value: String(profile.deaths.length), note: realDeaths.length ? `first at ${fmtClock(realDeaths[0].atSec)}` : profile.deaths.length ? 'only the wipe' : undefined },
    { label: 'Potions', value: String(myPotions), note: poolPotions.length ? `top use ${Math.round(median(poolPotions))}` : undefined },
    { label: 'Item level', value: player.ilvl ? String(Math.round(player.ilvl)) : '—', note: pool && pool.ilvl.length ? `top ~${Math.round(median(pool.ilvl))}` : undefined },
  ];
  if (pool) {
    const totalTaken = profile.damageTaken.reduce((s, t) => s + t.total, 0);
    stats.push({ label: 'Avoidable dmg', value: fmtNum(avoidableTotal), note: totalTaken ? `${pct(100 * avoidableTotal / totalTaken)} of damage taken` : undefined });
  }
  if (talentNames) {
    stats.push({ label: 'Build', value: talentDiffNames.length <= 2 ? 'Meta' : talentDiffNames.length <= 5 ? 'Near meta' : 'Off-meta', note: talentDiffNames.length ? `${plural(talentDiffNames.length, 'pick')} differ` : 'matches top players' });
  }
  let verdict = `${fmtNum(perSec)} ${metricLabel}${aliveSec < durationSec - 5 ? `, dead at ${fmtClock(aliveSec)}` : ', alive the whole pull'}`;
  if (pool && pool.output.length) {
    const med = median(pool.output);
    const ratio = med > 0 ? perSec / med : 0;
    stats[0].note = `${pct(100 * ratio)} of top-${pool.n} median`;
    verdict = `${fmtNum(perSec)} ${metricLabel}, ${pct(100 * ratio)} of the top-${pool.n} median${aliveSec < durationSec - 5 ? `, dead at ${fmtClock(aliveSec)}` : ', alive the whole pull'}`;
    const deadNote = aliveSec < durationSec - 5 ? ` You were dead for ${fmtClock(durationSec - aliveSec)} of a ${fmtClock(durationSec)} pull, which is most of the gap on its own.` : '';
    const healerNote = player.role === 'healer' ? ' Healing parses reward raids that take damage, so a low number here is not automatically a problem.' : '';
    findings.push({
      id: 'output', severity: ratio >= 0.85 ? 'good' : ratio >= 0.6 ? 'info' : 'warn', category: 'output', impact: 35,
      title: `${fmtNum(perSec)} ${metricLabel}, ${pct(100 * ratio)} of what ${topWordFull} average`,
      text: (ratio >= 0.85
        ? `That is within touching distance of the best parses on this boss${pool.difficulty !== fight.difficulty ? ' (compared on a different difficulty, so take it loosely)' : ''}.`
        : ratio >= 0.6
          ? 'A normal gap for a progression raid. The findings above are where it comes from, in order.'
          : 'A big gap. The findings above are ranked by what cost the most.') + deadNote + healerNote,
    });
  }
  if (profile.raid.length > 1) {
    const sorted = profile.raid.slice().sort((a, b) => b.total - a.total);
    const rank = sorted.findIndex(r => r.id === player.id) + 1;
    if (rank > 0) stats.push({ label: `Raid ${outputWord}`, value: `#${rank} of ${sorted.length}` });
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.impact - a.impact);

  // ── Headline & summary ──
  const diffLabel = DIFFICULTY_LABELS[fight.difficulty] ?? '';
  const result = fight.kill ? 'kill' : `wipe at ${Math.round(fight.fightPercentage)}%`;
  const headline = `${player.name}, ${specLabel} on ${fight.name}. ${diffLabel} ${result}, ${fmtClock(durationSec)}.`;

  const problems = findings.filter(f => f.severity === 'bad' || f.severity === 'warn');
  const wins = findings.filter(f => f.severity === 'good');
  let summary: string;
  if (problems.length === 0) {
    summary = `Honestly, not much to fix here. ${wins[0] ? wins[0].title + '.' : ''}`;
  } else {
    const top = problems.slice(0, 3).map(f => f.title.replace(/\.$/, ''));
    summary = `${top.length === 1 ? 'The one thing to fix' : `The ${top.length === 2 ? 'two' : 'three'} things to fix first`}: ${top.join('. ')}.`;
    if (wins.length) summary += ` On the plus side: ${wins.slice(0, 2).map(w => w.title.replace(/\.$/, '')).join('. ')}.`;
  }

  const sourceParts: string[] = [];
  if (boss?.sources.dbm) sourceParts.push('mechanic types from Deadly Boss Mods');
  if (raidStats && raidStats.n > 0) sourceParts.push(`who takes what across ${plural(raidStats.n, 'top raid')}`);
  if (boss?.sources.descriptions) sourceParts.push('ability descriptions from Wowhead');
  if (majorSpells) sourceParts.push(LORRGS_CREDIT);
  const sourcesNote = sourceParts.length ? ucFirst(sourceParts.join(', ')) + '.' : null;

  let poolNote: string | null = null;
  if (!pool) poolNote = `No top-parse pool was available for ${specLabel} on ${diffLabel} ${fight.name}, so this review only covers what can be read from your own log.`;
  else if (pool.difficulty !== fight.difficulty) poolNote = `Compared against ${DIFFICULTY_LABELS[pool.difficulty] ?? 'another'} top parses because there is no ranked pool for ${diffLabel}.`;
  else if (sameDiffIdx.length < pool.n) poolNote = `Compared against ${pool.n} top ${specLabel} parses: ${sameDiffIdx.length} on ${diffLabel}, the rest on Heroic. Damage comparisons use only the ${diffLabel} ones.`;
  else if (pool.n < 10) poolNote = `Compared against the ${pool.n} top ${specLabel} parses available for this boss.`;

  const debug = {
    poolN: pool?.n ?? 0, poolTalentN: pool?.talentN ?? 0, poolGearN: pool?.gearN ?? 0,
    myTalentNodes: profile.talentNodes?.length ?? 0, layoutNodes: talents ? Object.keys(talents.nodeNames).length : 0,
    entryNames: talents ? Object.keys(talents.entryNames).length : 0, myTalentNames: talentNames?.mine.size ?? 0,
    talentDiffNames, talentGaps, missingByBuild, buildDiffers,
    myItemNames: [...myItemNames], poolItemNames: pool?.itemNames.length ?? 0, poolCastStarts: Object.keys(pool?.castStarts ?? {}),
    timelineSkips: Object.entries(pool?.castStarts ?? {}).map(([name, starts]) => `${name}: present=${countPresent(starts.map(x => x.length))} cd=${cooldowns?.[name] ?? '?'}/${minReuseGap(starts) ?? '?'} item=${unownedItemCast(name)} gap=${isTalentGap(name)}`),
    buffRowDebug: Object.entries(pool?.buffs ?? {}).filter(([n]) => /Metamorph|Devoured Strength|Golden Luster|Impending/.test(n)).map(([n, e]) => { const mine = profile.buffs.find(b => b.name === n); return `${n}: present=${countPresent(e.uptimePct)}/${pool?.n} poolCountMed=${median(e.starts.map(x => x.length))} uptimeMed=${Math.round(median(e.uptimePct))} mineBands=${mine?.bands.length ?? 'none'} mineDur=${mine?.bands.length ? Math.round(median(mine.bands.map(([x, y]) => y - x))) : '-'} icon=${e.icon} cd=${cooldowns?.[n] ?? 'undef'} family=${buffFamily(n) === n}`; }),
    knownPotions: [...KNOWN_POTIONS], potionBuffs: profile.buffs.filter(b => /potential|luster|potion|draught/i.test(b.name)).map(b => `${b.name}:${b.uses}`),
    trinkets: (trinkets ?? []).map(t => `${t.name}#${t.itemId} use=${t.onUse} cd=${t.cooldownSec ?? '?'}`), cooldownsKnown: Object.keys(cooldowns ?? {}).length,
    resourceWaste: (profile.resourceWaste ?? []).map(w => `${w.name}: ${w.wasted}/${w.gained}`), deathRecaps: (profile.deathRecaps ?? []).map(r => `${r.atSec}: ${r.hits.length} hits, ${r.healCount} heals, auras ${r.aurasAtDeath.map(a => a.name).join('/')}`),
    defensiveRoster: defensiveRows.map(r => `${r.name}:${r.used}/${r.possible ?? '?'} cd=${r.cooldownSec ?? '?'} ch=${r.charges}`),
    potionCasts: profile.casts.filter(c => /potion|heal/i.test(c.name)).map(c => `${JSON.stringify(c.name)} codes=${[...c.name].map(ch => ch.charCodeAt(0)).join(",")} id=${c.spellId} key=${defensiveKey(c.name)} def=${DEFENSIVES.has(defensiveKey(c.name))} fam=${buffFamily(c.name)}`),
    buffTrace: timeline?.trace ?? [],
    timelineRows: (timeline?.rows ?? []).map(r => `${r.name} <${r.poolName}> ${r.kind}/${r.origin} #${r.spellId} mine=${r.mine.length} pool=${r.pool.length} medians=${r.medians.map(fmtClock).join('/')} verdict=${r.verdict ? r.verdict.kind + ':' + r.verdict.text : '-'}`),
    majorSpells: (majorSpells ?? []).map(m => `${m.name}#${m.spellId}${m.cooldown ? '@' + m.cooldown : ''}:${m.kind}`), notMajorSpells: (notMajorSpells ?? []).map(m => m.name), lorrgsLoaded: !!majorSpells,
    dbmLabels: boss?.labels.length ?? 0, journalAbilities: boss?.journal.length ?? 0, raidStatFights: raidStats?.n ?? 0,
    classified: profile.damageTaken.map(t => `${t.name}: ${classify(t.name, t.spellId)?.type ?? '-'} (${classify(t.name, t.spellId)?.via ?? ''})`),
  };
  return { headline, summary, verdict, stats, findings, timeline: timeline ? { durationSec: timeline.durationSec, aliveSec: timeline.aliveSec, phases: context?.phases ?? [], rows: timeline.rows.map(r => ({ name: r.name, icon: r.icon, spellId: r.spellId, kind: r.kind, mine: r.mine, pool: r.pool, poolN: r.poolN, medians: r.medians, bands: r.bands, verdict: r.verdict })) } : null, defensives: defensiveRows, poolNote, sourcesNote, debug };
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

interface TimelineRowInternal extends TimelineRow { poolName: string; firstMed: number; origin: 'pool' | 'potion' | 'own' | 'buff' | 'trinket'; members: number[][] }

// Rows, lorrgs-style: the spec's major cooldowns (see isMajorCooldown in reviewPlayer),
// combat potions as one row, and the player's own on-use trinkets with a cooldown of a
// minute or more. Bars run from the cast to the end of the matching buff when there is
// one, else a few seconds. Ordered by when the top players first press each.
const TIMELINE_MAX_ROWS = 8;

// The top players' k-th press agrees when the middle half of them land within this
// many seconds of each other; a press of this player's that is further than the band
// (or 20s, whichever is larger) from their median is early or late.
const TIMING_BAND_SEC = 45;
const TIMING_MIN_SHARE = 0.6;
const ordinal = (k: number) => ['first', 'second', 'third', 'fourth', 'fifth'][k] ?? `${k + 1}th`;
const shortOrdinal = (k: number) => ['1st', '2nd', '3rd'][k] ?? `${k + 1}th`;

interface TimingJudgement {
  medians: number[];
  bands: Array<{ k: number; med: number; lo: number; hi: number }>;
  verdict: TimelineRow['verdict'];
  finding: { title: string; text: string; impact: number } | null;
  // The worst-off press: when this player pressed, and when the top players do.
  worstAt?: { mine: number; med: number } | null;
}

function judgeTiming(row: TimelineRowInternal, aliveSec: number, preCast: { pool: boolean; mine: boolean } | null): TimingJudgement {
  const none: TimingJudgement = { medians: [], bands: [], verdict: null, finding: null };
  const members = row.members.map(s => s.slice().sort((a, b) => a - b));
  if (members.length < 3) return none;
  const n = members.length;
  const mine = row.mine.map(([s]) => s).sort((a, b) => a - b);
  const bands: Array<{ k: number; med: number; lo: number; hi: number; agree: boolean }> = [];
  for (let k = 0; k < 40; k++) { // every press the top players make, not just the first few
    const kth = members.map(s => s[k]).filter((x): x is number => x != null).sort((a, b) => a - b);
    if (kth.length < n * TIMING_MIN_SHARE) break;
    const lo = kth[Math.floor(kth.length * 0.25)];
    const hi = kth[Math.min(kth.length - 1, Math.floor(kth.length * 0.75))];
    bands.push({ k, med: median(kth), lo, hi, agree: hi - lo <= TIMING_BAND_SEC });
  }
  const medians = bands.filter(b => b.agree).map(b => b.med);
  const agreed = bands.filter(b => b.agree).map(b => ({ k: b.k, med: b.med, lo: b.lo, hi: b.hi }));
  if (!bands.length) return none;
  // Tolerance: the band the top players themselves span, at least 20s, widening a
  // little as the fight goes on (6% of the way in) so a 5th press at 8:45 is not
  // "late" by 22 seconds.
  const tol = (b: { med: number; lo: number; hi: number }) => Math.max(20, b.hi - b.lo, 0.06 * b.med);
  // How well this player's presses line up with the top players' when the press
  // indexes are shifted: +1 means this player's first press matches their second
  // (a press missing at the start), -1 means this player's second matches their first
  // (one press more at the start — usually the top players pre-cast before the pull,
  // which the log's events do not contain, and this player did not).
  const fit = (shift: number) => {
    let sum = 0, cnt = 0;
    for (const b of bands) {
      if (!b.agree) continue;
      const m = mine[b.k - shift];
      if (m == null) continue;
      sum += Math.abs(m - b.med); cnt++;
    }
    return cnt >= 2 ? sum / cnt : null;
  };
  const f0 = fit(0), fPlus = fit(1), fMinus = fit(-1);
  const shifted = f0 != null && ((fPlus != null && fPlus < 0.5 * f0 && fPlus <= 30) ? 1 : (fMinus != null && fMinus < 0.5 * f0 && fMinus <= 30) ? -1 : 0);
  if (shifted === -1) {
    // Facts first: did the top players have the buff up at the pull while this player did not?
    if (preCast?.pool && !preCast.mine) return { medians, bands: agreed, verdict: { kind: 'info', text: 'not pre-cast; later presses in step' }, finding: null };
    return { medians, bands: agreed, verdict: { kind: 'info', text: 'one press ahead of top players' }, finding: null };
  }
  if (shifted === 1) {
    const first = bands[0];
    return {
      medians,
      bands: agreed,
      verdict: { kind: 'warn', text: `1st press a cooldown late; rest in step` },
      finding: {
        title: `${row.name}: first press at ${fmtClock(mine[0])}, top players at ${fmtClock(first.med)}`,
        text: `press it first around ${fmtClock(first.med)}. Yours came a whole cooldown later and every press after stayed one step behind — one use of ${row.name} lost over the fight.`,
        impact: 46,
      },
    };
  }
  // Presses the top players had made while this player was still alive (with a little
  // slack: a press due at 2:00 is not "missed" by someone who died at 2:05).
  const due = bands.filter(b => b.med <= aliveSec - 15).length;
  const offs: Array<{ k: number; diff: number; med: number }> = [];
  let judged = 0;
  for (const b of bands) {
    if (!b.agree || mine[b.k] == null) continue;
    judged++;
    const diff = mine[b.k] - b.med;
    if (Math.abs(diff) > tol(b)) offs.push({ k: b.k, diff, med: b.med });
  }
  const missing = Math.max(0, due - mine.length);
  if (!judged && !missing) return { medians, bands: agreed, verdict: null, finding: null };
  offs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const parts: string[] = [];
  const two = offs.slice(0, 2);
  if (two.length === 2 && (two[0].diff > 0) === (two[1].diff > 0)) {
    parts.push(`${shortOrdinal(two[0].k)} ${Math.round(Math.abs(two[0].diff))}s, ${shortOrdinal(two[1].k)} ${Math.round(Math.abs(two[1].diff))}s ${two[0].diff > 0 ? 'late' : 'early'}`);
  } else {
    for (const o of two) parts.push(`${shortOrdinal(o.k)} ${Math.round(Math.abs(o.diff))}s ${o.diff > 0 ? 'late' : 'early'}`);
  }
  if (missing) parts.push(`${plural(mine.length, 'use')} vs ${due}`);
  if (!parts.length) {
    return { medians, bands: agreed, verdict: { kind: 'good', text: judged === 1 ? 'on time' : `${judged} of ${judged} on time` }, finding: null };
  }
  const worst = offs[0];
  const title = missing && !worst
    ? `${row.name}: ${plural(mine.length, 'use')} where top players get ${due}`
    : `${row.name} ${ordinal(worst.k)} use at ${fmtClock(mine[worst.k])}, top players at ${fmtClock(worst.med)}`;
  const text = missing && !worst
    ? `had pressed it ${due} times by ${fmtClock(aliveSec)}; you pressed it ${plural(mine.length, 'time')}. A press that never happens is damage that never happens.`
    : `press their ${ordinal(worst.k)} ${row.name} around ${fmtClock(worst.med)} — usually a phase or a damage window. Yours was ${Math.round(Math.abs(worst.diff))}s ${worst.diff > 0 ? 'later' : 'earlier'}${missing ? `, and you ended ${plural(missing, 'use')} short of them` : ''}.`;
  return {
    medians,
    bands: agreed,
    verdict: { kind: 'warn', text: parts.join(' · ') },
    finding: { title, text, impact: 34 + Math.min(14, Math.round((worst ? Math.abs(worst.diff) : 60) / 12)) + (missing ? 6 : 0) },
    worstAt: worst ? { mine: mine[worst.k], med: worst.med } : null,
  };
}
const baseName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase();
function buildTimeline(profile: PlayerProfile, pool: PoolSummary, durationSec: number, aliveSec: number, skip: (name: string) => boolean, labelFor: (name: string) => string, isItemEffect: (name: string) => boolean, ownTrinkets: Array<{ label: string; castName: string; spellId: number; cooldownSec: number }>, cooldowns: Record<string, number>, isMajor: (name: string, spellId: number) => boolean): { durationSec: number; aliveSec: number; rows: TimelineRowInternal[]; trace: string[] } {
  const rows: TimelineRowInternal[] = [];
  const buffDuration = (name: string) => {
    const b = profile.buffs.find(x => x.name === name);
    return b?.bands.length ? median(b.bands.map(([s, e]) => e - s)) : 0;
  };
  const bars = (times: number[], dur: number): Array<[number, number]> => times.slice().sort((a, b) => a - b).map(t => [t, t + Math.max(3, Math.min(dur, 60))]);
  for (const [name, starts] of Object.entries(pool.castStarts)) {
    if (skip(name) || buffFamily(name) !== name || name === 'Healthstone' || name === 'Healing potion') continue;
    if (countPresent(starts.map(s => s.length)) / pool.n < CONSENSUS) continue;
    if (median(starts.map(s => s.length)) < 1) continue;
    const e = pool.casts[name];
    if (!isMajor(name, profile.casts.find(c => c.name === name)?.spellId || e?.spellId || 0)) continue;
    const firsts = starts.filter(s => s.length).map(s => s[0]);
    rows.push({
      kind: 'cooldown', origin: 'pool',
      poolName: name,
      name: labelFor(name),
      icon: profile.casts.find(c => c.name === name)?.icon || e?.icon || '',
      spellId: profile.casts.find(c => c.name === name)?.spellId || e?.spellId || 0,
      mine: bars(profile.castTimes[name] ?? [], buffDuration(name)),
      pool: starts.flat(),
      poolN: pool.n,
      firstMed: median(firsts),
      members: starts, medians: [], bands: [], verdict: null,
    });
  }
  // Combat potions: every potion name folded into one row.
  const poolPotion: number[][] = Array.from({ length: pool.n }, () => []);
  for (const [name, starts] of Object.entries(pool.castStarts)) if (buffFamily(name) === 'potion') starts.forEach((s, i) => poolPotion[i].push(...s));
  const minePotion = Object.entries(profile.castTimes).filter(([n]) => buffFamily(n) === 'potion').flatMap(([, t]) => t);
  if (countPresent(poolPotion.map(s => s.length)) / pool.n >= 0.5 || minePotion.length) {
    const potionCast = profile.casts.find(c => buffFamily(c.name) === 'potion');
    const firsts = poolPotion.filter(s => s.length).map(s => Math.min(...s));
    rows.push({
      kind: 'cooldown', origin: 'potion',
      poolName: 'Combat potion', name: 'Combat potion',
      icon: potionCast?.icon ?? '', spellId: potionCast?.spellId ?? 0,
      mine: bars(minePotion, 30), pool: poolPotion.flat(), poolN: pool.n,
      firstMed: firsts.length ? median(firsts) : 0,
      members: poolPotion, medians: [], bands: [], verdict: null,
    });
  }
  // The player's own major cooldowns that the top players' builds don't press (a
  // different hero tree): cast in this pull, up to 20 times.
  for (const c of profile.casts) {
    if (rows.some(r => r.poolName === c.name) || c.total > 20 || !isMajor(c.name, c.spellId)) continue;
    const times = profile.castTimes[c.name] ?? [];
    if (!times.length) continue;
    rows.push({
      kind: 'cooldown', origin: 'own',
      poolName: c.name, name: labelFor(c.name), icon: c.icon, spellId: c.spellId,
      mine: bars(times, buffDuration(c.name)), pool: pool.castStarts[c.name]?.flat() ?? [], poolN: pool.n,
      firstMed: Math.min(...times),
      members: pool.castStarts[c.name] ?? [], medians: [], bands: [], verdict: null,
    });
  }
  // Cooldown-shaped self-buffs that never log as a cast — Void Metamorphosis is applied
  // by the spec's own mechanics, 7 or 8 windows a fight — drawn only when the player
  // has the buff in this pull. Band counts, not "uses", decide the shape: a stacking
  // effect under the same name can add hundreds of applications.
  const trace: string[] = [];
  for (const [name, e] of Object.entries(pool.buffs)) {
    const T = (why: string) => { if (/Metamorph/.test(name)) trace.push(`${name}: ${why}`); };
    if (rows.some(r => r.poolName === name || r.name === name)) { T("dup"); continue; }
    // "Stasis" the buff is "Stasis (Store)" the cast: one button, one row.
    if (rows.some(r => baseName(r.poolName) === baseName(name) || baseName(r.name) === baseName(name))) { T("basename dup"); continue; }
    if (countPresent(e.uptimePct) / pool.n < CONSENSUS) { T("consensus"); continue; }
    const poolCounts = e.starts.map(x => x.length);
    if (median(poolCounts) < 1 || median(poolCounts) > 12 || median(e.uptimePct) > 60) { T("pool shape"); continue; }
    const mine = profile.buffs.find(b => b.name === name);
    if (!mine || !mine.bands.length || mine.bands.length > 12) { T("mine bands " + (mine?.bands.length ?? "none")); continue; }
    if (median(mine.bands.map(([s, e2]) => e2 - s)) < 15) { T("short windows"); continue; } // a proc that flickers for seconds is not a cooldown window
    if (isItemEffect(name) || !isMajor(name, mine.spellId || e.spellId)) { T(`item=${isItemEffect(name)} major=${isMajor(name, mine.spellId || e.spellId)} id=${mine.spellId || e.spellId}`); continue; } // item effects are trinket rows; the rest must be a major cooldown
    const firsts = e.starts.filter(x => x.length).map(x => x[0]);
    // Every window starts inside a drawn cooldown's own window: it is that cooldown's
    // buff (Devoured Strength lives inside each Voracious Heart press), not a row of its own.
    const followsACast = mine.bands.every(([s]) => rows.some(r => r.kind === 'cooldown' && r.mine.some(([cs, ce]) => s >= cs - 1.5 && s <= ce + 1.5)));
    if (followsACast) { T("follows a cast"); continue; }
    T("pushed");
    rows.push({
      kind: 'buff', origin: 'buff',
      poolName: name, name: labelFor(name), icon: mine.icon || e.icon, spellId: mine.spellId || e.spellId,
      mine: mine.bands, pool: e.starts.flat(), poolN: pool.n,
      firstMed: firsts.length ? median(firsts) : 9999,
      members: e.starts, medians: [], bands: [], verdict: null,
    });
  }

  // The player's own on-use trinkets with a cooldown of a minute or more (top players
  // may carry different ones).
  for (const t of ownTrinkets) {
    if (t.cooldownSec < MAJOR_CD_SEC) continue;
    if (rows.some(r => r.poolName === t.castName || r.name === t.label || r.name === t.castName)) continue;
    const c = profile.casts.find(x => (t.spellId && x.spellId === t.spellId) || x.name === t.castName);
    const times = c ? (profile.castTimes[c.name] ?? []) : [];
    rows.push({
      kind: 'cooldown', origin: 'trinket',
      poolName: c?.name ?? t.castName, name: t.label, icon: c?.icon ?? '', spellId: c?.spellId || t.spellId,
      mine: bars(times, buffDuration(c?.name ?? t.castName)), pool: [], poolN: pool.n,
      firstMed: times.length ? Math.min(...times) : 9999,
      members: pool.castStarts[c?.name ?? t.castName] ?? [], medians: [], bands: [], verdict: null,
    });
  }
  rows.sort((a, b) => (a.kind === b.kind ? a.firstMed - b.firstMed : a.kind === 'cooldown' ? -1 : 1));
  return { durationSec, aliveSec, rows: rows.slice(0, TIMELINE_MAX_ROWS), trace };
}
