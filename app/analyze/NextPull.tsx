import type { ReactNode } from 'react';
import Image from 'next/image';
import { fmtClock } from '../../lib/analyzeRules';
import { approxTimes, cooldownWords, type DefensivePlan, type NextPull, type NextPullAction, type PlanPart, type PlanSpell } from '../../lib/nextPull';

// The forward-looking half of a player review (lib/nextPull.ts): what to do on the next
// attempt, and which defensive goes on which damage. Server-rendered, no state.

const ABILITY_ICON = (icon: string) => `https://assets.rpglogs.com/img/warcraft/abilities/${icon}`;

// A spell inside a sentence: its icon and name, linked to Wowhead like every other spell on the page.
function Spell({ spell, strong }: { spell: PlanSpell; strong?: boolean }) {
  const body = (
    <>
      {spell.icon && <Image src={ABILITY_ICON(spell.icon)} alt="" width={18} height={18} unoptimized className="inline-block w-[1.15em] h-[1.15em] rounded-[3px] border border-zinc-700 align-[-0.2em] mr-1" />}
      <span className={strong ? 'font-bold text-zinc-50' : 'font-semibold text-zinc-200'}>{spell.name}</span>
    </>
  );
  return spell.spellId
    ? <a href={`https://www.wowhead.com/spell=${spell.spellId}`} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap hover:text-amber-200 underline decoration-zinc-600 underline-offset-4 decoration-dotted">{body}</a>
    : <span className="whitespace-nowrap">{body}</span>;
}

// The moment: a time, a phase or a number to aim for, set apart from the sentence.
function Chip({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.86em] text-amber-200 bg-amber-500/10 border border-amber-500/25 rounded px-1.5 py-px [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">{children}</span>;
}

function Parts({ parts }: { parts: PlanPart[] }) {
  return (
    <>
      {parts.map((p, i) => p.t === 'spell' ? <Spell key={i} spell={p} strong /> : p.t === 'time' ? <Chip key={i}>{p.v}</Chip> : <span key={i}>{p.v}</span>)}
    </>
  );
}

function ActionItem({ action, n }: { action: NextPullAction; n: number }) {
  return (
    <li data-plan={action.id} className="flex gap-3">
      <span className="shrink-0 w-7 h-7 rounded-full bg-emerald-400/15 border border-emerald-400/40 text-emerald-300 text-sm font-black flex items-center justify-center tabular-nums mt-0.5">{n}</span>
      <div className="min-w-0 space-y-1">
        <p className="text-base md:text-lg leading-snug text-zinc-100 font-medium"><Parts parts={action.parts} /></p>
        {action.evidence && <p className="text-xs md:text-sm text-zinc-400 leading-relaxed">{action.evidence}</p>}
      </div>
    </li>
  );
}

export function NextPullSection({ plan, kill }: { plan: NextPull; kill: boolean }) {
  if (!plan.actions.length && !plan.clean) return null;
  const played = plan.actions.filter(a => a.kind !== 'prep');
  const prep = plan.actions.filter(a => a.kind === 'prep');
  return (
    <section data-next-pull className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-5 md:p-6 space-y-4">
      <div className="space-y-0.5">
        <p className="text-xs font-bold uppercase tracking-widest text-emerald-400">Next pull</p>
        {played.length > 0 && <p className="text-xs text-zinc-500">{played.length === 1 ? 'The one thing' : `The ${played.length === 2 ? 'two' : 'three'} things`} to do differently on the next {kill ? 'kill' : 'attempt'}, biggest first.</p>}
      </div>
      {plan.clean && <p className="text-base md:text-lg leading-snug text-zinc-100 font-medium">{plan.clean}</p>}
      {played.length > 0 && (
        <ol className="space-y-4">
          {played.map((a, i) => <ActionItem key={a.id} action={a} n={i + 1} />)}
        </ol>
      )}
      {prep.length > 0 && (
        <div className={`space-y-3 ${played.length || plan.clean ? 'pt-3 border-t border-emerald-500/15' : ''}`}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Before the pull</p>
          <ol className="space-y-4">
            {prep.map((a, i) => <ActionItem key={a.id} action={a} n={played.length + i + 1} />)}
          </ol>
        </div>
      )}
    </section>
  );
}

export function DefensivePlanSection({ plan }: { plan: DefensivePlan }) {
  return (
    <section data-defensive-plan className="space-y-2.5">
      <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Defensive plan for this fight</h2>
      <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 divide-y divide-zinc-800/50">
        {plan.rows.map(r => (
          <div key={`${r.kind}-${r.ability.name}`} className="px-4 py-2.5 space-y-1.5">
            <p className="text-sm leading-relaxed text-zinc-300 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <Spell spell={r.ability} />
              <Chip>{approxTimes(r.times)}</Chip>
              {r.sizePct != null && <span className="text-xs text-zinc-500">{r.kind === 'dodge' ? `${r.sizePct}% of your health over the pull` : `about ${r.sizePct}% of your health in 5 seconds`}</span>}
            </p>
            <p className="text-sm leading-relaxed text-zinc-300 pl-3 border-l-2 border-zinc-700 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {r.kind === 'dodge' && <span className="text-amber-300 font-semibold">Step out of it. No defensive.</span>}
              {r.kind === 'skip' && <span className="text-zinc-400">Nothing of yours is free for it.</span>}
              {r.assign.map((a, i) => (
                <span key={a.spell.name} className="inline-flex flex-wrap items-baseline gap-x-1.5">
                  {i > 0 && <span className="text-zinc-500">then</span>}
                  <Spell spell={a.spell} strong />
                  {r.times.length > 1 && <span className="font-mono text-xs text-zinc-400">{a.times.length === r.times.length ? 'each time' : `at ${a.times.map(fmtClock).join(', ')}`}</span>}
                  <span className="text-xs text-zinc-500">{cooldownWords(a.cooldownSec)} cooldown{a.charges > 1 ? `, ${a.charges} charges` : ''}</span>
                </span>
              ))}
            </p>
            {r.poolNote && <p className="text-xs text-zinc-500 pl-3 border-l-2 border-transparent">{r.poolNote[0].toUpperCase()}{r.poolNote.slice(1)}.</p>}
          </div>
        ))}
      </div>
      <p className="text-xs text-zinc-500">{plan.note}</p>
    </section>
  );
}
