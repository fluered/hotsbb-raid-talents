import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import LinkPending from '../../components/LinkPending';
import CopyDiscordButton from '../../components/CopyDiscordButton';
import { POPULAR_SPECS } from '../../lib/wow';
import { DIFFICULTY_LABELS } from '../../lib/analyze';
import { fmtClock, fmtNum, plural } from '../../lib/analyzeRules';
import { MECHANIC_WORDS } from '../../lib/bossMechanics';
import { NIGHT_FIRST_DEATHS, NIGHT_MAX_PULLS, type NightPull, type NightReview } from '../../lib/nightReview';

// The night view: every pull of one boss in one report, read the way a raid leader
// reads a progression night. Server-rendered throughout; the only client code is the
// copy button.

const ABILITY_ICON = (icon: string) => `https://assets.rpglogs.com/img/warcraft/abilities/${icon}`;
const BOSS_ICON = (encounterId: number) => `https://assets.rpglogs.com/img/warcraft/bosses/${encounterId}-icon.jpg`;
const classColor = (className: string) => POPULAR_SPECS.find(c => c.class === className)?.color ?? 'text-zinc-200';

const LABEL = 'text-xs font-bold uppercase tracking-widest text-zinc-500';
const BORDER = { bad: 'border-l-red-500/70', warn: 'border-l-amber-500/70', good: 'border-l-emerald-500/70', info: 'border-l-zinc-600' } as const;

function AbilityIcon({ icon, spellId, size = 36 }: { icon: string; spellId: number; size?: number }) {
  const cls = size >= 36 ? 'w-9 h-9 rounded-lg' : 'w-5 h-5 rounded';
  const img = icon
    ? <Image src={ABILITY_ICON(icon)} alt="" width={size} height={size} unoptimized className={`${cls} shrink-0 border border-zinc-800`} />
    : <span className={`${cls} shrink-0 bg-zinc-900 border border-zinc-800 inline-block`} />;
  const wrap = size >= 36 ? 'shrink-0 mt-0.5' : 'shrink-0';
  return spellId ? <a href={`https://www.wowhead.com/spell=${spellId}`} target="_blank" rel="noopener noreferrer" className={wrap}>{img}</a> : <span className={wrap}>{img}</span>;
}

function Card({ severity, icon, spellId, title, text, children }: { severity: keyof typeof BORDER; icon: string; spellId: number; title: string; text?: string; children?: React.ReactNode }) {
  return (
    <li className={`rounded-xl border border-zinc-800/70 border-l-4 ${BORDER[severity]} bg-zinc-900/40 p-4 flex gap-3`}>
      <AbilityIcon icon={icon} spellId={spellId} />
      <div className="min-w-0 space-y-1 flex-1">
        <p className="font-bold text-zinc-100 leading-snug">{title}</p>
        {text && <p className="text-sm text-zinc-400 leading-relaxed">{text}</p>}
        {children}
      </div>
    </li>
  );
}

function Rows({ label, open, children }: { label: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="pt-1 group" open={open}>
      <summary className="cursor-pointer text-xs font-bold text-amber-400/90 hover:text-amber-300 select-none list-none">
        <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span> {label}
      </summary>
      <ul className="mt-2 grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">{children}</ul>
    </details>
  );
}

function PlayerRow({ href, name, className, value }: { href: string; name: string; className: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-zinc-800/50 py-1 min-w-0">
      <Link href={href} className={`font-semibold ${classColor(className)} hover:underline underline-offset-2 truncate`}>{name}</Link>
      <span className="text-xs font-mono text-zinc-400 truncate shrink-0 max-w-[65%]">{value}</span>
    </li>
  );
}

const KILLER_CARDS = 6;
const pullList = (ns: number[]) => `${ns.length === 1 ? 'pull' : 'pulls'} ${ns.slice(0, 6).join(', ')}${ns.length > 6 ? '…' : ''}`;

// ─── Progress across pulls ────────────────────────────────────────────────────
//
// One column per pull, in order. The bar is how far the pull got (boss health taken
// off, so taller is further and a kill fills the column); underneath, on the same
// columns, how long it lasted and how many died before the wipe. Three small charts
// on one x axis rather than three measures on one y axis. Every column is a link to
// that pull's raid summary and carries the figures as its tooltip; the table under
// the chart holds the same numbers as text.
function PullChart({ night }: { night: NightReview }) {
  const pulls = night.pulls;
  const dense = pulls.length > 20;
  const maxDur = Math.max(1, ...pulls.map(p => p.durationSec));
  const maxDeaths = Math.max(1, ...pulls.map(p => p.deathsBefore ?? 0));
  const bestWipe = pulls.filter(p => !p.kill).sort((a, b) => a.pct - b.pct)[0];
  const href = (p: NightPull) => `/analyze?report=${night.code}&fight=${p.fightId}`;
  const tip = (p: NightPull) => `Pull ${p.n}: ${p.kill ? 'kill' : `${Math.round(p.pct)}% left`} · ${fmtClock(p.durationSec)}${p.deathsBefore != null ? ` · ${plural(p.deathsBefore, 'death')} ${p.kill ? '' : 'before the wipe'}` : ''}${p.wipe ? ` · wiped to ${p.wipe.killer}` : ''}`.trim();
  const every = pulls.length <= 12 ? 1 : pulls.length <= 20 ? 2 : 5;
  const gap = dense ? 'gap-px' : 'gap-0.5 sm:gap-1';
  return (
    <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3 sm:p-4 space-y-3">
      <div className="flex gap-2">
        <div className="w-7 shrink-0 h-28 flex flex-col justify-between text-[9px] font-mono text-zinc-600 text-right leading-none">
          <span>kill</span><span>50%</span><span>pull</span>
        </div>
        <div className="relative flex-1 min-w-0 h-28">
          <div className="absolute inset-x-0 top-0 border-t border-zinc-800" />
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-zinc-800" />
          <div className="absolute inset-x-0 bottom-0 border-t border-zinc-700" />
          <div className={`absolute inset-0 flex items-end ${gap}`}>
            {pulls.map(p => {
              const got = p.kill ? 100 : Math.max(0, Math.min(100, 100 - p.pct));
              const colour = p.kill ? 'bg-emerald-400' : p === bestWipe ? 'bg-amber-400' : 'bg-zinc-500 group-hover/bar:bg-zinc-300';
              return (
                <Link key={p.fightId} href={href(p)} title={tip(p)} aria-label={tip(p)} data-pull={p.n} className="group/bar relative flex-1 min-w-0 h-full flex flex-col justify-end items-center">
                  {!dense && <span className={`text-[9px] font-mono leading-none mb-0.5 ${p.kill ? 'text-emerald-300' : p === bestWipe ? 'text-amber-300' : 'text-zinc-500'}`}>{p.kill ? 'K' : Math.round(p.pct)}</span>}
                  <span className={`block w-full max-w-6 rounded-t-sm ${colour} transition-colors`} style={{ height: `${Math.max(2, got * 0.86)}%` }} />
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex gap-2 items-end">
        <span className="w-7 shrink-0 text-[9px] font-mono text-zinc-600 text-right leading-none pb-px">time</span>
        <div className={`flex-1 min-w-0 h-6 flex items-end ${gap} border-b border-zinc-800`}>
          {pulls.map(p => (
            <Link key={p.fightId} href={href(p)} title={tip(p)} tabIndex={-1} aria-hidden className="flex-1 min-w-0 h-full flex items-end justify-center">
              <span className="block w-full max-w-6 rounded-t-sm bg-sky-400/60" style={{ height: `${Math.max(6, 100 * p.durationSec / maxDur)}%` }} />
            </Link>
          ))}
        </div>
      </div>

      <div className="flex gap-2 items-center">
        <span className="w-7 shrink-0 text-[9px] font-mono text-zinc-600 text-right leading-none">died</span>
        <div className={`flex-1 min-w-0 flex ${gap}`}>
          {pulls.map(p => {
            const d = p.deathsBefore;
            // Shade by count so a dense night still reads; the digit is shown when it fits.
            const shade = d == null ? 'bg-zinc-900 text-zinc-600' : d === 0 ? 'bg-zinc-800/60 text-zinc-500' : d / maxDeaths > 0.66 ? 'bg-red-500/50 text-red-100' : d / maxDeaths > 0.33 ? 'bg-red-500/30 text-red-100' : 'bg-red-500/15 text-red-200';
            return (
              <Link key={p.fightId} href={href(p)} title={tip(p)} tabIndex={-1} aria-hidden className="flex-1 min-w-0 flex justify-center">
                <span className={`block w-full max-w-6 h-4 rounded-sm text-[9px] font-mono leading-4 text-center overflow-hidden ${shade}`}>{dense ? '' : d ?? '?'}</span>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2">
        <span className="w-7 shrink-0 text-[9px] font-mono text-zinc-600 text-right leading-none">#</span>
        <div className={`flex-1 min-w-0 flex ${gap}`}>
          {pulls.map((p, i) => (
            <span key={p.fightId} className="flex-1 min-w-0 text-center text-[9px] font-mono text-zinc-600 leading-none overflow-visible whitespace-nowrap">{i % every === 0 || i === pulls.length - 1 && every === 1 ? p.n : ''}</span>
          ))}
        </div>
      </div>

      <p className="text-xs text-zinc-500 leading-relaxed">
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-zinc-500 align-middle mr-1" />how far each pull got{!dense && ' (the number is the % left)'} ·{' '}
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-400 align-middle mr-1" />best wipe ·{' '}
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-400 align-middle mr-1" />kill ·{' '}
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-sky-400/60 align-middle mr-1" />how long it lasted ·{' '}
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500/40 align-middle mr-1" />deaths before the wipe was called. Every column opens that pull.
      </p>

      <details className="group">
        <summary className="cursor-pointer text-xs font-bold text-amber-400/90 hover:text-amber-300 select-none list-none">
          <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span> {pulls.length} pulls as a list
        </summary>
        <ul className="mt-2 text-sm divide-y divide-zinc-800/50">
          {pulls.map(p => (
            <li key={p.fightId}>
              <Link href={href(p)} className="flex items-center gap-3 py-1.5 hover:bg-zinc-900/60 rounded px-1 -mx-1">
                <span className="text-xs font-mono text-zinc-500 w-7 shrink-0">#{p.n}</span>
                <span className={`w-16 shrink-0 whitespace-nowrap font-mono text-xs ${p.kill ? 'text-emerald-300 font-bold' : 'text-zinc-200'}`}>{p.kill ? 'Kill' : `${Math.round(p.pct)}% left`}</span>
                <span className="text-xs font-mono text-zinc-500 w-10 shrink-0">{fmtClock(p.durationSec)}</span>
                <span className="text-xs text-zinc-400 min-w-0 truncate flex-1">
                  {p.deathsBefore == null ? 'deaths not loaded' : p.deathsBefore === 0 ? (p.kill ? 'nobody died' : 'nobody died first') : `${p.deathsBefore} died${p.kill ? '' : ' first'}`}
                  {p.firstDeath ? ` · ${p.firstDeath.name} to ${p.firstDeath.killer} at ${fmtClock(p.firstDeath.atSec)}` : ''}
                  {p.wipe ? ` · wipe: ${p.wipe.killer}` : ''}
                </span>
                <LinkPending label="opening" />
              </Link>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ─── The page ─────────────────────────────────────────────────────────────────

export default function NightView({ night, reportTitle, discordText }: { night: NightReview; reportTitle: string; discordText: string }) {
  const { code, pulls } = night;
  const wipes = pulls.filter(p => !p.kill).length;
  const playerHref = (fightId: number, id: number) => `/analyze?report=${code}&fight=${fightId}&player=${id}`;
  const fallbackPulls = pulls.filter(p => p.rule === 'first-deaths').length;
  const raidSize = night.players.length || 1;
  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <Image src={BOSS_ICON(night.encounterID)} alt="" width={48} height={48} unoptimized className="w-12 h-12 rounded-xl object-cover mt-0.5" />
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl md:text-3xl font-black tracking-tight leading-tight">{night.bossName} <span className="text-zinc-400 font-bold">· night summary</span></h1>
            <p className="text-sm text-zinc-400">
              {DIFFICULTY_LABELS[night.difficulty] ?? ''} · {plural(pulls.length, 'pull')} · <span className="text-zinc-500">{reportTitle}</span>
              {' · '}
              <Link href={`/analyze?report=${code}`} className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">all pulls</Link>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyDiscordButton text={discordText} />
        </div>
      </header>

      <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-transparent p-5 md:p-6 space-y-2">
        <p className="text-xs font-bold uppercase tracking-widest text-amber-400">The short version</p>
        <p className="text-lg md:text-xl leading-snug text-zinc-100 font-medium">{night.summary}</p>
        {night.capped && <p className="text-xs text-zinc-500 pt-1">This report has {night.totalPulls} pulls of this boss; the newest {NIGHT_MAX_PULLS} are read here.</p>}
      </section>

      <section className="grid grid-cols-3 sm:grid-cols-5 gap-2">
        {night.stats.map(s => (
          <div key={s.label} className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-3 py-2.5 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 truncate">{s.label}</p>
            <p className="text-lg font-black text-zinc-100 tabular-nums leading-tight">{s.value}</p>
            {s.note && <p className="text-[10px] text-zinc-500 truncate">{s.note}</p>}
          </div>
        ))}
      </section>

      {night.notes.length > 0 && (
        <ul className="space-y-1">{night.notes.map(n => <li key={n} className="text-xs text-amber-300/80">{n}</li>)}</ul>
      )}

      <section className="space-y-2.5">
        <h2 className={LABEL}>Progress across pulls</h2>
        <PullChart night={night} />
        {night.trend.length > 0 && (
          <ul className="space-y-1" data-trend>
            {night.trend.map(t => <li key={t} className="text-sm text-zinc-300 leading-relaxed">{t}</li>)}
          </ul>
        )}
      </section>

      {night.wipeCauses.length > 0 && (
        <section className="space-y-2.5">
          <h2 className={LABEL}>What wiped the raid</h2>
          <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 divide-y divide-zinc-800/50">
            {night.wipeCauses.map(w => (
              <div key={w.name} className="flex items-center gap-3 px-4 py-2 text-sm min-w-0">
                <AbilityIcon icon={w.icon} spellId={w.spellId} size={20} />
                <span className="font-semibold text-zinc-200 min-w-0 flex-1 truncate">{w.name === 'unknown damage' ? 'No killing blow recorded' : w.name}</span>
                <span className="text-xs text-zinc-500 shrink-0 hidden sm:inline">{pullList(w.pullNumbers)}</span>
                <span className="text-xs font-mono text-zinc-300 shrink-0 tabular-nums">{w.pulls} of {plural(wipes, 'wipe')}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-500">Five or more players dead to one ability inside three seconds is the pull ending: those deaths are counted against nobody.</p>
        </section>
      )}

      <section className="space-y-2.5">
        <h2 className={LABEL}>What killed people{wipes ? ' before the wipes' : ''}</h2>
        {night.killers.length === 0 && (
          <p className="text-sm text-zinc-400">{pulls.some(p => p.rule === 'unknown') && !night.countedDeaths ? 'The death tables could not be loaded.' : 'Nobody died before a wipe was called.'}</p>
        )}
        <ul className="space-y-2">
          {night.killers.slice(0, KILLER_CARDS).map(k => (
            <Card key={k.name} severity={k.pulls >= Math.max(3, pulls.length / 3) ? 'bad' : k.pulls >= 2 ? 'warn' : 'info'} icon={k.icon} spellId={k.spellId}
              title={`${k.name} killed someone on ${k.pulls} of ${plural(pulls.length, 'pull')}`}
              text={`${plural(k.deaths, 'death')} across ${plural(k.players.length, 'player')}.${k.typeWords ? ` It is ${k.typeWords}.` : ''}`}>
              <Rows label={`${k.players.length} who died to it`}>
                {k.players.map(p => <PlayerRow key={p.id} href={playerHref(p.fightId, p.id)} name={p.name} className={p.className} value={`${p.count}× · ${pullList(p.pullNumbers)}`} />)}
              </Rows>
            </Card>
          ))}
        </ul>
        {night.killers.length > KILLER_CARDS && (
          <details className="group rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-4 py-2.5">
            <summary className="cursor-pointer text-xs font-bold text-amber-400/90 hover:text-amber-300 select-none list-none">
              <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span> {night.killers.length - KILLER_CARDS} more abilities that killed someone
            </summary>
            <ul className="mt-2 text-sm divide-y divide-zinc-800/50">
              {night.killers.slice(KILLER_CARDS).map(k => (
                <li key={k.name} className="flex items-center gap-3 py-1.5 min-w-0">
                  <AbilityIcon icon={k.icon} spellId={k.spellId} size={20} />
                  <span className="font-semibold text-zinc-200 shrink-0 max-w-[45%] truncate">{k.name}</span>
                  <span className="text-xs text-zinc-400 min-w-0 flex-1 truncate">
                    {k.players.map((p, i) => <React.Fragment key={p.id}>{i > 0 && ', '}<Link href={playerHref(p.fightId, p.id)} className={`${classColor(p.className)} hover:underline underline-offset-2`}>{p.name}</Link>{p.count > 1 ? ` ×${p.count}` : ''}</React.Fragment>)}
                  </span>
                  <span className="text-xs font-mono text-zinc-400 shrink-0 tabular-nums">{k.pulls} of {pulls.length}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {night.firstDeaths.length > 0 && (
        <section className="space-y-2.5">
          <h2 className={LABEL}>First deaths</h2>
          <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 divide-y divide-zinc-800/50">
            {night.firstDeaths.slice(0, 10).map(f => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-2 text-sm min-w-0">
                <Link href={playerHref(f.fightId, f.id)} className={`font-semibold ${classColor(f.className)} hover:underline underline-offset-2 truncate w-28 sm:w-36 shrink-0`}>{f.name}</Link>
                <span className="text-xs font-mono text-zinc-200 shrink-0 w-8 tabular-nums">{f.count}×</span>
                <span className="text-xs text-zinc-400 min-w-0 truncate">{f.causes.map(c => `${c.name}${c.count > 1 ? ` ×${c.count}` : ''}`).join(', ')}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-500">
            The first counted death of each pull, on the {night.pullsWithFirstDeath} of {pulls.length} pulls that had one.
            {night.firstDeaths.length > 10 ? ` ${night.firstDeaths.length - 10} more players died first once.` : ''}
          </p>
        </section>
      )}

      <section className="space-y-2.5">
        <h2 className={LABEL}>Repeat offenders, by mechanic</h2>
        {night.mechanicsNote && <p className="text-sm text-zinc-400">{night.mechanicsNote}</p>}
        <ul className="space-y-2">
          {night.mechanics.map(m => {
            const top = m.players[0];
            return (
              <Card key={m.name} severity={m.assigned && m.players.length <= 4 ? 'info' : m.players.length >= raidSize / 2 || m.pulls >= pulls.length * 0.75 ? 'bad' : 'warn'} icon={m.icon} spellId={m.spellId}
                title={`${m.name} hit ${plural(m.players.length, 'player')} ${m.times} ${m.times === 1 ? 'time' : 'times'}, on ${m.pulls} of ${plural(pulls.length, 'pull')}`}
                text={`${fmtNum(m.damage)} taken. It is ${MECHANIC_WORDS[m.type]} (${m.via === 'dbm' ? 'the boss addons flag it' : 'top raids do not take it'}).${top ? ` Most often: ${top.name}, ${top.times}× over ${plural(top.pulls, 'pull')}.` : ''}${m.dot ? ' It ticks: a run of ticks counts as one time.' : ''}${m.assigned ? ` ${m.assigned.name}${m.assigned.role === 'tank' ? ', a tank,' : ''} takes most of it pull after pull, which usually means it is their job rather than a mistake.` : ''}`}>
                <Rows label={`${m.players.length} who got hit`}>
                  {m.players.map(p => <PlayerRow key={p.id} href={playerHref(p.fightId, p.id)} name={p.name} className={p.className} value={`${p.times}× · ${fmtNum(p.damage)} · ${plural(p.pulls, 'pull')}`} />)}
                </Rows>
              </Card>
            );
          })}
        </ul>
      </section>

      {night.players.length > 0 && (
        <section className="space-y-2.5">
          <h2 className={LABEL}>Player by player</h2>
          <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 overflow-hidden">
            <table className="w-full text-sm table-fixed">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-zinc-500 text-right">
                  <th className="text-left font-bold px-3 sm:px-4 py-2">Player</th>
                  <th className="font-bold px-1.5 py-2 w-14 sm:w-16">Deaths</th>
                  <th className="font-bold px-1.5 py-2 w-12 sm:w-16">First</th>
                  <th className="font-bold px-1.5 py-2 w-12 sm:w-16">Hits</th>
                  <th className="font-bold px-1.5 py-2 w-20 hidden sm:table-cell">Avoidable</th>
                  <th className="font-bold pl-1.5 pr-3 sm:pr-4 py-2 w-12 sm:w-16">Pulls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {night.players.map(p => (
                  <tr key={p.id} className="text-right font-mono text-xs tabular-nums">
                    <td className="text-left px-3 sm:px-4 py-1.5 font-sans text-sm truncate">
                      <Link href={playerHref(p.fightId, p.id)} className={`font-semibold ${classColor(p.className)} hover:underline underline-offset-2`}>{p.name}</Link>
                    </td>
                    <td className={`px-1.5 py-1.5 ${p.deaths ? 'text-red-300' : 'text-zinc-600'}`}>{p.deaths}</td>
                    <td className={`px-1.5 py-1.5 ${p.firstDeaths ? 'text-amber-300' : 'text-zinc-600'}`}>{p.firstDeaths}</td>
                    <td className={`px-1.5 py-1.5 ${p.hits ? 'text-zinc-200' : 'text-zinc-600'}`}>{night.mechanics.length ? p.hits : '—'}</td>
                    <td className="px-1.5 py-1.5 text-zinc-400 hidden sm:table-cell">{night.mechanics.length ? (p.avoidDamage ? fmtNum(p.avoidDamage) : '0') : '—'}</td>
                    <td className="pl-1.5 pr-3 sm:pr-4 py-1.5 text-zinc-400">{p.pulls ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">Most costly first: a death weighs four hits, a first death two more. Hits are the avoidable abilities listed above. A name opens that player&apos;s review of the latest pull they died or were hit on.</p>
        </section>
      )}

      <p className="text-xs text-zinc-600 leading-relaxed">
        How this is counted: on a kill every death counts. On a wipe, five or more deaths to one ability inside three seconds are the wipe itself; those deaths, and every death from that moment on, are left out{fallbackPulls ? `. On the ${plural(fallbackPulls, 'wipe')} with no such moment, the first ${NIGHT_FIRST_DEATHS} deaths count` : ''}. Hits are counted up to the wipe too.
        {' '}Numbers come from the fight tables and damage events on Warcraft Logs.{' '}
        <a href={`https://www.warcraftlogs.com/reports/${code}`} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">Open this report on Warcraft Logs</a>.
      </p>
    </div>
  );
}
