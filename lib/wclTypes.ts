// Shapes of the Warcraft Logs and Blizzard JSON this app reads, plus the few derived
// shapes it builds from them. Pure types and two dependency-free guards — safe to import
// from client components (lib/wow.ts re-exports everything here, but pulls in
// server-only next/cache itself). Each interface lists the fields the code actually
// reads, not the vendor's full schema: both APIs return far more than this, and a field
// missing here is unread, not absent.

// ─── Errors ───────────────────────────────────────────────────────────────────

// A 429 from WCL or Blizzard is thrown as a plain Error carrying these two extra
// fields, so route handlers and the export script can tell "rate-limited, pause and
// resume" from "this one combo failed". retryAfter is the raw Retry-After header
// (seconds, as a string), or null when the vendor sent none.
export interface RateLimitError extends Error {
  isRateLimit?: boolean;
  retryAfter?: string | null;
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return typeof err === 'object' && err !== null && 'isRateLimit' in err && !!err.isRateLimit;
}

// Whatever was thrown, as text for a JSON error body: an Error's (or error-shaped
// object's) message, otherwise the value itself stringified.
export function errorMessage(err: unknown): string {
  const message = typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined;
  return typeof message === 'string' ? message : String(message ?? err);
}

// ─── WCL: GraphQL envelope ────────────────────────────────────────────────────

export interface WclGraphQLResponse<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}

// ─── WCL: zones and encounters ────────────────────────────────────────────────

export interface WclEncounter {
  id: number;
  name: string;
  // Blizzard's JournalEncounter id. WCL returns 0 for zones it hasn't mapped yet (see
  // RAID_JOURNAL_ID_FALLBACK in lib/wow.ts).
  journalID?: number | null;
}

export interface WclZone {
  id: number;
  name: string;
  frozen?: boolean | null;
  expansion?: { id: number; name: string } | null;
  encounters?: WclEncounter[] | null;
}

export interface WclZonesData {
  worldData?: { zones?: WclZone[] | null } | null;
}

export interface WclZoneEncountersData {
  worldData?: { zone?: { encounters?: WclEncounter[] | null } | null } | null;
}

// ─── WCL: character rankings ──────────────────────────────────────────────────

// One gear slot as characterRankings(includeCombatantInfo: true) returns it inline.
// Ids and levels are coerced with Number() where they are read, so they are typed as
// loosely as that coercion tolerates.
export interface WclRankingGearItem {
  id?: number | string | null;
  itemLevel?: number | string | null;
  icon?: string | null;
  bonusIDs?: Array<number | string> | null;
}

// One inline talent: talentID is the trait ENTRY id (the same id CombatantInfo
// telemetry reports as a talentTree row's `id`), points the rank taken.
export interface WclRankingTalent {
  talentID: number;
  points: number;
}

// A ranking row after getWclRankings' compaction: WCL's own fields pass through
// untouched (rows are spread into client props), with the bulky inline gear/talents
// replaced by _tp = [entryId, points] pairs and _tg = positional [itemId, ilvl] pairs
// (0 = empty slot). Both are server-side only and stripped before a row reaches the
// client; rows past the compaction margins carry neither.
export interface WclRankingRow {
  name: string;
  class?: string;
  spec?: string;
  amount: number; // the ranking metric's value (dps, hps, …)
  duration?: number;
  startTime?: number;
  hardModeLevel?: number;
  rankPercent?: number;
  score?: number;
  bracketData?: number;
  faction?: number;
  report?: { code: string; fightID: number; startTime?: number };
  guild?: { id?: number; name?: string; faction?: number } | null;
  server?: { id?: number; name?: string; slug?: string; region?: string };
  _tp?: Array<[number, number]>;
  _tg?: Array<[number, number]>;
}

// The row exactly as WCL returns it, before compaction.
export interface WclRawRankingRow extends WclRankingRow {
  gear?: WclRankingGearItem[] | null;
  talents?: WclRankingTalent[] | null;
}

// characterRankings is a JSON scalar in WCL's schema, not a typed GraphQL object.
export interface WclCharacterRankingsData {
  worldData?: { encounter?: { characterRankings?: { rankings?: WclRawRankingRow[] | null } | null } | null } | null;
}

export interface WclItemEntry {
  ilvl: number;
  icon: string;
  bonusIds: number[];
}

// Keyed by item id: the best-ilvl copy of each item seen across a response's top rows.
export type WclItemData = Record<number, WclItemEntry>;

// What getWclRankings returns: a plain array of rows with the aggregated item dict
// riding along as a non-JSON property — invisible to array consumers, lost on
// serialization, lifted into CachedRankings.itemData by getRankingsCachedSWR.
export type WclRankingsWithItemData = WclRankingRow[] & { _itemData?: WclItemData };

// ─── WCL: fight telemetry ─────────────────────────────────────────────────────

// One talentTree row. `id` is the trait entry id — present on real CombatantInfo rows
// and on rows synthesized from inline talents, absent on the consensus pseudo-
// telemetry makeTelemetry builds.
export interface WclTalentRow {
  nodeID: number;
  rank: number;
  id?: number;
}

// A gear slot on a CombatantInfo event. Rows synthesized from a ranking's _tg carry
// id and itemLevel only; icons and bonus ids then come from the combo's WclItemData.
export interface WclGearItem {
  id: number;
  itemLevel: number;
  icon?: string;
  bonusIDs?: number[];
}

export interface WclCombatantInfoEvent {
  sourceID?: number;
  talentTree?: WclTalentRow[];
  gear?: WclGearItem[];
}

// One player's fight telemetry. event is null when the report is private/deleted or
// the player has no CombatantInfo in that fight; sourceId is the player's actor id in
// the report (null when unmatched or synthesized, absent on makeTelemetry's output).
export interface WclTelemetry {
  sourceId?: number | null;
  event: WclCombatantInfoEvent | null;
}

export interface WclReportActor {
  id: number;
  name?: string | null;
  server?: string | null;
}

// The sub-selection both telemetry queries make on a report.
export interface WclReportTelemetry {
  masterData?: { actors?: WclReportActor[] | null } | null;
  events?: { data?: WclCombatantInfoEvent[] | null } | null;
}

export interface WclReportTelemetryData {
  reportData?: { report?: WclReportTelemetry | null } | null;
}

// The batched query aliases `report` once per player (p0, p1, …), so reportData is
// keyed by alias here; a private/deleted report comes back null under its alias.
export interface WclReportTelemetryBatchData {
  reportData?: Record<string, WclReportTelemetry | null> | null;
}

// The least a ranked player must carry to have their Blizzard profile looked up.
export type WclProfileTarget = Pick<WclRankingRow, 'name' | 'server'>;

// …and to have their fight telemetry fetched (or synthesized from inline talents).
export type WclTelemetryTarget = Pick<WclRankingRow, 'name' | 'server' | 'report' | '_tp' | '_tg'>;

// ─── Blizzard: character profile ──────────────────────────────────────────────

// One selected node of a saved loadout. tooltip.talent.id is Blizzard's talent-catalog
// id — a different id space from WCL's trait entry ids (see harvestEntryTalentPairs).
export interface BlizzardLoadoutNode {
  id: number;
  rank: number;
  tooltip?: { talent?: { id?: number; name?: string } };
}

export interface BlizzardLoadout {
  is_active?: boolean;
  talent_loadout_code?: string;
  selected_class_talents?: BlizzardLoadoutNode[];
  selected_spec_talents?: BlizzardLoadoutNode[];
  selected_hero_talents?: BlizzardLoadoutNode[];
}

// /profile/wow/character/{realm}/{name}/specializations
export interface BlizzardSpecializationsProfile {
  specializations?: Array<{
    specialization?: { id?: number; name?: string };
    loadouts?: BlizzardLoadout[];
  }>;
}

// /profile/wow/character/{realm}/{name}/character-media
export interface BlizzardCharacterMedia {
  assets?: Array<{ key: string; value: string }>;
}

// The profile endpoints whose response shape is modelled here. Any other endpoint
// (equipment, statistics, …) still fetches fine through blizzardCharacterProfileFetch —
// its caller names the shape it expects.
export interface BlizzardProfileEndpoints {
  'specializations': BlizzardSpecializationsProfile;
  'character-media': BlizzardCharacterMedia;
}

// ─── Blizzard: talent trees (static game data) ────────────────────────────────

export interface BlizzardSpellTooltip {
  spell?: { id?: number; name?: string };
  description?: string;
  cast_time?: string;
  range?: string;
  power_cost?: string | null;
  cooldown?: string;
}

export interface BlizzardTalentTooltip {
  talent?: { id?: number; name?: string };
  spell_tooltip?: BlizzardSpellTooltip;
}

// A node's rank carries either one tooltip, or (choice nodes) one per option.
export interface BlizzardTalentRank {
  default_points?: number;
  tooltip?: BlizzardTalentTooltip;
  choice_of_tooltips?: BlizzardTalentTooltip[];
}

export interface BlizzardTalentNode {
  id: number;
  display_row: number;
  display_col: number;
  ranks?: BlizzardTalentRank[];
}

export interface BlizzardHeroTalentTree {
  id: number;
  name: string;
  media?: { key?: { href?: string } };
  hero_talent_nodes?: BlizzardTalentNode[];
}

// /data/wow/talent-tree/{treeId}/playable-specialization/{specId}
export interface BlizzardTalentTree {
  class_talent_nodes?: BlizzardTalentNode[];
  spec_talent_nodes?: BlizzardTalentNode[];
  hero_talent_trees?: BlizzardHeroTalentTree[];
}

// One spec's entry in the index; its href names both the tree id and the spec id.
export interface BlizzardTalentTreeIndexEntry {
  key: { href: string };
}

// /data/wow/talent-tree/index
export interface BlizzardTalentTreeIndex {
  spec_talent_trees?: BlizzardTalentTreeIndexEntry[];
}
