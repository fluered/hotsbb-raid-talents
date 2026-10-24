/* eslint-disable @typescript-eslint/no-explicit-any */ // raw WCL table JSON, same posture as lib/wow.ts
import { unstable_cache } from 'next/cache';
import { getPersistentReadOnly, setPersistentValue } from './persistentCache';
import { getRankingsCachedSWR, wclQuery, HEALER_SPECS, SPEC_IDS } from './wow';
import { defensiveKey, isDefensive } from './defensives';

// ─── Log review: data layer ─────────────────────────────────────────────────────
//
// Everything a review needs comes from Warcraft Logs report tables (casts, buffs,
// damage taken/done, deaths) — aggregated per fight, ~1 point each, far cheaper than
// raw events. A player's fight is compared against a POOL built from the same tables
// for the top-ranked players of the same spec on the same boss (the rankings the
// finder already caches), so no per-spec rulebook has to be written or maintained:
// "what top players do" is measured, not hand-coded. See lib/analyzeRules.ts for the
// comparison itself.
//
// Abilities are keyed by NAME, not spell id: the same button often logs under several
// ids (ranks, talent overrides, "Volatile Purge" ×2), and a per-id comparison then
// reads as "you never used X" twice while the player pressed it plenty.

// ─── Input ────────────────────────────────────────────────────────────────────

export interface ReportRef {
  code: string;
  fightId: number | 'last' | null;
  sourceId: number | null;
}

// Accepts a full report URL (with or without the #fight=…&source=… hash) or a bare
// report code. Codes are alphanumeric, which is also what makes them safe to
// interpolate into GraphQL below.
export function parseReportInput(raw: string): ReportRef | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  let code: string | null = null;
  const m = text.match(/reports\/([A-Za-z0-9]{10,24})/);
  if (m) code = m[1];
  else if (/^[A-Za-z0-9]{10,24}$/.test(text)) code = text;
  if (!code) return null;
  const hash = text.includes('#') ? text.slice(text.indexOf('#') + 1) : '';
  const params = new URLSearchParams(hash.replace(/^\?/, ''));
  const fightRaw = params.get('fight');
  const sourceRaw = params.get('source');
  const fightId: ReportRef['fightId'] = fightRaw === 'last' ? 'last' : fightRaw && /^\d+$/.test(fightRaw) ? parseInt(fightRaw) : null;
  const sourceId = sourceRaw && /^\d+$/.test(sourceRaw) ? parseInt(sourceRaw) : null;
  return { code, fightId, sourceId };
}

// ─── Report overview ──────────────────────────────────────────────────────────

export interface ReportFight {
  id: number;
  encounterID: number;
  name: string;
  difficulty: number;
  kill: boolean;
  fightPercentage: number;
  startTime: number;
  endTime: number;
  durationMs: number;
}

export interface ReportOverview {
  code: string;
  title: string;
  startTime: number;
  fights: ReportFight[];
}

export const DIFFICULTY_LABELS: Record<number, string> = { 1: 'LFR', 2: 'Flex', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };

// Short revalidate: a report that's still being live-logged grows new fights.
export async function getReportOverview(token: string, code: string): Promise<ReportOverview | null> {
  const data = await wclQuery(
    token,
    `{ reportData { report(code: "${code}") { title startTime fights(killType: Encounters) { id encounterID name difficulty kill fightPercentage startTime endTime } } } }`,
    'report-overview',
    300
  );
  const report = data?.reportData?.report;
  if (!report) return null;
  const fights: ReportFight[] = (report.fights ?? [])
    // Raid difficulties only (1-5); Mythic+ runs (10) in the same report have no ranked pool to compare against.
    .filter((f: any) => f.encounterID && f.difficulty >= 1 && f.difficulty <= 5)
    .map((f: any) => ({
      id: f.id,
      encounterID: f.encounterID,
      name: f.name,
      difficulty: f.difficulty ?? 0,
      kill: !!f.kill,
      fightPercentage: f.fightPercentage ?? 0,
      startTime: f.startTime,
      endTime: f.endTime,
      durationMs: Math.max(0, (f.endTime ?? 0) - (f.startTime ?? 0)),
    }));
  return { code, title: report.title ?? code, startTime: report.startTime ?? 0, fights };
}

// ─── Players in a fight ───────────────────────────────────────────────────────

export type Role = 'tank' | 'healer' | 'dps';

export interface GearSlot {
  slot: number;
  id: number;
  name: string;
  ilvl: number;
  enchanted: boolean;
  temp: boolean;   // weapon oil / sharpening stone style temporary enchant
  gems: number;
}

export interface GearInfo {
  ilvl: number;     // average over real equipment slots
  slots: GearSlot[];
}

// WoW inventory slot indexes as WCL reports them in combatantInfo.gear.
export const GEAR_SLOT_NAMES: Record<number, string> = {
  0: 'Head', 1: 'Neck', 2: 'Shoulders', 3: 'Shirt', 4: 'Chest', 5: 'Belt', 6: 'Legs', 7: 'Boots',
  8: 'Bracers', 9: 'Gloves', 10: 'Ring', 11: 'Ring', 12: 'Trinket', 13: 'Trinket', 14: 'Cloak',
  15: 'Weapon', 16: 'Off-hand', 17: 'Tabard',
};
const COSMETIC_SLOTS = new Set([3, 17]);

export interface FightPlayer {
  id: number;
  name: string;
  server: string | null;
  className: string; // site spelling, e.g. "Death Knight"
  spec: string;      // site spelling, e.g. "Beast Mastery"
  role: Role;
  ilvl: number;
  potionUse: number;
  healthstoneUse: number;
  gear: GearInfo | null; // only when the query asked for combatant info
  // Taken talents as [nodeID, traitEntryId] pairs, same source. The entry id picks
  // the side of a choice node, when the entry→talent bridge map knows it.
  talentNodes: Array<[number, number]> | null;
}

// WCL spells classes/specs without spaces ("DeathKnight", "BeastMastery"); the site
// (and SPEC_IDS) uses the spaced names. Bridge both ways.
const CLASS_BY_WCL: Record<string, string> = Object.fromEntries(
  Object.keys(SPEC_IDS).map(c => [c.replace(/\s+/g, ''), c])
);
export const PLAYER_CLASS_TYPES = new Set(Object.keys(CLASS_BY_WCL));

function siteSpecName(className: string, wclSpec: string): string {
  const specs = Object.keys(SPEC_IDS[className] ?? {});
  return specs.find(s => s.replace(/\s+/g, '') === wclSpec) ?? wclSpec;
}

function mapGear(gear: any): GearInfo | null {
  if (!Array.isArray(gear) || gear.length === 0) return null;
  const slots: GearSlot[] = gear
    .filter((g: any) => (g?.id ?? 0) > 0 && !COSMETIC_SLOTS.has(g.slot))
    .map((g: any) => ({
      slot: g.slot,
      id: g.id,
      name: g.name ?? '',
      ilvl: g.itemLevel ?? 0,
      enchanted: !!g.permanentEnchant,
      temp: !!g.temporaryEnchant,
      gems: Array.isArray(g.gems) ? g.gems.length : 0,
    }));
  const real = slots.filter(s => s.ilvl > 1);
  const ilvl = real.length ? real.reduce((s, g) => s + g.ilvl, 0) / real.length : 0;
  return { ilvl, slots };
}

export function mapPlayerDetails(pd: any): FightPlayer[] {
  const out: FightPlayer[] = [];
  const groups: Array<[Role, any[]]> = [['tank', pd?.tanks ?? []], ['healer', pd?.healers ?? []], ['dps', pd?.dps ?? []]];
  for (const [role, list] of groups) {
    for (const p of list) {
      const className = CLASS_BY_WCL[p.type] ?? p.type ?? '';
      // A player can swap specs mid-report; take the one they spent the most fights in.
      const specs: Array<{ spec: string; count: number }> = Array.isArray(p.specs) ? p.specs : [];
      const topSpec = specs.slice().sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0]?.spec
        ?? (typeof p.icon === 'string' && p.icon.includes('-') ? p.icon.split('-')[1] : '');
      // combatantInfo is an object when requested and present, [] otherwise.
      const ci = p.combatantInfo && !Array.isArray(p.combatantInfo) ? p.combatantInfo : null;
      out.push({
        id: p.id,
        name: p.name,
        server: p.server ?? null,
        className,
        spec: siteSpecName(className, topSpec),
        role,
        ilvl: p.maxItemLevel ?? p.minItemLevel ?? 0,
        potionUse: p.potionUse ?? 0,
        healthstoneUse: p.healthstoneUse ?? 0,
        gear: ci ? mapGear(ci.gear) : null,
        talentNodes: ci && Array.isArray(ci.talentTree) ? ci.talentTree.filter((t: any) => (t.rank ?? 0) > 0 && t.nodeID).map((t: any): [number, number] => [Number(t.nodeID), Number(t.id) || 0]) : null,
      });
    }
  }
  return out;
}

export function getFightPlayers(token: string, code: string, fightId: number): Promise<FightPlayer[]> {
  return unstable_cache(
    async () => {
      const data = await wclQuery(token, `{ reportData { report(code: "${code}") { playerDetails(fightIDs: [${fightId}], includeCombatantInfo: true) } } }`, 'player-details');
      return mapPlayerDetails(data?.reportData?.report?.playerDetails?.data?.playerDetails);
    },
    [`analyze-players-v2-${code}-${fightId}`],
    { revalidate: 86400 }
  )();
}

// ─── Per-player fight profile ─────────────────────────────────────────────────

export interface CastStat { name: string; icon: string; spellId: number; total: number }
export interface BuffStat {
  name: string;
  icon: string;
  spellId: number;
  uptimeMs: number;
  uses: number;
  atPull: boolean;
  // [start, end] seconds from the pull, kept only for buffs applied a handful of
  // times (cooldown-shaped); rotational procs with dozens of bands stay empty.
  bands: Array<[number, number]>;
}
// byId keeps each spell that shares the name (a boss ability and its pulsing aura often do).
export interface DamageTakenStat { name: string; icon: string; spellId: number; total: number; hits: number; ticks: number; source: string; byId: Array<{ spellId: number; total: number; hits: number }> }
export interface DeathInfo {
  atSec: number;
  killer: string;
  killerIcon: string;
  killerSpellId: number;
  killerDamage: number;
  totalRecent: number;
  otherHitters: string[];
}

// The ten seconds before a death, from the events: every hit with what it did, how
// much healing landed, and which auras were on the player at the killing blow.
export interface DeathRecap {
  atSec: number;
  hits: Array<{ atSec: number; name: string; spellId: number; icon: string; source: string; amount: number; absorbed: number; overkill: number }>;
  healing: number;
  healCount: number;
  aurasAtDeath: Array<{ name: string; spellId: number }>;
}

// Primary-resource generation and waste over the fight, from resourcechange events:
// "waste" is what the game threw away because the bar was already full.
export interface ResourceWaste { type: number; name: string; gained: number; wasted: number }

export const RESOURCE_NAMES: Record<number, string> = {
  0: 'Mana', 1: 'Rage', 2: 'Focus', 3: 'Energy', 4: 'Combo Points', 5: 'Runes', 6: 'Runic Power', 7: 'Soul Shards', 8: 'Lunar Power',
  9: 'Holy Power', 11: 'Maelstrom', 12: 'Chi', 13: 'Insanity', 16: 'Arcane Charges', 17: 'Fury', 18: 'Pain', 19: 'Essence',
};
// Hostile debuffs the player picked up: a mechanic the game marked as failed often
// shows up as a debuff before (or instead of) damage.
export interface DebuffStat { name: string; icon: string; spellId: number; count: number; uptimeMs: number }
export interface RaidDeath { id: number; name: string; className: string; atSec: number; killer: string; killerIcon: string; killerSpellId: number }
export interface RaidMember { id: number; name: string; className: string; total: number; activeTime: number }

export interface PlayerProfile {
  durationMs: number;
  // Time until the player's first death (or the whole fight). Rotation and uptime
  // are judged over this, not the fight length — a 12s death shouldn't read as
  // "you never pressed anything".
  aliveMs: number;
  casts: CastStat[];
  // Every cast with its time in seconds from the pull, by ability name — one events
  // page per player (~250 casts in a 10-minute fight, about a point).
  castTimes: Record<string, number[]>;
  buffs: BuffStat[];       // self-applied only (see buffsTable)
  damageTaken: DamageTakenStat[];
  debuffs: DebuffStat[];
  activeTimeMs: number;
  // Damage for tanks/dps, healing for healers — whichever the role is judged on.
  outputTotal: number;
  deaths: DeathInfo[];
  deathRecaps: DeathRecap[];
  resourceWaste: ResourceWaste[];
  raidDeaths: RaidDeath[];
  interrupts: number;
  dispels: number;
  // Everyone in the fight on the same output table, for "where you placed in your raid".
  raid: RaidMember[];
  gear: GearInfo | null;
  talentNodes: Array<[number, number]> | null;
}

const MAX_BANDS_KEPT = 12;

// Buffs the player put on THEMSELVES: sourceID is who has the aura, targetID (same
// id) restricts to auras they applied. Without that, a healer's Renew, a priest's
// Power Infusion and the evoker's Prescience all show up as "buffs you were missing"
// — verified live: 94 auras → 55 self-applied. Flasks, food, potions, trinket procs
// and the player's own cooldowns are all self-applied, so nothing judgeable is lost.
function buffsTable(fightId: number, sourceId: number): string {
  return `table(dataType: Buffs, fightIDs: [${fightId}], sourceID: ${sourceId}, targetID: ${sourceId})`;
}

// The tables that make up one player's profile. Healers are judged on the Healing
// table (active time in DamageDone would only count their damage casts); the
// `full` extras (deaths, interrupts, dispels) are only fetched for the player being
// reviewed, not for pool members. Gear and talents come from the playerDetails call
// the caller already made (getFightPlayers / the pool's own phase 1).
function playerTablesSelection(fightId: number, sourceId: number, role: Role, full: boolean): string {
  const output = role === 'healer' ? 'Healing' : 'DamageDone';
  return `
    casts: table(dataType: Casts, fightIDs: [${fightId}], sourceID: ${sourceId})
    castEvents: events(fightIDs: [${fightId}], sourceID: ${sourceId}, dataType: Casts, limit: 5000) { data }
    buffs: ${buffsTable(fightId, sourceId)}
    taken: table(dataType: DamageTaken, fightIDs: [${fightId}], sourceID: ${sourceId})
    debuffs: table(dataType: Debuffs, fightIDs: [${fightId}], sourceID: ${sourceId})
    output: table(dataType: ${output}, fightIDs: [${fightId}])
    ${full ? `deaths: table(dataType: Deaths, fightIDs: [${fightId}])
    interrupts: table(dataType: Interrupts, fightIDs: [${fightId}], sourceID: ${sourceId})
    dispels: table(dataType: Dispels, fightIDs: [${fightId}], sourceID: ${sourceId})` : ''}
  `;
}

// Interrupt/dispel tables nest: top-level entries per ability, each with its own
// `entries` of what was interrupted/dispelled.
function countNested(entries: any[] | undefined): number {
  let n = 0;
  for (const e of entries ?? []) {
    if (Array.isArray(e?.entries)) n += countNested(e.entries);
    else n += Number(e?.total ?? 0);
  }
  return n;
}

const MELEE_GUID = 1;
const AUTO_SHOT_GUID = 75;
const sec1 = (ms: number) => Math.round(ms / 100) / 10;

export function buildProfile(raw: any, fight: { startTime: number; endTime: number }, sourceId: number): PlayerProfile {
  const durationMs = Math.max(1, fight.endTime - fight.startTime);

  const castMap = new Map<string, CastStat>();
  const castNameByGuid = new Map<number, string>();
  for (const e of raw?.casts?.data?.entries ?? []) {
    if (e.guid && e.name) castNameByGuid.set(Number(e.guid), e.name);
    if (e.guid === MELEE_GUID || e.guid === AUTO_SHOT_GUID || !(e.total > 0) || !e.name) continue;
    const c = castMap.get(e.name) ?? { name: e.name, icon: e.abilityIcon ?? '', spellId: e.guid ?? 0, total: 0 };
    c.total += e.total;
    castMap.set(e.name, c);
  }
  // One press, one cast: the game logs a second cast for the same ability within a
  // second when a spell is applied to an ally and copied to self (Power Infusion with
  // Twins of the Sun Priestess) or echoed by a pet/clone. Those are dropped, and the
  // cast counts used for every comparison are taken from the de-duplicated times, so
  // a priest without the talent is not told the top priests press it twice as often.
  const castTimes: Record<string, number[]> = {};
  for (const ev of raw?.castEvents?.data ?? []) {
    if (ev?.type !== 'cast') continue;
    const name = castNameByGuid.get(Number(ev.abilityGameID));
    if (!name || !castMap.has(name)) continue;
    const t = sec1(Math.max(0, (ev.timestamp ?? fight.startTime) - fight.startTime));
    const list = (castTimes[name] ??= []);
    if (list.length && Math.abs(t - list[list.length - 1]) <= 1) continue;
    list.push(t);
  }
  for (const [name, times] of Object.entries(castTimes)) {
    const c = castMap.get(name);
    if (c) c.total = times.length;
  }

  // Band times are report-relative like fight.startTime (verified live); a buff whose
  // first band starts at the pull (bands are clipped to the fight) was up going in. Half
  // a second, not two: an opener cast at 0:01 is not a pre-pull buff.
  const buffMap = new Map<string, BuffStat>();
  for (const a of raw?.buffs?.data?.auras ?? []) {
    if (!a?.name) continue;
    const bands: any[] = Array.isArray(a.bands) ? a.bands : [];
    const b = buffMap.get(a.name) ?? { name: a.name, icon: a.abilityIcon ?? '', spellId: a.guid ?? 0, uptimeMs: 0, uses: 0, atPull: false, bands: [] as Array<[number, number]> };
    b.uptimeMs = Math.max(b.uptimeMs, a.totalUptime ?? 0);
    b.uses += a.totalUses ?? 0;
    b.atPull = b.atPull || (bands[0]?.startTime ?? Infinity) <= fight.startTime + 500;
    // Two auras under one name (Void Metamorphosis: 7 windows plus a stacking effect
    // with hundreds of applications): the sparser one is the cooldown, keep its windows.
    if (bands.length && bands.length <= MAX_BANDS_KEPT && (!b.bands.length || bands.length < b.bands.length)) {
      b.bands = bands.map((x: any): [number, number] => [sec1(Math.max(0, x.startTime - fight.startTime)), sec1(Math.max(0, x.endTime - fight.startTime))]).sort((x, y) => x[0] - y[0]);
    }
    buffMap.set(a.name, b);
  }

  // Damage from players (self-damage procs, friendly fire) isn't a mechanic — drop it.
  const takenMap = new Map<string, DamageTakenStat>();
  for (const e of raw?.taken?.data?.entries ?? []) {
    if (PLAYER_CLASS_TYPES.has(e.actorType) || !(e.total > 0) || !e.name) continue;
    // Damage redirected from a friendly player (Blessing of Sacrifice, Interpose) has no
    // actor of its own but every source is a player: that is a job, not a mistake.
    const sources: any[] = Array.isArray(e.sources) ? e.sources : [];
    if (!e.actorType && sources.length && sources.every((s: any) => PLAYER_CLASS_TYPES.has(s.type))) continue;
    const t = takenMap.get(e.name) ?? { name: e.name, icon: e.abilityIcon ?? '', spellId: e.guid ?? 0, total: 0, hits: 0, ticks: 0, source: e.actorName ?? '', byId: [] as DamageTakenStat['byId'] };
    t.total += e.total;
    t.hits += e.hitCount ?? 0;
    t.ticks += e.tickCount ?? 0;
    const sub = t.byId.find(x => x.spellId === (e.guid ?? 0)) ?? (t.byId.push({ spellId: e.guid ?? 0, total: 0, hits: 0 }), t.byId[t.byId.length - 1]);
    sub.total += e.total; sub.hits += e.hitCount ?? 0;
    takenMap.set(e.name, t);
  }

  const debuffMap = new Map<string, DebuffStat>();
  for (const a of raw?.debuffs?.data?.auras ?? []) {
    if (!a?.name) continue;
    const d = debuffMap.get(a.name) ?? { name: a.name, icon: a.abilityIcon ?? '', spellId: a.guid ?? 0, count: 0, uptimeMs: 0 };
    d.count += a.totalUses ?? 0;
    d.uptimeMs = Math.max(d.uptimeMs, a.totalUptime ?? 0);
    debuffMap.set(a.name, d);
  }

  const outputEntries: any[] = raw?.output?.data?.entries ?? [];
  const me = outputEntries.find((e: any) => e.id === sourceId);
  const raid: RaidMember[] = outputEntries.map((e: any) => ({
    id: e.id,
    name: e.name,
    className: CLASS_BY_WCL[e.type] ?? e.type ?? '',
    total: e.total ?? 0,
    activeTime: e.activeTime ?? 0,
  }));

  const deathEntries: any[] = raw?.deaths?.data?.entries ?? [];
  const atSec = (d: any) => Math.max(0, Math.round(((d.timestamp ?? fight.startTime) - fight.startTime) / 1000));
  const describeDeath = (d: any) => {
    // Damage in the death window, merged by ability name and sorted biggest first.
    const byName = new Map<string, { name: string; icon: string; spellId: number; total: number }>();
    for (const a of d.damage?.abilities ?? []) {
      const cur = byName.get(a.name) ?? { name: a.name, icon: a.icon ?? '', spellId: a.guid ?? 0, total: 0 };
      cur.total += a.total ?? 0;
      byName.set(a.name, cur);
    }
    const abilities = [...byName.values()].sort((a, b) => b.total - a.total);
    const kb = d.killingBlow;
    const killer = kb?.name ? { name: kb.name as string, icon: (kb.abilityIcon ?? kb.icon ?? '') as string, spellId: Number(kb.guid) || 0 } : abilities[0] ?? { name: 'unknown damage', icon: '', spellId: 0 };
    return { abilities, killer };
  };
  const raidDeaths: RaidDeath[] = deathEntries
    .map((d: any) => ({
      id: d.id,
      name: d.name,
      className: CLASS_BY_WCL[d.type] ?? d.type ?? '',
      atSec: atSec(d),
      ...(({ killer }) => ({ killer: killer.name, killerIcon: killer.icon, killerSpellId: killer.spellId }))(describeDeath(d)),
    }))
    .sort((a, b) => a.atSec - b.atSec);
  const deaths: DeathInfo[] = deathEntries
    .filter((d: any) => d.id === sourceId)
    .map((d: any) => {
      const { abilities, killer } = describeDeath(d);
      return {
        atSec: atSec(d),
        killer: killer.name,
        killerIcon: killer.icon,
        killerSpellId: killer.spellId,
        killerDamage: abilities.find(a => a.name === killer.name)?.total ?? 0,
        totalRecent: d.damage?.total ?? 0,
        otherHitters: abilities.filter(a => a.name !== killer.name && a.total > 0).slice(0, 2).map(a => a.name),
      };
    })
    .sort((a, b) => a.atSec - b.atSec);
  const aliveMs = deaths.length ? Math.max(1, Math.min(durationMs, deaths[0].atSec * 1000)) : durationMs;

  const pdPlayers = raw?.pd ? mapPlayerDetails(raw.pd?.data?.playerDetails) : [];
  const pdMe = pdPlayers.find(p => p.id === sourceId);

  return {
    durationMs,
    aliveMs,
    casts: [...castMap.values()],
    castTimes,
    buffs: [...buffMap.values()],
    damageTaken: [...takenMap.values()],
    debuffs: [...debuffMap.values()],
    activeTimeMs: me?.activeTime ?? 0,
    outputTotal: me?.total ?? 0,
    deaths,
    deathRecaps: [],
    resourceWaste: [],
    raidDeaths,
    interrupts: countNested(raw?.interrupts?.data?.entries),
    dispels: countNested(raw?.dispels?.data?.entries),
    raid,
    gear: pdMe?.gear ?? null,
    talentNodes: pdMe?.talentNodes ?? null,
  };
}

// A logged fight never changes once uploaded, so a day is a safe cache; the key
// covers everything that shapes the result.
export function getPlayerProfile(token: string, code: string, fight: ReportFight, player: FightPlayer): Promise<PlayerProfile> {
  return unstable_cache(
    async () => {
      const data = await wclQuery(
        token,
        `{ reportData { report(code: "${code}") { ${playerTablesSelection(fight.id, player.id, player.role, true)} } } }`,
        'player-tables',
        null
      );
      const profile = buildProfile(data?.reportData?.report, fight, player.id);
      const extra = await fetchDeathRecapsAndResources(token, code, fight, player.id, profile.deaths).catch(err => { console.error('analyze: death recap / resources unavailable', err); return { deathRecaps: [], resourceWaste: [] }; });
      return { ...profile, ...extra, gear: player.gear ?? profile.gear, talentNodes: player.talentNodes ?? profile.talentNodes };
    },
    [`analyze-profile-v16-${code}-${fight.id}-${player.id}-${player.role}`],
    { revalidate: 86400 }
  )();
}

const RECAP_WINDOW_MS = 10000;
const RECAP_MAX_DEATHS = 3;

async function fetchDeathRecapsAndResources(token: string, code: string, fight: ReportFight, sourceId: number, deaths: DeathInfo[]): Promise<{ deathRecaps: DeathRecap[]; resourceWaste: ResourceWaste[] }> {
  const windows = deaths.slice(0, RECAP_MAX_DEATHS).map((d, i) => {
    const end = fight.startTime + Math.round(d.atSec * 1000) + 1000;
    const start = Math.max(fight.startTime, end - RECAP_WINDOW_MS - 1000);
    // DamageTaken takes the taker as sourceID (the same convention as its table).
    return `d${i}: events(fightIDs: [${fight.id}], dataType: DamageTaken, sourceID: ${sourceId}, startTime: ${start}, endTime: ${end}, limit: 500) { data }
    h${i}: events(fightIDs: [${fight.id}], dataType: Healing, targetID: ${sourceId}, startTime: ${start}, endTime: ${end}, limit: 500) { data }`;
  }).join('\n');
  const data = await wclQuery(token, `{ reportData { report(code: "${code}") {
    ${windows}
    res: events(fightIDs: [${fight.id}], dataType: Resources, sourceID: ${sourceId}, limit: 5000) { data nextPageTimestamp }
    masterData { actors { id name } abilities { gameID name icon } }
  } } }`, 'player-recap', null);
  const r = data?.reportData?.report ?? {};
  // Resource events run to thousands in a long pull: follow the pages.
  const resEvents: any[] = [...(r.res?.data ?? [])];
  let next = r.res?.nextPageTimestamp;
  for (let page = 0; next && page < 4; page++) {
    const more = await wclQuery(token, `{ reportData { report(code: "${code}") { res: events(fightIDs: [${fight.id}], dataType: Resources, sourceID: ${sourceId}, startTime: ${next}, limit: 5000) { data nextPageTimestamp } } } }`, 'player-recap', null);
    resEvents.push(...(more?.reportData?.report?.res?.data ?? []));
    next = more?.reportData?.report?.res?.nextPageTimestamp;
  }
  const actorName = new Map<number, string>((r.masterData?.actors ?? []).map((a: any) => [a.id, a.name]));
  const ability = new Map<number, { name: string; icon: string }>((r.masterData?.abilities ?? []).map((a: any) => [a.gameID, { name: a.name ?? '', icon: a.icon ?? '' }]));
  const deathRecaps: DeathRecap[] = deaths.slice(0, RECAP_MAX_DEATHS).map((d, i) => {
    const deathMs = fight.startTime + Math.round(d.atSec * 1000);
    const dmg: any[] = (r[`d${i}`]?.data ?? []).filter((e: any) => e.type === 'damage' && e.timestamp <= deathMs + 1000 && e.timestamp >= deathMs - RECAP_WINDOW_MS);
    const heals: any[] = (r[`h${i}`]?.data ?? []).filter((e: any) => e.type === 'heal' && e.timestamp <= deathMs && e.timestamp >= deathMs - RECAP_WINDOW_MS);
    const hits = dmg.map((e: any) => ({
      atSec: Math.max(0, (e.timestamp - fight.startTime) / 1000),
      name: ability.get(e.abilityGameID)?.name ?? `#${e.abilityGameID}`,
      spellId: e.abilityGameID ?? 0,
      icon: ability.get(e.abilityGameID)?.icon ?? '',
      source: actorName.get(e.sourceID) ?? '',
      amount: e.amount ?? 0, absorbed: e.absorbed ?? 0, overkill: e.overkill ?? 0,
    })).filter(h => h.amount > 0 || h.absorbed > 0 || h.overkill > 0);
    // The killing blow carries the auras active at that moment.
    const last = dmg.filter((e: any) => (e.overkill ?? 0) > 0).pop() ?? dmg[dmg.length - 1];
    const auraIds = String(last?.buffs ?? '').split('.').filter(Boolean).map(Number);
    return {
      atSec: d.atSec,
      hits,
      healing: heals.reduce((s: number, e: any) => s + (e.amount ?? 0), 0),
      healCount: heals.length,
      aurasAtDeath: auraIds.map(id => ({ name: ability.get(id)?.name ?? '', spellId: id })).filter(a => a.name),
    };
  });
  const waste = new Map<number, ResourceWaste>();
  for (const e of resEvents) {
    if (e.type !== 'resourcechange' || e.sourceID !== sourceId) continue;
    const t = Number(e.resourceChangeType ?? -1);
    if (!(t in RESOURCE_NAMES) || t === 0) continue; // mana is a healer story told elsewhere
    const cur = waste.get(t) ?? { type: t, name: RESOURCE_NAMES[t], gained: 0, wasted: 0 };
    // Spenders log a negative change; only generation counts as gained.
    const change = Number(e.resourceChange ?? 0);
    if (change > 0) cur.gained += change;
    cur.wasted += Number(e.waste ?? 0);
    waste.set(t, cur);
  }
  return { deathRecaps, resourceWaste: [...waste.values()].filter(w => w.gained > 0).sort((a, b) => b.gained - a.gained) };
}

// ─── Pool: what the top players of this spec do on this boss ──────────────────

// Per-ability arrays are indexed by pool member (0 / empty where that member didn't
// have it), so medians, spreads and "how many of them had it" fall straight out.
export interface PoolSummary {
  n: number;
  fetchedAt: number;
  difficulty: number;
  durations: number[];
  output: number[];      // ranking metric per player (dps, or hps for healers)
  activePct: number[];
  ilvl: number[];
  // Per-slot counts of members with a permanent / temporary enchant there, and how
  // many members had gear data at all — "what slots do top players enchant" without
  // a hand-kept list that goes stale when an expansion adds helm enchants.
  gearN: number;
  enchantBySlot: number[];
  tempBySlot: number[];
  // Every equipped item name across the pool: lets "you never used <trinket>" be
  // skipped when the player simply doesn't own that trinket.
  itemNames: string[];
  // Every item worn across the pool (cosmetic slots excluded), so any on-use effect's
  // cast can be recognised as an item ability and skipped for players who do not own
  // the item. Audit 2026-10-18: every on-use trinket in 39 specs' top logs cast under
  // its Use spell id.
  trinkets: Array<{ id: number; name: string }>;
  // How many members had talent data, and how many of them took each node id — so a
  // "you never used X" can be recognised as "you don't take the talent that grants X".
  talentN: number;
  talentNodeCount: Record<string, number>;
  talentEntryCount: Record<string, number>;
  // The pool members' own fights, so raid-level mechanic stats can reuse the same top logs.
  fights: Array<{ code: string; fightId: number; difficulty: number }>;
  // Each member's difficulty (Mythic pools are padded with Heroic parses).
  memberDifficulty: number[];
  casts: Record<string, { icon: string; spellId: number; cpm: number[] }>;
  // Cast times per member for cooldown-shaped casts (20 or fewer in the fight):
  // defensives, damage cooldowns, on-use trinkets. Charges, cooldown lengths and
  // "when do the top players press this" all come from here.
  castStarts: Record<string, number[][]>;
  buffs: Record<string, { icon: string; spellId: number; uptimePct: number[]; atPull: number[]; starts: number[][] }>;
  taken: Record<string, { icon: string; spellId: number; source: string; perMin: number[]; hitsPerMin: number[] }>;
  debuffs: Record<string, { icon: string; spellId: number; perMin: number[] }>;
}

// 30 members: each costs ~6 WCL points of tables, so 50 would let one cold boss across a
// raid's specs burn most of the 3,600-point hour. A Mythic pool short of 30 is padded
// with the best Heroic parses, tagged by difficulty.
const POOL_SIZE = 30;
const POOL_CANDIDATES = 40; // ranked rows tried; name/server matching drops a few, so over-fetch
const POOL_PHASE1_BATCH = 10;
const POOL_BATCH = 5; // aliased reports per request — same caution as the telemetry batches
const POOL_TTL_SECONDS = 7 * 86400;

function emptyPool(difficulty: number): PoolSummary {
  return {
    n: 0, fetchedAt: Date.now(), difficulty,
    durations: [], output: [], activePct: [], ilvl: [],
    gearN: 0, enchantBySlot: new Array(18).fill(0), tempBySlot: new Array(18).fill(0), itemNames: [], trinkets: [], talentN: 0, talentNodeCount: {}, talentEntryCount: {},
    fights: [], memberDifficulty: [],
    casts: {}, castStarts: {}, buffs: {}, taken: {}, debuffs: {},
  };
}

function summarizePool(items: Array<{ profile: PlayerProfile; output: number; player: FightPlayer; difficulty: number }>, difficulty: number): PoolSummary {
  const n = items.length;
  const S = emptyPool(difficulty);
  S.n = n;
  const itemNames = new Set<string>();
  const trinkets = new Map<number, string>();
  items.forEach(({ profile: p, output, player, difficulty: memberDiff }, idx) => {
    const minutes = p.durationMs / 60000;
    S.memberDifficulty.push(memberDiff);
    S.durations.push(p.durationMs);
    S.output.push(output);
    S.activePct.push(100 * p.activeTimeMs / p.durationMs);
    if (player.talentNodes) {
      S.talentN++;
      for (const [node, entry] of player.talentNodes) {
        S.talentNodeCount[String(node)] = (S.talentNodeCount[String(node)] ?? 0) + 1;
        if (entry) S.talentEntryCount[String(entry)] = (S.talentEntryCount[String(entry)] ?? 0) + 1;
      }
    }
    if (player.gear) {
      S.gearN++;
      S.ilvl.push(player.gear.ilvl);
      for (const g of player.gear.slots) {
        if (g.enchanted) S.enchantBySlot[g.slot]++;
        if (g.temp) S.tempBySlot[g.slot]++;
        if (g.name) itemNames.add(g.name);
        if (g.name) trinkets.set(g.id, g.name);
      }
    }
    for (const c of p.casts) {
      const e = (S.casts[c.name] ??= { icon: c.icon, spellId: c.spellId, cpm: new Array(n).fill(0) });
      e.cpm[idx] += c.total / minutes;
    }
    for (const [name, times] of Object.entries(p.castTimes)) {
      if (!isDefensive(name) && times.length > 20) continue;
      const k = defensiveKey(name);
      const e = (S.castStarts[k] ??= Array.from({ length: n }, () => []));
      e[idx].push(...times);
    }
    for (const b of p.buffs) {
      const e = (S.buffs[b.name] ??= { icon: b.icon, spellId: b.spellId, uptimePct: new Array(n).fill(0), atPull: new Array(n).fill(0), starts: Array.from({ length: n }, () => []) });
      e.uptimePct[idx] = Math.max(e.uptimePct[idx], 100 * b.uptimeMs / p.durationMs);
      if (b.atPull) e.atPull[idx] = 1;
      e.starts[idx] = b.bands.map(([s]) => s);
    }
    for (const t of p.damageTaken) {
      const e = (S.taken[t.name] ??= { icon: t.icon, spellId: t.spellId, source: t.source, perMin: new Array(n).fill(0), hitsPerMin: new Array(n).fill(0) });
      e.perMin[idx] += t.total / minutes;
      e.hitsPerMin[idx] += (t.hits + t.ticks) / minutes;
    }
    for (const d of p.debuffs) {
      const e = (S.debuffs[d.name] ??= { icon: d.icon, spellId: d.spellId, perMin: new Array(n).fill(0) });
      e.perMin[idx] += d.count / minutes;
    }
  });
  S.itemNames = [...itemNames];
  S.trinkets = [...trinkets].map(([id, name]) => ({ id, name }));
  return S;
}

// Built from the finder's cached rankings (same SWR Redis entry the boss pages use)
// plus ~4 tables per top player. Persisted a week per boss/spec/difficulty — the key
// space is bounded by the combo count, and the summary is a few tens of KB, so it
// can't grow Redis the way per-visitor data would. Cost on a cold combo: ~2 WCL
// requests of playerDetails + 2 of tables, roughly 50 points. A pool with fewer than
// three members (patch day, a transient GraphQL miss) is only kept an hour, so a
// boss/spec isn't pinned to "no pool" for a week while rankings fill in.
const POOL_THIN_TTL_SECONDS = 3600;

export async function getPoolSummary(token: string, encounterId: number, className: string, spec: string, difficulty: number): Promise<PoolSummary> {
  const role: Role = HEALER_SPECS.some(h => h.class === className && h.spec === spec) ? 'healer' : 'dps';
  const metric = role === 'healer' ? 'hps' : undefined;
  const key = `analyze-pool-v18-${encounterId}-${className}-${spec}-${difficulty}`;
  const cached = await getPersistentReadOnly<PoolSummary>(key);
  if (cached) return cached;
  const compute = async (): Promise<PoolSummary> => {
    const { rankings } = await getRankingsCachedSWR(token, encounterId, className, spec, difficulty, 'global', metric);
    const tag = (rows: any[], d: number) => rows.filter((r: any) => r.report?.code && r.report?.fightID).map((r: any) => ({ ...r, _difficulty: d }));
    const candidates: any[] = tag(rankings, difficulty).slice(0, POOL_CANDIDATES);
    // Mythic short of a full pool: pad with the best Heroic parses (different players).
    if (difficulty === 5 && candidates.length < POOL_CANDIDATES) {
      const heroic = await getRankingsCachedSWR(token, encounterId, className, spec, 4, 'global', metric);
      const seen = new Set(candidates.map((r: any) => `${r.name}|${r.server?.name ?? ''}`));
      for (const r of tag(heroic.rankings, 4)) {
        if (candidates.length >= POOL_CANDIDATES) break;
        const k = `${r.name}|${r.server?.name ?? ''}`;
        if (!seen.has(k)) { seen.add(k); candidates.push(r); }
      }
    }
    if (candidates.length === 0) return emptyPool(difficulty);

    // Phase 1: the ranked player's actor id and gear in their own report.
    const members: Array<{ row: any; fight: any; player: FightPlayer }> = [];
    for (let i = 0; i < candidates.length && members.length < POOL_SIZE; i += POOL_PHASE1_BATCH) {
      const batch = candidates.slice(i, i + POOL_PHASE1_BATCH);
      const q1 = batch.map((r, j) =>
        `r${j}: report(code: "${r.report.code}") { fights(fightIDs: [${r.report.fightID}]) { id startTime endTime } playerDetails(fightIDs: [${r.report.fightID}], includeCombatantInfo: true) }`
      ).join('\n');
      const d1 = await wclQuery(token, `{ reportData { ${q1} } }`, 'pool-players', null);
      batch.forEach((r, j) => {
        if (members.length >= POOL_SIZE) return;
        const rep = d1?.reportData?.[`r${j}`];
        const fight = rep?.fights?.[0];
        const players = mapPlayerDetails(rep?.playerDetails?.data?.playerDetails);
        const nameLower = String(r.name).toLowerCase();
        const serverLower = String(r.server?.name ?? '').toLowerCase();
        const sameName = players.filter(p => p.name.toLowerCase() === nameLower);
        const me = sameName.find(p => serverLower && (p.server ?? '').toLowerCase() === serverLower) ?? sameName[0];
        if (me && fight) members.push({ row: r, fight, player: me });
      });
    }

    // Phase 2: tables, a few reports per request.
    const items: Array<{ profile: PlayerProfile; output: number; player: FightPlayer; difficulty: number }> = [];
    for (let i = 0; i < members.length; i += POOL_BATCH) {
      const batch = members.slice(i, i + POOL_BATCH);
      const q2 = batch.map((m, j) =>
        `r${j}: report(code: "${m.row.report.code}") { ${playerTablesSelection(m.fight.id, m.player.id, role, false)} }`
      ).join('\n');
      const d2 = await wclQuery(token, `{ reportData { ${q2} } }`, 'pool-tables', null);
      batch.forEach((m, j) => {
        const raw = d2?.reportData?.[`r${j}`];
        if (!raw) return;
        items.push({ profile: buildProfile(raw, m.fight, m.player.id), output: Number(m.row.amount) || 0, player: m.player, difficulty: m.row._difficulty });
      });
    }
    const summary = summarizePool(items, difficulty);
    summary.fights = members.map(m => ({ code: m.row.report.code as string, fightId: m.fight.id as number, difficulty: m.row._difficulty as number }));
    return summary;
  };
  const fresh = await compute();
  await setPersistentValue(key, fresh, fresh.n >= 3 ? POOL_TTL_SECONDS : POOL_THIN_TTL_SECONDS);
  return fresh;
}

// ─── Raid-level mechanic stats: who, across the whole raid, takes each ability ───
//
// The same-spec pool says whether top players OF YOUR SPEC take an ability; this says
// how much of the whole raid does, in the top logs: nobody ⇒ avoidable, everybody ⇒
// unavoidable raid damage, only the tanks ⇒ tank mechanic, a consistent few ⇒ a soak
// or assignment. Per encounter+difficulty, not per spec, so it's built once a week
// per boss. Costs one damage-taken-by-ability table per fight to find the abilities,
// then one small per-ability table each (~1 point) — ~90 points per boss for three
// fights. Per-ability tables are needed because the by-ability view caps its target
// list at five players (verified live).

export interface RaidMechanicStats {
  n: number; // fights sampled
  fetchedAt: number;
  difficulty: number;
  abilities: Record<string, { spellId: number; icon: string; share: number[]; tankShare: number[] }>;
}

const RAID_STAT_FIGHTS = 3;
const RAID_STAT_ABILITIES = 25;
const RAID_STAT_BATCH = 13;
const RAID_STAT_TTL_SECONDS = 7 * 86400;

export async function getRaidMechanicStats(token: string, encounterId: number, difficulty: number, fights: Array<{ code: string; fightId: number; difficulty?: number }>): Promise<RaidMechanicStats> {
  const key = `analyze-raidmech-v1-${encounterId}-${difficulty}`;
  const cached = await getPersistentReadOnly<RaidMechanicStats>(key);
  if (cached) return cached;
  const compute = async (): Promise<RaidMechanicStats> => {
    const S: RaidMechanicStats = { n: 0, fetchedAt: Date.now(), difficulty, abilities: {} };
    const same = fights.filter(f => f.difficulty == null || f.difficulty === difficulty);
    const use = (same.length ? same : fights).slice(0, RAID_STAT_FIGHTS);
    if (use.length === 0) return S;

    const q1 = use.map((f, i) =>
      `r${i}: report(code: "${f.code}") { byAbility: table(dataType: DamageTaken, fightIDs: [${f.fightId}], viewBy: Ability) pd: playerDetails(fightIDs: [${f.fightId}]) }`
    ).join('\n');
    const d1 = await wclQuery(token, `{ reportData { ${q1} } }`, 'raid-mechanics-abilities', null);

    for (let i = 0; i < use.length; i++) {
      const rep = d1?.reportData?.[`r${i}`];
      const players = mapPlayerDetails(rep?.pd?.data?.playerDetails);
      const raidSize = players.length;
      if (!raidSize) continue;
      const tanks = new Set(players.filter(p => p.role === 'tank').map(p => p.name));
      const abilities: any[] = (rep?.byAbility?.data?.entries ?? [])
        .filter((e: any) => e?.guid && e?.name && (e.total ?? 0) > 0 && !PLAYER_CLASS_TYPES.has(e.actorType))
        .sort((a: any, b: any) => (b.total ?? 0) - (a.total ?? 0))
        .slice(0, RAID_STAT_ABILITIES);
      if (!abilities.length) continue;
      S.n++;
      for (let j = 0; j < abilities.length; j += RAID_STAT_BATCH) {
        const batch = abilities.slice(j, j + RAID_STAT_BATCH);
        const q2 = batch.map((a: any, k: number) =>
          `a${k}: table(dataType: DamageTaken, fightIDs: [${use[i].fightId}], abilityID: ${a.guid})`
        ).join('\n');
        const d2 = await wclQuery(token, `{ reportData { report(code: "${use[i].code}") { ${q2} } } }`, 'raid-mechanics-targets', null);
        batch.forEach((a: any, k: number) => {
          const hit: any[] = (d2?.reportData?.report?.[`a${k}`]?.data?.entries ?? []).filter((e: any) => (e.total ?? 0) > 0);
          const e = (S.abilities[a.name] ??= { spellId: a.guid, icon: a.abilityIcon ?? '', share: [], tankShare: [] });
          e.share.push(hit.length / raidSize);
          e.tankShare.push(hit.length ? hit.filter(h => tanks.has(h.name)).length / hit.length : 0);
        });
      }
    }
    return S;
  };
  const fresh = await compute();
  await setPersistentValue(key, fresh, fresh.n > 0 ? RAID_STAT_TTL_SECONDS : POOL_THIN_TTL_SECONDS);
  return fresh;
}
