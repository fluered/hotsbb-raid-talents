import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import LinkPending from '../../components/LinkPending';
import CopyDiscordButton from '../../components/CopyDiscordButton';
import { POPULAR_SPECS } from '../../lib/wow';
import { DIFFICULTY_LABELS } from '../../lib/analyze';
import { fmtClock, fmtNum, plural } from '../../lib/analyzeRules';
import { nightHref } from '../../lib/nightReview';
import { pullOutcome, type PlayerNight, type PlayerNightPull } from '../../lib/playerNight';

// One player's night: every pull of one boss, seen from one character. Built from the
// night review the page already has; server-rendered, the copy button aside.

const ABILITY_ICON = (icon: string) => `https://assets.rpglogs.com/img/warcraft/abilities/${icon}`;
const BOSS_ICON = (encounterId: number) => `https://assets.rpglogs.com/img/warcraft/bosses/${encounterId}-icon.jpg`;
const classColor = (className: string) => POPULAR_SPECS.find(c => c.class === className)?.color ?? 'text-zinc-200';
const LABEL = 'text-xs font-bold uppercase tracking-widest text-zinc-500';

// What the death cell of a pull shows, and how it is shaded.
function deathCell(p: PlayerNightPull): { text: string; cls: string } {
  if (!p.present) return { text: '', cls: 'bg-transparent border border-dashed border-zinc-800 text-zinc-700' };
  if (!p.death) return { text: p.kill ? 'K' : '', cls: p.kill ? 'bg-emerald-500/30 text-emerald-200' : 'bg-zinc-800/60 text-zinc-500' };
  if (!p.death.counted) return { text: '', cls: 'bg-zinc-700/70 text-zinc-400' };
  return p.death.first ? { text: '1st', cls: 'bg-red-500/60 text-red-50' } : { text: '✕', cls: 'bg-red-500/30 text-red-100' };
}

function PullStrip({ pn }: { pn: PlayerNight }) {
  const pulls = pn.pulls;
  const dense = pulls.length > 20;
  const gap = dense ? 'gap-px' : 'gap-0.5 sm:gap-1';
  const maxHits = Math.max(1, ...pulls.map(p => p.hits));
  const href = (p: PlayerNightPull) => `/analyze?report=${pn.code}&fight=${p.fightId}${p.present ? `&player=${pn.player.id}` : ''}`;
  const tip = (p: PlayerNightPull) => `Pull ${p.n} (${p.kill ? 'kill' : `${Math.round(p.pct)}% left`}, ${fmtClock(p.durationSec)}): ${pullOutcome(p)}${p.present && pn.mechanicsKnown ? ` · ${plural(p.hits, 'avoidable hit')}` : ''}`;
  const every = pulls.length <= 12 ? 1 : pulls.length <= 20 ? 2 : 5;
  const healsKnown = pulls.some(p => p.healthstone != null);
  const row = (label: string, cell: (p: PlayerNightPull) => { text: string; cls: string }, first = false) => (
    <div className="flex gap-2 items-center">
      <span className="w-8 shrink-0 text-[9px] font-mono text-zinc-600 text-right leading-none">{label}</span>
      <div className={`flex-1 min-w-0 flex ${gap}`}>
        {pulls.map(p => {
          const c = cell(p);
          return (
            <Link key={p.fightId} href={href(p)} title={tip(p)} {...(first ? { 'aria-label': tip(p), 'data-pull': p.n } : { tabIndex: -1, 'aria-hidden': true })} className="flex-1 min-w-0 flex justify-center">
              <span className={`block w-full max-w-7 h-5 rounded-sm text-[9px] font-mono leading-5 text-center overflow-hidden ${c.cls}`}>{dense ? '' : c.text}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
  return (
    <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3 sm:p-4 space-y-1.5" data-strip>
      {row('died', deathCell, true)}
      {pn.mechanicsKnown && row('hits', p => !p.present ? { text: '', cls: 'bg-transparent' } : p.hits === 0 ? { text: '0', cls: 'bg-zinc-800/60 text-zinc-500' } : { text: String(p.hits), cls: p.hits / maxHits > 0.66 ? 'bg-amber-500/50 text-amber-50' : p.hits / maxHits > 0.33 ? 'bg-amber-500/30 text-amber-100' : 'bg-amber-500/15 text-amber-200' })}
      {healsKnown && row('heal', p => {
        const t = `${p.healthstone ? 'H' : ''}${p.potion ? 'P' : ''}`;
        return !p.present ? { text: '', cls: 'bg-transparent' } : t ? { text: t, cls: 'bg-sky-500/30 text-sky-100' } : { text: '', cls: 'bg-zinc-800/60 text-zinc-500' };
      })}
      <div className="flex gap-2">
        <span className="w-8 shrink-0 text-[9px] font-mono text-zinc-600 text-right leading-none">#</span>
        <div className={`flex-1 min-w-0 flex ${gap}`}>
          {pulls.map((p, i) => (
            <span key={p.fightId} className="flex-1 min-w-0 text-center text-[9px] font-mono text-zinc-600 leading-none overflow-visible whitespace-nowrap">{i % every === 0 ? p.n : ''}</span>
          ))}
        </div>
      </div>
      <p className="text-xs text-zinc-500 leading-relaxed pt-1.5">
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500/60 align-middle mr-1" />first to die ·{' '}
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500/30 align-middle mr-1" />died before the wipe ·{' '}
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-zinc-700/70 align-middle mr-1" />died in the wipe ·{' '}
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-zinc-800/60 align-middle mr-1" />alive to the end ·{' '}
        <span className="inline-block w-2.5 h-2.5 rounded-sm border border-dashed border-zinc-700 align-middle mr-1" />not in the pull
        {pn.mechanicsKnown && <> · <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-500/40 align-middle mr-1" />avoidable hits</>}
        {healsKnown && <> · <span className="inline-block w-2.5 h-2.5 rounded-sm bg-sky-500/30 align-middle mr-1" />healthstone (H) or healing potion (P) used</>}
        . Every column opens that pull.
      </p>
    </div>
  );
}

export default function PlayerNightView({ pn, reportTitle, discordText }: { pn: PlayerNight; reportTitle: string; discordText: string }) {
  const { code, player } = pn;
  const back = nightHref(code, pn);
  const here = pn.pulls.filter(p => p.present);
  const last = here[here.length - 1];
  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <Image src={BOSS_ICON(pn.encounterID)} alt="" width={48} height={48} unoptimized className="w-12 h-12 rounded-xl object-cover mt-0.5" />
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl md:text-3xl font-black tracking-tight leading-tight"><span className={classColor(player.className)}>{player.name}</span> <span className="text-zinc-400 font-bold">· their night on {pn.bossName}</span></h1>
            <p className="text-sm text-zinc-400">
              {DIFFICULTY_LABELS[pn.difficulty] ?? ''} · {player.className}{player.role ? ` (${player.role === 'dps' ? 'damage' : player.role})` : ''} · {pn.pullsPresent} of {plural(pn.pulls.length, 'pull')} · <span className="text-zinc-500">{reportTitle}</span>
              {' · '}
              <Link href={back} className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">the whole raid&apos;s night</Link>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyDiscordButton text={discordText} />
          {last && (
            <Link href={`/analyze?report=${code}&fight=${last.fightId}&player=${player.id}`} className="px-3 py-1.5 rounded-full text-xs font-bold transition-colors border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700">
              Full review of their last pull (#{last.n})
            </Link>
          )}
        </div>
      </header>

      <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-transparent p-5 md:p-6 space-y-2">
        <p className="text-xs font-bold uppercase tracking-widest text-amber-400">The short version</p>
        <p className="text-lg md:text-xl leading-snug text-zinc-100 font-medium">{pn.summary}</p>
      </section>

      {pn.nextPull.length > 0 && (
        <section className="rounded-2xl border border-sky-500/30 bg-gradient-to-br from-sky-500/10 to-transparent p-5 md:p-6 space-y-4" data-section="next-pull">
          <p className="text-xs font-bold uppercase tracking-widest text-sky-300">Before your next pull</p>
          <ol className="space-y-4">
            {pn.nextPull.map((s, i) => (
              <li key={s.text} className="flex gap-3">
                <span className="shrink-0 w-7 h-7 rounded-full bg-sky-400/15 border border-sky-400/40 text-sky-200 text-sm font-black flex items-center justify-center tabular-nums">{i + 1}</span>
                <div className="min-w-0 space-y-1">
                  <p className="text-base md:text-lg font-bold text-zinc-100 leading-snug">{s.text}</p>
                  <p className="text-sm text-zinc-400 leading-relaxed">{s.evidence}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="text-xs text-zinc-500 leading-relaxed">From {player.name}&apos;s own pulls tonight, what happened most often first. Only patterns are listed: one bad pull is not one.</p>
        </section>
      )}

      <section className="grid grid-cols-3 sm:grid-cols-5 gap-2">
        {pn.stats.map(s => (
          <div key={s.label} className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-3 py-2.5 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 truncate">{s.label}</p>
            <p className="text-lg font-black text-zinc-100 tabular-nums leading-tight">{s.value}</p>
            {s.note && <p className="text-[10px] text-zinc-500 truncate">{s.note}</p>}
          </div>
        ))}
      </section>

      <section className="space-y-2.5" data-section="pulls">
        <h2 className={LABEL}>Pull by pull</h2>
        <PullStrip pn={pn} />
        <ul className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 divide-y divide-zinc-800/50 text-sm">
          {pn.pulls.map(p => {
            const d = p.death;
            const heals = [p.healthstone ? 'healthstone' : '', p.potion ? 'healing potion' : ''].filter(Boolean);
            return (
              <li key={p.fightId} className={p.present ? '' : 'opacity-50'}>
                <Link href={`/analyze?report=${code}&fight=${p.fightId}${p.present ? `&player=${player.id}` : ''}`} className="flex items-start gap-3 px-3 sm:px-4 py-2 hover:bg-zinc-900/60">
                  <span className="text-xs font-mono text-zinc-500 w-7 shrink-0 pt-0.5">#{p.n}</span>
                  <span className={`w-16 shrink-0 whitespace-nowrap font-mono text-xs pt-0.5 ${p.kill ? 'text-emerald-300 font-bold' : 'text-zinc-300'}`}>{p.kill ? 'Kill' : `${Math.round(p.pct)}% left`}</span>
                  <span className="text-xs font-mono text-zinc-500 w-9 shrink-0 pt-0.5 hidden sm:inline">{fmtClock(p.durationSec)}</span>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className={`block text-sm leading-snug ${!p.present ? 'text-zinc-500' : d?.counted ? (d.first ? 'text-red-300 font-semibold' : 'text-red-200') : 'text-zinc-300'}`}>{pullOutcome(p).replace(/^./, c => c.toUpperCase())}</span>
                    {d?.counted && d.major.length > 0 && <span className="block text-xs text-amber-300">Major defensive ready: {d.major.join(', ')}</span>}
                    {d?.counted && d.minor.length > 0 && <span className="block text-[11px] text-zinc-500">Minor, also ready: {d.minor.join(', ')}</span>}
                    {d?.counted && d.judged && d.major.length === 0 && d.minor.length === 0 && <span className="block text-[11px] text-zinc-500">No defensive of theirs was ready</span>}
                    {p.present && (p.hits > 0 || heals.length > 0) && (
                      <span className="block text-xs text-zinc-500">
                        {p.hits > 0 && <>{plural(p.hits, 'avoidable hit')}: {p.hitNames.map(h => `${h.name}${h.times > 1 ? ` ×${h.times}` : ''}`).join(', ')}</>}
                        {p.hits > 0 && heals.length > 0 && ' · '}
                        {heals.length > 0 && <span className="text-sky-300/80">used a {heals.join(' and a ')}</span>}
                      </span>
                    )}
                  </span>
                  <LinkPending label="opening" />
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-zinc-500">Each line opens {player.name}&apos;s full review of that pull. Deaths and hits are read up to the moment the pull was lost, as on the raid&apos;s night summary.</p>
      </section>

      {pn.bestWorst && (
        <section className="space-y-2.5" data-section="bestworst">
          <h2 className={LABEL}>Best pull against worst pull</h2>
          <p className="text-sm text-zinc-300 leading-relaxed">{pn.bestWorst.text}</p>
          <p className="text-xs text-zinc-500">
            <Link href={`/analyze?report=${code}&fight=${pn.bestWorst.best.fightId}&player=${player.id}`} className="underline underline-offset-2 hover:text-zinc-300">Open pull {pn.bestWorst.best.n}</Link>
            {' · '}
            <Link href={`/analyze?report=${code}&fight=${pn.bestWorst.worst.fightId}&player=${player.id}`} className="underline underline-offset-2 hover:text-zinc-300">Open pull {pn.bestWorst.worst.n}</Link>
          </p>
        </section>
      )}

      <section className="space-y-2.5" data-section="compare">
        <h2 className={LABEL}>Totals{pn.comparedWith ? ' against the median player' : ''}</h2>
        <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 divide-y divide-zinc-800/50">
          {pn.compare.map(c => (
            <div key={c.label} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2 text-sm min-w-0">
              <span className="font-semibold text-zinc-200 w-44 shrink-0">{c.label}</span>
              <span className={`text-xs font-mono tabular-nums ${c.verdict === 'worse' ? 'text-red-300' : c.verdict === 'better' ? 'text-emerald-300' : 'text-zinc-300'}`}>{c.value}</span>
              {c.median && <span className="text-xs font-mono text-zinc-500 tabular-nums ml-auto">median {c.median}</span>}
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500">
          {pn.comparedWith
            ? `The median is over the ${pn.comparedWith} other players who were in at least three pulls, each counted per pull they were in. A figure is coloured only when it is half again above or below the median and at least two events apart. Healthstone and potion use is stated, not judged.`
            : 'Too few pulls, or too few other players, for a comparison with the rest of the raid to mean anything.'}
        </p>
      </section>

      {pn.ready && (pn.ready.withMajor > 0 || pn.ready.minorOnly > 0) && (
        <section className="space-y-2.5" data-section="ready">
          <h2 className={LABEL}>Died with a defensive ready</h2>
          {pn.ready.withMajor > 0 && (
            <p className="text-sm text-zinc-300">
              <span className="font-bold text-zinc-100">{pn.ready.withMajor} of {pn.ready.judged}</span> deaths before the wipes came with a major defensive off cooldown and not pressed: {pn.ready.names.map(x => `${x.name}${pn.ready!.withMajor > 1 ? ` ×${x.count}` : ''}`).join(', ')}.
            </p>
          )}
          {pn.ready.minorOnly > 0 && <p className="text-xs text-zinc-500">At {plural(pn.ready.minorOnly, 'death')} only a minor one was ready ({pn.ready.minorNames.map(x => x.name).join(', ')}): a short cooldown that is ready most of the time, so it says little.</p>}
        </section>
      )}

      <section className="space-y-2.5" data-section="mechanics">
        <h2 className={LABEL}>Their avoidable hits, by mechanic</h2>
        {!pn.mechanicsKnown ? <p className="text-sm text-zinc-400">Nothing is listed as avoidable for this night (see the raid&apos;s night summary).</p>
          : pn.mechanics.length === 0 ? <p className="text-sm text-zinc-400">Not hit by any of the avoidable abilities the raid&apos;s night summary lists.</p>
          : (
            <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 divide-y divide-zinc-800/50">
              {pn.mechanics.map(m => (
                <div key={m.key} className="flex items-center gap-3 px-4 py-2 text-sm min-w-0">
                  {m.icon
                    ? <Image src={ABILITY_ICON(m.icon)} alt="" width={20} height={20} unoptimized className="w-5 h-5 rounded shrink-0 border border-zinc-800" />
                    : <span className="w-5 h-5 rounded shrink-0 bg-zinc-900 border border-zinc-800 inline-block" />}
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-zinc-200 truncate">{m.name}</span>
                    <span className="block text-[11px] text-zinc-500">
                      {m.assigned ? 'takes most of it pull after pull: probably their job' : m.of === 1 ? 'the only player hit by it' : m.rank === 1 ? `hit most often of the ${m.of} players it hit` : `${m.rank}${m.rank === 2 ? 'nd' : m.rank === 3 ? 'rd' : 'th'} most often of the ${m.of} players it hit`}
                    </span>
                  </span>
                  <span className={`text-xs font-mono shrink-0 tabular-nums ${m.assigned ? 'text-zinc-500' : m.pulls >= 2 ? 'text-amber-300' : 'text-zinc-300'}`}>{m.times}× · {plural(m.pulls, 'pull')}{m.damage ? ` · ${fmtNum(m.damage)}` : ''}</span>
                </div>
              ))}
            </div>
          )}
      </section>

      <p className="text-xs text-zinc-600 leading-relaxed">
        Read from the same data as <Link href={back} className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">the raid&apos;s night summary</Link>, with the same rules: deaths at or after the moment a pull was lost are the wipe, not a mistake, and hits are counted up to that moment.{' '}
        <a href={`https://www.warcraftlogs.com/reports/${code}`} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">Open this report on Warcraft Logs</a>.
      </p>
    </div>
  );
}
