import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import LinkPending from '../../components/LinkPending';
import CopyDiscordButton from '../../components/CopyDiscordButton';
import { POPULAR_SPECS } from '../../lib/wow';
import { DIFFICULTY_LABELS } from '../../lib/analyze';
import { fmtClock, fmtNum, plural } from '../../lib/analyzeRules';
import { MECHANIC_WORDS } from '../../lib/bossMechanics';
import { NIGHT_FIRST_DEATHS, NIGHT_MAX_PULLS, type NightMechanic, type NightPull, type NightReadyDefensive, type NightReview } from '../../lib/nightReview';
import { playerNightHref } from '../../lib/playerNight';

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
// Mechanic cards shown in full; the rest fold into one list so a boss with a dozen definitions stays readable.
const MECHANIC_CARDS = 8;
const readyList = (rs: NightReadyDefensive[], counts: boolean) => rs.map(r => `${r.name}${counts ? ` ×${r.count}` : ''}`).join(', ');
const pullList = (ns: number[]) => `${ns.length === 1 ? 'pull' : 'pulls'} ${ns.slice(0, 6).join(', ')}${ns.length > 6 ? '…' : ''}`;

// One mechanic pull by pull: a cell per pull of the night, darker for more separate
// times, dashed where the pull ended before the mechanic could happen. The sentence
// under it appears only when the first half and the second half are clearly apart.
function MechanicProgress({ m, pulls }: { m: NightMechanic; pulls: NightPull[] }) {
  const per = m.progress.perPull;
  const max = Math.max(1, ...per.map(n => n ?? 0));
  const h = m.progress.halves;
  const per1 = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));
  return (
    <div className="pt-1 space-y-1" data-progress>
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-mono text-zinc-600 shrink-0">pull by pull</span>
        <div className={`flex-1 min-w-0 flex ${pulls.length > 20 ? 'gap-px' : 'gap-0.5'}`}>
          {pulls.map((p, i) => {
            const n = per[i];
            const shade = n == null ? 'border border-dashed border-zinc-800' : n === 0 ? 'bg-zinc-800/70' : n / max > 0.66 ? 'bg-amber-400/80' : n / max > 0.33 ? 'bg-amber-400/50' : 'bg-amber-400/25';
            return <span key={p.fightId} title={`Pull ${p.n}: ${n == null ? 'ended before it could happen' : `${n} ${n === 1 ? 'time' : 'times'}`}`} className={`flex-1 min-w-0 max-w-5 h-2.5 rounded-sm ${shade}`} />;
          })}
        </div>
      </div>
      {h && (
        <p className={`text-xs ${h.better ? 'text-emerald-300/90' : 'text-red-300/90'}`}>
          Getting {h.better ? 'better' : 'worse'}: {per1(h.first)} a pull in the first {h.pulls} pulls it could happen on, {per1(h.second)} in the last {h.pulls}.
        </p>
      )}
    </div>
  );
}

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
  // Every name opens that player's night; the single-pull reviews are one step on from there.
  const playerHref = (id: number) => playerNightHref(code, night, id);
  const fallbackPulls = pulls.filter(p => p.rule === 'first-deaths').length;
  const raidSize = night.players.length || 1;
  const rd = night.readyDeaths;
  // Major defensives lead; a death with only a minor one ready is a footnote.
  const majorRows = (rd?.players ?? []).filter(p => p.withMajor > 0);
  const minorRows = (rd?.players ?? []).filter(p => p.withMajor === 0 && p.minorOnly > 0);
  const heal = night.healing;
  // Mechanics that single players out get cards; the ones most of the raid takes each time are listed apart.
  const individual = night.mechanics.filter(m => !m.raidWide);
  const raidWide = night.mechanics.filter(m => m.raidWide);
  const noStones = !!heal && heal.warlockPulls === 0 && heal.healthstone.uses === 0;
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

      {(night.nextPull.steps.length > 0 || night.nextPull.working) && (
        <section className="rounded-2xl border border-sky-500/30 bg-gradient-to-br from-sky-500/10 to-transparent p-5 md:p-6 space-y-4" data-section="next-pull">
          <p className="text-xs font-bold uppercase tracking-widest text-sky-300">Before the next pull</p>
          {night.nextPull.steps.length > 0 && (
            <ol className="space-y-4">
              {night.nextPull.steps.map((s, i) => (
                <li key={s.text} className="flex gap-3">
                  <span className="shrink-0 w-7 h-7 rounded-full bg-sky-400/15 border border-sky-400/40 text-sky-200 text-sm font-black flex items-center justify-center tabular-nums">{i + 1}</span>
                  <div className="min-w-0 space-y-1">
                    <p className="text-base md:text-lg font-bold text-zinc-100 leading-snug">{s.text}</p>
                    <p className="text-sm text-zinc-400 leading-relaxed">{s.evidence}</p>
                    <p className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-500">
                      {s.icon && <AbilityIcon icon={s.icon} spellId={s.spellId} size={20} />}
                      <span>{s.scope}</span>
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {night.nextPull.working && (
            <p className={`text-sm text-emerald-300/90 leading-relaxed ${night.nextPull.steps.length ? 'border-t border-zinc-800/70 pt-3' : ''}`} data-working>
              <span className="font-bold">Already working.</span> {night.nextPull.working}
            </p>
          )}
          {night.nextPull.steps.length > 0 && (
            <p className="text-xs text-zinc-500 leading-relaxed">
              The changes that would have touched the most pulls, most first: a pull an ability ended or killed someone on counts as one, a pull where it only hit people counts a quarter (a death weighs four hits everywhere on this page). Each line is counted from this night&apos;s log; the sections below hold the detail.
            </p>
          )}
        </section>
      )}

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
                {k.players.map(p => <PlayerRow key={p.id} href={playerHref(p.id)} name={p.name} className={p.className} value={`${p.count}× · ${pullList(p.pullNumbers)}`} />)}
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
                    {k.players.map((p, i) => <React.Fragment key={p.id}>{i > 0 && ', '}<Link href={playerHref(p.id)} className={`${classColor(p.className)} hover:underline underline-offset-2`}>{p.name}</Link>{p.count > 1 ? ` ×${p.count}` : ''}</React.Fragment>)}
                  </span>
                  <span className="text-xs font-mono text-zinc-400 shrink-0 tabular-nums">{k.pulls} of {pulls.length}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {night.countedDeaths > 0 && (
        <section className="space-y-2.5" data-section="defensives">
          <h2 className={LABEL}>Died with a major defensive ready</h2>
          {!rd ? (
            <p className="text-xs text-zinc-500">The cast data for this night could not be loaded from Warcraft Logs, so this section is empty. Reload to try again.</p>
          ) : (
            <>
              <p className="text-sm text-zinc-300">
                {rd.judged === 0
                  ? 'Nobody who died before a wipe pressed a major personal defensive at any point tonight, so there is nothing to compare.'
                  : rd.withMajor === 0
                    ? `None of the ${rd.judged} deaths before the wipes came with a major personal defensive ready: every one was already pressed or on cooldown.`
                    : <>
                        <span className="font-bold text-zinc-100">{rd.withMajor} of {rd.judged}</span> deaths before the wipes that a defensive could have covered came with a major personal defensive off cooldown and not pressed.{' '}
                        {rd.nothingPressed === rd.withMajor ? (rd.withMajor === 1 ? 'No defensive at all was pressed in the ten seconds before it.' : 'At every one of them, no defensive at all was pressed in the ten seconds before.') : `At ${rd.nothingPressed} of those, no defensive at all was pressed in the ten seconds before; at the rest a different one was.`}
                      </>}
              </p>
              {majorRows.length > 0 && (
                <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 divide-y divide-zinc-800/50">
                  {majorRows.map(p => (
                    <div key={p.id} className="flex items-start gap-3 px-4 py-2 text-sm min-w-0">
                      <Link href={playerHref(p.id)} className={`font-semibold ${classColor(p.className)} hover:underline underline-offset-2 truncate w-28 sm:w-36 shrink-0`}>{p.name}</Link>
                      <span className={`text-xs font-mono shrink-0 w-14 tabular-nums ${p.withMajor === p.deaths ? 'text-red-300' : 'text-amber-300'}`}>{p.withMajor} of {p.deaths}</span>
                      <span className="text-xs text-zinc-300 min-w-0">
                        {readyList(p.major, p.withMajor > 1)}
                        <span className="text-zinc-600"> · pull{p.pullNumbers.length === 1 ? '' : 's'} {p.pullNumbers.join(', ')}</span>
                        {p.minor.length > 0 && <span className="block text-[11px] text-zinc-600">minor, also ready: {readyList(p.minor, false)}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {minorRows.length > 0 && (
                <p className="text-xs text-zinc-500" data-minor-only>
                  <span className="text-zinc-400">Only a minor one ready</span> ({plural(rd.minorOnly, 'death')}, not counted above):{' '}
                  {minorRows.map((p, i) => (
                    <React.Fragment key={p.id}>
                      {i > 0 && ', '}
                      <Link href={playerHref(p.id)} className={`${classColor(p.className)} opacity-80 hover:underline underline-offset-2`}>{p.name}</Link>
                      {' '}({readyList(p.minor, false)}{p.minorOnly > 1 ? `, ${p.minorOnly} deaths` : ''})
                    </React.Fragment>
                  ))}
                  .
                </p>
              )}
              <p className="text-xs text-zinc-500">
                Each player&apos;s deaths before the wipes, and at how many of them a major defensive of theirs was ready, with which ones. Ready is not the same as &quot;would have lived&quot;, but it is the first thing to ask about.
                Major means a cooldown of a minute or more (Wowhead): a button that is back in 15 to 45 seconds is ready most of the time for everyone, so finding it ready says little.
                A player&apos;s defensives are the ones they pressed at some point tonight.{rd.instant > 0 ? ` ${plural(rd.instant, 'death')} before the wipes ${rd.instant === 1 ? 'was an instant kill, which' : 'were instant kills, which'} no defensive stops: ${rd.instant === 1 ? 'it is' : 'they are'} left out here.` : ''} Healthstones and healing potions are counted separately, below.
              </p>
            </>
          )}
        </section>
      )}

      {heal && (
        <section className="space-y-2.5" data-section="healing">
          <h2 className={LABEL}>Healthstones and healing potions</h2>
          <p className="text-sm text-zinc-300">
            {heal.warlockPulls === 0 && heal.healthstone.uses === 0
              ? 'There was no Warlock in the raid tonight, so there were no healthstones to use.'
              : <>Healthstones were used on <span className="font-bold text-zinc-100">{heal.healthstone.pulls} of {plural(heal.pulls, 'pull')}</span>, by {heal.healthstone.players} of {plural(heal.players.length, 'player')}{heal.warlockPulls === 0 ? ' (no Warlock in the raid: stones kept from earlier)' : heal.warlockPulls < heal.pulls ? ` (a Warlock was in ${heal.warlockPulls} of the pulls)` : ''}.</>}
            {' '}Healing potions were used on <span className="font-bold text-zinc-100">{heal.potion.pulls} of {plural(heal.pulls, 'pull')}</span>, by {heal.potion.players} of {plural(heal.players.length, 'player')}.
          </p>
          <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 overflow-hidden">
            <table className="w-full text-sm table-fixed">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-zinc-500 text-right">
                  <th className="text-left font-bold px-3 sm:px-4 py-2">Player</th>
                  <th className="font-bold px-1.5 py-2 w-14 sm:w-24" title="Pulls on which they used a healthstone">Stone</th>
                  <th className="font-bold px-1.5 py-2 w-14 sm:w-24" title="Pulls on which they used a healing potion">Potion</th>
                  <th className="font-bold px-1.5 py-2 w-12 sm:w-16">Pulls</th>
                  <th className="font-bold pl-1.5 pr-3 sm:pr-4 py-2 w-[4.5rem] sm:w-28" title="Deaths before the wipes with neither used earlier in that pull">Died unused</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {heal.players.map(p => (
                  <tr key={p.id} className="text-right font-mono text-xs tabular-nums">
                    <td className="text-left px-3 sm:px-4 py-1.5 font-sans text-sm truncate">
                      <Link href={playerHref(p.id)} className={`font-semibold ${classColor(p.className)} hover:underline underline-offset-2`}>{p.name}</Link>
                    </td>
                    <td className={`px-1.5 py-1.5 ${p.healthstonePulls ? 'text-zinc-200' : 'text-zinc-600'}`}>{noStones ? '—' : p.healthstonePulls}</td>
                    <td className={`px-1.5 py-1.5 ${p.potionPulls ? 'text-zinc-200' : 'text-zinc-600'}`}>{p.potionPulls}</td>
                    <td className="px-1.5 py-1.5 text-zinc-400">{p.pulls}</td>
                    <td className={`pl-1.5 pr-3 sm:pr-4 py-1.5 ${p.deathsUnused ? 'text-amber-300' : 'text-zinc-600'}`}>{p.deaths ? `${p.deathsUnused} of ${p.deaths}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">
            On how many of their pulls each player used a healthstone and a healing potion. &quot;Died unused&quot; is their deaths before the wipes that came with neither used earlier in that pull.
            Counts only: the log does not say how many of either a player carried, and some deaths come too fast for a button.
          </p>
        </section>
      )}

      {night.firstDeaths.length > 0 && (
        <section className="space-y-2.5">
          <h2 className={LABEL}>First deaths</h2>
          <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 divide-y divide-zinc-800/50">
            {night.firstDeaths.slice(0, 10).map(f => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-2 text-sm min-w-0">
                <Link href={playerHref(f.id)} className={`font-semibold ${classColor(f.className)} hover:underline underline-offset-2 truncate w-28 sm:w-36 shrink-0`}>{f.name}</Link>
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

      <section className="space-y-2.5" data-section="mechanics">
        <h2 className={LABEL}>Repeat offenders, by mechanic</h2>
        {night.mechanicsNote && <p className="text-sm text-zinc-400">{night.mechanicsNote}</p>}
        {!night.mechanicsNote && individual.length === 0 && <p className="text-sm text-zinc-400">No avoidable ability singled players out tonight: the ones that landed hit most of the raid each time.</p>}
        <ul className="space-y-2">
          {individual.slice(0, MECHANIC_CARDS).map(m => {
            const top = m.players[0];
            const defined = m.via === 'wipefest';
            const counts = `${plural(m.players.length, 'player')}, ${m.times} separate ${m.times === 1 ? 'time' : 'times'}, on ${m.pulls} of ${plural(pulls.length, 'pull')}${m.damage ? ` · ${fmtNum(m.damage)} taken` : ''}.`;
            const why = defined ? '' : m.type ? ` It is ${MECHANIC_WORDS[m.type]} (${m.via === 'dbm' ? 'the boss addons flag it' : 'top raids do not take it'}).` : '';
            return (
              <Card key={m.key} severity={m.assigned && m.players.length <= 4 ? 'info' : m.players.length >= raidSize / 2 || m.pulls >= pulls.length * 0.75 ? 'bad' : 'warn'} icon={m.icon} spellId={m.spellId}
                title={defined ? m.title : `${m.title}, on ${m.pulls} of ${plural(pulls.length, 'pull')}`}
                text={`${defined ? counts : `${fmtNum(m.damage)} taken.`}${why}${top ? ` Most often: ${top.name}, ${top.times}× over ${plural(top.pulls, 'pull')}.` : ''}${m.dot ? ' It ticks: a run of ticks counts as one time.' : ''}${m.assigned ? ` ${m.assigned.tanks ? 'The tanks take nearly all of it between them' : `${m.assigned.name}${m.assigned.role === 'tank' ? ', a tank,' : ''} takes most of it pull after pull`}, which usually means it is their job rather than a mistake: it is left out of their hit counts.` : ''}`}>
                <MechanicProgress m={m} pulls={pulls} />
                <Rows label={`${m.players.length} who got hit`}>
                  {m.players.map(p => <PlayerRow key={p.id} href={playerHref(p.id)} name={p.name} className={p.className} value={`${p.times}×${p.damage ? ` · ${fmtNum(p.damage)}` : ''} · ${plural(p.pulls, 'pull')}`} />)}
                </Rows>
              </Card>
            );
          })}
        </ul>
        {individual.length > MECHANIC_CARDS && (
          <details className="group rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-4 py-2.5">
            <summary className="cursor-pointer text-xs font-bold text-amber-400/90 hover:text-amber-300 select-none list-none">
              <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span> {individual.length - MECHANIC_CARDS} more mechanics, hit less often
            </summary>
            <ul className="mt-2 text-sm divide-y divide-zinc-800/50">
              {individual.slice(MECHANIC_CARDS).map(m => (
                <li key={m.key} className="flex items-center gap-3 py-1.5 min-w-0">
                  <AbilityIcon icon={m.icon} spellId={m.spellId} size={20} />
                  <span className="font-semibold text-zinc-200 shrink-0 max-w-[45%] truncate">{m.name}{m.assigned && <span className="font-normal text-zinc-500"> · {m.assigned.tanks ? 'the tanks’ job' : `${m.assigned.name}’s job`}</span>}</span>
                  <span className="text-xs text-zinc-400 min-w-0 flex-1 truncate">
                    {m.players.map((p, i) => <React.Fragment key={p.id}>{i > 0 && ', '}<Link href={playerHref(p.id)} className={`${classColor(p.className)} hover:underline underline-offset-2`}>{p.name}</Link>{p.times > 1 ? ` ×${p.times}` : ''}</React.Fragment>)}
                  </span>
                  <span className="text-xs font-mono text-zinc-400 shrink-0 tabular-nums">{m.pulls} of {pulls.length}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {raidWide.length > 0 && (
          <details className="group rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-4 py-2.5" data-raidwide>
            <summary className="cursor-pointer text-xs font-bold text-zinc-400 hover:text-zinc-200 select-none list-none">
              <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span> {plural(raidWide.length, 'mechanic')} that hit most of the raid each time: counted against nobody
            </summary>
            <ul className="mt-2 text-sm divide-y divide-zinc-800/50">
              {raidWide.map(m => (
                <li key={m.key} className="flex items-start gap-3 py-1.5 min-w-0">
                  <AbilityIcon icon={m.icon} spellId={m.spellId} size={20} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-zinc-300 truncate">{m.name}</span>
                    <span className="block text-xs text-zinc-500">{m.via === 'wipefest' ? `${m.title}. ` : ''}About {Math.round(m.share * 100)}% of the players present were hit on each of the {plural(m.pulls, 'pull')} it happened on{m.damage ? ` · ${fmtNum(m.damage)} taken` : ''}.</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-zinc-500">When more than half the raid is hit every time, being hit is the normal case: a soak everyone takes, or something the raid as a whole has not solved. These are left out of every player&apos;s hit count.</p>
          </details>
        )}
        {night.mechanics.length > 0 && (
          <p className="text-xs text-zinc-500">
            Hits before the wipe only; hits on one player less than two seconds apart count as one time.
            {night.mechanicsCredit ? ' Which mechanics count against a player, and the sentence on each card, come from Wipefest\'s definitions for this boss; the numbers are counted from this log.' : ''}
          </p>
        )}
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
                  <th className="font-bold px-1.5 py-2 w-16 hidden sm:table-cell" title="Deaths with a major personal defensive ready">Def. ready</th>
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
                      <Link href={playerHref(p.id)} className={`font-semibold ${classColor(p.className)} hover:underline underline-offset-2`}>{p.name}</Link>
                    </td>
                    <td className={`px-1.5 py-1.5 ${p.deaths ? 'text-red-300' : 'text-zinc-600'}`}>{p.deaths}</td>
                    <td className={`px-1.5 py-1.5 hidden sm:table-cell ${p.readyDeaths ? 'text-amber-300' : 'text-zinc-600'}`}>{p.deaths && p.readyDeaths != null ? p.readyDeaths : '—'}</td>
                    <td className={`px-1.5 py-1.5 ${p.firstDeaths ? 'text-amber-300' : 'text-zinc-600'}`}>{p.firstDeaths}</td>
                    <td className={`px-1.5 py-1.5 ${p.hits ? 'text-zinc-200' : 'text-zinc-600'}`}>{individual.length ? p.hits : '—'}</td>
                    <td className="px-1.5 py-1.5 text-zinc-400 hidden sm:table-cell">{individual.length ? (p.avoidDamage ? fmtNum(p.avoidDamage) : '0') : '—'}</td>
                    <td className="pl-1.5 pr-3 sm:pr-4 py-1.5 text-zinc-400">{p.pulls ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500">Most costly first: a death weighs four hits, a first death two more. Hits are the avoidable abilities listed above, less the ones that hit most of the raid and anything that is the player&apos;s own job. Def. ready counts major defensives only. A name opens that player&apos;s night.</p>
        </section>
      )}

      <p className="text-xs text-zinc-600 leading-relaxed">
        How this is counted: on a kill every death counts. On a wipe, five or more deaths to one ability inside three seconds are the wipe itself; those deaths, and every death from that moment on, are left out{fallbackPulls ? `. On the ${plural(fallbackPulls, 'wipe')} with no such moment, the first ${NIGHT_FIRST_DEATHS} deaths count` : ''}. Hits are counted up to the wipe too.
        {' '}Numbers come from the fight tables and events on Warcraft Logs{night.mechanicsCredit ? `; ${night.mechanicsCredit}` : ''}.{' '}
        <a href={`https://www.warcraftlogs.com/reports/${code}`} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">Open this report on Warcraft Logs</a>.
      </p>
    </div>
  );
}
