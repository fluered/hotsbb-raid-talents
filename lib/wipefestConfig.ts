import { getOrSetPersistent } from './persistentCache';

// ─── Wipefest fight configurations ─────────────────────────────────────────────
//
// Wipefest (wipefest.gg) publishes, per boss, the hand-written definitions behind its
// mechanic insights: typed filters over Warcraft Logs events ("damage from spell X to
// players", "debuff Y applied", "actor Z first seen / died") and insight rules that
// combine them ("hit by X without Y", "killed Z in N seconds"). The same ids Warcraft
// Logs uses key both. We read those definitions as a source of facts about each
// mechanic, the way DBM modules and the Blizzard journal are read, and compute every
// number ourselves from the log. Nothing of Wipefest's code is used; the definitions
// are credited on the page.
//
// Endpoint shapes were confirmed on 2026-10-19 against api.wipefest.gg (no auth; the
// game-version header picks retail). Definitions change with every tuning pass, so
// they are cached a day, and a failed fetch is never cached.

export interface WipefestEventFilter {
  type?: string;            // damage | applydebuff | removedebuff | applydebuffstack | cast | begincast | death | firstseen | dispel | interrupt | applybuff | removebuff | heal | summon | phase
  types?: string[];         // alternative to type
  ability?: { id?: number; ids?: number[] };
  actor?: { id: number };   // an NPC's game id (firstseen / death)
  phase?: { id: number };
  range?: number;           // ms: one event per target inside this window
  rangePer?: { range: number; target?: boolean; source?: boolean; instance?: boolean; minimum?: number };
  minimum?: number;         // with range: windows holding fewer events than this are dropped
  query?: string;           // a Warcraft Logs filter expression that replaces the above
  excludeNpcTargets?: boolean;
  excludeNpcSources?: boolean;
  excludeEnvironmentSources?: boolean;
  firstPerInstancePerActor?: boolean;
  playerRoles?: string[];
}

export interface WipefestEventConfig {
  id: string;
  name: string;
  tags: string[];
  show?: boolean;
  eventType: string;        // damage | debuff | debuffstack | removedebuff | ability | dispel | interrupt | heal | phase …
  friendly?: boolean;
  filter: WipefestEventFilter;
  group: string;            // 'raid' or the encounter id
  difficulties?: number[];
}

export interface WipefestStatistic {
  name: string;
  higherIsBetter?: boolean;
  require?: string;
  divideByFrequencyOf?: string;
  multiplyByRaidSize?: boolean;
  divideByRaidSize?: boolean;
  multiplyByFightLength?: boolean;
  divideByFightLength?: boolean;
}

export interface WipefestInsightConfig {
  id: string;
  group: string;
  name: string;
  type: string;             // hit | hitHard | hitWithoutDebuff | hitWithDebuff | hitUnlessRole | debuff | debuffUnlessRole | debuffDuration | removeDebuff | dispel | interrupt | cast | soak | custom | …
  title?: string;
  titleWhenNoEvents?: string;
  details?: string;
  tip?: string;
  tipEmbedUrl?: string;
  phases?: string;          // "P1", "P2"…
  difficulties?: number[];
  role?: string;            // Tank | Healer | DPS (hitUnlessRole, debuffUnlessRole)
  threshold?: number;
  gracePeriod?: number;
  debuffApplicationTimeRelativeToDamageTime?: number;
  countEndOfFightAsEndOfDebuff?: boolean;
  onlyMatchByTarget?: boolean;
  require?: string;         // "3513:E1E2H1H2" — pairs of event-config ids
  showIf?: string;
  statistics?: WipefestStatistic[];
  mainStatistic?: string;
  // How a player's own figure is scored on wipefest.gg: a positive weight (or isBonus)
  // means doing more of this is good (intercepts, soaks, interrupts).
  playerValue?: { value?: string; weight?: number; isBonus?: boolean };
}

export interface WipefestFightConfig {
  encounterId: number;
  fetchedAt: number;
  eventConfigs: WipefestEventConfig[];
  insightConfigs: WipefestInsightConfig[];
}

const API = 'https://api.wipefest.gg';
const HEADERS = { 'User-Agent': 'hotsbb-raid-talents (log review; definitions credited)', 'x-wipefest-game-version': 'warcraft-live', accept: 'application/json' };
const TTL_SECONDS = 86400;
export const WIPEFEST_CREDIT = 'mechanic definitions from Wipefest';
export const wipefestCredit = (config: { fetchedAt?: number } | null) => config?.fetchedAt ? `${WIPEFEST_CREDIT} (as of ${new Date(config.fetchedAt).toISOString().slice(0, 10)})` : WIPEFEST_CREDIT;

// The boss's definition set, or null when Wipefest has none for it (or is unreachable).
export async function getWipefestFightConfig(encounterId: number): Promise<WipefestFightConfig | null> {
  if (!encounterId) return null;
  try {
    const v = await getOrSetPersistent<WipefestFightConfig | { none: true }>(`wipefest-config-v2-${encounterId}`, TTL_SECONDS, async () => {
      const r = await fetch(`${API}/fightConfig/${encounterId}`, { headers: HEADERS, cache: 'no-store' });
      if (r.status === 404) return { none: true };
      if (!r.ok) throw new Error(`wipefest fightConfig ${encounterId}: ${r.status}`);
      const j = await r.json();
      const eventConfigs: WipefestEventConfig[] = Array.isArray(j?.eventConfigs) ? j.eventConfigs : [];
      const insightConfigs: WipefestInsightConfig[] = Array.isArray(j?.insightConfigs) ? j.insightConfigs : [];
      // A boss nobody has written up yet comes back with only the raid-wide set.
      if (!insightConfigs.some(c => String(c.group) === String(encounterId))) return { none: true };
      return { encounterId, fetchedAt: Date.now(), eventConfigs, insightConfigs };
    });
    return 'none' in v ? null : v;
  } catch (err) {
    console.error('wipefest config unavailable', err);
    return null;
  }
}

// "3513:E1E2H1H2" → ["E1", "E2", "H1", "H2"]. Ids are always two characters.
export function requireIds(spec: string | undefined): string[] {
  if (!spec) return [];
  const body = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
  return body.match(/.{2}/g) ?? [];
}

export function filterAbilityIds(f: WipefestEventFilter): number[] {
  const ids = [...(f.ability?.ids ?? []), ...(f.ability?.id != null ? [f.ability.id] : [])];
  return [...new Set(ids.filter(x => Number.isFinite(x)))];
}

export function filterTypes(f: WipefestEventFilter): string[] {
  return f.types?.length ? f.types : f.type ? [f.type] : [];
}
