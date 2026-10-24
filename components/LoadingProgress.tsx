'use client';

import { useEffect, useState } from 'react';

// An indeterminate progress bar with staged status text for the log review's loading
// screen. The server builds the whole review in one pass, so there is no real
// percentage to show: the bar only signals activity, and the stages are timed from
// how long each step usually takes (fight tables in seconds, a cold top-30 pool in a
// minute or two). The elapsed clock is the one honest number on screen.

const STAGES: Array<{ at: number; title: string; text: string }> = [
  { at: 0, title: 'Reading the log', text: 'Pulling the fight tables from Warcraft Logs: casts, buffs, damage taken, deaths.' },
  { at: 6, title: 'Lining you up against the top players', text: 'Loading the top 30 parses for your spec on this boss. If nobody has reviewed this spec here before, that pool is being built now and takes a minute or two.' },
  { at: 30, title: 'Checking the facts', text: 'Cooldowns, charges and item effects from Wowhead, mechanic types from Deadly Boss Mods, major cooldowns from lorrgs.' },
  { at: 75, title: 'Still working', text: 'A first review of a spec on a boss is the slow one. Everything it fetches is cached, so the next review of this spec takes a few seconds.' },
];

export default function LoadingProgress() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
  }, []);
  const stage = STAGES.reduce((s, x) => (elapsed >= x.at ? x : s), STAGES[0]);
  const stageIndex = STAGES.indexOf(stage);
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-6 space-y-4">
      <style>{`
        @keyframes hb-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }
        .hb-bar { animation: hb-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
        @media (prefers-reduced-motion: reduce) { .hb-bar { animation-duration: 3.2s; } }
      `}</style>
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs font-bold uppercase tracking-widest text-amber-400/80">{stage.title}</p>
        <p className="text-xs text-zinc-500 tabular-nums font-mono" aria-live="off">{clock}</p>
      </div>
      <div className="h-1.5 w-full rounded-full bg-zinc-800/80 overflow-hidden" role="progressbar" aria-label="Working" aria-busy="true">
        <div className="hb-bar h-full w-1/4 rounded-full bg-gradient-to-r from-amber-500/0 via-amber-400 to-amber-500/0" />
      </div>
      <p className="text-sm text-zinc-400" aria-live="polite">{stage.text}</p>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
        {STAGES.slice(0, 3).map((s, i) => (
          <li key={s.title} className={i < stageIndex ? 'text-zinc-400 line-through decoration-zinc-600' : i === stageIndex ? 'text-amber-300' : ''}>
            {s.title}
          </li>
        ))}
      </ol>
    </div>
  );
}
