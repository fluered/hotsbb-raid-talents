// Stage sets for components/LoadingProgress.tsx. Kept out of that 'use client' file
// so server components can import the data and call tierListStages() directly.

export interface LoadingStage { at: number; title: string; text: string }

// The log review (app/analyze): fight tables, then the top-30 pool, then the sources.
export const REVIEW_STAGES: LoadingStage[] = [
  { at: 0, title: 'Reading the log', text: 'Pulling the fight tables from Warcraft Logs: casts, buffs, damage taken, deaths.' },
  { at: 6, title: 'Lining you up against the top players', text: 'Loading the top 30 parses for your spec on this boss. If nobody has reviewed this spec here before, that pool is being built now and takes a minute or two.' },
  { at: 30, title: 'Checking the facts', text: 'Cooldowns, charges and item effects from Wowhead, mechanic types from Deadly Boss Mods, major cooldowns from lorrgs.' },
  { at: 75, title: 'Still working', text: 'A first review of a spec on a boss is the slow one. Everything it fetches is cached, so the next review of this spec takes a few seconds.' },
];

// A boss or dungeon build (BossContent): rankings, then each top player's talents,
// then their gear.
export const BUILD_STAGES: LoadingStage[] = [
  { at: 0, title: 'Fetching top parses', text: 'Pulling the top parses for this spec and boss from Warcraft Logs.' },
  { at: 5, title: 'Reading talents', text: 'Loading the talent loadout of up to 50 top players and counting which nodes they share.' },
  { at: 15, title: 'Checking gear', text: 'Equipment, stats, enchants and trinkets for the top players, from the Blizzard armory and Wowhead.' },
  { at: 45, title: 'Still working', text: 'The first load of a spec on a boss is the slow one. The result is cached, so the next load takes a moment.' },
];

// A tier list: the top 50 parses per spec (per boss, or on every boss), then the
// ranking. Rankings are cached for a week once built (unstable_cache revalidate).
export function tierListStages(opts: { scope: 'boss' | 'overall'; role: string; specCount: number; bossCount?: number }): LoadingStage[] {
  const { scope, role, specCount, bossCount = 0 } = opts;
  const fetching = scope === 'boss'
    ? `The top 50 parses for each of the ${specCount} ${role} specs on this boss, from Warcraft Logs.`
    : `The top 50 parses for each of the ${specCount} ${role} specs on every boss: ${specCount * bossCount} lists from Warcraft Logs, 20 at a time.`;
  const ranking = scope === 'boss'
    ? "Averaging each spec's top 50 and placing it in a tier relative to the strongest spec."
    : 'Averaging each spec across all bosses and placing it in a tier relative to the strongest spec.';
  return [
    { at: 0, title: 'Fetching top parses', text: fetching },
    { at: scope === 'boss' ? 8 : 12, title: 'Ranking specs', text: ranking },
    { at: scope === 'boss' ? 30 : 45, title: 'Still working', text: 'A tier list is cached for a week once built, so the next load of this one is quick.' },
  ];
}

// A tier-list page before its role and boss are known (the route's loading file).
export const TIER_LIST_STAGES: LoadingStage[] = [
  { at: 0, title: 'Fetching top parses', text: 'The top 50 parses for each spec, per boss, from Warcraft Logs.' },
  { at: 12, title: 'Ranking specs', text: 'Averaging each spec and placing it in a tier relative to the strongest spec.' },
  { at: 45, title: 'Still working', text: 'A tier list is cached for a week once built, so the next load of this one is quick.' },
];
