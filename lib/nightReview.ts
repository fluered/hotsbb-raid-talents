import { unstable_cache } from 'next/cache';
import { wclQuery, isRateLimitError } from './wow';
import {
  buildProfile, DIFFICULTY_LABELS, isPlayerSourcedDamage, mapPlayerDetails,
  type FightPlayer, type RaidDeath, type RaidMechanicStats, type ReportFight, type ReportOverview, type Role, type WclEventsPage, type WclReportData, type WclTable,
} from './analyze';
import { classifyAbility, fmtClock, fmtNum, median, plural } from './analyzeRules';
import { MECHANIC_WORDS, type BossKnowledge, type MechanicType } from './bossMechanics';
import { countWord, timesWord } from './summary';
import { getPersistentReadOnly } from './persistentCache';

// ─── Night review: every pull of one boss in one report ────────────────────────
//
// What a raid leader wants after a progression night: how it went, what kept ending
// pulls, who the repeat offenders are, whether the raid got further. Everything comes
// from the log — the same death parser and wipe detection as the single-pull raid
// summary, the same ability classification (DBM labels plus what top raids take).
//
// Requests for a cold night (the report overview is already loaded by the page):
//   1  roster: playerDetails, who was in which pull, damage taken by ability (all pulls)
//   N  deaths: one Deaths table per chunk of pulls (the table stops at 200 rows)
//   1+ hits: damage events for the avoidable abilities, all pulls, one paged query
// so a 15-pull Mythic night is 1 + 2 + 1 requests.
//
// THE RULES (also stated on the page):
//  · Kill: every death counts.
//  · Wipe with a wipe group (5+ deaths to the same ability within 3 seconds — the
//    single-pull view's definition of "the wipe"): deaths to a wipe ability never
//    count, and neither does any death at or after the first wipe-group death. What
//    is left is "deaths before the wipe".
//  · Wipe without a wipe group (the raid called it and died piecemeal): the first
//    three deaths count.
//  · First death of a pull: the earliest counted death.
//  · Avoidable hits: damage events from abilities classifyAbility calls avoid, spread
//    or fixate, landing before the wipe group started. Hits less than two seconds
//    apart on the same player from the same ability are one "time" (a puddle's ticks
//    are one mistake, not twelve).

export const NIGHT_MAX_PULLS = 40;
export const NIGHT_MAX_ABILITIES = 8;
const WIPE_GROUP_DEATHS = 5;
const WIPE_GROUP_WINDOW_SEC = 3;
export const NIGHT_FIRST_DEATHS = 3;
const DEATH_TABLE_ROWS = 200;
const EVENT_PAGES = 4;
const INCIDENT_GAP_MS = 2000;
const SHORT_PULL_SEC = 30;
const AVOIDABLE_TYPES: MechanicType[] = ['avoid', 'spread', 'fixate'];

// ─── Picking the pulls ────────────────────────────────────────────────────────

export interface NightGroup {
  encounterID: number;
  difficulty: number;
  name: string;
  // Every pull of this boss and difficulty in the report, in order.
  all: ReportFight[];
  // The pulls the night view reads: the newest NIGHT_MAX_PULLS.
  fights: ReportFight[];
}

export function nightGroups(overview: ReportOverview): NightGroup[] {
  const groups = new Map<string, NightGroup>();
  for (const f of overview.fights) {
    const key = `${f.encounterID}-${f.difficulty}`;
    const g = groups.get(key) ?? { encounterID: f.encounterID, difficulty: f.difficulty, name: f.name, all: [], fights: [] };
    g.all.push(f);
    groups.set(key, g);
  }
  return [...groups.values()].map(g => ({ ...g, fights: g.all.slice(-NIGHT_MAX_PULLS) }));
}

// `boss` and `difficulty` are the URL's params; both may be left out when the report
// has one group, and difficulty when the boss was pulled on one difficulty only.
export function pickNightGroup(overview: ReportOverview, boss: string | undefined, difficulty: string | undefined): NightGroup | null {
  const groups = nightGroups(overview);
  const enc = boss && /^\d+$/.test(boss) ? parseInt(boss) : null;
  const diff = difficulty && /^\d+$/.test(difficulty) ? parseInt(difficulty) : null;
  const match = groups.filter(g => (enc == null || g.encounterID === enc) && (diff == null || g.difficulty === diff));
  if (match.length === 1) return match[0];
  // No params on a report with several bosses: nothing to guess from.
  return null;
}

export const nightHref = (code: string, g: { encounterID: number; difficulty: number }) => `/analyze?report=${code}&view=night&boss=${g.encounterID}&difficulty=${g.difficulty}`;

// ─── Data ─────────────────────────────────────────────────────────────────────

export interface NightAbility {
  name: string;
  spellIds: number[];
  icon: string;
  total: number;
}

export interface NightPlayer { id: number; name: string; className: string; spec: string; role: Role | null }

export interface NightBase {
  // Deaths per pull as the single-pull view parses them; null when that pull's table failed.
  deaths: Record<number, RaidDeath[] | null>;
  roster: NightPlayer[];
  // The roster as getFightPlayers would give it, for picking the reference spec pool.
  fightPlayers: FightPlayer[];
  // Player ids present per pull; empty when the roster request failed.
  present: Record<number, number[]>;
  // Hostile damage abilities over the whole night, merged by name, biggest first.
  abilities: NightAbility[];
  failed: { deaths: boolean; roster: boolean };
  requests: number;
}

interface WclDeathRow { fight?: number }
interface WclTakenRow { guid?: number; name?: string; abilityIcon?: string; total?: number; actorType?: string }
interface WclRosterReport {
  pd?: { data?: { playerDetails?: unknown } | null } | null;
  fights?: Array<{ id: number; friendlyPlayers?: number[] | null }> | null;
  taken?: WclTable<WclTakenRow | null> | null;
}
interface WclHitEvent { timestamp: number; targetID?: number; abilityGameID?: number; fight?: number; amount?: number; absorbed?: number; tick?: boolean }

// Thrown inside unstable_cache so a night with a failed section is returned but not kept.
class PartialResult<T> extends Error {
  constructor(public value: T) { super('partial night data'); }
}
async function cacheUnlessPartial<T>(key: string, revalidate: number, compute: () => Promise<{ value: T; partial: boolean }>): Promise<T> {
  try {
    return await unstable_cache(async () => {
      const r = await compute();
      if (r.partial) throw new PartialResult(r.value);
      return r.value;
    }, [key], { revalidate })();
  } catch (err) {
    if (err instanceof PartialResult) return err.value as T;
    throw err;
  }
}

const cacheKey = (code: string, fights: ReportFight[]) => {
  const f = fights[0];
  return `${code}-${f?.encounterID ?? 0}-${f?.difficulty ?? 0}-${fights.length}-${fights[fights.length - 1]?.id ?? 0}`;
};

// One Deaths table for a run of pulls. The table stops at 200 rows (earliest first),
// so a full answer is asked for again in two halves.
async function fetchDeaths(token: string, code: string, ids: number[], count: { n: number }): Promise<Map<number, WclDeathRow[]>> {
  count.n++;
  const d = await wclQuery<WclReportData<{ deaths?: WclTable<WclDeathRow> | null }>>(token, `{ reportData { report(code: "${code}") { deaths: table(dataType: Deaths, fightIDs: [${ids.join(',')}]) } } }`, 'night-deaths', null);
  const rows = d?.reportData?.report?.deaths?.data?.entries ?? [];
  if (rows.length >= DEATH_TABLE_ROWS && ids.length > 1) {
    const mid = Math.ceil(ids.length / 2);
    const [a, b] = [await fetchDeaths(token, code, ids.slice(0, mid), count), await fetchDeaths(token, code, ids.slice(mid), count)];
    return new Map([...a, ...b]);
  }
  const out = new Map<number, WclDeathRow[]>(ids.map(id => [id, []]));
  for (const r of rows) if (r.fight != null) out.get(r.fight)?.push(r);
  return out;
}

export function getNightBase(token: string, code: string, fights: ReportFight[]): Promise<NightBase> {
  return cacheUnlessPartial<NightBase>(`analyze-night-base-v1-${cacheKey(code, fights)}`, 86400, async () => {
    const ids = fights.map(f => f.id);
    const count = { n: 0 };
    const base: NightBase = { deaths: {}, roster: [], fightPlayers: [], present: {}, abilities: [], failed: { deaths: false, roster: false }, requests: 0 };

    // A rate limit is the page's error to show; anything else costs only its section.
    try {
      count.n++;
      const d = await wclQuery<WclReportData<WclRosterReport>>(token, `{ reportData { report(code: "${code}") {
        pd: playerDetails(fightIDs: [${ids.join(',')}])
        fights(fightIDs: [${ids.join(',')}]) { id friendlyPlayers }
        taken: table(dataType: DamageTaken, fightIDs: [${ids.join(',')}], viewBy: Ability)
      } } }`, 'night-roster', null);
      const r = d?.reportData?.report;
      base.fightPlayers = mapPlayerDetails(r?.pd?.data?.playerDetails).map(p => ({ ...p, gear: null, talentNodes: null }));
      base.roster = base.fightPlayers.map(p => ({ id: p.id, name: p.name, className: p.className, spec: p.spec, role: p.role }));
      const known = new Set(base.roster.map(p => p.id));
      for (const f of r?.fights ?? []) base.present[f.id] = (f.friendlyPlayers ?? []).filter(id => known.has(id));
      const merged = new Map<string, NightAbility>();
      for (const e of r?.taken?.data?.entries ?? []) {
        if (!e?.name || !e.guid || !((e.total ?? 0) > 0) || isPlayerSourcedDamage(e) || /^melee$/i.test(e.name)) continue;
        const cur = merged.get(e.name) ?? { name: e.name, spellIds: [], icon: e.abilityIcon ?? '', total: 0 };
        cur.total += e.total ?? 0;
        if (!cur.spellIds.includes(e.guid)) cur.spellIds.push(e.guid);
        merged.set(e.name, cur);
      }
      base.abilities = [...merged.values()].sort((a, b) => b.total - a.total).slice(0, 40);
      if (!base.roster.length) base.failed.roster = true;
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      console.error('night: roster unavailable', err);
      base.failed.roster = true;
    }

    // Mythic is 20 players, so eight pulls fit under the table's 200 rows even with
    // battle resurrections; flexible raids go up to 30.
    const per = fights[0]?.difficulty === 5 ? 8 : 5;
    for (let i = 0; i < fights.length; i += per) {
      const chunk = fights.slice(i, i + per);
      try {
        const rows = await fetchDeaths(token, code, chunk.map(f => f.id), count);
        for (const f of chunk) base.deaths[f.id] = buildProfile({ deaths: { data: { entries: rows.get(f.id) ?? [] } } }, f, -1).raidDeaths;
      } catch (err) {
        if (isRateLimitError(err)) throw err;
        console.error('night: deaths unavailable', err);
        base.failed.deaths = true;
        for (const f of chunk) base.deaths[f.id] = null;
      }
    }
    base.requests = count.n;
    return { value: base, partial: base.failed.deaths || base.failed.roster };
  });
}

// ─── Deaths that count ────────────────────────────────────────────────────────

export interface PullDeaths {
  rule: 'kill' | 'wipe-group' | 'first-deaths' | 'unknown';
  // Deaths before the wipe (or all of them on a kill), in order.
  counted: RaidDeath[];
  total: number;
  // The wipe itself: the earliest wipe group.
  wipe: { killer: string; icon: string; spellId: number; atSec: number; deaths: number } | null;
  // Seconds into the pull after which nothing is read as an individual mistake.
  cutoffSec: number;
}

export function splitPullDeaths(fight: ReportFight, deaths: RaidDeath[] | null): PullDeaths {
  const durationSec = fight.durationMs / 1000;
  if (!deaths) return { rule: 'unknown', counted: [], total: 0, wipe: null, cutoffSec: durationSec };
  const sorted = deaths.slice().sort((a, b) => a.atSec - b.atSec);
  if (fight.kill) return { rule: 'kill', counted: sorted, total: sorted.length, wipe: null, cutoffSec: durationSec };
  const groups = new Map<string, RaidDeath[]>();
  for (const d of sorted) {
    const same = sorted.filter(x => x.killer === d.killer && Math.abs(x.atSec - d.atSec) <= WIPE_GROUP_WINDOW_SEC);
    if (same.length < WIPE_GROUP_DEATHS) continue;
    const g = groups.get(d.killer) ?? [];
    for (const x of same) if (!g.includes(x)) g.push(x);
    groups.set(d.killer, g);
  }
  if (!groups.size) return { rule: 'first-deaths', counted: sorted.slice(0, NIGHT_FIRST_DEATHS), total: sorted.length, wipe: null, cutoffSec: durationSec };
  const ranked = [...groups.entries()]
    .map(([killer, g]) => ({ killer, g, start: Math.min(...g.map(d => d.atSec)) }))
    .sort((a, b) => a.start - b.start || b.g.length - a.g.length);
  const first = ranked[0];
  return {
    rule: 'wipe-group',
    counted: sorted.filter(d => !groups.has(d.killer) && d.atSec < first.start),
    total: sorted.length,
    wipe: { killer: first.killer, icon: first.g[0].killerIcon, spellId: first.g[0].killerSpellId, atSec: first.start, deaths: first.g.length },
    // Death times are whole seconds; half a second back keeps the wipe's own hit out.
    cutoffSec: Math.max(0, first.start - 0.5),
  };
}

// ─── Avoidable hits ───────────────────────────────────────────────────────────

export interface NightHitRow { ability: string; playerId: number; fightId: number; events: number; ticks: number; times: number; damage: number }
export interface NightHits { rows: NightHitRow[]; truncated: boolean; requests: number }

export interface PickedAbility extends NightAbility { type: MechanicType; via: 'dbm' | 'logs' }

// The night's avoidable-type abilities by damage, capped. `known` tells a night with
// nothing avoidable apart from one where nothing could be classified at all.
export function pickAvoidable(abilities: NightAbility[], boss: BossKnowledge | null, raidStats: RaidMechanicStats | null): { picked: PickedAbility[]; known: number; more: number } {
  const all: PickedAbility[] = [];
  let known = 0;
  for (const a of abilities) {
    const c = a.spellIds.map(id => classifyAbility(boss, raidStats, a.name, id)).find(x => x) ?? classifyAbility(boss, raidStats, a.name);
    if (!c) continue;
    known++;
    if (AVOIDABLE_TYPES.includes(c.type)) all.push({ ...a, type: c.type, via: c.via });
  }
  return { picked: all.slice(0, NIGHT_MAX_ABILITIES), known, more: Math.max(0, all.length - NIGHT_MAX_ABILITIES) };
}

// Every hit of the picked abilities on a raid member, all pulls, in one paged events
// query (a ten-thousand-event page; four pages at most). Amounts are damage plus
// absorbed, which is what the Damage Taken table calls the total.
export function getNightHits(token: string, code: string, fights: ReportFight[], picked: PickedAbility[], cutoffs: Record<number, number>, playerIds: number[]): Promise<NightHits> {
  const ids = picked.flatMap(a => a.spellIds).sort((a, b) => a - b);
  if (!ids.length || !fights.length) return Promise.resolve({ rows: [], truncated: false, requests: 0 });
  return unstable_cache(
    async () => {
      const nameOf = new Map<number, string>(picked.flatMap(a => a.spellIds.map((id): [number, string] => [id, a.name])));
      const fightById = new Map(fights.map(f => [f.id, f]));
      const players = new Set(playerIds);
      const end = Math.max(...fights.map(f => f.endTime));
      const rows = new Map<string, NightHitRow & { last: number }>();
      let from: number | null = null;
      let requests = 0;
      let truncated = false;
      for (let page = 0; page < EVENT_PAGES; page++) {
        requests++;
        const range: string = from == null ? '' : `startTime: ${from}, endTime: ${end}, `;
        const d: WclReportData<{ ev?: WclEventsPage<WclHitEvent | null> | null }> | null | undefined = await wclQuery(token, `{ reportData { report(code: "${code}") {
          ev: events(fightIDs: [${fights.map(f => f.id).join(',')}], ${range}dataType: DamageTaken, hostilityType: Friendlies, filterExpression: "ability.id in (${ids.join(',')})", limit: 10000) { data nextPageTimestamp }
        } } }`, 'night-hits', null);
        const ev = d?.reportData?.report?.ev;
        for (const e of ev?.data ?? []) {
          if (!e || e.targetID == null || e.fight == null) continue;
          const fight = fightById.get(e.fight);
          const ability = nameOf.get(Number(e.abilityGameID));
          if (!fight || !ability || (players.size && !players.has(e.targetID))) continue;
          if (e.timestamp - fight.startTime > (cutoffs[fight.id] ?? Infinity) * 1000) continue;
          const key = `${ability}|${e.targetID}|${fight.id}`;
          const row = rows.get(key) ?? { ability, playerId: e.targetID, fightId: fight.id, events: 0, ticks: 0, times: 0, damage: 0, last: -Infinity };
          row.events++;
          if (e.tick) row.ticks++;
          if (e.timestamp - row.last > INCIDENT_GAP_MS) row.times++;
          row.last = e.timestamp;
          row.damage += (e.amount ?? 0) + (e.absorbed ?? 0);
          rows.set(key, row);
        }
        from = ev?.nextPageTimestamp ?? null;
        if (from == null) break;
        if (page === EVENT_PAGES - 1) truncated = true;
      }
      return { rows: [...rows.values()].map(r => ({ ability: r.ability, playerId: r.playerId, fightId: r.fightId, events: r.events, ticks: r.ticks, times: r.times, damage: r.damage })), truncated, requests };
    },
    // The cutoffs follow from the deaths; their sum keeps a night read with a death table missing apart.
    [`analyze-night-hits-v1-${cacheKey(code, fights)}-${ids.join('.')}-${Math.round(fights.reduce((s, f) => s + Math.min(cutoffs[f.id] ?? 0, 1e6), 0))}`],
    { revalidate: 86400 }
  )();
}

// ─── Review ───────────────────────────────────────────────────────────────────

export interface NightPull {
  fightId: number;
  // Pull number within the boss's pulls in this report (1 = the first of the night).
  n: number;
  kill: boolean;
  pct: number;
  durationSec: number;
  rule: PullDeaths['rule'];
  deathsBefore: number | null;
  totalDeaths: number | null;
  wipe: PullDeaths['wipe'];
  firstDeath: { name: string; killer: string; atSec: number } | null;
}

export interface NightPlayerRef { id: number; name: string; className: string }

export interface NightKiller {
  name: string;
  icon: string;
  spellId: number;
  typeWords: string | null;
  pulls: number;
  deaths: number;
  players: Array<NightPlayerRef & { count: number; pullNumbers: number[]; fightId: number }>;
}

export interface NightWipeCause { name: string; icon: string; spellId: number; pulls: number; pullNumbers: number[] }

export interface NightFirstDeath extends NightPlayerRef { count: number; causes: Array<{ name: string; count: number }>; fightId: number }

export interface NightMechanic {
  name: string;
  icon: string;
  spellId: number;
  type: MechanicType;
  via: 'dbm' | 'logs';
  damage: number;
  times: number;
  pulls: number;
  // Mostly ticks: the count is of separate exposures, the damage is the whole burn.
  dot: boolean;
  // One player takes most of it, pull after pull: more likely their job than their mistake.
  assigned: { name: string; role: Role | null } | null;
  players: Array<NightPlayerRef & { times: number; events: number; damage: number; pulls: number; fightId: number }>;
}

export interface NightPlayerRow extends NightPlayerRef {
  role: Role | null;
  deaths: number;
  firstDeaths: number;
  hits: number;
  avoidDamage: number;
  pulls: number | null;
  // Where the name links: the latest pull they died on, else were hit on, else were in.
  fightId: number;
  score: number;
}

export interface NightReview {
  code: string;
  encounterID: number;
  difficulty: number;
  bossName: string;
  summary: string;
  stats: Array<{ label: string; value: string; note?: string }>;
  pulls: NightPull[];
  totalPulls: number;
  capped: boolean;
  wipeCauses: NightWipeCause[];
  killers: NightKiller[];
  countedDeaths: number;
  firstDeaths: NightFirstDeath[];
  pullsWithFirstDeath: number;
  mechanics: NightMechanic[];
  mechanicsNote: string | null;
  players: NightPlayerRow[];
  trend: string[];
  notes: string[];
  requests: number;
}

// "1h 32m" / "47 min".
export function fmtSpan(sec: number): string {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
}

const tally = <K,>(keys: K[]): Array<[K, number]> => {
  const m = new Map<K, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

export function buildNightReview(opts: {
  code: string;
  group: NightGroup;
  base: NightBase;
  hits: NightHits | null;
  picked: { picked: PickedAbility[]; known: number; more: number } | null;
  boss: BossKnowledge | null;
  raidStats: RaidMechanicStats | null;
  hitsFailed?: boolean;
}): NightReview {
  const { code, group, base, hits, picked, boss, raidStats } = opts;
  const fights = group.fights;
  const offset = group.all.length - fights.length;
  const numberOf = new Map(fights.map((f, i) => [f.id, offset + i + 1]));
  const split = new Map(fights.map(f => [f.id, splitPullDeaths(f, base.deaths[f.id] ?? null)]));

  // Names for everyone seen: the roster, and anyone the death tables name beyond it.
  const people = new Map<number, NightPlayerRef & { role: Role | null }>(base.roster.map(p => [p.id, { id: p.id, name: p.name, className: p.className, role: p.role }]));
  for (const ds of Object.values(base.deaths)) for (const d of ds ?? []) if (!people.has(d.id)) people.set(d.id, { id: d.id, name: d.name, className: d.className, role: null });
  const ref = (id: number): NightPlayerRef => { const p = people.get(id); return { id, name: p?.name ?? `Player ${id}`, className: p?.className ?? '' }; };

  const pulls: NightPull[] = fights.map(f => {
    const s = split.get(f.id)!;
    const first = s.counted[0];
    return {
      fightId: f.id, n: numberOf.get(f.id)!, kill: f.kill, pct: f.kill ? 0 : f.fightPercentage, durationSec: f.durationMs / 1000,
      rule: s.rule, deathsBefore: s.rule === 'unknown' ? null : s.counted.length, totalDeaths: s.rule === 'unknown' ? null : s.total, wipe: s.wipe,
      firstDeath: first ? { name: first.name, killer: first.killer, atSec: first.atSec } : null,
    };
  });

  // ── What killed people ──
  const counted = fights.flatMap(f => split.get(f.id)!.counted.map(d => ({ d, fightId: f.id })));
  const killerMap = new Map<string, Array<{ d: RaidDeath; fightId: number }>>();
  for (const x of counted) (killerMap.get(x.d.killer) ?? killerMap.set(x.d.killer, []).get(x.d.killer)!).push(x);
  const killers: NightKiller[] = [...killerMap.entries()].map(([name, list]) => {
    const byPlayer = new Map<number, Array<{ d: RaidDeath; fightId: number }>>();
    for (const x of list) (byPlayer.get(x.d.id) ?? byPlayer.set(x.d.id, []).get(x.d.id)!).push(x);
    const c = classifyAbility(boss, raidStats, name, list[0].d.killerSpellId || undefined);
    return {
      name, icon: list[0].d.killerIcon, spellId: list[0].d.killerSpellId,
      typeWords: c && c.type !== 'unknown' ? MECHANIC_WORDS[c.type] : null,
      pulls: new Set(list.map(x => x.fightId)).size, deaths: list.length,
      players: [...byPlayer.entries()].map(([id, xs]) => ({ ...ref(id), count: xs.length, pullNumbers: [...new Set(xs.map(x => numberOf.get(x.fightId)!))], fightId: xs[xs.length - 1].fightId }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    };
  }).sort((a, b) => b.pulls - a.pulls || b.deaths - a.deaths);

  const wipeMap = new Map<string, NightWipeCause>();
  for (const p of pulls) {
    if (!p.wipe) continue;
    const w = wipeMap.get(p.wipe.killer) ?? { name: p.wipe.killer, icon: p.wipe.icon, spellId: p.wipe.spellId, pulls: 0, pullNumbers: [] };
    w.pulls++;
    w.pullNumbers.push(p.n);
    wipeMap.set(p.wipe.killer, w);
  }
  const wipeCauses = [...wipeMap.values()].sort((a, b) => b.pulls - a.pulls);

  // ── First deaths ──
  const firsts = fights.map(f => ({ f, d: split.get(f.id)!.counted[0] })).filter((x): x is { f: ReportFight; d: RaidDeath } => !!x.d);
  const firstByPlayer = new Map<number, Array<{ f: ReportFight; d: RaidDeath }>>();
  for (const x of firsts) (firstByPlayer.get(x.d.id) ?? firstByPlayer.set(x.d.id, []).get(x.d.id)!).push(x);
  const firstDeaths: NightFirstDeath[] = [...firstByPlayer.entries()].map(([id, xs]) => ({
    ...ref(id), count: xs.length, fightId: xs[xs.length - 1].f.id,
    causes: tally(xs.map(x => x.d.killer)).map(([name, count]) => ({ name, count })),
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // ── Repeat offenders per mechanic ──
  const mechanics: NightMechanic[] = [];
  for (const a of picked?.picked ?? []) {
    const rows = (hits?.rows ?? []).filter(r => r.ability === a.name);
    if (!rows.length) continue;
    const byPlayer = new Map<number, NightHitRow[]>();
    for (const r of rows) (byPlayer.get(r.playerId) ?? byPlayer.set(r.playerId, []).get(r.playerId)!).push(r);
    const sum = (xs: NightHitRow[], k: 'events' | 'ticks' | 'times' | 'damage') => xs.reduce((s, x) => s + x[k], 0);
    const perPlayer = [...byPlayer.entries()].map(([id, xs]) => ({ id, times: sum(xs, 'times'), pulls: xs.length })).sort((x, y) => y.times - x.times);
    const lead = perPlayer[0];
    const assigned = lead && lead.pulls >= 3 && lead.times >= 0.6 * sum(rows, 'times') ? { name: ref(lead.id).name, role: people.get(lead.id)?.role ?? null } : null;
    mechanics.push({
      assigned,
      name: a.name, icon: a.icon, spellId: a.spellIds[0], type: a.type, via: a.via,
      damage: sum(rows, 'damage'), times: sum(rows, 'times'), pulls: new Set(rows.map(r => r.fightId)).size,
      dot: sum(rows, 'ticks') >= 0.7 * sum(rows, 'events'),
      players: [...byPlayer.entries()].map(([id, xs]) => ({ ...ref(id), times: sum(xs, 'times'), events: sum(xs, 'events'), damage: sum(xs, 'damage'), pulls: xs.length, fightId: Math.max(...xs.map(x => x.fightId)) }))
        .sort((x, y) => y.times - x.times || y.damage - x.damage),
    });
  }
  mechanics.sort((a, b) => b.damage - a.damage);
  let mechanicsNote: string | null = null;
  if (opts.hitsFailed) mechanicsNote = 'The hit-by-hit data for this night could not be loaded from Warcraft Logs, so this section is empty. Reload to try again.';
  else if (!picked || base.failed.roster) mechanicsNote = 'The damage tables for this night could not be loaded from Warcraft Logs. Reload to try again.';
  else if (!picked.known) mechanicsNote = 'Nothing is known yet about which of this boss\'s abilities are avoidable (no addon labels and no top-raid logs to compare with), so nobody is listed.';
  else if (!picked.picked.length) mechanicsNote = 'None of the abilities that hit the raid tonight is one the addons or the top raids\' logs mark as avoidable.';
  else if (!mechanics.length) mechanicsNote = 'Nobody was hit by an avoidable ability before a wipe.';

  // ── Per player ──
  const lastFightOf = (id: number) => fights.slice().reverse().find(f => (base.present[f.id] ?? []).includes(id))?.id ?? fights[fights.length - 1].id;
  const players: NightPlayerRow[] = [...people.values()].map(p => {
    const myDeaths = counted.filter(x => x.d.id === p.id);
    const myHits = (hits?.rows ?? []).filter(r => r.playerId === p.id);
    const deaths = myDeaths.length;
    const firstCount = firstByPlayer.get(p.id)?.length ?? 0;
    const times = myHits.reduce((s, r) => s + r.times, 0);
    const present = base.failed.roster ? null : fights.filter(f => (base.present[f.id] ?? []).includes(p.id)).length;
    return {
      id: p.id, name: p.name, className: p.className, role: p.role,
      deaths, firstDeaths: firstCount, hits: times, avoidDamage: myHits.reduce((s, r) => s + r.damage, 0), pulls: present,
      fightId: myDeaths.length ? myDeaths[myDeaths.length - 1].fightId : myHits.length ? Math.max(...myHits.map(r => r.fightId)) : lastFightOf(p.id),
      // A death costs the pull more than a hit does; dying first costs more again.
      score: deaths * 4 + firstCount * 2 + times,
    };
  }).filter(p => p.pulls !== 0).sort((a, b) => b.score - a.score || b.deaths - a.deaths || a.name.localeCompare(b.name));

  // ── Numbers for the top ──
  const kills = pulls.filter(p => p.kill);
  const wipes = pulls.filter(p => !p.kill);
  const combatSec = pulls.reduce((s, p) => s + p.durationSec, 0);
  const wallSec = (fights[fights.length - 1].endTime - fights[0].startTime) / 1000;
  const bestWipe = wipes.slice().sort((a, b) => a.pct - b.pct || b.durationSec - a.durationSec)[0] ?? null;
  const countedTotal = counted.length;
  const diff = DIFFICULTY_LABELS[group.difficulty] ?? '';

  // ── Trend: first half against second half, only when the numbers carry it ──
  const trend: string[] = [];
  const real = pulls.filter(p => p.durationSec >= SHORT_PULL_SEC);
  if (real.length >= 6) {
    const half = Math.floor(real.length / 2);
    const a = real.slice(0, half);
    const b = real.slice(-half);
    const [ma, mb] = [median(a.map(p => p.pct)), median(b.map(p => p.pct))];
    const span = `the first ${half} pulls`;
    if (Math.abs(ma - mb) >= 10) {
      trend.push(mb < ma
        ? `The raid got further as the night went on: a typical pull ended with ${Math.round(ma)}% left in ${span} and ${Math.round(mb)}% in the last ${half}.`
        : `The raid went backwards: a typical pull ended with ${Math.round(ma)}% left in ${span} and ${Math.round(mb)}% in the last ${half}.`);
    }
    if (hits && mechanics.length) {
      const rate = (ps: NightPull[]) => {
        const idSet = new Set(ps.map(p => p.fightId));
        const times = hits.rows.filter(r => idSet.has(r.fightId)).reduce((s, r) => s + r.times, 0);
        const minutes = ps.reduce((s, p) => s + Math.min(p.durationSec, split.get(p.fightId)!.cutoffSec), 0) / 60;
        return { times, perMin: minutes > 0 ? times / minutes : 0 };
      };
      const [ra, rb] = [rate(a), rate(b)];
      const ratio = ra.perMin > 0 && rb.perMin > 0 ? rb.perMin / ra.perMin : null;
      if (ratio != null && ra.times + rb.times >= 20 && Math.max(ra.perMin, rb.perMin) >= 1 && (ratio >= 1.5 || ratio <= 1 / 1.5)) {
        trend.push(`Avoidable hits ${ratio < 1 ? 'came down' : 'went up'}: ${ra.perMin.toFixed(1)} a minute across the raid in ${span}, ${rb.perMin.toFixed(1)} in the last ${half}.`);
      }
    }
    const [da, db] = [a, b].map(ps => { const k = ps.filter(p => p.deathsBefore != null && !p.kill); return k.length >= 3 ? k.reduce((s, p) => s + (p.deathsBefore ?? 0), 0) / k.length : null; });
    if (da != null && db != null && Math.abs(da - db) >= 1 && Math.max(da, db) >= 1.5 * Math.max(0.5, Math.min(da, db))) {
      trend.push(`Deaths before the wipe went ${db < da ? 'down' : 'up'}: ${da.toFixed(1)} a pull in ${span}, ${db.toFixed(1)} in the last ${half}.`);
    }
  }

  // ── The short version ──
  const parts: string[] = [];
  const result = kills.length
    ? `${kills.length === 1 ? 'killed' : `${countWord(kills.length, 'kill')}, the first`} on pull ${kills[0].n}${bestWipe && wipes.length >= 2 ? `; the best wipe reached ${Math.round(bestWipe.pct)}% (pull ${bestWipe.n})` : ''}`
    : `no kill; the best pull reached ${Math.round(bestWipe?.pct ?? 100)}% (pull ${bestWipe?.n ?? 0})`;
  parts.push(`${diff} ${group.name}: ${countWord(pulls.length, 'pull')} and ${fmtSpan(combatSec)} in combat over ${fmtSpan(wallSec)}, ${result}.`);
  const topWipe = wipeCauses.find(w => w.name !== 'unknown damage');
  const topKiller = killers[0];
  const enders: string[] = [];
  if (topWipe && wipes.length) enders.push(`${topWipe.name} wiped the raid on ${topWipe.pulls} of ${plural(wipes.length, 'wipe')}`);
  if (topKiller) enders.push(`${topWipe ? 'before the wipes, ' : ''}${topKiller.name} killed someone on ${topKiller.pulls} of ${plural(pulls.length, 'pull')} (${plural(topKiller.deaths, 'death')})`);
  if (enders.length) parts.push(`What ended pulls: ${enders.join('; ')}.`);
  else if (!base.failed.deaths && countedTotal === 0) parts.push('Nobody died before a wipe was called.');
  const topFirst = firstDeaths[0];
  if (topFirst && topFirst.count >= 2) {
    const tied = firstDeaths.filter(f => f.count === topFirst.count);
    parts.push(tied.length > 2
      ? `No one player kept dying first: ${tied.length} players each did it ${timesWord(topFirst.count)}.`
      : `The most common first death: ${tied.map(t => t.name).join(' and ')}, ${timesWord(topFirst.count)}${tied.length > 1 ? ' each' : ''}${tied.length === 1 ? ` (${topFirst.causes[0].count === topFirst.count ? 'every time' : 'mostly'} to ${topFirst.causes[0].name})` : ''}.`);
  } else if (firsts.length >= 3) {
    parts.push('A different player died first on every pull.');
  }
  if (trend[0]) parts.push(trend[0]);

  const notes: string[] = [];
  if (base.failed.deaths) notes.push('Some of the death tables could not be loaded from Warcraft Logs, so death counts are missing for those pulls. Reload to try again.');
  if (hits?.truncated) notes.push('This night has more avoidable-damage events than one page load reads; hit counts cover the earlier pulls only.');
  if (picked?.more) notes.push(`Only the ${NIGHT_MAX_ABILITIES} avoidable abilities that did the most damage are listed; ${picked.more} more ${picked.more === 1 ? 'is' : 'are'} left out.`);

  const stats = [
    { label: 'Pulls', value: String(pulls.length), note: kills.length ? plural(kills.length, 'kill') : 'no kill' },
    { label: 'Best pull', value: kills.length ? 'Kill' : `${Math.round(bestWipe?.pct ?? 100)}%`, note: kills.length ? `pull ${kills[0].n}` : bestWipe ? `pull ${bestWipe.n} · ${fmtClock(bestWipe.durationSec)}` : undefined },
    { label: 'In combat', value: fmtSpan(combatSec), note: `of ${fmtSpan(wallSec)}` },
    { label: 'Deaths', value: base.failed.deaths && !countedTotal ? '—' : String(countedTotal), note: 'before the wipes' },
    { label: 'Avoidable', value: hits && mechanics.length ? String(mechanics.reduce((s, m) => s + m.times, 0)) : '—', note: mechanics.length ? `hits · ${fmtNum(mechanics.reduce((s, m) => s + m.damage, 0))}` : 'hits' },
  ];

  return {
    code, encounterID: group.encounterID, difficulty: group.difficulty, bossName: group.name,
    summary: parts.join(' '), stats, pulls, totalPulls: group.all.length, capped: group.all.length > fights.length,
    wipeCauses, killers, countedDeaths: countedTotal, firstDeaths, pullsWithFirstDeath: firsts.length,
    mechanics, mechanicsNote, players, trend, notes,
    requests: base.requests + (hits?.requests ?? 0),
  };
}

// ─── One call for the page ────────────────────────────────────────────────────

// The page supplies the two loaders it already has (boss knowledge, top-raid stats) so
// this module stays free of the page's caching arrangements. Either may fail quietly.
export async function loadNightReview(token: string, code: string, group: NightGroup, deps: {
  bossKnowledge: (fight: ReportFight) => Promise<BossKnowledge | null>;
  raidStats: (fight: ReportFight, players: FightPlayer[]) => Promise<RaidMechanicStats | null>;
}): Promise<NightReview> {
  // The finished review is kept six hours when every part of it loaded, so a second
  // visit skips the classification inputs as well (they are the slow part when warm).
  return cacheUnlessPartial<NightReview>(`analyze-night-review-v3-${cacheKey(code, group.fights)}`, 6 * 3600, async () => {
    const r = await computeNightReview(token, code, group, deps);
    return { value: r.review, partial: r.partial };
  });
}

async function computeNightReview(token: string, code: string, group: NightGroup, deps: {
  bossKnowledge: (fight: ReportFight) => Promise<BossKnowledge | null>;
  raidStats: (fight: ReportFight, players: FightPlayer[]) => Promise<RaidMechanicStats | null>;
}): Promise<{ review: NightReview; partial: boolean }> {
  const fights = group.fights;
  const last = fights[fights.length - 1];
  const base = await getNightBase(token, code, fights);
  const quiet = async <T,>(p: Promise<T | null>): Promise<T | null> => {
    try { return await p; } catch (err) { if (isRateLimitError(err)) throw err; console.error('night: classification input unavailable', err); return null; }
  };
  // Top-raid stats are kept per boss and difficulty (getRaidMechanicStats' own key). When
  // they are already there, read them directly: the page's loader goes through a spec
  // pool first, and a raid whose commonest spec has no pool yet would wait a minute and
  // a half for numbers that do not depend on the spec at all.
  const kept = await getPersistentReadOnly<RaidMechanicStats>(`analyze-raidmech-v1-${group.encounterID}-${Math.max(4, group.difficulty)}`).catch(() => null);
  const [boss, raidStats] = await Promise.all([
    quiet(deps.bossKnowledge(last)),
    kept && kept.n > 0 ? Promise.resolve(kept) : base.fightPlayers.length ? quiet(deps.raidStats(last, base.fightPlayers)) : Promise.resolve(null),
  ]);
  const picked = base.failed.roster ? null : pickAvoidable(base.abilities, boss, raidStats);
  let hits: NightHits | null = null;
  let hitsFailed = false;
  if (picked?.picked.length) {
    const cutoffs = Object.fromEntries(fights.map(f => [f.id, splitPullDeaths(f, base.deaths[f.id] ?? null).cutoffSec]));
    try {
      hits = await getNightHits(token, code, fights, picked.picked, cutoffs, base.roster.map(p => p.id));
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      console.error('night: hits unavailable', err);
      hitsFailed = true;
    }
  }
  const review = buildNightReview({ code, group, base, hits, picked, boss, raidStats, hitsFailed });
  return { review, partial: base.failed.deaths || base.failed.roster || hitsFailed || !boss || !raidStats };
}
