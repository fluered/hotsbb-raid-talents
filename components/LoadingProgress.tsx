'use client';

import { useEffect, useState } from 'react';

// An indeterminate progress bar with staged status text for the parts of the site
// that fetch from Warcraft Logs and Blizzard before they can render. The server
// builds each section in one pass, so there is no real percentage to show: the bar
// only signals activity, and the stages are timed from how long each step usually
// takes. The elapsed clock is the one honest number on screen. Every stage set
// below describes what that section's code actually fetches, in the order it does.

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

export type LoadingAccent = 'amber' | 'sky' | 'emerald';
const ACCENT: Record<LoadingAccent, { box: string; title: string; bar: string; current: string }> = {
  amber: { box: 'border-amber-500/20 bg-amber-500/5', title: 'text-amber-400/80', bar: 'from-amber-500/0 via-amber-400 to-amber-500/0', current: 'text-amber-300' },
  sky: { box: 'border-sky-500/20 bg-sky-500/5', title: 'text-sky-400/80', bar: 'from-sky-500/0 via-sky-400 to-sky-500/0', current: 'text-sky-300' },
  emerald: { box: 'border-emerald-500/20 bg-emerald-500/5', title: 'text-emerald-400/80', bar: 'from-emerald-500/0 via-emerald-400 to-emerald-500/0', current: 'text-emerald-300' },
};

export default function LoadingProgress({ stages = REVIEW_STAGES, accent = 'amber' }: { stages?: LoadingStage[]; accent?: LoadingAccent }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
  }, []);
  const stage = stages.reduce((s, x) => (elapsed >= x.at ? x : s), stages[0]);
  const stageIndex = stages.indexOf(stage);
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const c = ACCENT[accent];
  // The trailing "Still working" stage is a reassurance, not a step, so it stays off the step list.
  const steps = stages.filter(s => s.title !== 'Still working');

  return (
    <div className={`rounded-2xl border p-6 space-y-4 ${c.box}`}>
      <style>{`
        @keyframes hb-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }
        .hb-bar { animation: hb-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
        @media (prefers-reduced-motion: reduce) { .hb-bar { animation-duration: 3.2s; } }
      `}</style>
      <div className="flex items-baseline justify-between gap-4">
        <p className={`text-xs font-bold uppercase tracking-widest ${c.title}`}>{stage.title}</p>
        <p className="text-xs text-zinc-500 tabular-nums font-mono" aria-live="off">{clock}</p>
      </div>
      <div className="h-1.5 w-full rounded-full bg-zinc-800/80 overflow-hidden" role="progressbar" aria-label="Working" aria-busy="true">
        <div className={`hb-bar h-full w-1/4 rounded-full bg-gradient-to-r ${c.bar}`} />
      </div>
      <p className="text-sm text-zinc-400" aria-live="polite">{stage.text}</p>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
        {steps.map((s, i) => (
          <li key={s.title} className={i < stageIndex ? 'text-zinc-400 line-through decoration-zinc-600' : i === stageIndex ? c.current : ''}>
            {s.title}
          </li>
        ))}
      </ol>
    </div>
  );
}
