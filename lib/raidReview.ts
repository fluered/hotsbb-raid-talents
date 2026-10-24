/* eslint-disable @typescript-eslint/no-explicit-any */ // raw WCL table JSON, same posture as lib/wow.ts
import { unstable_cache } from 'next/cache';
import { wclQuery } from './wow';
import { buildProfile, DIFFICULTY_LABELS, PLAYER_CLASS_TYPES, type FightPlayer, type RaidDeath, type RaidMechanicStats, type ReportFight } from './analyze';
import { defensiveKey } from './defensives';
import { buffFamily, classifyAbility, fmtClock, fmtNum, median, plural, ucFirst, type Severity } from './analyzeRules';
import { lookupJournal, MECHANIC_WORDS, type BossKnowledge, type MechanicType } from './bossMechanics';
import type { MechanicComparison, MechanicInsight } from './wipefestInsights';
import { composeSummary, paceClause, type SummaryItem } from './summary';
import { defensivesAt, isDefensive, minReuseGap, noChargeModel, wastedDoublePresses } from './defensives';

// ─── Raid review: the whole pull, not one player ───────────────────────────────
//
// Same philosophy as the player review — measured against top logs and DBM's
// labels, no hand-written boss files — but organised the way a raid leader reads
// a pull: what ended it, which mechanics the raid failed and who, which interrupts
// and dispels were missed, who turned up without consumables. Every item carries a
// per-player breakdown for the expandable row.

// ─── Data ─────────────────────────────────────────────────────────────────────

export interface RaidAbilityBreakdown {
  name: string;
  spellId: number;
  icon: string;
  source: string;
  total: number;
  hits: number;
  // Per player: `count` is debuff applications when the ability applies a debuff of
  // the same name (the cleanest "times hit"), otherwise 0; `total` is damage taken.
  perPlayer: Array<{ id: number; name: string; count: number; total: number }>;
}

export interface RaidCastCheck {
  name: string;
  spellId: number;
  icon: string;
  begun: number;
  stopped: number;
  by: Array<{ name: string; total: number }>;
}

export interface RaidPlayerConsumables {
  flask: boolean;
  food: boolean;
  rune: boolean;
  potions: number;
  potionNames: string[];
}

export interface RaidFightData {
  players: FightPlayer[];
  raidDeaths: RaidDeath[];
  interrupts: RaidCastCheck[];
  dispels: RaidCastCheck[];
  enemyCasts: Record<string, { spellId: number; icon: string; total: number }>;
  raidDebuffs: Record<string, { spellId: number; icon: string; uses: number }>;
  abilities: RaidAbilityBreakdown[];
  output: Array<{ id: number; name: string; total: number; activeTime: number }>;
  // Each player's self-buffs (name, uses, up at the pull); consumables are derived from
  // these in buildRaidReview, once potion names have been resolved from Wowhead.
  playerBuffs: Record<number, Array<{ name: string; uses: number; atPull: boolean }>>;
  // Friendly casts seen in the fight, for resolving consumables by spell id.
  friendlyCasts: Record<string, { spellId: number; icon: string }>;
  // Each player's defensives: exact cast times (uses) plus buff windows where the
  // ability applies one, for "died with X available" and double presses.
  defensives: Record<number, Array<{ name: string; spellId: number; icon: string; uses: number[]; bands: Array<[number, number]> }>>;
  avgIlvl: number;
}

const BREAKDOWN_ABILITIES = 22;
const BUFF_BATCH = 10;
const ABILITY_BATCH = 11;

function castCheck(entries: any[]): RaidCastCheck[] {
  const out: RaidCastCheck[] = [];
  for (const top of entries ?? []) {
    for (const e of top?.entries ?? []) {
      if (!e?.name) continue;
      out.push({
        name: e.name,
        spellId: e.guid ?? 0,
        icon: e.abilityIcon ?? '',
        begun: e.spellsBegun ?? 0,
        stopped: e.spellsInterrupted ?? 0,
        by: (e.details ?? []).map((d: any) => ({ name: d.name, total: d.total ?? 0 })).sort((a: any, b: any) => b.total - a.total),
      });
    }
  }
  return out;
}

// `players` comes from getFightPlayers (already cached, with gear) so the fight's
// playerDetails isn't fetched a second time.
export function getRaidFightData(token: string, code: string, fight: ReportFight, players: FightPlayer[]): Promise<RaidFightData> {
  return unstable_cache(
    async () => {
      const fid = fight.id;
      const d1 = await wclQuery(token, `{ reportData { report(code: "${code}") {
        deaths: table(dataType: Deaths, fightIDs: [${fid}])
        ints: table(dataType: Interrupts, fightIDs: [${fid}])
        disp: table(dataType: Dispels, fightIDs: [${fid}])
        enemyCasts: table(dataType: Casts, fightIDs: [${fid}], hostilityType: Enemies, viewBy: Ability)
        raidDebuffs: table(dataType: Debuffs, fightIDs: [${fid}], viewBy: Ability)
        taken: table(dataType: DamageTaken, fightIDs: [${fid}], viewBy: Ability)
        friendlyCasts: table(dataType: Casts, fightIDs: [${fid}], viewBy: Ability)
        dmg: table(dataType: DamageDone, fightIDs: [${fid}])
        masterData { abilities { gameID icon } }
      } } }`, 'raid-fight', null);
      const r = d1?.reportData?.report ?? {};
      const iconOf = new Map<number, string>((r.masterData?.abilities ?? []).map((a: any) => [Number(a.gameID), String(a.icon ?? '')]));
      // Ability id → name for every friendly cast in the fight (one table), so each
      // player's cast events resolve to names without a per-player casts table.
      const castName = new Map<number, string>();
      for (const e of r.friendlyCasts?.data?.entries ?? []) if (e?.guid && e?.name) castName.set(Number(e.guid), e.name);
      const byId = new Map(players.map(p => [p.id, p]));

      // Deaths reuse the player profile's parser (killing blow, timing).
      const raidDeaths = buildProfile({ deaths: r.deaths }, fight, -1).raidDeaths;

      const enemyCasts: RaidFightData['enemyCasts'] = {};
      for (const e of r.enemyCasts?.data?.entries ?? []) {
        if (!e?.name) continue;
        const cur = (enemyCasts[e.name] ??= { spellId: e.guid ?? 0, icon: e.abilityIcon ?? '', total: 0 });
        cur.total += e.total ?? 0;
      }
      const raidDebuffs: RaidFightData['raidDebuffs'] = {};
      for (const a of r.raidDebuffs?.data?.auras ?? []) {
        if (!a?.name) continue;
        const cur = (raidDebuffs[a.name] ??= { spellId: a.guid ?? 0, icon: a.abilityIcon ?? '', uses: 0 });
        cur.uses += a.totalUses ?? 0;
      }

      // Hostile damage abilities, merged by name, biggest first.
      const takenMap = new Map<string, { name: string; spellId: number; icon: string; source: string; total: number; hits: number; guids: number[] }>();
      for (const e of r.taken?.data?.entries ?? []) {
        if (!e?.name || !e.guid || PLAYER_CLASS_TYPES.has(e.actorType) || !(e.total > 0)) continue;
        const cur = takenMap.get(e.name) ?? { name: e.name, spellId: e.guid, icon: e.abilityIcon ?? '', source: e.actorName ?? '', total: 0, hits: 0, guids: [] as number[] };
        cur.total += e.total;
        cur.hits += (e.hitCount ?? 0) + (e.tickCount ?? 0);
        cur.guids.push(e.guid);
        takenMap.set(e.name, cur);
      }
      const takenList = [...takenMap.values()].sort((a, b) => b.total - a.total).slice(0, BREAKDOWN_ABILITIES);

      // Phase B: self-applied buffs per player (consumables) and per-ability breakdowns.
      const playerBuffs: RaidFightData['playerBuffs'] = {};
      const defensives: RaidFightData['defensives'] = {};
      const friendlyCasts: RaidFightData['friendlyCasts'] = {};
      for (const e of r.friendlyCasts?.data?.entries ?? []) if (e?.guid && e?.name && !friendlyCasts[e.name]) friendlyCasts[e.name] = { spellId: Number(e.guid), icon: e.abilityIcon ?? '' };
      for (let i = 0; i < players.length; i += BUFF_BATCH) {
        const batch = players.slice(i, i + BUFF_BATCH);
        const q = batch.map((p, j) => `b${j}: table(dataType: Buffs, fightIDs: [${fid}], sourceID: ${p.id}, targetID: ${p.id})\n          c${j}: events(fightIDs: [${fid}], sourceID: ${p.id}, dataType: Casts, limit: 5000) { data }`).join('\n');
        const d = await wclQuery(token, `{ reportData { report(code: "${code}") { ${q} } } }`, 'raid-buffs', null);
        batch.forEach((p, j) => {
          const buffs = buildProfile({ buffs: d?.reportData?.report?.[`b${j}`] }, fight, p.id).buffs;
          playerBuffs[p.id] = buffs.map(b => ({ name: b.name, uses: b.uses, atPull: b.atPull }));
          const uses: Record<string, { spellId: number; times: number[] }> = {};
          for (const ev of d?.reportData?.report?.[`c${j}`]?.data ?? []) {
            if (ev?.type !== 'cast') continue;
            const name = castName.get(Number(ev.abilityGameID));
            if (!name || !isDefensive(name)) continue;
            const k = defensiveKey(name);
            (uses[k] ??= { spellId: Number(ev.abilityGameID), times: [] }).times.push(Math.round((ev.timestamp - fight.startTime) / 100) / 10);
          }
          const bandsByName = new Map(buffs.map(b => [b.name, b]));
          defensives[p.id] = [
            ...Object.entries(uses).map(([name, u]) => ({ name, spellId: u.spellId, icon: iconOf.get(u.spellId) ?? '', uses: u.times, bands: bandsByName.get(name)?.bands ?? [] })),
            ...buffs.filter(b => isDefensive(b.name) && !uses[b.name]).map(b => ({ name: b.name, spellId: b.spellId, icon: iconOf.get(b.spellId) ?? '', uses: b.bands.map(([s]) => s), bands: b.bands })),
          ];
        });
      }

      const abilities: RaidAbilityBreakdown[] = [];
      for (let i = 0; i < takenList.length; i += ABILITY_BATCH) {
        const batch = takenList.slice(i, i + ABILITY_BATCH);
        const q = batch.map((a, j) => {
          const deb = raidDebuffs[a.name];
          return deb
            ? `m${j}: table(dataType: Debuffs, fightIDs: [${fid}], abilityID: ${deb.spellId})`
            : `m${j}: table(dataType: DamageTaken, fightIDs: [${fid}], abilityID: ${a.spellId})`;
        }).join('\n');
        const d = await wclQuery(token, `{ reportData { report(code: "${code}") { ${q} } } }`, 'raid-ability', null);
        batch.forEach((a, j) => {
          const t = d?.reportData?.report?.[`m${j}`]?.data;
          const rows: any[] = t?.auras ?? t?.entries ?? [];
          const perPlayer = rows
            .filter((e: any) => byId.has(e.id) && ((e.totalUses ?? 0) > 0 || (e.total ?? 0) > 0))
            .map((e: any) => ({ id: e.id, name: e.name, count: e.totalUses ?? 0, total: e.total ?? 0 }))
            .sort((x: any, y: any) => (y.count - x.count) || (y.total - x.total));
          abilities.push({ name: a.name, spellId: a.spellId, icon: a.icon, source: a.source, total: a.total, hits: a.hits, perPlayer });
        });
      }

      const output = (r.dmg?.data?.entries ?? []).map((e: any) => ({ id: e.id, name: e.name, total: e.total ?? 0, activeTime: e.activeTime ?? 0 }));
      const ilvls = players.map(p => p.gear?.ilvl || p.ilvl).filter(x => x > 0);
      return {
        players,
        raidDeaths,
        interrupts: castCheck(r.ints?.data?.entries),
        dispels: castCheck(r.disp?.data?.entries),
        enemyCasts,
        raidDebuffs,
        abilities,
        output,
        playerBuffs,
        friendlyCasts,
        defensives,
        avgIlvl: ilvls.length ? ilvls.reduce((s, x) => s + x, 0) / ilvls.length : 0,
      };
    },
    [`analyze-raid-v7-${code}-${fight.id}`],
    { revalidate: 86400 }
  )();
}

// ─── Review ───────────────────────────────────────────────────────────────────

export interface RaidRow { id?: number; name: string; className: string; value: string; n: number; icons?: Array<{ name: string; spellId: number; icon: string }>; killer?: { name: string; icon: string; spellId: number } }

export interface RaidItem {
  id: string;
  severity: Severity;
  group: 'ending' | 'boss' | 'mechanics' | 'utility' | 'prep';
  title: string;
  text: string;
  icon?: string;
  spellId?: number;
  explain?: string;
  comparison?: string;
  rows: RaidRow[];
  rowsLabel: string;
  // 'list': one full-width line per row (name · time · killer · what was ready).
  rowsLayout?: 'list';
  impact: number;
  // Timestamped event list behind the card (the "details" of a mechanic).
  events?: Array<{ atSec: number; text: string }>;
  tip?: string;
  // For the short version: a clause that reads after "the thing that mattered:", and a
  // cost to rank it by (see lib/summary.ts).
  brief?: string;
  cost?: number;
}

// Cards from Wipefest-defined mechanics, evaluated against this log. The sentence is
// Wipefest's template filled with our numbers; the plain-English line underneath and
// the verdict against the top raids are ours.
export function buildMechanicItems(insights: MechanicInsight[], comparison: MechanicComparison | null, raidSize: number): RaidItem[] {
  const items: RaidItem[] = [];
  for (const ins of insights) {
    // A sentence written for a failure ("Failed to kill X before…") with nothing behind it
    // would read as blame: only zero-event cards whose sentence shows the zero stay.
    if (ins.totalEvents === 0 && !/\b0\b/.test(ins.title)) continue;
    const main = ins.stats.find(s => s.name === ins.mainStat) ?? ins.stats[0] ?? null;
    const cmp = comparison?.byConfig[ins.configId] ?? null;
    let severity: Severity = ins.totalEvents === 0 ? 'good' : 'info';
    let comparisonText: string | undefined;
    if (main && cmp && cmp.median > 0) {
      const ratio = main.value / cmp.median;
      const gap = Math.abs(main.value - cmp.median);
      const tiny = main.kind === 'duration' ? gap < 2000 : main.kind === 'damage' ? gap < 2000 : gap < 0.05;
      const worse = !tiny && (cmp.higherIsBetter ? ratio < 1 / 1.5 : ratio >= 1.5);
      const muchWorse = !tiny && (cmp.higherIsBetter ? ratio < 1 / 3 : ratio >= 3);
      const better = cmp.higherIsBetter ? ratio >= 1 : ratio <= 1;
      severity = muchWorse && ins.totalEvents >= 3 ? 'bad' : worse ? 'warn' : better ? 'good' : 'info';
      comparisonText = `${main.name}${main.unit ? ` ${main.unit}` : ''}: ${main.display} here · top raids ${cmp.display} (median of ${comparison!.n})${ins.phase ? ` · ${ins.phase.replace(/^P/, 'phase ')}` : ''}`;
    } else if (main && cmp && cmp.median === 0) {
      severity = main.value > 0 && !cmp.higherIsBetter ? 'warn' : ins.totalEvents === 0 ? 'good' : 'info';
      comparisonText = `Top raids: none at all (median of ${comparison!.n})${ins.phase ? ` · ${ins.phase.replace(/^P/, 'phase ')}` : ''}`;
    }
    const parts: string[] = [];
    const dotRule = (ins.type === 'hitWithoutDebuff' || ins.type === 'hitWithDebuff') && (ins.tickShare ?? 0) >= 0.7;
    if (dotRule && severity === 'bad') severity = 'warn';
    if (ins.totalEvents === 0) parts.push('Nothing to report: it did not happen in this pull.');
    else if (dotRule) parts.push('A damage-over-time effect: the count is how many times it was applied, and the damage figure is the whole burn.');
    else if (ins.rows.length && ins.rows[0].id != null) {
      const hitPlayers = ins.rows.filter(r => r.id != null).length;
      if (/^hit/.test(ins.type)) parts.push(`${hitPlayers} of ${raidSize} players were hit; worst was ${ins.rows[0].name} (${ins.rows[0].value}).`);
      else if (ins.type === 'dispel' || ins.type === 'interrupt') parts.push(`Most by ${ins.rows[0].name} (${ins.rows[0].value}).`);
      else if (ins.type === 'debuffDuration' || ins.type === 'removeDebuff') {
        const who = new Set(ins.rows.map(r => r.name)).size;
        parts.push(`${ins.rows.length} time${ins.rows.length === 1 ? '' : 's'} across ${who} player${who === 1 ? '' : 's'}; longest ${ins.rows[0].name} (${ins.rows[0].value}).`);
      } else parts.push(`${hitPlayers} player${hitPlayers === 1 ? '' : 's'}; most on ${ins.rows[0].name} (${ins.rows[0].value}).`);
    } else if (ins.rows.length) {
      parts.push(`Longest: ${ins.rows[0].name} (${ins.rows[0].value}); shortest: ${ins.rows[ins.rows.length - 1].name} (${ins.rows[ins.rows.length - 1].value}).`);
    }
    const impact = severity === 'bad' ? 60 : severity === 'warn' ? 45 : severity === 'info' ? 20 : 5;
    const shortName = ins.name.replace(/^(Damage|Debuffs|Average duration|Casts) (from|of) /i, '').replace(/ (soaks|dispels|interrupts|spawns|duration)$/i, '');
    let brief: string | undefined;
    let cost: number | undefined;
    if (main && cmp && cmp.median > 0) {
      const ratio = main.value / cmp.median;
      const worseBy = cmp.higherIsBetter ? (ratio > 0 ? 1 / ratio : Infinity) : ratio;
      const figure = main.kind === 'damage' ? `did ${fmtNum(main.raw)}` : main.kind === 'duration' ? `took ${main.display}` : `happened ${plural(ins.totalEvents, 'time')}`;
      if (severity === 'bad' || severity === 'warn') {
        brief = Number.isFinite(worseBy)
          ? `${shortName} ${figure}, ${worseBy.toFixed(1)}× what the top raids ${main.kind === 'duration' ? 'need' : cmp.higherIsBetter ? 'manage' : 'take'}`
          : `${shortName} never happened, where the top raids manage ${cmp.display}${cmp.unit ? ` ${cmp.unit}` : ''}`;
        cost = Number.isFinite(worseBy) ? 2 + worseBy * (main.kind === 'damage' ? 1.3 : 1) : 3;
      } else if (severity === 'good' && (ins.totalEvents === 0 || main.raw === 0 || main.display === '0')) {
        brief = `no ${shortName} to speak of, where the top raids take ${cmp.display}${cmp.unit ? ` ${cmp.unit}` : ''}`;
        cost = 0.95;
      } else if (severity === 'good') {
        const onPar = Math.abs(ratio - 1) <= 0.05;
        brief = onPar
          ? `${shortName} on par with the top raids (${main.display}${main.unit ? ` ${main.unit}` : ''})`
          : main.kind === 'duration'
            ? `${shortName} ${main.display} against the top raids' ${cmp.display}`
            : `${shortName} at ${main.display}${main.unit ? ` ${main.unit}` : ''}, ${cmp.higherIsBetter ? 'above' : 'under'} the top raids' ${cmp.display}`;
        cost = onPar ? 0.97 : worseBy;
      }
    } else if (severity === 'warn' && cmp && cmp.median === 0) {
      brief = `${shortName} ${main?.kind === 'damage' ? `did ${fmtNum(main.raw)}` : `happened ${plural(ins.totalEvents, 'time')}`}, which the top raids avoid entirely`;
      cost = 4;
    }
    items.push({
      brief, cost,
      id: `wf-${ins.configId}`, severity, group: 'boss',
      title: ins.title || ins.name,
      text: parts.join(' '),
      icon: ins.icon ?? undefined, spellId: ins.spellId ?? undefined,
      comparison: comparisonText,
      rows: ins.rows.map(r => ({ id: r.id ?? undefined, name: r.name, className: r.className, value: r.value, n: r.raw })),
      rowsLabel: ins.rows.length && ins.rows[0].id == null ? 'entries' : 'players',
      impact,
      events: ins.events,
      tip: ins.tip ?? undefined,
    });
  }
  const order: Record<Severity, number> = { bad: 0, warn: 1, info: 2, good: 3 };
  return items.sort((a, b) => order[a.severity] - order[b.severity] || b.impact - a.impact);
}

// The same mechanics, seen from one player: what hit them, what they gained, what they
// dispelled or interrupted, and what they avoided while raidmates did not. Their own
// figure is set against the top raids' per-player median where the rule gives one.
export function buildPlayerMechanicItems(insights: MechanicInsight[], comparison: MechanicComparison | null, playerId: number, raidSize: number): RaidItem[] {
  const items: RaidItem[] = [];
  let avoided = 0;
  const short = (name: string) => name.replace(/^(Damage|Debuffs) (from|of) /i, '').replace(/ (soaks|dispels|interrupts|spawns)$/i, '');
  for (const ins of insights) {
    const mine = ins.rows.filter(r => r.id === playerId);
    const myEvents = ins.events.filter(e => e.pid === playerId);
    const playerRows = ins.rows.filter(r => r.id != null);
    const main = ins.stats.find(s => s.name === ins.mainStat) ?? ins.stats[0] ?? null;
    const cmp = comparison?.byConfig[ins.configId] ?? null;
    const hitLike = /^hit/.test(ins.type) || ins.type === 'debuff' || ins.type === 'debuffUnlessRole';
    const base = { id: `wfp-${ins.configId}`, group: 'boss' as const, icon: ins.icon ?? undefined, spellId: ins.spellId ?? undefined, rows: ins.rows.map(r => ({ id: r.id ?? undefined, name: r.name, className: r.className, value: r.value, n: r.raw })), rowsLabel: playerRows.length ? 'players' : 'entries', events: myEvents, tip: ins.tip ?? undefined };
    // My own figure on the rule's scale: the raid's statistic is raw ÷ (casts × raid size);
    // mine is my raw ÷ casts, so scale by the raid's factor and undo the raid-size split.
    const myValueOf = (row: MechanicInsight['rows'][number]) => {
      if (!main || main.raw <= 0) return null;
      const myRaw = main.kind === 'count' ? row.count : row.raw;
      return myRaw * (main.value / main.raw) * (main.unit.includes('per player') ? raidSize : 1);
    };
    const unitWord = main ? main.unit.replace(/ ?per player/, '').trim() : '';
    if (hitLike) {
      if (ins.totalEvents === 0) continue;
      if (!mine.length) {
        if (ins.goodForPlayer || avoided >= 3) continue;
        avoided++;
        items.push({ ...base, severity: 'good', impact: 4, brief: `clean on ${short(ins.name)} while ${playerRows.length} raidmates were hit`, cost: 0.9, title: `Clean on ${short(ins.name)}`, text: `${ins.title} None of it was you: ${playerRows.length} of ${raidSize} raidmates were.`, rows: [], events: [] });
        continue;
      }
      const my = mine[0];
      const myValue = myValueOf(my);
      let severity: Severity = ins.goodForPlayer ? 'good' : 'info';
      let comparisonText: string | undefined;
      if (myValue != null && cmp && main?.unit.includes('per player')) {
        if (cmp.median > 0) {
          const ratio = myValue / cmp.median;
          if (!ins.goodForPlayer) severity = ratio >= 6 && myEvents.length >= 2 ? 'bad' : ratio >= 3 ? 'warn' : ratio <= 1 ? 'good' : 'info';
          comparisonText = `You: ${fmtStatLike(myValue, main!.kind)}${unitWord ? ` ${unitWord}` : ''} · an average top-raid player: ${cmp.display}`;
        } else if (!ins.goodForPlayer) {
          severity = 'warn';
          comparisonText = 'Top raids: nobody takes this at all';
        }
      }
      const rank = playerRows.findIndex(r => r.id === playerId) + 1;
      const verb = ins.goodForPlayer ? (rank === 1 ? 'You did the most of it.' : `You were #${rank} of ${playerRows.length}.`) : (rank === 1 ? 'You were the worst hit.' : `You were #${rank} of ${playerRows.length} hit.`);
      const ratio = myValue != null && cmp && cmp.median > 0 ? myValue / cmp.median : null;
      let brief: string | undefined;
      let cost: number | undefined;
      if (severity === 'bad' || severity === 'warn') {
        brief = `${short(ins.name)} hit you ${my.value}${ratio ? `, ${ratio.toFixed(1)}× what an average top-raid player takes` : ''}${rank === 1 ? ', the worst in the raid' : ''}`;
        cost = 2 + Math.min(ratio ?? 2, 8); // a death (12) still outranks any single mechanic
      } else if (severity === 'good') {
        brief = ins.goodForPlayer ? `${rank === 1 ? 'you did the most of' : 'you helped with'} ${short(ins.name)} (${my.value})` : `${short(ins.name)} at ${my.value}, under what an average top-raid player takes`;
        cost = ins.goodForPlayer ? 0.6 : (ratio ?? 0.8);
      }
      items.push({
        ...base, brief, cost, severity, impact: severity === 'bad' ? 55 : severity === 'warn' ? 40 : severity === 'good' ? 8 : 15,
        title: `${short(ins.name)}: ${my.value}`,
        text: `${ins.title} ${verb}`,
        comparison: comparisonText,
      });
    } else if (ins.type === 'dispel' || ins.type === 'interrupt') {
      if (!mine.length) continue;
      items.push({ ...base, severity: 'good', impact: 6, title: `You ${ins.type === 'dispel' ? 'dispelled' : 'interrupted'} ${short(ins.name)} ${mine[0].value}`, text: ins.title });
    } else if (ins.type === 'debuffDuration' || ins.type === 'removeDebuff') {
      if (!mine.length) continue;
      const myAvg = mine.reduce((a, r) => a + r.raw, 0) / mine.length;
      let severity: Severity = 'info';
      let comparisonText: string | undefined;
      if (cmp && cmp.median > 0 && main?.kind === 'duration') {
        const ratio = myAvg / cmp.median;
        severity = ins.goodForPlayer ? 'good' : ratio >= 1.5 ? 'warn' : ratio <= 1 ? 'good' : 'info';
        comparisonText = `You: ${(myAvg / 1000).toFixed(1)}s on average · top raids: ${cmp.display}`;
      }
      items.push({ ...base, severity, impact: severity === 'warn' ? 35 : 10, title: `${short(ins.name)}: ${mine.length}×, ${(myAvg / 1000).toFixed(1)}s on average`, text: ins.title, comparison: comparisonText });
    } else if (ins.type === 'soak') {
      if (!mine.length) continue;
      items.push({ ...base, severity: 'good', impact: 8, title: `You soaked ${short(ins.name)} ${mine[0].value}`, text: ins.title });
    }
  }
  const order: Record<Severity, number> = { bad: 0, warn: 1, info: 2, good: 3 };
  return items.sort((a, b) => order[a.severity] - order[b.severity] || b.impact - a.impact).slice(0, 12);
}

// Recomposes the raid's short version once every card, mechanics included, is in.
export function composeRaidSummary(review: RaidReview, fight: ReportFight, opts: { topMedianSec: number | null; deaths: number; wipeDeaths: number }): void {
  const diff = DIFFICULTY_LABELS[fight.difficulty] ?? '';
  const durationSec = fight.durationMs / 1000;
  const boss = review.items.filter(i => i.group === 'boss');
  const judged = boss.filter(i => i.comparison && !/none at all/.test(i.comparison));
  const worse = judged.filter(i => i.severity === 'bad' || i.severity === 'warn').length;
  const pace = fight.kill ? paceClause(durationSec, opts.topMedianSec) : '';
  const deathsClause = opts.deaths === 0 ? 'nobody died' : `${plural(opts.deaths, 'death')}${opts.wipeDeaths ? ` (${opts.deaths - opts.wipeDeaths} before the wipe)` : ''}`;
  const mechClause = judged.length ? `${worse === 0 ? 'no mechanic' : `${worse} of ${judged.length} mechanics`} worse than the top raids manage` : '';
  const verdict = `${diff} ${fight.name}: ${fight.kill ? `killed in ${fmtClock(durationSec)}` : `wiped at ${Math.round(fight.fightPercentage)}% after ${fmtClock(durationSec)}`}${pace ? `, ${pace}` : ''}; ${deathsClause}${mechClause ? `, ${mechClause}` : ''}`;
  const groupCost: Record<RaidItem['group'], number> = { ending: 2, boss: 3, mechanics: 2.5, utility: 0.6, prep: 1.5 };
  const baseCost = (i: RaidItem) => (/^(wipe|deaths)$/i.test(i.id) ? 8 + opts.deaths : /death/i.test(i.id) ? 3 : groupCost[i.group]);
  const toItem = (i: RaidItem): SummaryItem => ({ severity: i.severity, brief: i.brief ?? i.title, cost: i.cost ?? (i.severity === 'good' ? 1 / baseCost(i) : baseCost(i) * (i.severity === 'bad' ? 2 : 1)) });
  const problems = review.items.filter(i => i.severity === 'bad' || i.severity === 'warn').map(toItem);
  const strengths = review.items.filter(i => i.severity === 'good' && (i.brief || i.group === 'ending')).map(toItem);
  review.summaryDebug = { deaths: opts.deaths, problems: problems.map(p => `${p.cost.toFixed(1)} ${p.brief}`), strengths: strengths.map(p => `${p.cost.toFixed(2)} ${p.brief}`) };
  review.summary = composeSummary({ verdict, subject: 'raid', problems, strengths });
}

function fmtStatLike(v: number, kind: 'duration' | 'damage' | 'count'): string {
  if (kind === 'duration') return `${(v / 1000).toFixed(1)}s`;
  if (kind === 'damage') return fmtNum(v);
  return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : String(Math.round(v * 100) / 100);
}

export interface RaidReview {
  headline: string;
  summary: string;
  stats: Array<{ label: string; value: string; note?: string }>;
  items: RaidItem[];
  sourcesNote: string | null;
  summaryDebug?: unknown;
}

const SEV: Record<Severity, number> = { bad: 0, warn: 1, good: 2, info: 3 };

// The potion norm in words, from the top players' own logs; silent when there is no pool.
function potionLine(norm: { n: number; spec: string; perPull: number; prePotShare: number } | null | undefined): string {
  if (!norm) return '';
  const pre = Math.round(100 * norm.prePotShare);
  const preText = pre >= 50 ? `${pre}% of them pre-pot` : pre > 0 ? `only ${pre}% of them pre-pot` : 'none of them pre-pot';
  return `The top ${norm.n} ${norm.spec}s on this boss use about ${Math.round(norm.perPull)} potion${Math.round(norm.perPull) === 1 ? '' : 's'} a pull, and ${preText}.`;
}

export function buildRaidReview(opts: { fight: ReportFight; data: RaidFightData; boss: BossKnowledge | null; raidStats: RaidMechanicStats | null; cooldowns?: Record<string, number> | null; charges?: Record<string, number> | null; potionNorm?: { n: number; spec: string; perPull: number; prePotShare: number } | null }): RaidReview {
  const { fight, data, boss, raidStats, cooldowns } = opts;
  const chargesKnown = opts.charges ?? {};
  const items: RaidItem[] = [];
  const n = data.players.length || 1;
  const byId = new Map(data.players.map(p => [p.id, p]));
  const byName = new Map(data.players.map(p => [p.name, p]));
  const cls = (name: string, id?: number) => (id != null ? byId.get(id) : byName.get(name))?.className ?? '';
  const classify = (name: string, spellId?: number) => classifyAbility(boss, raidStats, name, spellId);
  const explain = (name: string, spellId?: number) => lookupJournal(boss, name, spellId)?.description || undefined;
  const topRaidShare = (name: string) => {
    const rs = raidStats?.abilities[name];
    return rs && rs.share.length >= 2 ? median(rs.share) : null;
  };
  const rowLink = (p: { id: number; name: string }) => ({ id: p.id, name: p.name, className: cls(p.name, p.id) });

  // ── How the pull ended ──
  const wipeGroups = new Map<string, RaidDeath[]>();
  if (!fight.kill) {
    for (const d of data.raidDeaths) {
      const same = data.raidDeaths.filter(x => x.killer === d.killer && Math.abs(x.atSec - d.atSec) <= 3);
      if (same.length >= 5) wipeGroups.set(d.killer, same);
    }
  }
  const wipeKillers = new Set(wipeGroups.keys());
  const realDeaths = data.raidDeaths.filter(d => !wipeKillers.has(d.killer));
  if (wipeGroups.size) {
    for (const [killer, deaths] of wipeGroups) {
      const first = deaths.slice().sort((a, b) => a.atSec - b.atSec)[0];
      const ability = data.abilities.find(a => a.name === killer);
      items.push({
        id: `wipe-${killer}`, severity: 'info', group: 'ending', impact: 100, icon: ability?.icon, spellId: ability?.spellId,
        title: `${killer} ended the pull at ${fmtClock(first.atSec)}`,
        text: `${deaths.length} of ${n} died to it inside a few seconds. ${classify(killer)?.type === 'raidwide' ? 'DBM marks it as raid-wide damage, so that is the fight ending rather than a positioning mistake.' : 'That is the fight ending, not individual mistakes.'}`,
        explain: explain(killer),
        rows: deaths.map(d => ({ ...rowLink(d), value: fmtClock(d.atSec), n: d.atSec })),
        rowsLabel: 'who died to it',
      });
    }
  }
  if (realDeaths.length) {
    const byKiller = new Map<string, RaidDeath[]>();
    for (const d of realDeaths) (byKiller.get(d.killer) ?? byKiller.set(d.killer, []).get(d.killer)!).push(d);
    const killers = [...byKiller.entries()].sort((a, b) => b[1].length - a[1].length);
    const first = realDeaths.slice().sort((a, b) => a.atSec - b.atSec)[0];
    const perPlayer = new Map<string, number>();
    for (const d of realDeaths) perPlayer.set(d.name, (perPlayer.get(d.name) ?? 0) + 1);
    items.push({
      id: 'deaths', severity: realDeaths.length >= 3 ? 'bad' : 'warn', group: 'ending', impact: 95,
      title: `${plural(realDeaths.length, 'death')} before the ${fight.kill ? 'kill' : 'wipe'}`,
      text: `First was ${first.name} at ${fmtClock(first.atSec)} to ${first.killer}. ${killers.slice(0, 3).map(([k, ds]) => `${k} killed ${ds.length}`).join(', ')}${killers.length > 3 ? ' and more' : ''}.`,
      rows: [...perPlayer.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => {
        const ds = realDeaths.filter(d => d.name === name);
        return { ...rowLink({ id: ds[0].id, name }), value: `${count}× · ${ds.map(d => `${fmtClock(d.atSec)} ${d.killer}`).join(', ')}`, n: count };
      }),
      rowsLabel: 'deaths by player',
    });
  } else {
    items.push({ id: 'no-deaths', severity: 'good', group: 'ending', impact: 90, title: fight.kill ? 'Nobody died on the kill' : 'Nobody died before the wipe', text: 'Clean on survival.', rows: [], rowsLabel: '' });
  }

  // Deaths with a personal defensive sitting ready. Only the player's own defensives
  // (what they pressed in this pull) are known here; cooldowns from Wowhead, else
  // the player's own shortest re-use gap.
  if (realDeaths.length) {
    const withCd: Array<{ d: RaidDeath; names: string[] }> = [];
    for (const d of realDeaths) {
      const defs = data.defensives[d.id] ?? [];
      if (!defs.length) continue;
      const bands: Record<string, Array<[number, number]>> = {};
      const uses: Record<string, number[]> = {};
      const cds: Record<string, number | undefined> = {};
      const charges: Record<string, number> = {};
      for (const x of defs) {
        bands[x.name] = x.bands;
        uses[x.name] = x.uses;
        cds[x.name] = cooldowns?.[x.name] ?? minReuseGap([x.uses]);
        charges[x.name] = noChargeModel(x.name) ? 1 : (chargesKnown[x.name] ?? 1);
      }
      const st = defensivesAt(d.atSec, defs.map(x => x.name), uses, cds, charges, bands);
      if (st.available.length) withCd.push({ d, names: st.available });
    }
    if (withCd.length) {
      items.push({
        id: 'deaths-defensives', severity: withCd.length >= 3 ? 'bad' : 'warn', group: 'ending', impact: 80,
        title: `${withCd.length} of ${realDeaths.length} deaths happened with a defensive available`,
        text: 'Available is not the same as "would have lived", but a defensive that was ready and unused is the first thing to ask about.',
        rows: withCd.map(({ d, names }) => ({ ...rowLink(d), icons: names.map(n => { const def = (data.defensives[d.id] ?? []).find(x => x.name === n); return { name: n, spellId: def?.spellId ?? data.friendlyCasts[n]?.spellId ?? 0, icon: def?.icon || data.friendlyCasts[n]?.icon || '' }; }), value: fmtClock(d.atSec), killer: { name: d.killer, icon: d.killerIcon, spellId: d.killerSpellId }, n: names.length })),
        rowsLabel: 'who died with what ready', rowsLayout: 'list',
      });
    }
  }

  // Wasted second charges across the raid.
  const doubled: RaidRow[] = [];
  for (const p of data.players) {
    for (const x of data.defensives[p.id] ?? []) {
      if (noChargeModel(x.name)) continue;
      const w = wastedDoublePresses(x.uses, x.bands);
      if (w.length) doubled.push({ ...rowLink(p), icons: [{ name: x.name, spellId: x.spellId, icon: x.icon || data.friendlyCasts[x.name]?.icon || '' }], value: `×${w.length} (${w.map(y => fmtClock(y.atSec)).join(', ')})`, n: w.length });
    }
  }
  if (doubled.length) {
    items.push({
      id: 'double-charges', severity: 'warn', group: 'ending', impact: 60,
      title: `${plural(doubled.length, 'defensive')} pressed twice while the first press was still running`,
      text: 'The second press landed while the first was still running, so the overlap was wasted.',
      rows: doubled.sort((a, b) => b.n - a.n), rowsLabel: 'who, and when',
    });
  }

  // ── Mechanics: per ability, by what it is ──
  const totalTaken = data.abilities.reduce((s, a) => s + a.total, 0) || 1;
  for (const a of data.abilities) {
    if (/^melee$/i.test(a.name) || wipeKillers.has(a.name)) continue;
    const c = classify(a.name, a.spellId);
    const kind: MechanicType | null = c?.type ?? null;
    const share = topRaidShare(a.name);
    const hitPlayers = a.perPlayer;
    const hits = hitPlayers.reduce((s, p) => s + p.count, 0);
    const countWord = hits > 0 ? `${plural(hits, 'hit')}` : fmtNum(a.total);
    const rows: RaidRow[] = hitPlayers.map(p => ({ ...rowLink(p), value: p.count ? `${p.count}×${p.total ? ` · ${fmtNum(p.total)}` : ''}` : fmtNum(p.total), n: p.count || p.total }));
    const comparison = share != null ? `Top raids: ${Math.round(share * 100)}% of players take it, here ${Math.round(100 * hitPlayers.length / n)}%` : undefined;
    const sev = (hitPlayers.length >= n * 0.3 || a.total / totalTaken >= 0.08) ? 'bad' : 'warn';
    if (kind === 'avoid') {
      items.push({
        id: `avoid-${a.name}`, severity: sev, group: 'mechanics', impact: 60 + Math.round(30 * a.total / totalTaken) + Math.min(10, hitPlayers.length), icon: a.icon, spellId: a.spellId, explain: explain(a.name, a.spellId),
        title: `${a.name} hit ${hitPlayers.length} of ${n} players${hits ? ` (${countWord})` : ''}`,
        text: `${fmtNum(a.total)} of avoidable damage, ${Math.round(100 * a.total / totalTaken)}% of everything the raid took. ${ucFirst(MECHANIC_WORDS.avoid)}.`,
        comparison, rows, rowsLabel: 'who got hit',
      });
    } else if (kind === 'spread' || kind === 'gather' || kind === 'fixate') {
      items.push({
        id: `mech-${a.name}`, severity: sev, group: 'mechanics', impact: 55 + Math.round(30 * a.total / totalTaken), icon: a.icon, spellId: a.spellId, explain: explain(a.name, a.spellId),
        title: `${a.name}: ${hitPlayers.length} of ${n} players took it${hits ? ` (${countWord})` : ''}`,
        text: `${fmtNum(a.total)} damage. It is ${MECHANIC_WORDS[kind]}; ${kind === 'spread' ? 'people were too close together' : kind === 'gather' ? 'too few people shared it' : 'the fixated players got caught'}.`,
        comparison, rows, rowsLabel: 'who took it',
      });
    } else if (kind === 'tank') {
      const nonTanks = hitPlayers.filter(p => byId.get(p.id)?.role !== 'tank');
      if (nonTanks.length) {
        items.push({
          id: `tank-${a.name}`, severity: 'warn', group: 'mechanics', impact: 50 + Math.min(20, nonTanks.length * 4), icon: a.icon, spellId: a.spellId, explain: explain(a.name, a.spellId),
          title: `${a.name} hit ${plural(nonTanks.length, 'non-tank')}`,
          text: `${a.name} is ${MECHANIC_WORDS.tank}. Anyone else in it is taking damage the tanks are built for.`,
          comparison, rows: nonTanks.map(p => ({ ...rowLink(p), value: p.count ? `${p.count}×` : fmtNum(p.total), n: p.count || p.total })), rowsLabel: 'non-tanks hit',
        });
      }
    } else if (kind === 'targeted') {
      items.push({
        id: `target-${a.name}`, severity: 'info', group: 'mechanics', impact: 28, icon: a.icon, spellId: a.spellId, explain: explain(a.name, a.spellId),
        title: `${a.name} picked ${hitPlayers.length} of ${n} players`,
        text: `${fmtNum(a.total)} damage. It targets someone every pull; what matters is how fast the raid deals with it once it is on them.`,
        comparison, rows, rowsLabel: 'who was picked',
      });
    } else if (kind === 'soak') {
      items.push({
        id: `soak-${a.name}`, severity: 'info', group: 'mechanics', impact: 30, icon: a.icon, spellId: a.spellId, explain: explain(a.name, a.spellId),
        title: `${a.name} soaked by ${hitPlayers.length} of ${n} players`,
        text: `${fmtNum(a.total)} of soak damage shared across the raid.`,
        comparison, rows, rowsLabel: 'who soaked',
      });
    } else if (kind === 'defensive') {
      // A big hit everyone takes: only interesting when it killed people.
      const killed = realDeaths.filter(d => d.killer === a.name);
      if (killed.length) {
        items.push({
          id: `def-${a.name}`, severity: 'warn', group: 'mechanics', impact: 45 + killed.length * 5, icon: a.icon, spellId: a.spellId, explain: explain(a.name, a.spellId),
          title: `${a.name} killed ${plural(killed.length, 'player')}`,
          text: `DBM flags it as ${MECHANIC_WORDS.defensive}. Deaths to it are where to look for a defensive or external that was not there.`,
          rows: killed.map(d => ({ ...rowLink(d), value: fmtClock(d.atSec), n: d.atSec })), rowsLabel: 'who died to it',
        });
      }
    }
  }

  // ── Interrupts and dispels: DBM says which casts matter; the log says how many were stopped ──
  for (const ic of data.interrupts) {
    if (!ic.begun) continue;
    const missed = ic.begun - ic.stopped;
    items.push({
      id: `int-${ic.name}`, severity: missed === 0 ? 'good' : missed >= ic.begun / 2 ? 'bad' : 'warn', group: 'utility', impact: 50 + missed * 5, icon: ic.icon, spellId: ic.spellId, explain: explain(ic.name, ic.spellId),
      title: `Interrupted ${ic.name} ${ic.stopped} of ${ic.begun} times`,
      text: missed === 0 ? 'Every cast stopped.' : `${plural(missed, 'cast')} went through.`,
      rows: ic.by.map(b => ({ ...rowLink({ id: byName.get(b.name)?.id ?? -1, name: b.name }), value: `${b.total}×`, n: b.total })), rowsLabel: 'who kicked',
    });
  }
  const seenInt = new Set(data.interrupts.map(i => i.name));
  for (const l of boss?.labels ?? []) {
    if (l.type !== 'interrupt' || !l.name || seenInt.has(l.name)) continue;
    const casts = data.enemyCasts[l.name];
    if (!casts?.total) continue;
    seenInt.add(l.name);
    items.push({
      id: `int-${l.name}`, severity: 'bad', group: 'utility', impact: 60, icon: casts.icon, spellId: l.spellId, explain: explain(l.name, l.spellId),
      title: `Interrupted ${l.name} 0 of ${casts.total} times`,
      text: 'DBM flags this cast as a kick, and none landed.',
      rows: [], rowsLabel: '',
    });
  }
  for (const dc of data.dispels) {
    if (!dc.begun) continue;
    const missed = dc.begun - dc.stopped;
    items.push({
      id: `disp-${dc.name}`, severity: missed === 0 ? 'good' : dc.stopped === 0 ? 'bad' : 'warn', group: 'utility', impact: 40 + Math.min(20, missed), icon: dc.icon, spellId: dc.spellId, explain: explain(dc.name, dc.spellId),
      title: `Dispelled ${dc.name} ${dc.stopped} of ${dc.begun} times`,
      text: missed === 0 ? 'Every application cleared.' : `${plural(missed, 'application')} ran its course.`,
      rows: dc.by.map(b => ({ ...rowLink({ id: byName.get(b.name)?.id ?? -1, name: b.name }), value: `${b.total}×`, n: b.total })), rowsLabel: 'who dispelled',
    });
  }
  const seenDisp = new Set(data.dispels.map(d => d.name));
  for (const l of boss?.labels ?? []) {
    if (l.type !== 'dispel' || !l.name || seenDisp.has(l.name)) continue;
    const deb = data.raidDebuffs[l.name];
    if (!deb?.uses) continue;
    seenDisp.add(l.name);
    items.push({
      id: `disp-${l.name}`, severity: 'bad', group: 'utility', impact: 48, icon: deb.icon, spellId: deb.spellId, explain: explain(l.name, l.spellId),
      title: `Dispelled ${l.name} 0 of ${deb.uses} times`,
      text: 'DBM flags this debuff as a dispel, and none were cleared.',
      rows: [], rowsLabel: '',
    });
  }

  // ── Consumables, per player ──
  const consumablesOf = (id: number): RaidPlayerConsumables => {
    const c: RaidPlayerConsumables = { flask: false, food: false, rune: false, potions: 0, potionNames: [] };
    for (const b of data.playerBuffs[id] ?? []) {
      const fam = buffFamily(b.name);
      if (fam === 'flask' && b.atPull) c.flask = true;
      if (fam === 'food' && b.atPull) c.food = true;
      if (fam === 'rune' && b.atPull) c.rune = true;
      if (fam === 'potion') { c.potions += b.uses; c.potionNames.push(b.name); }
    }
    return c;
  };
  const cons = data.players.map(p => ({ p, c: consumablesOf(p.id) }));
  const noPotion = cons.filter(x => x.c.potions === 0);
  const totalPotions = cons.reduce((s, x) => s + x.c.potions, 0);
  items.push({
    id: 'potions', severity: noPotion.length === 0 ? 'good' : noPotion.length >= n / 2 ? 'bad' : 'warn', group: 'prep', impact: 40 + Math.min(20, noPotion.length * 2),
    title: `${n - noPotion.length} of ${n} used a combat potion (${totalPotions} total)`,
    text: `${potionLine(opts.potionNorm)}${noPotion.length ? ' Listed: everyone who used none.' : ' Everyone potted.'}`.trim(),
    rows: noPotion.map(x => ({ ...rowLink(x.p), value: '0', n: 0 })), rowsLabel: 'no potion',
  });
  // Flask, food and rune as three cards: each is its own count, its own list, and its
  // own severity (a missing flask matters more than a missing rune).
  const prepCard = (id: string, label: string, missing: typeof cons, severity: Severity, impact: number) => {
    items.push({
      id, severity, group: 'prep', impact,
      title: `${label}: ${n - missing.length} of ${n}`,
      text: missing.length ? `Checked at the pull. Listed: everyone without one running when the fight started.` : `Everyone had one running at the pull.`,
      rows: missing.map(x => ({ ...rowLink(x.p), value: `no ${label.toLowerCase()}`, n: 1 })), rowsLabel: `without a ${label.toLowerCase()}`,
    });
  };
  const noFlask = cons.filter(x => !x.c.flask);
  const noFood = cons.filter(x => !x.c.food);
  const noRune = cons.filter(x => !x.c.rune);
  prepCard('flask', 'Flask', noFlask, noFlask.length === 0 ? 'good' : noFlask.length >= n / 3 ? 'bad' : 'warn', 38 + noFlask.length * 3);
  prepCard('food', 'Food', noFood, noFood.length === 0 ? 'good' : noFood.length > n / 3 ? 'warn' : 'info', 30 + noFood.length);
  prepCard('rune', 'Rune', noRune, noRune.length === 0 ? 'good' : noRune.length === n ? 'info' : 'info', 20);
  // Enchants: slots most of the raid has enchanted are the expected ones.
  const geared = data.players.filter(p => p.gear);
  if (geared.length >= 5) {
    const slotCounts = new Map<number, { have: number; of: number }>();
    for (const p of geared) for (const g of p.gear!.slots) { const c = slotCounts.get(g.slot) ?? { have: 0, of: 0 }; c.of++; if (g.enchanted) c.have++; slotCounts.set(g.slot, c); }
    const expected = new Set([...slotCounts.entries()].filter(([, c]) => c.of >= geared.length * 0.6 && c.have / c.of >= 0.6).map(([slot]) => slot));
    const missing = geared.map(p => ({ p, slots: p.gear!.slots.filter(g => expected.has(g.slot) && !g.enchanted).length })).filter(x => x.slots > 0).sort((a, b) => b.slots - a.slots);
    items.push({
      id: 'enchants', severity: missing.length === 0 ? 'good' : missing.length > n / 3 ? 'warn' : 'info', group: 'prep', impact: 25 + missing.length,
      title: missing.length ? `${plural(missing.length, 'player')} missing enchants` : 'Enchants all in place',
      text: `Average item level ${Math.round(data.avgIlvl)}. Slots counted are the ones most of this raid enchants.`,
      rows: missing.map(x => ({ ...rowLink(x.p), value: plural(x.slots, 'empty slot'), n: x.slots })), rowsLabel: 'who is missing what',
    });
  }

  items.sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.impact - a.impact);

  const tanks = data.players.filter(p => p.role === 'tank').length;
  const healers = data.players.filter(p => p.role === 'healer').length;
  const avoidable = items.filter(i => i.id.startsWith('avoid-')).length;
  const diff = DIFFICULTY_LABELS[fight.difficulty] ?? '';
  const headline = `${diff} ${fight.name}, ${fight.kill ? 'kill' : `wipe at ${Math.round(fight.fightPercentage)}%`} in ${fmtClock(fight.durationMs / 1000)}.`;
  const problems = items.filter(i => i.severity === 'bad' || i.severity === 'warn');
  const summary = problems.length
    ? `The ${problems.length === 1 ? 'thing' : problems.length === 2 ? 'two things' : 'three things'} that cost the raid most: ${problems.slice(0, 3).map(i => i.title).join('. ')}.`
    : 'Clean pull. Nothing here the raid needs to change.';
  const stats = [
    { label: 'Raid', value: String(n), note: `${tanks} tank${tanks === 1 ? '' : 's'} · ${healers} heal${healers === 1 ? 'er' : 'ers'}` },
    { label: 'Deaths', value: String(data.raidDeaths.length), note: wipeKillers.size ? `${realDeaths.length} before the wipe` : undefined },
    { label: 'Avoidable', value: String(avoidable), note: 'mechanics failed' },
    { label: 'Potions', value: `${n - noPotion.length}/${n}` },
    { label: 'Item level', value: data.avgIlvl ? String(Math.round(data.avgIlvl)) : '—' },
  ];
  const sourceParts: string[] = [];
  if (boss?.sources.dbm) sourceParts.push('mechanic types from Deadly Boss Mods');
  if (raidStats && raidStats.n > 0) sourceParts.push(`who takes what across ${plural(raidStats.n, 'top raid')}`);
  if (boss?.sources.descriptions) sourceParts.push('ability descriptions from Wowhead');
  const sourcesNote = sourceParts.length ? ucFirst(sourceParts.join(', ')) + '.' : null;
  return { headline, summary, stats, items, sourcesNote };
}

