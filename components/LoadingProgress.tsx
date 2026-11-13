'use client';

import { useEffect, useState } from 'react';
import { REVIEW_STAGES, type LoadingStage } from '../lib/loadingStages';

// An indeterminate progress bar with staged status text for the parts of the site
// that fetch from Warcraft Logs and Blizzard before they can render. The server
// builds each section in one pass, so there is no real percentage to show: the bar
// only signals activity, and the stages are timed from how long each step usually
// takes. The elapsed clock is the one honest number on screen. Every stage set
// describes what that section's code actually fetches, in the order it does.
//
// The stage sets live in lib/loadingStages.ts, a plain module: a server component
// cannot call a function exported from this 'use client' file, and tierListStages()
// is called from one (components/TierListLoading.tsx).

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
