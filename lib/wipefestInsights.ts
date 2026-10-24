/* eslint-disable @typescript-eslint/no-explicit-any */
import { wclQuery } from './wow';
import { fmtClock, fmtNum, median } from './analyzeRules';
import { filterAbilityIds, filterTypes, requireIds, type WipefestEventConfig, type WipefestFightConfig, type WipefestInsightConfig } from './wipefestConfig';
import type { FightPlayer, ReportFight } from './analyze';

// ─── Evaluating Wipefest's mechanic definitions against a log ──────────────────
//
// Two halves. fetchFightEvents turns a boss's event definitions into Warcraft Logs
// event queries (damage taken per spell id, debuff applications, boss casts, NPC
// deaths, first sightings…) and files the results under each definition's id.
// evaluateInsights then runs each insight rule over those events: how many hits,
// to whom, with or without the protective buff, how long each add lived. Every
// number on the page comes out of this file; Wipefest supplies only the rules.

export interface WfEvent {
  timestamp: number;
  type: string;
  sourceID: number;
  sourceInstance?: number;
  targetID: number;
  targetInstance?: number;
  abilityGameID: number;
  extraAbilityGameID?: number;
  amount?: number;
  absorbed?: number;
  overkill?: number;
  stack?: number;
  killerID?: number;
  tick?: boolean;
}

export interface FightEvents {
  startTime: number;
  endTime: number;
  phases: Array<{ id: number; startTime: number }>;
  npcs: Array<{ id: number; gameID: number; name: string; instanceCount: number }>;
  abilities: Record<number, { name: string; icon: string }>;
  byConfig: Record<string, WfEvent[]>;
}

export interface MechanicInsight {
  configId: string;
  type: string;
  name: string;
  phase: string | null;
  title: string;
  spellId: number | null;
  icon: string | null;
  tip: string | null;
  totalEvents: number;
  // Normalised statistics (per raid member, per boss cast… as the rule says), used for
  // the comparison with top raids. `display` is the human version of the raw figure.
  stats: Array<{ name: string; value: number; raw: number; higherIsBetter: boolean; display: string; kind: 'duration' | 'damage' | 'count'; unit: string }>;
  mainStat: string | null;
  // raw is the figure the row is sorted by (damage for hits), count the number of events.
  rows: Array<{ id: number | null; name: string; className: string; value: string; raw: number; count: number }>;
  // Doing more of this is good for the player (Wipefest's player-value weight is positive).
  goodForPlayer: boolean;
  // Share of the counted hits that were damage-over-time ticks (hit rules only).
  tickShare?: number;
  // pid: the player the event belongs to (hit, debuffed, dispelling, interrupting), when one does.
  events: Array<{ atSec: number; text: string; pid?: number }>;
}

const EVENT_LIMIT = 5000;
const NON_HITS = new Set([0, 7, 8, 10, 13]); // Warcraft Logs hitType: miss, dodge, parry, immune, evade
const MAX_PAGES = 4;
const BATCH = 8;

// ─── Fetching ─────────────────────────────────────────────────────────────────

interface Pending { alias: string; args: string }

export async function fetchFightEvents(token: string, code: string, fight: ReportFight, players: FightPlayer[], config: WipefestFightConfig): Promise<FightEvents> {
  const fid = fight.id;
  const meta = await wclQuery(token, `{ reportData { report(code: "${code}") {
    fights(fightIDs: [${fid}]) { id startTime endTime enemyNPCs { id gameID instanceCount } phaseTransitions { id startTime } }
    masterData { actors(type: "NPC") { id gameID name } abilities { gameID name icon } }
  } } }`, 'wipefest-meta', null);
  const rep = meta?.reportData?.report ?? {};
  const f = rep.fights?.[0] ?? {};
  const actorName = new Map<number, string>((rep.masterData?.actors ?? []).map((a: any) => [a.id, a.name]));
  const npcs = (f.enemyNPCs ?? []).map((n: any) => ({ id: n.id, gameID: n.gameID, name: actorName.get(n.id) ?? `NPC ${n.gameID}`, instanceCount: n.instanceCount ?? 1 }));
  const abilities: FightEvents['abilities'] = {};
  for (const a of rep.masterData?.abilities ?? []) if (a?.gameID) abilities[a.gameID] = { name: a.name ?? '', icon: a.icon ?? '' };
  const startTime = f.startTime ?? fight.startTime;
  const endTime = f.endTime ?? fight.endTime;
  const phases = (f.phaseTransitions ?? []).map((p: any) => ({ id: p.id, startTime: p.startTime }));

  // One query per distinct need; several definitions can share one.
  const pending = new Map<string, Pending>();
  const need = (key: string, args: string) => { if (!pending.has(key)) pending.set(key, { alias: `e${pending.size}`, args }); return key; };
  const npcByGame = new Map<number, number>(npcs.map((n: any) => [n.gameID, n.id]));
  const wants: Array<{ cfg: WipefestEventConfig; keys: string[] }> = [];
  for (const cfg of config.eventConfigs) {
    if (cfg.group === 'raid') continue;
    const fl = cfg.filter ?? {};
    const types = filterTypes(fl);
    const ids = filterAbilityIds(fl);
    const keys: string[] = [];
    if (fl.query) {
      keys.push(need(`q:${fl.query}`, `filterExpression: ${JSON.stringify(fl.query)}`));
    } else if (types.some(t => t === 'damage' || t === 'miss')) {
      for (const id of ids) keys.push(need(`dt:${id}`, `dataType: DamageTaken, abilityID: ${id}`));
    } else if (types.some(t => /^(apply|remove|refresh)(de)?buff/.test(t))) {
      // One expression per spell covers buffs and debuffs on players and on enemies alike:
      // a definition calls the egg-carrier's aura a debuff where the log calls it a buff.
      for (const id of ids) keys.push(need(`aura:${id}`, `filterExpression: ${JSON.stringify(`ability.id = ${id} and type in ('applybuff','removebuff','applybuffstack','refreshbuff','applydebuff','removedebuff','applydebuffstack','refreshdebuff')`)}`));
    } else if (types.some(t => t === 'cast' || t === 'begincast')) {
      for (const id of ids) keys.push(need(`cast:${id}`, `filterExpression: ${JSON.stringify(`ability.id = ${id} and type in ('cast','begincast')`)}`));
    } else if (types.includes('death')) {
      keys.push(need('deaths', 'dataType: Deaths, hostilityType: Enemies'));
    } else if (types.includes('firstseen')) {
      const npcId = fl.actor?.id != null ? npcByGame.get(fl.actor.id) : null;
      const npcName = npcs.find((n: any) => n.id === npcId)?.name;
      if (npcId != null && npcName) {
        const expr = `source.name = "${npcName.replace(/"/g, '\\"')}" or target.name = "${npcName.replace(/"/g, '\\"')}"`;
        keys.push(need(`fs:${npcId}`, `filterExpression: ${JSON.stringify(expr)}`));
      }
    } else if (types.includes('dispel') || types.includes('spellsteal')) {
      keys.push(need('dispels', 'dataType: Dispels'));
    } else if (types.includes('interrupt')) {
      keys.push(need('interrupts', 'dataType: Interrupts'));
      if (fl.excludeNpcSources === false) keys.push(need('interruptsE', 'dataType: Interrupts, hostilityType: Enemies'));
    } else if (types.includes('heal') || types.includes('absorbed')) {
      for (const id of ids) keys.push(need(cfg.friendly === false ? `he:${id}` : `hf:${id}`, `dataType: Healing, ${cfg.friendly === false ? 'hostilityType: Enemies, ' : ''}abilityID: ${id}`));
    } else if (types.includes('summon')) {
      for (const id of ids) keys.push(need(`q:summon:${id}`, `filterExpression: ${JSON.stringify(`type = 'summon' and ability.id = ${id}`)}`));
    }
    wants.push({ cfg, keys });
  }

  // Run the queries, batched, following pagination a few pages deep.
  const results = new Map<string, WfEvent[]>();
  const list = [...pending.entries()];
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    let cursors = new Map<string, number | null>(batch.map(([k]) => [k, null]));
    for (let page = 0; page < MAX_PAGES && cursors.size; page++) {
      const q = [...cursors.entries()].map(([k, start]) => {
        const p = pending.get(k)!;
        return `${p.alias}: events(fightIDs: [${fid}], ${p.args}, limit: ${EVENT_LIMIT}${start != null ? `, startTime: ${start}` : ''}) { data nextPageTimestamp }`;
      }).join('\n');
      const d = await wclQuery(token, `{ reportData { report(code: "${code}") { ${q} } } }`, 'wipefest-events', null);
      const r = d?.reportData?.report ?? {};
      const next = new Map<string, number | null>();
      for (const [k] of cursors) {
        const p = pending.get(k)!;
        const res = r[p.alias];
        const arr = results.get(k) ?? [];
        arr.push(...((res?.data ?? []) as WfEvent[]));
        results.set(k, arr);
        if (res?.nextPageTimestamp) next.set(k, res.nextPageTimestamp);
      }
      cursors = next;
    }
  }

  // File events under each definition, applying its own filters.
  const playerIds = new Set(players.map(p => p.id));
  const roleById = new Map(players.map(p => [p.id, (p.role ?? '').toLowerCase()]));
  const byConfig: Record<string, WfEvent[]> = {};
  for (const { cfg, keys } of wants) {
    const fl = cfg.filter ?? {};
    const types = new Set(filterTypes(fl));
    const ids = new Set(filterAbilityIds(fl));
    let evs: WfEvent[] = [];
    for (const k of keys) {
      const src = results.get(k) ?? [];
      if (k === 'deaths') {
        const npcId = fl.actor?.id != null ? npcByGame.get(fl.actor.id) : null;
        evs.push(...src.filter(e => e.type === 'death' && (npcId == null || e.targetID === npcId)));
      } else if (k.startsWith('fs:')) {
        const npcId = Number(k.slice(3));
        const seen = new Set<number>();
        for (const e of src.slice().sort((a, b) => a.timestamp - b.timestamp)) {
          const asSource = e.sourceID === npcId;
          if (!asSource && e.targetID !== npcId) continue;
          if (fl.excludeEnvironmentSources && e.sourceID < 0) continue;
          const inst = (asSource ? e.sourceInstance : e.targetInstance) ?? 1;
          if (seen.has(inst)) continue;
          seen.add(inst);
          evs.push({ timestamp: e.timestamp, type: 'firstseen', sourceID: npcId, sourceInstance: inst, targetID: npcId, targetInstance: inst, abilityGameID: 0 });
        }
      } else if (k === 'dispels' || k === 'interrupts' || k === 'interruptsE') {
        evs.push(...src.filter(e => ids.size === 0 || ids.has(e.extraAbilityGameID ?? -1) || ids.has(e.abilityGameID)));
      } else if (k.startsWith('q:')) {
        evs.push(...src);
      } else if (k.startsWith('aura:')) {
        const flavours = new Set([...types].flatMap(t => [t, t.replace('debuff', 'buff'), t.replace(/buff$/, 'debuff').replace('debuffdebuff', 'debuff')]));
        evs.push(...src.filter(e => flavours.has(e.type)));
      } else {
        evs.push(...src.filter(e => types.has(e.type) && (ids.size === 0 || ids.has(e.abilityGameID))));
      }
    }
    // A written query says exactly what it wants; the plain filters default to players.
    if (!fl.query && fl.excludeNpcTargets !== false && (types.has('damage') || types.has('applydebuff') || types.has('applydebuffstack') || types.has('removedebuff'))) {
      evs = evs.filter(e => e.targetID < 0 || playerIds.has(e.targetID) || e.type === 'firstseen');
    }
    // A miss, dodge, parry, immune or evade is logged as damage with no effect: not a hit.
    if (types.has('damage')) evs = evs.filter(e => e.type !== 'damage' || !NON_HITS.has((e as any).hitType ?? 1));
    if (fl.excludeNpcSources) evs = evs.filter(e => playerIds.has(e.sourceID));
    if (fl.playerRoles?.length) {
      const roles = fl.playerRoles.map(r => r.toLowerCase());
      evs = evs.filter(e => roles.includes(roleById.get(e.targetID) ?? '') || roles.includes(roleById.get(e.sourceID) ?? ''));
    }
    evs.sort((a, b) => a.timestamp - b.timestamp);
    // Windows, as Wipefest applies them: `range` groups every event inside the window
    // into one (damage summed, so no damage is lost — a scream that hits 28 players is
    // one hit for 2.4M); `rangePer` does the same per target, source or instance.
    // `minimum` drops windows with fewer events (a "splash" needs two players hit).
    const win = fl.range ?? fl.rangePer?.range;
    if (win && win > 0) {
      const keyOf = (e: WfEvent): string => {
        if (!fl.rangePer) return 'all';
        const parts: string[] = [];
        if (fl.rangePer.target) parts.push(`t${e.targetID}`);
        if (fl.rangePer.source) parts.push(`s${e.sourceID}`);
        if (fl.rangePer.instance) parts.push(`i${e.sourceInstance ?? 0}`);
        return parts.length ? parts.join('|') : 'all';
      };
      const minimum = fl.minimum ?? fl.rangePer?.minimum ?? 0;
      const groups = new Map<string, WfEvent[]>();
      for (const e of evs) (groups.get(keyOf(e)) ?? groups.set(keyOf(e), []).get(keyOf(e))!).push(e);
      const merged: WfEvent[] = [];
      for (const arr of groups.values()) {
        let i = 0;
        while (i < arr.length) {
          const open = arr[i].timestamp;
          let j = i;
          const first: WfEvent = { ...arr[i] };
          let amount = 0, absorbed = 0, overkill = 0;
          while (j < arr.length && arr[j].timestamp <= open + win) { amount += arr[j].amount ?? 0; absorbed += arr[j].absorbed ?? 0; overkill += arr[j].overkill ?? 0; j++; }
          if (j - i >= minimum) {
            if (types.has('damage')) { first.amount = amount; first.absorbed = absorbed; first.overkill = overkill; }
            merged.push(first);
          }
          i = j;
        }
      }
      // The merged window carries one target; who actually took what lives in the raw list.
      byConfig[cfg.id + '#raw'] = evs;
      evs = merged.sort((a, b) => a.timestamp - b.timestamp);
    }
    byConfig[cfg.id] = evs;
  }
  return { startTime, endTime, phases, npcs, abilities, byConfig };
}

// ─── Evaluating ───────────────────────────────────────────────────────────────

interface Ctx {
  fight: ReportFight;
  ev: FightEvents;
  players: Map<number, FightPlayer>;
  cfgById: Map<string, WipefestEventConfig>;
  raidSize: number;
  bossName: string;
}

const sec = (ctx: Ctx, t: number) => Math.max(0, (t - ctx.ev.startTime) / 1000);
const k = (n: number) => fmtNum(n);
const roleOf = (r: string | undefined) => (r ?? '').toLowerCase();

function phaseInterval(ctx: Ctx, phases: string | undefined): Array<[number, number]> | null {
  if (!phases) return null;
  const want = [...phases.matchAll(/P?(\d+)/gi)].map(m => Number(m[1])).filter(n => Number.isFinite(n));
  if (!want.length) return null;
  const ps = ctx.ev.phases.slice().sort((a, b) => a.startTime - b.startTime);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < ps.length; i++) if (want.includes(ps[i].id)) out.push([ps[i].startTime, ps[i + 1]?.startTime ?? ctx.ev.endTime]);
  if (!ps.length && want.includes(1)) return null; // no phase data: treat the fight as phase 1
  return out;
}
const inInterval = (iv: Array<[number, number]> | null, t: number) => !iv || iv.some(([s, e]) => t >= s && t < e);

function eventsFor(ctx: Ctx, ids: string[], pred: (c: WipefestEventConfig) => boolean, iv: Array<[number, number]> | null): WfEvent[] {
  const out: WfEvent[] = [];
  for (const id of ids) {
    const c = ctx.cfgById.get(id.replace(/#raw$/, ''));
    if (!c || !pred(c)) continue;
    for (const e of ctx.ev.byConfig[id] ?? []) if (inInterval(iv, e.timestamp)) out.push(e);
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

const isDamageCfg = (c: WipefestEventConfig) => filterTypes(c.filter).some(t => t === 'damage' || t === 'miss') || c.eventType === 'damage';
const isDebuffApplyCfg = (c: WipefestEventConfig) => filterTypes(c.filter).some(t => t === 'applydebuff' || t === 'applybuff' || t === 'summon') || c.filter.type === 'firstseen' || ((c.filter.type === 'begincast' || c.filter.type === 'cast') && c.eventType === 'debuff');
const isStackCfg = (c: WipefestEventConfig) => filterTypes(c.filter).some(t => t === 'applydebuffstack' || t === 'applybuffstack');
const isDebuffRemoveCfg = (c: WipefestEventConfig) => c.eventType === 'removedebuff' || filterTypes(c.filter).some(t => t === 'removedebuff' || t === 'removebuff' || t === 'death');
const isCastCfg = (c: WipefestEventConfig) => filterTypes(c.filter).some(t => t === 'cast' || t === 'begincast') && c.eventType !== 'debuff';

function cfgNames(ctx: Ctx, ids: string[], pred: (c: WipefestEventConfig) => boolean): string[] {
  const names: string[] = [];
  for (const id of ids) { const c = ctx.cfgById.get(id); if (c && pred(c) && !names.includes(c.name)) names.push(c.name); }
  return names;
}
function primarySpell(ctx: Ctx, ids: string[], pred: (c: WipefestEventConfig) => boolean): number | null {
  for (const id of ids) { const c = ctx.cfgById.get(id); if (c && pred(c)) { const a = filterAbilityIds(c.filter); if (a.length) return a[0]; } }
  return null;
}
const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

// Wipefest's title markup → plain text. {abilities}, {totalHits} and friends are
// values; {npc:Voidweavers}, {ability:id:Name:school:icon} and {danger:lethal} carry
// their text inside the braces.
function renderTitle(template: string | undefined, vals: Record<string, string | number>): string {
  if (!template) return '';
  return template
    .replace(/\{ability:\d+:([^:}]+)[^}]*\}/g, '$1')
    .replace(/\{[a-zA-Z]+:([^}]*)\}/g, '$1')
    .replace(/\{(\w+)\}/g, (_, key) => (key in vals ? String(vals[key]) : ''))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .trim();
}

function statsFor(ctx: Ctx, cfg: WipefestInsightConfig, raw: Record<string, number>, iv: Array<[number, number]> | null): MechanicInsight['stats'] {
  const out: MechanicInsight['stats'] = [];
  const minutes = Math.max(0.5, (ctx.ev.endTime - ctx.ev.startTime) / 60000);
  for (const s of cfg.statistics ?? []) {
    if (!(s.name in raw)) continue;
    let v = raw[s.name];
    if (s.divideByFrequencyOf) {
      const n = eventsFor(ctx, requireIds(s.divideByFrequencyOf), () => true, iv).length;
      if (n > 0) v /= n;
    }
    if (s.divideByRaidSize) v /= ctx.raidSize;
    if (s.multiplyByRaidSize) v *= ctx.raidSize;
    if (s.divideByFightLength) v /= minutes;
    if (s.multiplyByFightLength) v *= minutes;
    const kind: 'duration' | 'damage' | 'count' = /duration/i.test(s.name) ? 'duration' : /damage|healing/i.test(s.name) ? 'damage' : 'count';
    const unit = [s.divideByFrequencyOf ? 'per cast' : '', s.divideByRaidSize ? 'per player' : '', s.divideByFightLength ? 'per minute' : ''].filter(Boolean).join(' ');
    out.push({ name: s.name, value: v, raw: raw[s.name], higherIsBetter: !!s.higherIsBetter, display: fmtStat(v, kind), kind, unit });
  }
  return out;
}

export function fmtStat(v: number, kind: 'duration' | 'damage' | 'count'): string {
  if (kind === 'duration') return `${(v / 1000).toFixed(1)}s`;
  if (kind === 'damage') return k(v);
  return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : String(Math.round(v * 100) / 100);
}

function playerRow(ctx: Ctx, id: number, value: string, raw: number, count = 1): MechanicInsight['rows'][number] {
  const p = ctx.players.get(id);
  return { id: p ? id : null, name: p?.name ?? ctx.ev.npcs.find(n => n.id === id)?.name ?? `#${id}`, className: p?.className ?? '', value, raw, count };
}

export function evaluateInsights(fight: ReportFight, ev: FightEvents, players: FightPlayer[], config: WipefestFightConfig, errors?: string[]): MechanicInsight[] {
  const ctx: Ctx = { fight, ev, players: new Map(players.map(p => [p.id, p])), cfgById: new Map(config.eventConfigs.map(c => [c.id, c])), raidSize: Math.max(1, players.length), bossName: fight.name };
  const out: MechanicInsight[] = [];
  for (const cfg of config.insightConfigs) {
    if (cfg.group === 'raid') continue;
    if (cfg.difficulties?.length && !cfg.difficulties.includes(fight.difficulty)) continue;
    // `phases` is where Wipefest files the card (its stage heading); the numbers cover the
    // whole pull, as on wipefest.gg, so no interval is applied.
    const iv: Array<[number, number]> | null = null;
    if (cfg.phases && phaseInterval(ctx, cfg.phases)?.length === 0) continue; // the stage never came
    const req = requireIds(cfg.require);
    const showIf = requireIds(cfg.showIf);
    if (showIf.length && eventsFor(ctx, showIf, () => true, null).length === 0) continue;
    try {
      const r = evaluateOne(ctx, cfg, req, iv);
      if (r) out.push(r);
    } catch (err) {
      console.error(`wipefest insight ${cfg.group}-${cfg.id} failed`, err);
      errors?.push(`${cfg.id} ${cfg.type}: ${(err as Error)?.message ?? err}`);
    }
  }
  return out;
}

const DEFAULT_TITLES: Record<string, string> = {
  hit: 'Hit by {abilities} {totalHits} time{plural}.',
  hitHard: 'Hit hard by {abilities} {totalHits} time{plural}.',
  hitUnlessRole: 'Hit by {abilities} {totalHits} time{plural} on players it was not meant for.',
  hitWithoutDebuff: 'Hit by {damageAbilities} without {debuffAbilities} {totalHits} time{plural}.',
  hitWithDebuff: 'Hit by {damageAbilities} while under {debuffAbilities} {totalHits} time{plural}.',
  debuff: 'Gained {abilities} {totalHits} time{plural}.',
  debuffUnlessRole: 'Gained {abilities} {totalHits} time{plural} on players it was not meant for.',
  debuffDuration: '{abilities} lasted {averageDuration} on average.',
  removeDebuff: 'Reset stacks of {abilities} every {averageDuration} on average, with an average of {averageMaxStack} stack{averageMaxStackPlural}.',
  dispel: 'Dispelled {abilities} {totalFrequency} time{plural}.',
  interrupt: 'Interrupted {abilities} {totalInterrupts} of {totalCastAttempts} time{plural}.',
  cast: '{abilities} cast {totalCasts} time{plural}.',
  soak: 'Soaked {abilities} with an average of {average}/{raidSize} players.',
};

function evaluateOne(ctx: Ctx, cfg: WipefestInsightConfig, req: string[], iv: Array<[number, number]> | null): MechanicInsight | null {
  const template = (n: number) => (n === 0 && cfg.titleWhenNoEvents) ? cfg.titleWhenNoEvents : (cfg.title || DEFAULT_TITLES[cfg.type] || '');
  const base = (over: Partial<MechanicInsight>): MechanicInsight => ({
    configId: cfg.id, type: cfg.type, name: cfg.name, phase: cfg.phases ?? null, title: '', spellId: null, icon: null,
    tip: cfg.tip ? renderTitle(cfg.tip, {}) : null, totalEvents: 0, stats: [], mainStat: cfg.mainStatistic ?? null, rows: [], events: [],
    goodForPlayer: (cfg.playerValue?.weight ?? 0) > 0 || !!cfg.playerValue?.isBonus || !!(cfg.statistics ?? []).find(s => s.name === cfg.mainStatistic)?.higherIsBetter,
    ...over,
  });
  const nameOf = (id: number) => ctx.players.get(id)?.name ?? ctx.ev.npcs.find(n => n.id === id)?.name ?? `#${id}`;
  const abilityName = (gid: number, fallback: string) => ctx.ev.abilities[gid]?.name || fallback;
  const iconOf = (gid: number | null) => (gid != null ? ctx.ev.abilities[gid]?.icon || null : null);
  const finish = (ins: MechanicInsight, spellId: number | null) => { ins.spellId = spellId; ins.icon = iconOf(spellId); return ins; };

  switch (cfg.type) {
    case 'hit': case 'hitHard': case 'hitUnlessRole': case 'hitWithoutDebuff': case 'hitWithDebuff': {
      const dmgNames = cfgNames(ctx, req, isDamageCfg);
      const debNames = cfgNames(ctx, req, c => isDebuffApplyCfg(c) && !isDamageCfg(c));
      const filters: Array<(e: WfEvent) => boolean> = [e => e.type === 'damage'];
      if (cfg.type === 'hitHard') filters.push(e => (e.amount ?? 0) + (e.overkill ?? 0) > (cfg.threshold ?? 0));
      if (cfg.type === 'hitUnlessRole') filters.push(e => roleOf(ctx.players.get(e.targetID)?.role) !== roleOf(cfg.role));
      if (cfg.type === 'hitWithoutDebuff' || cfg.type === 'hitWithDebuff') {
        // Buff windows per target from the paired apply/remove definitions.
        const applies = eventsFor(ctx, req, c => isDebuffApplyCfg(c) && !isDamageCfg(c), null);
        const removes = eventsFor(ctx, req, isDebuffRemoveCfg, null);
        const windows = new Map<number, Array<[number, number]>>();
        const open = new Map<number, number>();
        const all = [...applies.map(e => ({ t: e.timestamp, id: e.targetID, on: true })), ...removes.map(e => ({ t: e.timestamp, id: e.targetID, on: false }))].sort((a, b) => a.t - b.t);
        for (const x of all) {
          if (x.on) { if (!open.has(x.id)) open.set(x.id, x.t); }
          else if (open.has(x.id)) { (windows.get(x.id) ?? windows.set(x.id, []).get(x.id)!).push([open.get(x.id)!, x.t]); open.delete(x.id); }
        }
        for (const [id, t] of open) (windows.get(id) ?? windows.set(id, []).get(id)!).push([t, ctx.ev.endTime]);
        const grace = cfg.gracePeriod ?? cfg.debuffApplicationTimeRelativeToDamageTime ?? 0;
        const covered = (e: WfEvent) => (windows.get(e.targetID) ?? []).some(([s, en]) => e.timestamp >= s - grace && e.timestamp <= en + grace);
        filters.push(e => (cfg.type === 'hitWithoutDebuff' ? !covered(e) : covered(e)));
      }
      const passes = (e: WfEvent) => filters.every(f => f(e));
      // Totals and the hit count come from the definition's (possibly merged) events; who
      // took what comes from the raw events behind a merged window.
      const hits = eventsFor(ctx, req, isDamageCfg, iv).filter(passes);
      const detail = eventsFor(ctx, req.map(id => (ctx.ev.byConfig[id + '#raw'] ? id + '#raw' : id)), isDamageCfg, iv).filter(passes);
      const castCount = eventsFor(ctx, req, isCastCfg, iv).filter(e => e.type === 'cast').length;
      // A damage-over-time effect logs a tick every second or two; counting those as hits
      // says nothing. For one, a hit is an application (a non-tick event) and the damage
      // figure is the whole burn.
      const isDot = detail.length > 0 && detail.filter(e => e.tick).length / detail.length >= 0.7;
      const counts = (e: WfEvent) => (isDot ? (e.tick ? 0 : 1) : 1);
      const perPlayer = new Map<number, { hits: number; dmg: number }>();
      let totalDamage = 0;
      for (const e of hits) totalDamage += e.amount ?? 0;
      for (const e of detail) {
        const cur = perPlayer.get(e.targetID) ?? { hits: 0, dmg: 0 };
        cur.hits += counts(e); cur.dmg += e.amount ?? 0;
        perPlayer.set(e.targetID, cur);
      }
      const hitCount = isDot ? hits.filter(e => !e.tick).length : hits.length;
      const ins = base({
        totalEvents: hitCount,
        tickShare: detail.length ? detail.filter(e => e.tick).length / detail.length : 0,
        title: renderTitle(template(hitCount), { ability: dmgNames[0] ?? '', abilities: list(dmgNames), damageAbilities: list(dmgNames), damageAbilties: list(dmgNames), debuffAbilities: list(debNames), totalHits: hitCount, plural: hitCount === 1 ? '' : 's', totalDamage: k(totalDamage), averageDamage: k(castCount ? totalDamage / castCount : hits.length ? totalDamage / hits.length : 0), raidSize: ctx.raidSize, boss: ctx.bossName, total: hits.length }),
        stats: statsFor(ctx, cfg, { Hits: hitCount, Damage: totalDamage }, iv),
        rows: [...perPlayer.entries()].sort((a, b) => b[1].dmg - a[1].dmg || b[1].hits - a[1].hits).map(([id, v]) => playerRow(ctx, id, v.dmg > 0 ? `${k(v.dmg)} · ${v.hits} ${isDot ? (v.hits === 1 ? 'application' : 'applications') : (v.hits === 1 ? 'hit' : 'hits')}` : `${v.hits} hit${v.hits === 1 ? '' : 's'}, no damage`, v.dmg, v.hits)),
        events: groupHits(detail.filter(e => !isDot || !e.tick)).map(g => ({ atSec: sec(ctx, g.t), pid: g.target, text: `${nameOf(g.target)} hit by ${abilityName(g.ability, dmgNames[0] ?? '')}${g.n > 1 ? ` ${g.n} times` : ''} for ${k(g.amount)}${g.absorbed ? ` (${k(g.absorbed)} absorbed)` : ''}${g.source ? ` from ${nameOf(g.source)}${g.inst ? ` #${g.inst}` : ''}` : ''}` })),
      });
      return finish(ins, primarySpell(ctx, req, isDamageCfg));
    }
    case 'debuff': case 'debuffUnlessRole': {
      let apps = eventsFor(ctx, req, c => isDebuffApplyCfg(c) || isStackCfg(c), iv);
      if (cfg.type === 'debuffUnlessRole') apps = apps.filter(e => roleOf(ctx.players.get(e.targetID)?.role) !== roleOf(cfg.role));
      const names = cfgNames(ctx, req, () => true);
      const per = new Map<number, number>();
      for (const e of apps) per.set(e.targetID, (per.get(e.targetID) ?? 0) + 1);
      const ins = base({
        totalEvents: apps.length,
        title: renderTitle(template(apps.length), { ability: names[0] ?? '', abilities: list(names), totalHits: apps.length, totalFrequency: apps.length, total: apps.length, plural: apps.length === 1 ? '' : 's', raidSize: ctx.raidSize, boss: ctx.bossName }),
        stats: statsFor(ctx, cfg, { Debuffs: apps.length, Hits: apps.length }, iv),
        rows: [...per.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => playerRow(ctx, id, `${n}×`, n, n)),
        events: apps.map(e => ({ atSec: sec(ctx, e.timestamp), pid: e.targetID, text: `${nameOf(e.targetID)} gained ${abilityName(e.abilityGameID, names[0] ?? '')}` })),
      });
      return finish(ins, primarySpell(ctx, req, () => true));
    }
    case 'debuffDuration': case 'removeDebuff': {
      // Start/end pairs per target (a player, or an NPC instance for spawns), with the
      // highest stack seen in between.
      const starts = eventsFor(ctx, req, isDebuffApplyCfg, iv);
      const stacks = eventsFor(ctx, req, isStackCfg, null);
      const ends = eventsFor(ctx, req, isDebuffRemoveCfg, null);
      // A definition with a global `range` merged each window down to one event and kept
      // whichever actor came first, so actor identity means nothing there: pair in order.
      const anonymous = req.some(id => { const c = ctx.cfgById.get(id); return !!c && (isDebuffApplyCfg(c) || isDebuffRemoveCfg(c)) && !!c.filter.range; });
      const keyOf = (e: WfEvent) => anonymous ? 'all' : (e.type === 'begincast' || e.type === 'cast') ? `${e.sourceID}#${e.sourceInstance ?? 0}` : `${e.targetID}#${e.targetInstance ?? 0}`;
      const open = new Map<string, { t: number; stack: number }>();
      const spans: Array<{ key: string; id: number; inst: number; start: number; end: number; stack: number }> = [];
      const all = [
        ...starts.map(e => ({ e, kind: 'start' as const })),
        ...stacks.map(e => ({ e, kind: 'stack' as const })),
        ...ends.map(e => ({ e, kind: 'end' as const })),
      ].sort((a, b) => a.e.timestamp - b.e.timestamp || (a.kind === 'end' ? 1 : -1));
      for (const { e, kind } of all) {
        const key = keyOf(e);
        if (kind === 'start') {
          const o = open.get(key);
          if (o) spans.push({ key, id: e.targetID, inst: e.targetInstance ?? 0, start: o.t, end: e.timestamp, stack: o.stack });
          open.set(key, { t: e.timestamp, stack: e.stack ?? 1 });
        }
        else if (kind === 'stack') { const o = open.get(key); if (o) o.stack = Math.max(o.stack, e.stack ?? o.stack + 1); }
        else { const o = open.get(key); if (o) { spans.push({ key, id: e.targetID, inst: e.targetInstance ?? 0, start: o.t, end: e.timestamp, stack: o.stack }); open.delete(key); } }
      }
      // Starts still open and ends nobody used pair in order: the boss casts the spawn and the
      // add dies, or a merged window kept one actor's start and another actor's end.
      const usedEnds = new Set(spans.map(sp => sp.end));
      const spareEnds = ends.filter(e => !usedEnds.has(e.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
      for (const [key, o] of [...open.entries()].sort((a, b) => a[1].t - b[1].t)) {
        const [id, inst] = key.split('#').map(Number);
        const i = spareEnds.findIndex(e => e.timestamp > o.t);
        const e = i >= 0 ? spareEnds.splice(i, 1)[0] : null;
        spans.push({ key, id: e?.targetID ?? id, inst: e?.targetInstance ?? inst, start: o.t, end: e ? e.timestamp : ctx.ev.endTime, stack: o.stack });
      }
      const threshold = cfg.threshold ?? 0;
      const kept = spans.filter(s => s.end - s.start >= threshold);
      const durs = kept.map(s => s.end - s.start);
      const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
      const total = durs.reduce((a, b) => a + b, 0);
      const avgStack = kept.length ? kept.reduce((a, s) => a + s.stack, 0) / kept.length : 0;
      const names = cfgNames(ctx, req, () => true);
      const isNpc = kept.some(s => !ctx.players.has(s.id));
      const label = (s: typeof kept[number]) => isNpc ? `${nameOf(s.id)}${s.inst ? ` #${s.inst}` : ''}` : nameOf(s.id);
      const ins = base({
        totalEvents: kept.length,
        title: renderTitle(template(kept.length), { ability: names[0] ?? '', abilities: list(names), averageDuration: `${(avg / 1000).toFixed(1)}s`, totalDuration: `${(total / 1000).toFixed(1)}s`, averageMaxStack: Math.round(avgStack * 10) / 10, averageMaxStackPlural: Math.round(avgStack * 10) / 10 === 1 ? '' : 's', totalFrequency: kept.length, total: kept.length, plural: kept.length === 1 ? '' : 's', raidSize: ctx.raidSize, boss: ctx.bossName }),
        stats: statsFor(ctx, cfg, { 'Average Duration': avg, 'Total Duration': total, 'Average Max Stack': avgStack }, iv),
        rows: kept.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start)).map(s => ({ id: ctx.players.has(s.id) ? s.id : null, name: label(s), className: ctx.players.get(s.id)?.className ?? '', count: 1, value: `${((s.end - s.start) / 1000).toFixed(1)}s${isStackCfgPresent(ctx, req) ? ` · ${s.stack} stack${s.stack === 1 ? '' : 's'}` : ''}`, raw: s.end - s.start })),
        events: kept.map(s => ({ atSec: sec(ctx, s.start), pid: ctx.players.has(s.id) ? s.id : undefined, text: `${label(s)} had ${names[0] ?? cfg.name}: ${fmtClock(sec(ctx, s.start))} → ${fmtClock(sec(ctx, s.end))} (${((s.end - s.start) / 1000).toFixed(1)}s${isStackCfgPresent(ctx, req) ? `, ${s.stack} stack${s.stack === 1 ? '' : 's'}` : ''})` })),
      });
      if (!cfg.statistics?.length) {
        ins.stats = [{ name: 'Average Duration', value: avg, raw: avg, higherIsBetter: false, display: fmtStat(avg, 'duration'), kind: 'duration', unit: '' }];
        if (isStackCfgPresent(ctx, req)) ins.stats.push({ name: 'Average Max Stack', value: avgStack, raw: avgStack, higherIsBetter: false, display: fmtStat(avgStack, 'count'), kind: 'count', unit: '' });
        ins.mainStat = 'Average Duration';
      }
      return finish(ins, primarySpell(ctx, req, c => filterAbilityIds(c.filter).length > 0));
    }
    case 'dispel': {
      const evs = eventsFor(ctx, req, () => true, iv).filter(e => e.type === 'dispel' || e.type === 'spellsteal');
      const names = cfgNames(ctx, req, () => true);
      const per = new Map<number, number>();
      for (const e of evs) per.set(e.sourceID, (per.get(e.sourceID) ?? 0) + 1);
      const ins = base({
        totalEvents: evs.length,
        title: renderTitle(template(evs.length), { ability: names[0] ?? '', abilities: list(names), stoppedAbilities: list(names), totalFrequency: evs.length, total: evs.length, totalHits: evs.length, plural: evs.length === 1 ? '' : 's', raidSize: ctx.raidSize, boss: ctx.bossName }),
        stats: statsFor(ctx, cfg, { Dispels: evs.length }, iv),
        rows: [...per.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => playerRow(ctx, id, `${n}×`, n, n)),
        events: evs.map(e => ({ atSec: sec(ctx, e.timestamp), pid: e.sourceID, text: `${nameOf(e.sourceID)} dispelled ${abilityName(e.extraAbilityGameID ?? 0, names[0] ?? '')} from ${nameOf(e.targetID)}` })),
      });
      return finish(ins, primarySpell(ctx, req, () => true));
    }
    case 'interrupt': {
      const ints = eventsFor(ctx, req, c => c.eventType === 'interrupt' || filterTypes(c.filter).includes('interrupt'), iv);
      const casts = eventsFor(ctx, req, isCastCfg, iv);
      // Attempts: cast starts when the definition tracks them, else completed casts plus the
      // ones that were stopped (a stopped cast never completes).
      const begins = casts.filter(e => e.type === 'begincast').length;
      const attempts = begins || casts.filter(e => e.type === 'cast').length + ints.length;
      const names = cfgNames(ctx, req, () => true);
      const per = new Map<number, number>();
      for (const e of ints) per.set(e.sourceID, (per.get(e.sourceID) ?? 0) + 1);
      const pct = attempts ? Math.round((ints.length / attempts) * 100) : 0;
      const ins = base({
        totalEvents: ints.length,
        title: renderTitle(template(ints.length), { ability: names[0] ?? '', abilities: list(names), stoppedAbilities: list(names), totalInterrupts: ints.length, totalCastAttempts: attempts, totalCasts: attempts, plural: ints.length === 1 ? '' : 's', raidSize: ctx.raidSize, boss: ctx.bossName }),
        stats: statsFor(ctx, cfg, { 'Percent Interrupted': pct, Interrupts: ints.length }, iv),
        rows: [...per.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => playerRow(ctx, id, `${n}×`, n, n)),
        events: ints.map(e => ({ atSec: sec(ctx, e.timestamp), pid: e.sourceID, text: `${nameOf(e.sourceID)} interrupted ${abilityName(e.extraAbilityGameID ?? 0, names[0] ?? '')} on ${nameOf(e.targetID)}` })),
      });
      return finish(ins, primarySpell(ctx, req, () => true));
    }
    case 'cast': {
      const casts = eventsFor(ctx, req, isCastCfg, iv).filter(e => e.type === 'cast');
      const names = cfgNames(ctx, req, () => true);
      const ins = base({
        totalEvents: casts.length,
        title: renderTitle(template(casts.length), { ability: names[0] ?? '', abilities: list(names), totalFrequency: casts.length, totalCasts: casts.length, total: casts.length, plural: casts.length === 1 ? '' : 's', raidSize: ctx.raidSize, boss: ctx.bossName }),
        stats: statsFor(ctx, cfg, { Casts: casts.length }, iv),
        events: casts.map(e => ({ atSec: sec(ctx, e.timestamp), text: `${nameOf(e.sourceID)} cast ${abilityName(e.abilityGameID, names[0] ?? '')}` })),
      });
      return finish(ins, primarySpell(ctx, req, () => true));
    }
    case 'heal': {
      const heals = eventsFor(ctx, req, c => c.eventType === 'heal' || filterTypes(c.filter).some(t => t === 'heal' || t === 'absorbed'), iv).filter(e => e.type === 'heal' || e.type === 'absorbed');
      if (!heals.length && !cfg.titleWhenNoEvents) return null;
      // One cast can log several heal events (ticks, multiple targets): count distinct seconds.
      const casts = new Set(heals.map(e => Math.round(e.timestamp / 1000))).size;
      const total = heals.reduce((s, e) => s + (e.amount ?? 0), 0);
      const names = cfgNames(ctx, req, () => true);
      const ins = base({
        totalEvents: casts,
        title: renderTitle(template(casts), { ability: names[0] ?? '', abilities: list(names), totalCasts: casts, totalFrequency: casts, total: casts, totalHealing: k(total), plural: casts === 1 ? '' : 's', raidSize: ctx.raidSize, boss: ctx.bossName }),
        stats: statsFor(ctx, cfg, { Healing: total, Casts: casts }, iv),
        events: heals.map(e => ({ atSec: sec(ctx, e.timestamp), text: `${nameOf(e.sourceID)} healed ${nameOf(e.targetID)} for ${k(e.amount ?? 0)} with ${abilityName(e.abilityGameID, names[0] ?? '')}` })),
      });
      return finish(ins, primarySpell(ctx, req, () => true));
    }
    case 'soak': {
      // Players hit per boss cast: each cast opens a window until the next one.
      let casts = eventsFor(ctx, req, isCastCfg, iv).filter(e => e.type === 'cast');
      const hits = eventsFor(ctx, req, isDamageCfg, iv);
      if (!casts.length) {
        // No cast to anchor on: hits within 1.5s of each other are one soak.
        const clusters: WfEvent[] = [];
        for (const h of hits) if (!clusters.length || h.timestamp > clusters[clusters.length - 1].timestamp + 1500) clusters.push(h);
        casts = clusters;
      }
      if (!casts.length) return null;
      const counts = casts.map((c, i) => {
        const end = casts[i + 1]?.timestamp ?? ctx.ev.endTime;
        return new Set(hits.filter(h => h.timestamp >= c.timestamp - 500 && h.timestamp < end).map(h => h.targetID)).size;
      });
      const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
      const names = cfgNames(ctx, req, isDamageCfg);
      const per = new Map<number, number>();
      for (const h of hits) per.set(h.targetID, (per.get(h.targetID) ?? 0) + 1);
      const ins = base({
        totalEvents: casts.length,
        title: renderTitle(template(casts.length), { ability: names[0] ?? '', abilities: list(names), average: avg.toFixed(1), raidSize: ctx.raidSize, plural: Math.round(avg) === 1 ? '' : 's', total: casts.length, boss: ctx.bossName }),
        stats: statsFor(ctx, cfg, { 'Average Number of Players Soaking': avg }, iv),
        rows: [...per.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => playerRow(ctx, id, `${n}×`, n, n)),
        events: casts.map((c, i) => ({ atSec: sec(ctx, c.timestamp), text: `${abilityName(c.abilityGameID, names[0] ?? '')}: ${counts[i]} player${counts[i] === 1 ? '' : 's'} soaked` })),
      });
      return finish(ins, primarySpell(ctx, req, isDamageCfg));
    }
    default:
      return null; // custom, reportComponent, heal, aggregate…: not evaluated here
  }
}

// Hits on the same player inside the same second become one line: "took three hits for
// 583K" reads like a recap, three identical lines do not.
function groupHits(evs: WfEvent[]): Array<{ t: number; target: number; ability: number; source: number; inst: number; n: number; amount: number; absorbed: number }> {
  const out: Array<{ t: number; target: number; ability: number; source: number; inst: number; n: number; amount: number; absorbed: number }> = [];
  for (const e of evs) {
    const last = out[out.length - 1];
    if (last && last.target === e.targetID && last.ability === e.abilityGameID && e.timestamp - last.t < 1000) {
      last.n++; last.amount += e.amount ?? 0; last.absorbed += e.absorbed ?? 0;
    } else {
      out.push({ t: e.timestamp, target: e.targetID, ability: e.abilityGameID, source: e.sourceID, inst: e.sourceInstance ?? 0, n: 1, amount: e.amount ?? 0, absorbed: e.absorbed ?? 0 });
    }
  }
  return out;
}

function isStackCfgPresent(ctx: Ctx, req: string[]): boolean {
  return req.some(id => { const c = ctx.cfgById.get(id); return !!c && isStackCfg(c); });
}

// The top raids' value of each insight's main statistic, for "top raids: X".
export interface MechanicComparison { n: number; byConfig: Record<string, { median: number; higherIsBetter: boolean; display: string; unit: string }> }

export function summariseComparison(runs: MechanicInsight[][]): MechanicComparison {
  const byConfig: MechanicComparison['byConfig'] = {};
  const vals = new Map<string, { v: number[]; hib: boolean; kind: 'duration' | 'damage' | 'count'; unit: string }>();
  for (const run of runs) for (const ins of run) {
    const main = ins.stats.find(s => s.name === ins.mainStat) ?? ins.stats[0];
    if (!main) continue;
    const cur = vals.get(ins.configId) ?? { v: [], hib: main.higherIsBetter, kind: main.kind, unit: main.unit };
    cur.v.push(main.value);
    vals.set(ins.configId, cur);
  }
  for (const [id, x] of vals) {
    if (x.v.length < 2) continue;
    const m = median(x.v);
    byConfig[id] = { median: m, higherIsBetter: x.hib, display: fmtStat(m, x.kind), unit: x.unit };
  }
  return { n: runs.length, byConfig };
}
