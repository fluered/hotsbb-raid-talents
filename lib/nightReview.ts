import { unstable_cache } from 'next/cache';
import { wclQuery, isRateLimitError, mapConcurrent } from './wow';
import { defensiveKey, defensivesAt, isDefensive, noChargeModel } from './defensives';
import { getSpellInfo, isHealingPotionSpell, saysDodge, wardFor } from './bossMechanics';
import { filterAbilityIds, getWipefestFightConfig, requireIds, wipefestCredit, type WipefestFightConfig, type WipefestInsightConfig } from './wipefestConfig';
import { evaluateInsights, fetchNightEvents, insightSentence } from './wipefestInsights';
import { MAJOR_CD_SEC } from './lorrgsSpells';
import {
  buildProfile, DIFFICULTY_LABELS, isPlayerSourcedDamage, mapPlayerDetails,
  type FightPlayer, type RaidDeath, type RaidMechanicStats, type ReportFight, type ReportOverview, type Role, type WclEventsPage, type WclReportData, type WclTable,
} from './analyze';
import { classifyAbility, fmtClock, fmtNum, median, plural, type ClassifiedVia } from './analyzeRules';
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
//   2+ mechanics: Wipefest's definitions for the boss over all pulls at once (one
//      metadata request, then one paged request carrying a damage, an aura and a cast query)
//   0+ hits: damage events for avoidable abilities no definition covers, one paged query
//   2+ defensives: the casts table, then one paged query for who pressed what and when
// so a 15-pull Mythic night is 1 + 2 + 2 + 0 + 2 = 7 requests when nothing needs a second page.
// "Before the next pull" (the instructions at the top) is derived from all of the above
// and asks for nothing more: the definitions tied to a wipe ride in the mechanics request.
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
// A mechanic that hits more than half of the players present each time it happens is
// not an individual's mistake: being hit is the normal case. A soak the whole raid
// takes, or a zone nobody manages to leave, belongs to the raid, not to a list of names.
const RAID_WIDE_SHARE = 0.5;
const SHORT_PULL_SEC = 30;
const AVOIDABLE_TYPES: MechanicType[] = ['avoid', 'spread', 'fixate'];

// ── "Before the next pull" ──
// At most three instructions: a raid leader reads them out between pulls.
const NEXT_STEPS = 3;
// One wipe to an ability can be anything; two is the fewest that is "keeps ending pulls".
const WIPE_STEP_MIN_PULLS = 2;
// A definition explains a wipe only when its failure count is at least twice as high on
// the pulls that ability ended as on the pulls that got past it, and it was there on
// three in four of them; anything closer is noise over a handful of pulls.
const PRECURSOR_RATIO = 2;
const PRECURSOR_PRESENT_SHARE = 0.75;
// A defensive call needs three deaths with a major defensive unused, over two pulls or
// more, and they must be at least half the deaths to that ability: fewer is one bad pull.
const DEFENSIVE_STEP_MIN_DEATHS = 3;
const DEFENSIVE_STEP_MIN_PULLS = 2;
// A repeat offender was caught on three pulls or more and on a third of the pulls they
// were in: "several pulls, not one bad pull", and not just someone who was there all night.
const OFFENDER_MIN_PULLS = 3;
const OFFENDER_MIN_SHARE = 1 / 3;
// Consumables are worth a slot only when half the raid never used one all night and at
// least three deaths came with nothing used: below that it is a habit of a few players.
const CONSUMABLE_NEVER_SHARE = 0.5;
const CONSUMABLE_MIN_DEATHS = 3;
// In the ranking a pull that an ability ended, or on which it killed someone, counts as
// one pull; a pull on which it only hit people (or a death only lacked a healthstone)
// counts a quarter: the four-to-one the player table gives a death against a hit.
const HIT_PULL_WEIGHT = 0.25;
// Deaths or wipes within fifteen seconds of each other across pulls are "the same
// moment": boss timers drift by a few seconds from pull to pull, not by more.
const MOMENT_WINDOW_SEC = 15;
// A mechanic's first half against its second half is stated on the evidence the night's
// trend sentences ask for: three pulls a side, twenty events, half again apart.
const PROGRESS_MIN_PULLS = 6;
const PROGRESS_MIN_TIMES = 20;
const PROGRESS_RATIO = 1.5;

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
  // Deaths that were an instant kill (the death's last event is an "instakill", not
  // damage), per pull as [player id, seconds into the pull]: no defensive, healthstone or
  // healing cooldown stops one, so nothing is said about what was ready at them.
  instant: Record<number, Array<[number, number]>>;
  failed: { deaths: boolean; roster: boolean };
  requests: number;
}

interface WclDeathRow { fight?: number; id?: number; timestamp?: number; events?: Array<{ type?: string } | null> | null }
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
  return cacheUnlessPartial<NightBase>(`analyze-night-base-v2-${cacheKey(code, fights)}`, 86400, async () => {
    const ids = fights.map(f => f.id);
    const count = { n: 0 };
    const base: NightBase = { deaths: {}, roster: [], fightPlayers: [], present: {}, abilities: [], instant: {}, failed: { deaths: false, roster: false }, requests: 0 };

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
        for (const f of chunk) {
          base.deaths[f.id] = buildProfile({ deaths: { data: { entries: rows.get(f.id) ?? [] } } }, f, -1).raidDeaths;
          // Keyed the way RaidDeath is (player id, whole seconds from the pull); the row's events run newest first.
          base.instant[f.id] = (rows.get(f.id) ?? []).filter(r => r.id != null && r.events?.[0]?.type === 'instakill')
            .map((r): [number, number] => [r.id!, Math.max(0, Math.round(((r.timestamp ?? f.startTime) - f.startTime) / 1000))]);
        }
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

export interface PickedAbility extends NightAbility { type: MechanicType; via: ClassifiedVia }

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

// ─── Wipefest's mechanic definitions across the night ──────────────────────────
//
// The single-pull view reads Wipefest's per-boss definitions; the night reads the same
// ones for every pull in one go (fetchNightEvents). Which of them name an individual's
// mistake is Wipefest's own call, not ours: each definition carries the weight
// wipefest.gg scores a player with, and a negative weight on a rule that lists players
// (hit by, gained the debuff, reached the stacks) means "this counts against whoever it
// happened to". Soaks, interrupts and dispels carry a positive weight and are left out;
// so are rules with no weight (raid-level facts such as how long an add lived).
const AGAINST_PLAYER_TYPES = new Set(['hit', 'hitHard', 'hitUnlessRole', 'hitWithoutDebuff', 'hitWithDebuff', 'debuff', 'debuffUnlessRole', 'stackThreshold']);

export function pickDefined(config: WipefestFightConfig, difficulty: number): WipefestInsightConfig[] {
  const events = new Map(config.eventConfigs.filter(c => String(c.group) !== 'raid').map(c => [c.id, c]));
  const idsOf = (c: WipefestInsightConfig) => requireIds(c.require).flatMap(id => filterAbilityIds(events.get(id)?.filter ?? {}));
  // A rule whose one occurrence needs several events together ("splashed to two or more")
  // lists everyone its damage touched, not who caused it: no names can be read from it.
  const grouped = (c: WipefestInsightConfig) => requireIds(c.require).some(id => { const f = events.get(id)?.filter; return ((f?.minimum ?? f?.rangePer?.minimum ?? 0) > 1); });
  const all = config.insightConfigs.filter(c => String(c.group) !== 'raid' && AGAINST_PLAYER_TYPES.has(c.type)
    && (c.playerValue?.weight ?? 0) < 0 && !c.playerValue?.isBonus && !grouped(c)
    && (!c.difficulties?.length || c.difficulties.includes(difficulty)));
  // "Damage from X" and "Debuffs of X" on the same spell are one mistake seen twice: the
  // damage rule stays (it carries the damage figure).
  const hitIds = new Set(all.filter(c => /^hit/.test(c.type)).flatMap(idsOf));
  return all.filter(c => /^hit/.test(c.type) || !idsOf(c).length || !idsOf(c).every(id => hitIds.has(id)));
}

export interface NightDefinedMechanic {
  // The key its rows carry in `ability` ("wf:" + the definition's id).
  key: string;
  name: string;
  // Wipefest's sentence with {totalHits}, {plural} and {totalDamage} left to fill; null when it has none that totals.
  sentence: string | null;
  spellId: number;
  icon: string;
  // The night's count as the sentence counts it (hits, ticks or applications), and per pull.
  events: number;
  eventsByFight: Record<number, number>;
}
// A definition tied to an ability that wiped the raid, counted per pull up to the wipe
// (and the few seconds in which the wipe forms): what the log says came before it.
export interface NightPrecursor {
  key: string;
  // The wipe ability's name as the death tables give it.
  wipe: string;
  name: string;
  // The definition's sentence without its count ("failed to interrupt X before …"); null when it has none.
  sentence: string | null;
  // Per fight id: the count up to the moment the pull was lost, and the count including
  // the seconds in which the wipe formed (what to read on the pulls this ability ended).
  byFight: Record<number, [number, number]>;
}

// Definitions that count a raid-level failure (a cast that was let through, a hit that
// only lands when something else was missed) and name an ability the raid wiped to. The
// link is the definition's own: one of the events it requires carries the wipe ability's
// name or spell id. Rules that already count against players are the repeat-offender
// list's, and anything where more is better (soaks, interrupts) is not a failure count.
const PRECURSOR_TYPES = new Set(['cast', 'hit', 'hitHard', 'hitUnlessRole', 'hitWithoutDebuff', 'hitWithDebuff', 'debuff', 'debuffUnlessRole', 'stackThreshold']);
export function pickPrecursors(config: WipefestFightConfig, difficulty: number, wipes: Array<{ killer: string; spellId: number }>, chosen: WipefestInsightConfig[]): Array<{ cfg: WipefestInsightConfig; wipe: string }> {
  if (!wipes.length) return [];
  const events = new Map(config.eventConfigs.filter(c => String(c.group) !== 'raid').map(c => [c.id, c]));
  const taken = new Set(chosen.map(c => c.id));
  const out: Array<{ cfg: WipefestInsightConfig; wipe: string }> = [];
  for (const c of config.insightConfigs) {
    if (String(c.group) === 'raid' || taken.has(c.id) || !PRECURSOR_TYPES.has(c.type)) continue;
    if (c.difficulties?.length && !c.difficulties.includes(difficulty)) continue;
    if ((c.playerValue?.weight ?? 0) > 0 || c.playerValue?.isBonus || (c.statistics ?? []).find(x => x.name === c.mainStatistic)?.higherIsBetter) continue;
    const req = requireIds(c.require).map(id => events.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
    const wipe = wipes.find(w => req.some(e => e.name.toLowerCase() === w.killer.toLowerCase() || (w.spellId > 0 && filterAbilityIds(e.filter).includes(w.spellId))));
    // The definition has to say what the failure is in a sentence that can be counted
    // ("failed to … N times"); one that only reports an average has nothing to compare.
    if (wipe && insightSentence(config, c, '')) out.push({ cfg: c, wipe: wipe.killer });
  }
  return out;
}

export interface NightDefined {
  mechanics: NightDefinedMechanic[];
  rows: NightHitRow[];
  precursors: NightPrecursor[];
  // Warcraft Logs' phase transitions per pull as [phase id, seconds into the pull], in
  // order, and its names for the phases; empty for a boss with a single phase.
  phases: Record<number, Array<[number, number]>>;
  phaseNames: Record<number, string>;
  // Spell ids and lower-case names any definition of this boss covers: the type-guessed list leaves those alone.
  coveredIds: number[];
  coveredNames: string[];
  fetchedAt: number;
  truncated: boolean;
  requests: number;
}

export function getNightDefined(token: string, code: string, fights: ReportFight[], config: WipefestFightConfig, base: NightBase, cutoffs: Record<number, number>): Promise<NightDefined> {
  const difficulty = fights[0]?.difficulty ?? 0;
  const chosen = pickDefined(config, difficulty);
  const own = config.eventConfigs.filter(c => String(c.group) !== 'raid');
  const used = new Set(config.insightConfigs.filter(c => String(c.group) !== 'raid').flatMap(c => requireIds(c.require)));
  const covered = own.filter(c => used.has(c.id));
  const empty: NightDefined = {
    mechanics: [], rows: [], precursors: [], phases: {}, phaseNames: {}, fetchedAt: config.fetchedAt, truncated: false, requests: 0,
    coveredIds: [...new Set(covered.flatMap(c => filterAbilityIds(c.filter)))], coveredNames: [...new Set(covered.map(c => c.name.toLowerCase()))],
  };
  // The abilities that wiped the raid often enough to get an instruction, and the definitions tied to them.
  const wipeTally = new Map<string, { killer: string; spellId: number; n: number }>();
  for (const f of fights) {
    const w = splitPullDeaths(f, base.deaths[f.id] ?? null).wipe;
    if (!w) continue;
    const cur = wipeTally.get(w.killer) ?? { killer: w.killer, spellId: w.spellId, n: 0 };
    cur.n++;
    wipeTally.set(w.killer, cur);
  }
  const linked = pickPrecursors(config, difficulty, [...wipeTally.values()].filter(w => w.n >= WIPE_STEP_MIN_PULLS), chosen);
  if ((!chosen.length && !linked.length) || !fights.length || base.failed.roster) return Promise.resolve(empty);
  return unstable_cache(
    async () => {
      const byId = new Map(base.fightPlayers.map(p => [p.id, p]));
      const playersOf = (fightId: number) => (base.present[fightId] ?? []).map(id => byId.get(id)).filter((p): p is FightPlayer => !!p);
      const lateIds = new Set(linked.flatMap(l => [...requireIds(l.cfg.require), ...requireIds(l.cfg.showIf)]));
      const only = new Set([...chosen.flatMap(c => [...requireIds(c.require), ...requireIds(c.showIf)]), ...lateIds]);
      // The cut-off sits half a second before the wipe; the wipe group forms inside its window.
      const ev = await fetchNightEvents(token, code, fights, playersOf, config, { only, untilSec: cutoffs, late: { ids: lateIds, sec: WIPE_GROUP_WINDOW_SEC + 0.5 } });
      const precursors: NightPrecursor[] = linked.map(l => {
        const sentence = insightSentence(config, l.cfg, fights[0].name)?.replace(/\s*\{totalHits\} (time|tick)\{plural\}/g, '') ?? null;
        return { key: `wf:${l.cfg.id}`, wipe: l.wipe, name: l.cfg.name, sentence: sentence && !/[{}]/.test(sentence) ? sentence : null, byFight: {} };
      });
      const phases: NightDefined['phases'] = {};
      let phaseNames: Record<number, string> = {};
      for (const fight of fights) {
        const fe = ev.byFight[fight.id];
        if (fe) {
          phases[fight.id] = fe.phases.slice().sort((a, b) => a.startTime - b.startTime).map((ph): [number, number] => [ph.id, Math.max(0, Math.round((ph.startTime - fe.startTime) / 100) / 10)]);
          phaseNames = fe.phaseNames;
        }
        const late = ev.lateByFight?.[fight.id];
        if (!fe || !late || !linked.length) continue;
        const only: WipefestFightConfig = { ...config, insightConfigs: linked.map(l => l.cfg) };
        const [before, through] = [evaluateInsights(fight, fe, playersOf(fight.id), only), evaluateInsights(fight, late, playersOf(fight.id), only)];
        const countIn = (found: typeof before, key: string) => found.find(i => `wf:${i.configId}` === key)?.totalEvents ?? 0;
        for (const pre of precursors) pre.byFight[fight.id] = [countIn(before, pre.key), countIn(through, pre.key)];
      }
      const sub: WipefestFightConfig = { ...config, insightConfigs: chosen };
      const mechanics = new Map<string, NightDefinedMechanic>();
      const rows: NightHitRow[] = [];
      for (const fight of fights) {
        const fe = ev.byFight[fight.id];
        if (!fe) continue;
        for (const ins of evaluateInsights(fight, fe, playersOf(fight.id), sub)) {
          if (!ins.totalEvents && !ins.rows.length) continue;
          const key = `wf:${ins.configId}`;
          const cfg = chosen.find(c => c.id === ins.configId);
          const m = mechanics.get(key) ?? {
            key, name: ins.name.replace(/^(Damage|Debuffs|Buffs) (from|of) /i, ''), sentence: cfg ? insightSentence(config, cfg, fight.name) : null,
            spellId: ins.spellId ?? 0, icon: ins.icon ?? '', events: 0, eventsByFight: {},
          };
          m.events += ins.totalEvents;
          m.eventsByFight[fight.id] = ins.totalEvents;
          if (!m.icon && ins.icon) m.icon = ins.icon;
          mechanics.set(key, m);
          // Separate times per player: the rule's own event list (ticks of a damage-over-time
          // effect already left out), with the night's two-second rule on top.
          const times = new Map<number, { n: number; last: number }>();
          for (const e of ins.events.slice().sort((a, b) => a.atSec - b.atSec)) {
            if (e.pid == null) continue;
            const t = times.get(e.pid) ?? { n: 0, last: -Infinity };
            if ((e.atSec - t.last) * 1000 > INCIDENT_GAP_MS) t.n++;
            t.last = e.atSec;
            times.set(e.pid, t);
          }
          // A pure damage-over-time rule lists no events (every one is a tick): its separate
          // times are runs of ticks, read from the damage events behind the rule.
          const dot = (ins.tickShare ?? 0) >= 0.7;
          const raw = dot && cfg ? requireIds(cfg.require).flatMap(id => fe.byConfig[`${id}#raw`] ?? fe.byConfig[id] ?? []).filter(e => e.type === 'damage').sort((a, b) => a.timestamp - b.timestamp) : [];
          const runs = (pid: number) => {
            let n = 0, last = -Infinity;
            for (const e of raw) { if (e.targetID !== pid) continue; if (e.timestamp - last > INCIDENT_GAP_MS) n++; last = e.timestamp; }
            return n;
          };
          for (const r of ins.rows) {
            if (r.id == null) continue;
            const events = Math.max(1, r.count);
            rows.push({ ability: key, playerId: r.id, fightId: fight.id, events, ticks: dot ? events : 0, times: times.get(r.id)?.n || runs(r.id) || 1, damage: /^hit/.test(ins.type) ? r.raw : 0 });
          }
        }
      }
      return { ...empty, mechanics: [...mechanics.values()], rows, precursors, phases, phaseNames, truncated: ev.truncated, requests: ev.requests };
    },
    [`analyze-night-wf-v6-${cacheKey(code, fights)}-${chosen.map(c => c.id).join('.')}-p${linked.map(l => l.cfg.id).join('.')}-${Math.round(fights.reduce((s, f) => s + Math.min(cutoffs[f.id] ?? 0, 1e6), 0))}`],
    { revalidate: 86400 }
  )();
}

// ─── Defensives pressed across the night ───────────────────────────────────────
//
// For "died with a defensive ready": every personal-defensive cast by anyone on any
// pull, in two requests however long the night is (the friendly casts table names the
// spells, one filtered events query gives who pressed what and when), plus each
// spell's cooldown and charges from Wowhead (cached a week per spell).
export interface NightDefensives {
  spells: Record<string, { spellId: number; icon: string; cooldownSec: number | null; charges: number }>;
  // [fight id, player id, defensive name, seconds from that pull's start]
  casts: Array<[number, number, string, number]>;
  truncated: boolean;
  requests: number;
}

interface WclCastEvent { timestamp: number; sourceID?: number; abilityGameID?: number; fight?: number; type?: string }

export function getNightDefensives(token: string, code: string, fights: ReportFight[]): Promise<NightDefensives> {
  return unstable_cache(
    async () => {
      const out: NightDefensives = { spells: {}, casts: [], truncated: false, requests: 1 };
      const fids = fights.map(f => f.id).join(',');
      const t = await wclQuery<WclReportData<{ casts?: WclTable<{ guid?: number; name?: string; abilityIcon?: string } | null> | null }>>(token, `{ reportData { report(code: "${code}") {
        casts: table(dataType: Casts, fightIDs: [${fids}], viewBy: Ability)
      } } }`, 'night-defensive-spells', null);
      const entries = (t?.reportData?.report?.casts?.data?.entries ?? []).filter((e): e is { guid: number; name: string; abilityIcon?: string } => !!e?.guid && !!e.name);
      // Healing potions are renamed every season, so the name test alone would miss a new
      // one: anything that looks like a consumable is checked against Wowhead's text for
      // "restores health" (the same test the single-pull views register potions with).
      const healing = new Set<number>();
      await mapConcurrent(entries.filter(e => !isDefensive(e.name) && /potion|alchemy|flask|drink|draught|elixir|health/i.test(`${e.abilityIcon ?? ''} ${e.name}`)), 8, async e => {
        if (isHealingPotionSpell(await getSpellInfo(e.guid).catch(() => null))) healing.add(e.guid);
      });
      const nameOf = new Map<number, string>();
      const idsOf = new Map<string, number[]>();
      for (const e of entries) {
        const name = healing.has(e.guid) ? 'Healing potion' : isDefensive(e.name) ? defensiveKey(e.name) : null;
        if (!name) continue;
        nameOf.set(e.guid, name);
        (idsOf.get(name) ?? idsOf.set(name, []).get(name)!).push(e.guid);
        out.spells[name] ??= { spellId: e.guid, icon: e.abilityIcon ?? '', cooldownSec: null, charges: 1 };
      }
      if (!nameOf.size) return out;
      const fightById = new Map(fights.map(f => [f.id, f]));
      const end = Math.max(...fights.map(f => f.endTime));
      let from: number | null = null;
      for (let page = 0; page < EVENT_PAGES; page++) {
        out.requests++;
        const range: string = from == null ? '' : `startTime: ${from}, endTime: ${end}, `;
        const d: WclReportData<{ ev?: WclEventsPage<WclCastEvent | null> | null }> | null | undefined = await wclQuery(token, `{ reportData { report(code: "${code}") {
          ev: events(fightIDs: [${fids}], ${range}dataType: Casts, filterExpression: "type = 'cast' and ability.id in (${[...nameOf.keys()].join(',')})", limit: 10000) { data nextPageTimestamp }
        } } }`, 'night-defensive-casts', null);
        const ev = d?.reportData?.report?.ev;
        for (const e of ev?.data ?? []) {
          const f = e && e.fight != null ? fightById.get(e.fight) : undefined;
          const name = e ? nameOf.get(Number(e.abilityGameID)) : undefined;
          if (!e || !f || !name || e.sourceID == null || e.type !== 'cast') continue;
          out.casts.push([f.id, e.sourceID, name, Math.round((e.timestamp - f.startTime) / 100) / 10]);
        }
        from = ev?.nextPageTimestamp ?? null;
        if (from == null) break;
        if (page === EVENT_PAGES - 1) out.truncated = true;
      }
      // One button can log under two spell ids (Alter Time and its return, which has no
      // cooldown of its own): the longest cooldown stated for any of them is the button's.
      await mapConcurrent(Object.entries(out.spells), 8, async ([name, s]) => {
        for (const id of idsOf.get(name) ?? [s.spellId]) {
          const info = await getSpellInfo(id).catch(() => null);
          if (!info) continue;
          const cd = info.cooldownSec ?? 0;
          if (s.cooldownSec == null || cd > s.cooldownSec) { s.cooldownSec = cd; s.charges = info.charges && info.charges > 1 ? info.charges : 1; }
        }
      });
      return out;
    },
    [`analyze-night-def-v4-${cacheKey(code, fights)}`],
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
  // The ability can be sidestepped: it is typed as avoidable, or nothing types it and a
  // mechanic definition counts being hit by it against the player.
  avoidable: boolean;
  pulls: number;
  deaths: number;
  players: Array<NightPlayerRef & { count: number; pullNumbers: number[]; fightId: number }>;
}

export interface NightWipeCause { name: string; icon: string; spellId: number; pulls: number; pullNumbers: number[] }

export interface NightFirstDeath extends NightPlayerRef { count: number; causes: Array<{ name: string; count: number }>; fightId: number }

export interface NightMechanic {
  key: string;
  name: string;
  // The card's sentence: Wipefest's own, filled with the night's totals, or ours.
  title: string;
  icon: string;
  spellId: number;
  // null for a Wipefest definition (its sentence says what the mechanic is).
  type: MechanicType | null;
  via: ClassifiedVia | 'wipefest';
  damage: number;
  times: number;
  pulls: number;
  // Mostly ticks: the count is of separate exposures, the damage is the whole burn.
  dot: boolean;
  // Of the players present each time it happened, the share it hit; over half is the
  // whole raid's problem (or part of the fight), listed apart and counted against nobody.
  share: number;
  raidWide: boolean;
  // Wipefest's own count per fight id, for ?debug=1.
  eventsByFight?: Record<number, number>;
  // One player takes most of it, pull after pull (or the tanks take nearly all of it
  // between them): more likely their job than their mistake. `ids` are the players it is
  // assigned to; their hits from it are left out of their own counts.
  assigned: { name: string; role: Role | null; tanks: boolean; ids: number[] } | null;
  players: Array<NightPlayerRef & { times: number; events: number; damage: number; pulls: number; fightId: number }>;
  progress: NightProgress;
}

// One mechanic pull by pull. A pull "could have had it" when it lasted at least as long
// as the shortest pull the mechanic was seen on, so a late-fight ability is not read as
// "getting worse" just because the raid started reaching it.
export interface NightProgress {
  // Separate times per pull of the night, in order; null for a pull that ended before it could happen.
  perPull: Array<number | null>;
  // First half against second half of the pulls it could happen on; null when there are
  // too few pulls or events, or the halves are less than half again apart.
  halves: { pulls: number; first: number; second: number; better: boolean } | null;
}

// One instruction of "Before the next pull".
export interface NightStep {
  kind: 'wipe' | 'defensive' | 'offenders' | 'consumables';
  // The ability it is about (two instructions on one ability are merged).
  subject: string;
  icon: string;
  spellId: number;
  // The instruction as it is read out, and the count or time behind it.
  text: string;
  evidence: string;
  // "ended 5 of 14 pulls": what the ranking counted.
  scope: string;
  weight: number;
}
export interface NightNextPull {
  steps: NightStep[];
  // Every candidate with its weight, ranked, for ?debug=1.
  ranked: string[];
  // One line on what clearly improved across the night; null when nothing did.
  working: string | null;
}

// MAJOR AND MINOR DEFENSIVES. A defensive is major when Wowhead states a cooldown of a
// minute or more for it, minor below that. The reason is what "ready" can mean: a
// button that comes back in 15 to 45 seconds (Feint, Fade, Crimson Vial, Ice Barrier,
// Spell Reflection, Frenzied Regeneration) is ready most of the time for everyone, so
// finding it ready at a death says nothing; one that takes a minute or longer is a
// decision about when to spend it, and dying with it unspent is worth asking about. A
// minute is also the line the rest of the review draws for a "major cooldown"
// (MAJOR_CD_SEC). lorrgs' DEFENSIVE tag was tried as a second opinion and does not
// separate the two: it tags Feint and Fade as well as Divine Shield. A defensive with
// no cooldown stated is minor (nothing can be claimed about it).
export const isMajorDefensive = (cooldownSec: number | null | undefined) => (cooldownSec ?? 0) >= MAJOR_CD_SEC;

export interface NightReadyDefensive { name: string; icon: string; spellId: number; count: number }

// Deaths that came with a personal defensive off cooldown and not running.
export interface NightReadyDeaths {
  // Deaths by players who pressed at least one major defensive during the night (nothing
  // is known about the others), and how many of those had a major one ready.
  judged: number;
  withMajor: number;
  // Of the deaths with a major one ready, how many came with no defensive at all pressed
  // in the ten seconds before (the rest had pressed a different one).
  nothingPressed: number;
  // Deaths (by anyone who pressed any defensive tonight) with only a minor one ready.
  minorOnly: number;
  // Deaths before the wipes that were an instant kill: left out of everything above.
  instant: number;
  players: Array<NightPlayerRef & {
    // Deaths before the wipes by this player, and at how many a major defensive was ready.
    deaths: number;
    withMajor: number;
    nothingPressed: number;
    minorOnly: number;
    // What sat unused, and at how many of this player's deaths.
    major: NightReadyDefensive[];
    minor: NightReadyDefensive[];
    // Pulls with a death that had a major defensive ready.
    pullNumbers: number[];
    fightId: number;
  }>;
}

// Healthstones and healing potions: who used them, on how many pulls. Facts only; the
// log does not say how many of either a player carried into a pull.
export interface NightHealing {
  pulls: number;
  // Pulls with a Warlock in the raid (no Warlock, no healthstones).
  warlockPulls: number;
  warlocks: string[];
  healthstone: { pulls: number; players: number; uses: number };
  potion: { pulls: number; players: number; uses: number };
  players: Array<NightPlayerRef & {
    pulls: number;
    healthstonePulls: number;
    potionPulls: number;
    // Deaths before the wipes, and how many came with neither used earlier in that pull.
    deaths: number;
    deathsUnused: number;
  }>;
}

// Per pull and player, for the one-player view (lib/playerNight.ts).
export interface NightDetail {
  present: Record<number, number[]>;
  deaths: Array<{
    fightId: number; playerId: number; atSec: number; killer: string;
    // Before the wipe (see THE RULES), and the first such death of its pull.
    counted: boolean; first: boolean;
    // An instant kill: nothing a player presses stops it.
    instant: boolean;
    // Whether anything is known about this player's defensives, and what was ready.
    judged: boolean; major: string[]; minor: string[];
    // Healthstone / healing potion used earlier in the pull.
    healthstone: boolean; potion: boolean;
  }>;
  // Avoidable hits: [mechanic key, player id, fight id, separate times, damage].
  hits: Array<[string, number, number, number, number]>;
  // [fight id, player id, healthstone uses, healing potion uses]; empty when the cast data is missing.
  heals: Array<[number, number, number, number]>;
  healsKnown: boolean;
}

export interface NightPlayerRow extends NightPlayerRef {
  role: Role | null;
  deaths: number;
  // Of those deaths, how many had a major defensive ready; null when nothing is known.
  readyDeaths: number | null;
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
  nextPull: NightNextPull;
  // When each ability that killed someone before the wipes lands ("around 4:55 and
  // 5:30"), by ability name; only abilities whose deaths repeat at the same moment.
  when: Record<string, string>;
  stats: Array<{ label: string; value: string; note?: string }>;
  pulls: NightPull[];
  totalPulls: number;
  capped: boolean;
  wipeCauses: NightWipeCause[];
  killers: NightKiller[];
  // null when the cast data could not be loaded.
  readyDeaths: NightReadyDeaths | null;
  // null when the cast data could not be loaded.
  healing: NightHealing | null;
  countedDeaths: number;
  firstDeaths: NightFirstDeath[];
  pullsWithFirstDeath: number;
  mechanics: NightMechanic[];
  mechanicsNote: string | null;
  // "mechanic definitions from Wipefest (as of …)" when they were used.
  mechanicsCredit: string | null;
  players: NightPlayerRow[];
  detail: NightDetail;
  trend: string[];
  notes: string[];
  requests: number;
  // Requests and seconds per part of the load, for ?debug=1 (zeros when a part came from cache).
  load?: Record<string, string>;
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

const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const rate = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

// When something lands, from the moments it was seen across the night: "around 4:55 and
// 5:30", or on a boss with phases "around 0:40 into Stage Two". A moment is a time seen
// on two pulls or more inside MOMENT_WINDOW_SEC (measured from the phase's start where
// the log has phases, since that is what a boss's timers run from). `repeats` is false
// when no time came twice: the words then only list or span what was seen.
export function whenWords(points: Array<{ fightId: number; atSec: number }>, phases: Record<number, Array<[number, number]>>, phaseNames: Record<number, string>): { words: string; repeats: boolean } | null {
  if (!points.length) return null;
  const phased = Object.values(phases).some(list => list.length > 1);
  // A phase that comes round again (stage one after an intermission) is its own stretch:
  // the key is the phase id and which time round it is.
  const placed = points.map(p => {
    let at: [number, number] | null = null;
    let round = 1;
    const seen = new Map<number, number>();
    if (phased) for (const ph of phases[p.fightId] ?? []) {
      if (ph[1] > p.atSec + 0.5) break;
      seen.set(ph[0], (seen.get(ph[0]) ?? 0) + 1);
      at = ph;
      round = seen.get(ph[0])!;
    }
    // Before the first transition is the first phase, which starts with the pull.
    return { ...p, phase: phased ? `${at ? at[0] : 1}#${round}` : '', rel: at ? p.atSec - at[1] : p.atSec };
  });
  const clusters: Array<{ phase: string; rel: number; abs: number; n: number; pulls: number }> = [];
  for (const phase of new Set(placed.map(p => p.phase))) {
    const inPhase = placed.filter(p => p.phase === phase).sort((a, b) => a.rel - b.rel);
    let run: typeof inPhase = [];
    const close = () => { if (run.length) clusters.push({ phase, rel: median(run.map(p => p.rel)), abs: median(run.map(p => p.atSec)), n: run.length, pulls: new Set(run.map(p => p.fightId)).size }); run = []; };
    for (const p of inPhase) { if (run.length && p.rel - run[0].rel > MOMENT_WINDOW_SEC) close(); run.push(p); }
    close();
  }
  // "Stage Two: Usurper's Reprisal" → "Stage Two"; a bare name ("Howling Maelstrom") → "the Howling Maelstrom phase".
  const label = (phase: string) => {
    const [id, round] = phase.split('#').map(Number);
    const name = (phaseNames[id] ?? `phase ${id}`).split(':')[0].trim();
    const words = /^intermission/i.test(name) ? 'the intermission' : /^(stage|phase) /i.test(name) ? name : `the ${name} phase`;
    return round > 1 ? `${words} (${round === 2 ? 'second' : round === 3 ? 'third' : `${round}th`} time)` : words;
  };
  const say = (cs: typeof clusters) => {
    const sorted = cs.slice().sort((a, b) => a.abs - b.abs);
    if (!phased) return listWords(sorted.map(c => fmtClock(c.rel)));
    const byPhase: Array<{ phase: string; times: string[] }> = [];
    for (const c of sorted) { const last = byPhase[byPhase.length - 1]; if (last && last.phase === c.phase) last.times.push(fmtClock(c.rel)); else byPhase.push({ phase: c.phase, times: [fmtClock(c.rel)] }); }
    return byPhase.map(g => `${listWords(g.times)} into ${label(g.phase)}`).join(', ');
  };
  const repeated = clusters.filter(c => c.pulls >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
  // Where the listed moments are not all of them, how many they cover is said.
  const covered = repeated.reduce((n, c) => n + c.n, 0);
  if (repeated.length) return { words: `around ${say(repeated)}${covered < points.length ? ` (${covered} of ${points.length} times)` : ''}`, repeats: true };
  if (clusters.length <= 3) return { words: `at ${say(clusters)}`, repeats: false };
  const times = points.map(p => p.atSec);
  return { words: `at a different time each pull (${fmtClock(Math.min(...times))} to ${fmtClock(Math.max(...times))})`, repeats: false };
}

export function buildNightReview(opts: {
  code: string;
  group: NightGroup;
  base: NightBase;
  hits: NightHits | null;
  picked: { picked: PickedAbility[]; known: number; more: number } | null;
  boss: BossKnowledge | null;
  raidStats: RaidMechanicStats | null;
  hitsFailed?: boolean;
  defensives?: NightDefensives | null;
  defined?: NightDefined | null;
  definedFailed?: boolean;
}): NightReview {
  const { code, group, base, hits, picked, boss, raidStats } = opts;
  const defined = opts.defined ?? null;
  // Every avoidable hit of the night, whichever list named the ability.
  const allHitRows: NightHitRow[] = [...(defined?.rows ?? []), ...(hits?.rows ?? [])];
  const fights = group.fights;
  const offset = group.all.length - fights.length;
  const numberOf = new Map(fights.map((f, i) => [f.id, offset + i + 1]));
  const split = new Map(fights.map(f => [f.id, splitPullDeaths(f, base.deaths[f.id] ?? null)]));
  // Instant kills: nothing pressed stops them, so they are never "died with something ready".
  const instant = new Set<RaidDeath>();
  for (const f of fights) for (const d of base.deaths[f.id] ?? []) if ((base.instant?.[f.id] ?? []).some(([id, at]) => id === d.id && at === d.atSec)) instant.add(d);

  // The same goes for a hit the fight gives its own answer to (wardFor): the answer is that
  // mechanic, so the death is never held against a defensive.
  const warded = new Set<RaidDeath>();
  for (const f of fights) for (const d of base.deaths[f.id] ?? []) if (!instant.has(d) && wardFor(boss, d.killer, d.killerSpellId || undefined)) { instant.add(d); warded.add(d); }

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
      name, icon: list[0].d.killerIcon, spellId: list[0].d.killerSpellId, avoidable: false,
      typeWords: (w => (w ? `a hit the fight answers with ${w.name}${w.pct ? ` (${w.pct}% off)` : ''}` : c && c.type !== 'unknown' ? MECHANIC_WORDS[c.type] : null))(wardFor(boss, name, list[0].d.killerSpellId || undefined)),
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
  // Two lists feed this: Wipefest's definitions for the boss where it has them (its own
  // sentence, its own call on what counts against a player), and for abilities no
  // definition covers, the ones classifyAbility types as avoidable.
  const sources: Array<{ key: string; name: string; icon: string; spellId: number; type: MechanicType | null; via: NightMechanic['via']; sentence: string | null; events: number | null; eventsByFight?: Record<number, number> }> = [
    ...(defined?.mechanics ?? []).map(m => ({ key: m.key, name: m.name, icon: m.icon, spellId: m.spellId, type: null, via: 'wipefest' as const, sentence: m.sentence, events: m.events, eventsByFight: m.eventsByFight })),
    ...(picked?.picked ?? []).map(a => ({ key: a.name, name: a.name, icon: a.icon, spellId: a.spellIds[0], type: a.type, via: a.via, sentence: null, events: null })),
  ];
  // Two definitions can share an ability's name (the same pool left by two different
  // casts); the sentence says which is which ("… from Sanguine Storm"), so the name borrows it.
  const shared = new Set(sources.map(a => a.name).filter((name, i, all) => all.indexOf(name) !== i));
  for (const a of sources) {
    if (!shared.has(a.name) || !a.sentence) continue;
    const from = a.sentence.split(`${a.name} from `)[1]?.split(/[,.{]/)[0]?.trim();
    if (from) a.name = `${a.name} (from ${from})`;
  }
  const mechanics: NightMechanic[] = [];
  const fightById = new Map(fights.map(f => [f.id, f]));
  for (const a of sources) {
    const rows = allHitRows.filter(r => r.ability === a.key);
    if (!rows.length) continue;
    // One row is one player on one pull: against everyone present on the pulls it happened.
    const exposed = [...new Set(rows.map(r => r.fightId))].reduce((n, fid) => n + (base.present[fid]?.length ?? 0), 0);
    const share = exposed > 0 ? rows.length / exposed : 0;
    const byPlayer = new Map<number, NightHitRow[]>();
    for (const r of rows) (byPlayer.get(r.playerId) ?? byPlayer.set(r.playerId, []).get(r.playerId)!).push(r);
    const sum = (xs: NightHitRow[], k: 'events' | 'ticks' | 'times' | 'damage') => xs.reduce((s, x) => s + x[k], 0);
    const perPlayer = [...byPlayer.entries()].map(([id, xs]) => ({ id, times: sum(xs, 'times'), pulls: xs.length })).sort((x, y) => y.times - x.times);
    const lead = perPlayer[0];
    // Three pulls and most of the night's count on one player: a job, not a habit.
    // Tanks swap, so neither holds 60% of a tank mechanic: nine tenths of the count on
    // the tanks together is the same finding (the line classifyAbility draws for one).
    const tankIds = perPlayer.filter(x => people.get(x.id)?.role === 'tank').map(x => x.id);
    const onTanks = perPlayer.filter(x => tankIds.includes(x.id)).reduce((n, x) => n + x.times, 0);
    const assigned: NightMechanic['assigned'] = lead && lead.pulls >= 3 && lead.times >= 0.6 * sum(rows, 'times')
      ? { name: ref(lead.id).name, role: people.get(lead.id)?.role ?? null, tanks: false, ids: [lead.id] }
      : tankIds.length >= 2 && new Set(rows.map(r => r.fightId)).size >= 3 && onTanks >= 0.9 * sum(rows, 'times')
        ? { name: 'The tanks', role: 'tank', tanks: true, ids: tankIds }
        : null;
    const [times, damage] = [sum(rows, 'times'), sum(rows, 'damage')];
    // A definition whose own count came to nothing (it counts applications, the log has only ticks) takes ours.
    const count = a.events || times;
    const title = a.sentence
      ? a.sentence.replace(/\{totalHits\}/g, String(count)).replace(/\{plural\}/g, count === 1 ? '' : 's').replace(/\{totalDamage\}/g, fmtNum(damage))
      : `${a.name} hit ${plural(byPlayer.size, 'player')} ${times} ${times === 1 ? 'time' : 'times'}`;
    // Pull by pull, without whoever it is assigned to (their hits are the job being done).
    const own = rows.filter(r => !assigned?.ids.includes(r.playerId));
    const lengthOf = (fid: number) => Math.min(split.get(fid)!.cutoffSec, (fightById.get(fid)?.durationMs ?? 0) / 1000);
    const reach = own.length ? Math.min(...own.map(r => lengthOf(r.fightId))) : Infinity;
    const could = pulls.filter(p => p.durationSec >= SHORT_PULL_SEC && lengthOf(p.fightId) >= reach);
    const timesOn = (fid: number) => own.filter(r => r.fightId === fid).reduce((n, r) => n + r.times, 0);
    let halves: NightProgress['halves'] = null;
    if (could.length >= PROGRESS_MIN_PULLS) {
      const half = Math.floor(could.length / 2);
      const side = (ps: NightPull[]) => {
        const n = ps.reduce((t, p) => t + timesOn(p.fightId), 0);
        return { n, perPull: n / ps.length, perMin: n / Math.max(1, ps.reduce((t, p) => t + lengthOf(p.fightId), 0) / 60) };
      };
      const [first, second] = [side(could.slice(0, half)), side(could.slice(-half))];
      // Per pull is what gets said; per minute has to agree, so longer pulls alone cannot read as "worse".
      const apart = (x: number, y: number) => Math.max(x, y) >= PROGRESS_RATIO * Math.min(x, y);
      if (first.n + second.n >= PROGRESS_MIN_TIMES && apart(first.perPull, second.perPull) && apart(first.perMin, second.perMin) && (first.perPull > second.perPull) === (first.perMin > second.perMin)) {
        halves = { pulls: half, first: first.perPull, second: second.perPull, better: second.perPull < first.perPull };
      }
    }
    const progress: NightProgress = { perPull: pulls.map(p => (could.includes(p) || timesOn(p.fightId) > 0 ? timesOn(p.fightId) : null)), halves };
    mechanics.push({
      progress, assigned, key: a.key, title, share, raidWide: share > RAID_WIDE_SHARE, eventsByFight: a.eventsByFight,
      name: a.name, icon: a.icon, spellId: a.spellId, type: a.type, via: a.via,
      damage, times, pulls: new Set(rows.map(r => r.fightId)).size,
      dot: sum(rows, 'ticks') >= 0.7 * sum(rows, 'events'),
      players: [...byPlayer.entries()].map(([id, xs]) => ({ ...ref(id), times: sum(xs, 'times'), events: sum(xs, 'events'), damage: sum(xs, 'damage'), pulls: xs.length, fightId: Math.max(...xs.map(x => x.fightId)) }))
        .sort((x, y) => y.times - x.times || y.damage - x.damage),
    });
  }
  // What happened most often first (a debuff rule has no damage figure to rank by); a
  // mechanic that is one player's job goes last.
  mechanics.sort((a, b) => Number(a.raidWide) - Number(b.raidWide) || Number(!!a.assigned) - Number(!!b.assigned) || b.times - a.times || b.damage - a.damage);
  // Everything said about a player's hits from here on leaves the raid-wide ones out.
  const individual = mechanics.filter(m => !m.raidWide);
  // ...and a player's assigned mechanic is not counted as their hits either.
  const assignedTo = new Map(individual.map(m => [m.key, new Set(m.assigned?.ids ?? [])]));
  const hitRows = allHitRows.filter(r => assignedTo.has(r.ability) && !assignedTo.get(r.ability)!.has(r.playerId));
  let mechanicsNote: string | null = null;
  if (mechanics.length) mechanicsNote = null;
  else if (opts.hitsFailed || opts.definedFailed) mechanicsNote = 'The hit-by-hit data for this night could not be loaded from Warcraft Logs, so this section is empty. Reload to try again.';
  else if (!picked || base.failed.roster) mechanicsNote = 'The damage tables for this night could not be loaded from Warcraft Logs. Reload to try again.';
  else if (sources.length) mechanicsNote = 'Nobody was hit by an avoidable ability before a wipe.';
  else if (!picked.known) mechanicsNote = 'Nothing is known yet about which of this boss\'s abilities are avoidable (no mechanic definitions, no addon labels and no top-raid logs to compare with), so nobody is listed.';
  else mechanicsNote = 'None of the abilities that hit the raid tonight is one the addons or the top raids\' logs mark as avoidable.';

  // ── Deaths with a defensive ready ──
  // A player's defensives are the ones they pressed at some point tonight: that proves
  // they have the talent, which the log does not otherwise say. For each counted death,
  // one of them is "ready" when it was neither pressed in the cooldown before the death
  // nor (where Wowhead gives charges) out of charges. Healthstones and healing potions
  // are left out: how many a player was carrying into a pull is not in the log. They
  // get their own section, as plain counts.
  const defs = opts.defensives ?? null;
  const readyAt = new Map<RaidDeath, string[]>();
  const pressedBefore = new Set<RaidDeath>();
  const ownedBy = new Map<number, Set<string>>();
  const isMajor = (name: string) => isMajorDefensive(defs?.spells[name]?.cooldownSec);
  const majorAt = (d: RaidDeath) => (readyAt.get(d) ?? []).filter(isMajor);
  const minorAt = (d: RaidDeath) => (readyAt.get(d) ?? []).filter(n => !isMajor(n));
  const ownsMajor = (id: number) => [...(ownedBy.get(id) ?? [])].some(isMajor);
  if (defs) {
    for (const [, pid, name] of defs.casts) {
      if (name === 'Healthstone' || name === 'Healing potion') continue;
      (ownedBy.get(pid) ?? ownedBy.set(pid, new Set()).get(pid)!).add(name);
    }
    for (const { d, fightId } of counted) {
      const owned = [...(ownedBy.get(d.id) ?? [])];
      if (!owned.length || instant.has(d)) continue;
      const uses: Record<string, number[]> = {};
      for (const [fid, pid, name, at] of defs.casts) if (fid === fightId && pid === d.id) (uses[name] ??= []).push(at);
      const cds: Record<string, number | undefined> = {};
      const charges: Record<string, number> = {};
      for (const n of owned) {
        cds[n] = defs.spells[n]?.cooldownSec ?? undefined;
        charges[n] = noChargeModel(n) ? 1 : defs.spells[n]?.charges ?? 1;
      }
      // A press in the last few seconds is a defensive that was running, not one left unused.
      const st = defensivesAt(d.atSec + 0.5, owned, uses, cds, charges);
      readyAt.set(d, st.available);
      if (Object.values(uses).some(ts => ts.some(t => t <= d.atSec + 0.5 && t >= d.atSec - 10))) pressedBefore.add(d);
    }
  }
  let readyDeaths: NightReadyDeaths | null = null;
  if (defs) {
    // The headline counts major defensives only, over deaths by players known to have one.
    const known = counted.filter(x => readyAt.has(x.d));
    const judged = known.filter(x => ownsMajor(x.d.id));
    const byPlayer = new Map<number, typeof known>();
    for (const x of known) (byPlayer.get(x.d.id) ?? byPlayer.set(x.d.id, []).get(x.d.id)!).push(x);
    const tallyNames = (lists: string[][]): NightReadyDefensive[] => tally(lists.flat()).map(([name, count]) => ({ name, icon: defs.spells[name]?.icon ?? '', spellId: defs.spells[name]?.spellId ?? 0, count }));
    readyDeaths = {
      judged: judged.length,
      withMajor: judged.filter(x => majorAt(x.d).length).length,
      nothingPressed: judged.filter(x => majorAt(x.d).length && !pressedBefore.has(x.d)).length,
      minorOnly: known.filter(x => !majorAt(x.d).length && minorAt(x.d).length).length,
      instant: counted.filter(x => instant.has(x.d)).length,
      players: [...byPlayer.entries()].map(([id, list]) => {
        const withMajor = list.filter(x => majorAt(x.d).length);
        const minorOnly = list.filter(x => !majorAt(x.d).length && minorAt(x.d).length);
        return {
          ...ref(id), deaths: list.length, withMajor: withMajor.length, nothingPressed: withMajor.filter(x => !pressedBefore.has(x.d)).length, minorOnly: minorOnly.length,
          major: tallyNames(withMajor.map(x => majorAt(x.d))),
          minor: tallyNames(list.map(x => minorAt(x.d))),
          pullNumbers: [...new Set(withMajor.map(x => numberOf.get(x.fightId)!))].sort((a, b) => a - b),
          fightId: (withMajor[withMajor.length - 1] ?? list[list.length - 1]).fightId,
        };
      }).filter(p => p.withMajor > 0 || p.minorOnly > 0).sort((a, b) => b.withMajor - a.withMajor || b.deaths - a.deaths || b.minorOnly - a.minorOnly || a.name.localeCompare(b.name)),
    };
  }

  // ── Healthstones and healing potions ──
  const present = (fightId: number, id: number) => (base.present[fightId] ?? []).includes(id);
  const healUses = new Map<string, { hs: number[]; pot: number[] }>();
  for (const [fid, pid, name, at] of defs?.casts ?? []) {
    if (name !== 'Healthstone' && name !== 'Healing potion') continue;
    const k = `${fid}|${pid}`;
    const u = healUses.get(k) ?? { hs: [], pot: [] };
    (name === 'Healthstone' ? u.hs : u.pot).push(at);
    healUses.set(k, u);
  }
  const usedBefore = (fightId: number, d: RaidDeath) => {
    const u = healUses.get(`${fightId}|${d.id}`);
    return { healthstone: !!u?.hs.some(t => t <= d.atSec + 0.5), potion: !!u?.pot.some(t => t <= d.atSec + 0.5) };
  };
  let healing: NightHealing | null = null;
  if (defs && !base.failed.roster) {
    // `people`, not the roster: a player who changed role mid-night is in the roster twice.
    const everyone = [...people.values()];
    const warlocks = everyone.filter(p => p.className === 'Warlock');
    const kinds = (['hs', 'pot'] as const).map(kind => {
      const used = [...healUses.entries()].filter(([, u]) => u[kind].length).map(([k, u]) => ({ fid: Number(k.split('|')[0]), pid: Number(k.split('|')[1]), n: u[kind].length }));
      return { pulls: new Set(used.map(x => x.fid)).size, players: new Set(used.map(x => x.pid)).size, uses: used.reduce((s, x) => s + x.n, 0) };
    });
    healing = {
      pulls: fights.length,
      warlockPulls: fights.filter(f => warlocks.some(w => present(f.id, w.id))).length,
      warlocks: warlocks.map(w => w.name),
      healthstone: kinds[0], potion: kinds[1],
      players: everyone.map(p => {
        const mine = fights.filter(f => present(f.id, p.id));
        // An instant kill is not a death a healthstone was ever going to stop.
        const myDeaths = counted.filter(x => x.d.id === p.id && !instant.has(x.d));
        return {
          ...ref(p.id), pulls: mine.length,
          healthstonePulls: mine.filter(f => healUses.get(`${f.id}|${p.id}`)?.hs.length).length,
          potionPulls: mine.filter(f => healUses.get(`${f.id}|${p.id}`)?.pot.length).length,
          deaths: myDeaths.length,
          deathsUnused: myDeaths.filter(x => { const u = usedBefore(x.fightId, x.d); return !u.healthstone && !u.potion; }).length,
        };
      }).filter(p => p.pulls > 0).sort((a, b) => b.deathsUnused - a.deathsUnused || (a.healthstonePulls + a.potionPulls) / a.pulls - (b.healthstonePulls + b.potionPulls) / b.pulls || a.name.localeCompare(b.name)),
    };
  }

  // ── Per pull and player, for the one-player view ──
  const detail: NightDetail = {
    present: base.present,
    deaths: fights.flatMap(f => {
      const s = split.get(f.id)!;
      return (base.deaths[f.id] ?? []).map(d => ({
        fightId: f.id, playerId: d.id, atSec: d.atSec, killer: d.killer,
        counted: s.counted.includes(d), first: s.counted[0] === d, instant: instant.has(d),
        judged: readyAt.has(d), major: majorAt(d), minor: minorAt(d),
        ...usedBefore(f.id, d),
      }));
    }),
    hits: hitRows.map(r => [r.ability, r.playerId, r.fightId, r.times, r.damage]),
    heals: [...healUses.entries()].map(([k, u]) => [Number(k.split('|')[0]), Number(k.split('|')[1]), u.hs.length, u.pot.length]),
    healsKnown: !!defs,
  };

  // ── Per player ──
  const lastFightOf = (id: number) => fights.slice().reverse().find(f => (base.present[f.id] ?? []).includes(id))?.id ?? fights[fights.length - 1].id;
  const players: NightPlayerRow[] = [...people.values()].map(p => {
    const myDeaths = counted.filter(x => x.d.id === p.id);
    const myHits = hitRows.filter(r => r.playerId === p.id);
    const deaths = myDeaths.length;
    const firstCount = firstByPlayer.get(p.id)?.length ?? 0;
    const times = myHits.reduce((s, r) => s + r.times, 0);
    const present = base.failed.roster ? null : fights.filter(f => (base.present[f.id] ?? []).includes(p.id)).length;
    return {
      id: p.id, name: p.name, className: p.className, role: p.role,
      deaths, readyDeaths: defs && ownsMajor(p.id) ? myDeaths.filter(x => majorAt(x.d).length).length : null, firstDeaths: firstCount, hits: times, avoidDamage: myHits.reduce((s, r) => s + r.damage, 0), pulls: present,
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
  // A trend that went the right way, for "what is already working" when no single mechanic stands out.
  let trendWorking: string | null = null;
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
    if (individual.length) {
      const rate = (ps: NightPull[]) => {
        const idSet = new Set(ps.map(p => p.fightId));
        const times = hitRows.filter(r => idSet.has(r.fightId)).reduce((s, r) => s + r.times, 0);
        const minutes = ps.reduce((s, p) => s + Math.min(p.durationSec, split.get(p.fightId)!.cutoffSec), 0) / 60;
        return { times, perMin: minutes > 0 ? times / minutes : 0 };
      };
      const [ra, rb] = [rate(a), rate(b)];
      const ratio = ra.perMin > 0 && rb.perMin > 0 ? rb.perMin / ra.perMin : null;
      if (ratio != null && ra.times + rb.times >= 20 && Math.max(ra.perMin, rb.perMin) >= 1 && (ratio >= 1.5 || ratio <= 1 / 1.5)) {
        trend.push(`Avoidable hits ${ratio < 1 ? 'came down' : 'went up'}: ${ra.perMin.toFixed(1)} a minute across the raid in ${span}, ${rb.perMin.toFixed(1)} in the last ${half}.`);
        if (ratio < 1) trendWorking ??= `Avoidable hits are already coming down: ${ra.perMin.toFixed(1)} a minute across the raid in ${span}, ${rb.perMin.toFixed(1)} in the last ${half}.`;
      }
    }
    const [da, db] = [a, b].map(ps => { const k = ps.filter(p => p.deathsBefore != null && !p.kill); return k.length >= 3 ? k.reduce((s, p) => s + (p.deathsBefore ?? 0), 0) / k.length : null; });
    if (da != null && db != null && Math.abs(da - db) >= 1 && Math.max(da, db) >= 1.5 * Math.max(0.5, Math.min(da, db))) {
      trend.push(`Deaths before the wipe went ${db < da ? 'down' : 'up'}: ${da.toFixed(1)} a pull in ${span}, ${db.toFixed(1)} in the last ${half}.`);
      if (db < da) trendWorking = `Deaths before the wipe are already coming down: ${da.toFixed(1)} a pull in ${span}, ${db.toFixed(1)} in the last ${half}.`;
    }
  }

  // ── Before the next pull ──
  // Candidates from four places (the wipes, the deaths with a defensive unused, the
  // repeat offenders, the consumables), each with its own evidence threshold, ranked by
  // the pulls they touched (HIT_PULL_WEIGHT). Nothing here is written per boss.
  const phases = defined?.phases ?? {};
  const phaseNames = defined?.phaseNames ?? {};
  const presentPulls = (id: number) => fights.filter(f => present(f.id, id)).length;
  // "Congelead Gore (from Sanguine Storm)" and "Clotted Bolt / Concentrated Spittle" against a killing blow's name.
  const sameAbility = (mech: string, killer: string) => !!mech && mech.split(' (from ')[0].split(' / ').some(part => part.trim().toLowerCase() === killer.toLowerCase());
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const lower = (t: string) => t.replace(/^./, c => c.toLowerCase());
  const upper = (t: string) => t.replace(/^./, c => c.toUpperCase());
  const candidates: Array<NightStep & { also: string }> = [];

  // The abilities that end pulls: what the definitions count before them when the count
  // separates those pulls from the ones that got past, else when they happen.
  // The one that ends the most pulls always; another only when the log shows what leads
  // to it ("agree a plan" for two abilities at once is not an instruction).
  const wipeSteps = wipeCauses.filter(x => x.name !== 'unknown damage' && x.pulls >= WIPE_STEP_MIN_PULLS);
  for (const w of wipeSteps) {
    const ended = pulls.filter(q => q.wipe?.killer === w.name);
    const at = ended.map(q => q.wipe!.atSec);
    const [earliest, latest] = [Math.min(...at), Math.max(...at)];
    const lengthOf = (q: NightPull) => Math.min(q.durationSec, split.get(q.fightId)!.cutoffSec);
    // Pulls it did not end that lasted at least as long as its earliest wipe.
    const past = pulls.filter(q => q.wipe?.killer !== w.name && (q.kill || lengthOf(q) >= earliest));
    let cause = '';
    let bestRatio = 0;
    for (const pre of defined?.precursors ?? []) {
      if (pre.wipe !== w.name || past.length < 2) continue;
      const on = ended.map(q => pre.byFight[q.fightId]?.[1] ?? 0);
      const [nOn, nOff] = [total(on), total(past.map(q => pre.byFight[q.fightId]?.[0] ?? 0))];
      const [rOn, rOff] = [nOn / ended.length, nOff / past.length];
      if (on.filter(n => n > 0).length < PRECURSOR_PRESENT_SHARE * ended.length || rOn < PRECURSOR_RATIO * rOff) continue;
      const ratio = rOff > 0 ? rOn / rOff : Infinity;
      if (ratio <= bestRatio) continue;
      bestRatio = ratio;
      // The definition's sentence up to its first comma: the failure, without its consequence.
      cause = ` What comes before it, by the mechanic definition: ${pre.sentence ? `"${lower(pre.sentence.split(', ')[0])}"` : pre.name}. That happened ${timesWord(nOn)} on the ${ended.length} pulls it ended and ${nOff === 0 ? 'never' : timesWord(nOff)} on the ${past.length} that got past ${fmtClock(earliest)}.`;
    }
    if (!cause && w !== wipeSteps[0]) continue;
    const when = whenWords(ended.map(q => ({ fightId: q.fightId, atSec: q.wipe!.atSec })), phases, phaseNames);
    const beyond = pulls.filter(q => q.wipe?.killer !== w.name && (q.kill || q.durationSec > latest));
    const best = beyond.slice().sort((a, b) => a.pct - b.pct)[0];
    const reach = beyond.length
      ? ` ${upper(countWord(beyond.length, 'pull'))} went on past ${fmtClock(latest)}, ${best.kill ? (beyond.length === 1 ? 'the kill' : 'the kill among them') : `the best to ${Math.round(best.pct)}% left`}.`
      : ` No pull has gone past ${fmtClock(latest)} yet.`;
    candidates.push({
      kind: 'wipe', subject: w.name, icon: w.icon, spellId: w.spellId, weight: w.pulls,
      text: `${cause ? `Stop what leads to ${w.name}` : `Agree a plan for ${w.name}`}: it ended ${w.pulls} of the ${wipes.length} wipes.`,
      evidence: `It wiped the raid on pulls ${listWords(w.pullNumbers.map(String))}${when ? `, ${when.words}` : ''}.${cause}${reach}`,
      scope: `ended ${w.pulls} of ${pulls.length} pulls`,
      also: `It also wiped the raid on ${w.pulls} of the ${wipes.length} wipes${when ? `, ${when.words}` : ''}.`,
    });
  }

  // The abilities that keep killing people who had a major defensive unused, and when they land.
  const when: Record<string, string> = {};
  // Abilities no source could type. A defensive is only called for damage something
  // positively says is meant to be taken; "we do not know what this is" is not that.
  const unread = new Set<string>();
  for (const k of killers) {
    // "Stay out of it" is said only when nothing contradicts it: an ability the addons or
    // the top raids' logs type as raid-wide stays a defensive call even where a definition
    // counts part of it (a wave inside it) against players.
    const cls = classifyAbility(boss, raidStats, k.name, k.spellId || undefined);
    // Where the addons or the journal call it a dodge and the logs say everyone is hit, it
    // stays "stay out of it, and press something when it catches you".
    k.avoidable = saysDodge(boss, k.name, k.spellId || undefined) || (cls && cls.type !== 'unknown' ? AVOIDABLE_TYPES.includes(cls.type) : individual.some(m => !m.assigned && sameAbility(m.name, k.name)));
    // No source says what this ability is: nothing is called for it (see below).
    if (!k.avoidable && (!cls || cls.type === 'unknown')) unread.add(k.name);
  }
  for (const k of killers) {
    if (/^melee$/i.test(k.name) || k.name === 'unknown damage') continue;
    // Deaths to a hit the fight answers itself: the step is that answer.
    const ward = wardFor(boss, k.name, k.spellId || undefined);
    const wardDeaths = ward ? counted.filter(x => x.d.killer === k.name && warded.has(x.d)) : [];
    const wardPulls = new Set(wardDeaths.map(x => x.fightId));
    if (ward && wardDeaths.length >= DEFENSIVE_STEP_MIN_DEATHS && wardPulls.size >= DEFENSIVE_STEP_MIN_PULLS) {
      const often = tally(wardDeaths.map(x => x.d.id)).filter(([, n]) => n >= 2).slice(0, 3).map(([id, n]) => `${ref(id).name} (${n})`);
      candidates.push({
        kind: 'defensive', subject: k.name, icon: k.icon, spellId: k.spellId, weight: wardPulls.size,
        text: `Everyone: have ${ward.name} on you for ${k.name}.`,
        evidence: `It caused ${plural(wardDeaths.length, 'death')} before the wipes over ${plural(wardPulls.size, 'pull')}. ${ward.name} is the fight's answer to it${ward.pct ? ` (${ward.pct}% off)` : ''}, not a defensive.${often.length ? ` Most often: ${listWords(often)}.` : ''}`,
        scope: `killed someone on ${wardPulls.size} of ${pulls.length} pulls`,
        also: `It also killed people before the wipes: ${plural(wardDeaths.length, 'death')}; ${ward.name} is the answer to it.`,
      });
      continue;
    }
    const list = counted.filter(x => x.d.killer === k.name && !instant.has(x.d));
    if (!list.length) continue;
    const lands = whenWords(list.map(x => ({ fightId: x.fightId, atSec: x.d.atSec })), phases, phaseNames);
    if (lands?.repeats) when[k.name] = lands.words;
    const ready = list.filter(x => majorAt(x.d).length > 0);
    const judged = list.filter(x => readyAt.has(x.d) && ownsMajor(x.d.id));
    const readyPulls = new Set(ready.map(x => x.fightId));
    if (ready.length < DEFENSIVE_STEP_MIN_DEATHS || readyPulls.size < DEFENSIVE_STEP_MIN_PULLS || ready.length < judged.length / 2) continue;
    if (unread.has(k.name)) continue;
    const avoidable = k.avoidable;
    const often = tally(ready.map(x => x.d.id)).filter(([, n]) => n >= 2).slice(0, 3).map(([id, n]) => `${ref(id).name} (${n})`);
    const share = `at ${ready.length === list.length ? 'every one' : ready.length} of them a major defensive was ready and unpressed`;
    candidates.push({
      kind: 'defensive', subject: k.name, icon: k.icon, spellId: k.spellId, weight: readyPulls.size,
      text: avoidable ? `Stay out of ${k.name}, and press a personal defensive when it does catch you.` : `Call a personal defensive for ${k.name}.`,
      evidence: `It caused ${plural(list.length, 'death')} before the wipes over ${plural(new Set(list.map(x => x.fightId)).size, 'pull')}; ${share}.${lands ? (lands.repeats ? ` It lands ${lands.words}.` : ` Those deaths came ${lands.words}.`) : ''}${often.length ? ` Most often: ${listWords(often)}.` : ''}`,
      scope: `killed someone with a defensive unused on ${readyPulls.size} of ${pulls.length} pulls`,
      also: `It also killed people before the wipes: ${plural(list.length, 'death')}, ${share}${lands?.repeats ? `; it lands ${lands.words}` : ''}.`,
    });
  }

  // Players a mechanic keeps catching. Never for a mechanic that is somebody's job, and
  // the raid-wide ones are not in `individual` to begin with.
  const regulars = players.filter(x => (x.pulls ?? 0) >= OFFENDER_MIN_PULLS).length;
  for (const m of individual) {
    if (m.assigned) continue;
    const pattern = m.players.map(x => ({ x, of: presentPulls(x.id) }))
      .filter(({ x, of }) => x.pulls >= OFFENDER_MIN_PULLS && x.pulls >= OFFENDER_MIN_SHARE * of)
      .sort((a, b) => b.x.pulls - a.x.pulls || b.x.times - a.x.times);
    if (!pattern.length) continue;
    const named = pattern.slice(0, 3);
    const ids = new Set(pattern.map(({ x }) => x.id));
    const hitPulls = new Set(allHitRows.filter(r => r.ability === m.key && ids.has(r.playerId)).map(r => r.fightId));
    const deathPulls = new Set(counted.filter(x => ids.has(x.d.id) && sameAbility(m.name, x.d.killer)).map(x => x.fightId));
    const sameOf = named.every(n => n.of === named[0].of);
    const counts = sameOf ? `${listWords(named.map(n => String(n.x.pulls)))} of ${named[0].of} pulls` : `${listWords(named.map(n => `${n.x.pulls} of ${n.of}`))} pulls`;
    const names = listWords(named.map(n => n.x.name));
    const more = pattern.length - named.length;
    // Half the regulars with the same habit is the raid's problem: say so, then name the top of the list.
    const everyone = regulars > 0 && pattern.length >= regulars / 2;
    const died = deathPulls.size ? ` It killed one of ${everyone ? 'them' : 'you'} on${countWord(deathPulls.size, 'pull')}.` : '';
    candidates.push({
      kind: 'offenders', subject: m.name, icon: m.icon, spellId: m.spellId,
      weight: deathPulls.size + HIT_PULL_WEIGHT * [...hitPulls].filter(f => !deathPulls.has(f)).length,
      text: everyone ? `Everyone: watch ${m.name}.` : `${names}: watch ${m.name}.`,
      evidence: everyone
        ? `${pattern.length} of ${regulars} players were caught by it on a third or more of their pulls; most often ${names}, on ${counts}.${died}`
        : `It has caught you on ${counts}${named.length > 1 ? ', in that order' : ''}.${more ? ` ${upper(countWord(more, 'more player'))} ${more === 1 ? 'has' : 'have'} the same pattern.` : ''}${died}`,
      scope: `hit on ${hitPulls.size} of ${pulls.length} pulls`,
      also: `Caught by it most often: ${names}, on ${counts}.`,
    });
  }

  // Healthstones (or healing potions on a night with no Warlock), only as a real gap.
  if (healing) {
    const stones = healing.warlockPulls >= healing.pulls / 2;
    const regular = healing.players.filter(x => x.pulls >= OFFENDER_MIN_PULLS);
    const never = regular.filter(x => (stones ? x.healthstonePulls : x.potionPulls) === 0);
    const stoppable = counted.filter(x => !instant.has(x.d));
    const unused = stoppable.filter(x => { const u = usedBefore(x.fightId, x.d); return !u.healthstone && !u.potion; });
    if (regular.length && never.length >= CONSUMABLE_NEVER_SHARE * regular.length && unused.length >= CONSUMABLE_MIN_DEATHS) {
      const unusedPulls = new Set(unused.map(x => x.fightId)).size;
      candidates.push({
        kind: 'consumables', subject: '', icon: '', spellId: 0, weight: HIT_PULL_WEIGHT * unusedPulls,
        text: stones ? 'Everyone: take a healthstone and press it when you are low.' : 'Everyone: keep a healing potion on your bars and press it when you are low.',
        evidence: `${never.length} of ${regular.length} players never used ${stones ? 'a healthstone' : 'a healing potion'} all night, and ${unused.length} of the ${stoppable.length} deaths before the wipes came with neither a healthstone nor a healing potion used.`,
        scope: `a death with neither used on ${unusedPulls} of ${pulls.length} pulls`,
        also: '',
      });
    }
  }

  const kindOrder: Record<NightStep['kind'], number> = { wipe: 0, defensive: 1, offenders: 2, consumables: 3 };
  candidates.sort((a, b) => b.weight - a.weight || kindOrder[a.kind] - kindOrder[b.kind]);
  const steps: NightStep[] = [];
  for (const { also, ...c } of candidates) {
    // A second instruction about the same ability folds into the first as more evidence.
    const same = steps.find(x => sameAbility(x.subject, c.subject) || sameAbility(c.subject, x.subject));
    if (same) { if (also) same.evidence += ` ${also}`; continue; }
    if (steps.length < NEXT_STEPS) steps.push(c);
  }
  // What is already working: the mechanic whose count fell furthest, else the night's own trend.
  const improved = individual.filter(m => m.progress.halves?.better && !m.assigned)
    .sort((a, b) => b.progress.halves!.first / Math.max(0.01, b.progress.halves!.second) - a.progress.halves!.first / Math.max(0.01, a.progress.halves!.second))[0];
  const nextPull: NightNextPull = {
    steps,
    ranked: candidates.map(c => `${c.weight.toFixed(2)} | ${c.kind} | ${c.text} | ${c.evidence}`),
    working: improved
      ? `${improved.name} is down from ${rate(improved.progress.halves!.first)} a pull across the raid (the first ${improved.progress.halves!.pulls} pulls it could happen on) to ${rate(improved.progress.halves!.second)} (the last ${improved.progress.halves!.pulls}): keep doing what you are doing there.`
      : trendWorking,
  };

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
  // Said only when there is something to act on: a few deaths judged, and at least a third of them with something ready.
  if (readyDeaths && readyDeaths.judged >= 3 && readyDeaths.withMajor >= Math.max(2, readyDeaths.judged / 3)) {
    parts.push(`${readyDeaths.withMajor} of the ${readyDeaths.judged} deaths before the wipes that a defensive could have covered came with a major one ready and unpressed.`);
  }
  if (trend[0]) parts.push(trend[0]);

  const notes: string[] = [];
  if (base.failed.deaths) notes.push('Some of the death tables could not be loaded from Warcraft Logs, so death counts are missing for those pulls. Reload to try again.');
  if (opts.hitsFailed && mechanics.length) notes.push('Part of the hit-by-hit data could not be loaded from Warcraft Logs, so some avoidable abilities are missing. Reload to try again.');
  if (defined?.truncated) notes.push('This night has more mechanic events than one page load reads; hit counts cover the earlier pulls only.');
  if (hits?.truncated) notes.push('This night has more avoidable-damage events than one page load reads; hit counts cover the earlier pulls only.');
  if (defs?.truncated) notes.push('This night has more defensive casts than one page load reads; "defensive ready" covers the earlier pulls only.');
  if (picked?.more) notes.push(`Only the ${NIGHT_MAX_ABILITIES} avoidable abilities that did the most damage are listed; ${picked.more} more ${picked.more === 1 ? 'is' : 'are'} left out.`);

  const stats = [
    { label: 'Pulls', value: String(pulls.length), note: kills.length ? plural(kills.length, 'kill') : 'no kill' },
    { label: 'Best pull', value: kills.length ? 'Kill' : `${Math.round(bestWipe?.pct ?? 100)}%`, note: kills.length ? `pull ${kills[0].n}` : bestWipe ? `pull ${bestWipe.n} · ${fmtClock(bestWipe.durationSec)}` : undefined },
    { label: 'In combat', value: fmtSpan(combatSec), note: `of ${fmtSpan(wallSec)}` },
    { label: 'Deaths', value: base.failed.deaths && !countedTotal ? '—' : String(countedTotal), note: 'before the wipes' },
    { label: 'Avoidable', value: individual.length ? String(hitRows.reduce((s, r) => s + r.times, 0)) : '—', note: individual.length ? `hits · ${fmtNum(hitRows.reduce((s, r) => s + r.damage, 0))}` : 'hits' },
  ];

  return {
    code, encounterID: group.encounterID, difficulty: group.difficulty, bossName: group.name,
    summary: parts.join(' '), nextPull, when, stats, pulls, totalPulls: group.all.length, capped: group.all.length > fights.length,
    wipeCauses, killers, readyDeaths, healing, detail, countedDeaths: countedTotal, firstDeaths, pullsWithFirstDeath: firsts.length,
    mechanics, mechanicsNote, mechanicsCredit: defined?.mechanics.length ? wipefestCredit(defined) : null, players, trend, notes,
    requests: base.requests + (hits?.requests ?? 0) + (defs?.requests ?? 0) + (defined?.requests ?? 0),
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
  return cacheUnlessPartial<NightReview>(`analyze-night-review-v24-${cacheKey(code, group.fights)}`, 6 * 3600, async () => {
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
  const t0 = Date.now();
  const load: Record<string, string> = {};
  const timed = async <T,>(name: string, requests: (v: T) => number, run: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    const v = await run();
    load[name] = `${requests(v)} req · ${((Date.now() - t) / 1000).toFixed(1)}s`;
    return v;
  };
  const base = await timed('roster and deaths', b => b.requests, () => getNightBase(token, code, fights));
  const quiet = async <T,>(p: Promise<T | null>): Promise<T | null> => {
    try { return await p; } catch (err) { if (isRateLimitError(err)) throw err; console.error('night: classification input unavailable', err); return null; }
  };
  const cutoffs = Object.fromEntries(fights.map(f => [f.id, splitPullDeaths(f, base.deaths[f.id] ?? null).cutoffSec]));
  // Three things need only the roster and the deaths, so they load side by side: what is
  // known about the boss, Wipefest's definitions read over every pull, and the defensive casts.
  let definedFailed = false;
  const [[boss, raidStats], defined, defensives] = await Promise.all([
    timed('boss knowledge and top-raid stats', () => 0, async () => {
      // Top-raid stats are kept per boss and difficulty (getRaidMechanicStats' own key). When
      // they are already there, read them directly: the page's loader goes through a spec
      // pool first, and a raid whose commonest spec has no pool yet would wait a minute and
      // a half for numbers that do not depend on the spec at all.
      const kept = await getPersistentReadOnly<RaidMechanicStats>(`analyze-raidmech-v1-${group.encounterID}-${Math.max(4, group.difficulty)}`).catch(() => null);
      return Promise.all([
        quiet(deps.bossKnowledge(last)),
        kept && kept.n > 0 ? Promise.resolve(kept) : base.fightPlayers.length ? quiet(deps.raidStats(last, base.fightPlayers)) : Promise.resolve(null),
      ]);
    }),
    // No definitions for a boss is an answer (null config), not a failure.
    timed('mechanic definitions', d => d?.requests ?? 0, async (): Promise<NightDefined | null> => {
      const config = await getWipefestFightConfig(group.encounterID);
      if (!config || base.failed.roster) return null;
      try {
        return await getNightDefined(token, code, fights, config, base, cutoffs);
      } catch (err) {
        if (isRateLimitError(err)) throw err;
        console.error('night: mechanic definitions unavailable', err);
        definedFailed = true;
        return null;
      }
    }),
    timed('defensive casts', d => d?.requests ?? 0, async (): Promise<NightDefensives | null> => {
      try {
        return await getNightDefensives(token, code, fights);
      } catch (err) {
        if (isRateLimitError(err)) throw err;
        console.error('night: defensive casts unavailable', err);
        return null;
      }
    }),
  ]);
  // The type-guessed list keeps only what no definition covers.
  const all = base.failed.roster ? null : pickAvoidable(base.abilities, boss, raidStats);
  const coveredIds = new Set(defined?.coveredIds ?? []);
  const coveredNames = new Set(defined?.coveredNames ?? []);
  const picked = all && { ...all, picked: all.picked.filter(a => !coveredNames.has(a.name.toLowerCase()) && !a.spellIds.some(id => coveredIds.has(id))) };
  let hits: NightHits | null = null;
  let hitsFailed = false;
  if (picked?.picked.length) {
    try {
      hits = await timed('other avoidable hits', h => h.requests, () => getNightHits(token, code, fights, picked.picked, cutoffs, base.roster.map(p => p.id)));
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      console.error('night: hits unavailable', err);
      hitsFailed = true;
    }
  }
  const review = buildNightReview({ code, group, base, hits, picked, boss, raidStats, hitsFailed, defensives, defined, definedFailed });
  review.load = { ...load, 'before the next pull': review.nextPull.ranked.join(' ‖ '), 'wipe precursors': (defined?.precursors ?? []).map(x => `${x.wipe} ← ${x.name}: ${JSON.stringify(x.byFight)}`).join(' ‖ '), total: `${review.requests} req · ${((Date.now() - t0) / 1000).toFixed(1)}s` };
  return { review, partial: base.failed.deaths || base.failed.roster || hitsFailed || definedFailed || !boss || !raidStats || !defensives };
}
