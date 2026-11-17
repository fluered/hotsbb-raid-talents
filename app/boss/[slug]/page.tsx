import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SiteFooter from '../../../components/SiteFooter';
import SiteShell from '../../../components/SiteShell';
import SiteNavLinks from '../../../components/SiteNavLinks';
import { getSeasonState, parseRaidDifficulty, POPULAR_SPECS, DPS_SPECS, TANK_SPECS, HEALER_SPECS } from '../../../lib/wow';
import { getRaidBosses, getBossStats, getBossMechanics, bossHref, type BossMechanic, type BossMechRow, type RaidBoss } from '../../../lib/bossPage';
import { normalizeName, type MechanicType } from '../../../lib/bossMechanics';
import { bossCanonical, raidCanonical, tierListCanonical } from '../../../lib/seo';
import { ogImageMeta } from '../../../lib/ogImage';
import { fixedTierAssignments, classHex, fmtDps, TIER_CONFIG } from '../../tier-list/TierListContent';

// One page per raid boss: what a raider looks up before raid night. Everything on it is
// measured (top Warcraft Logs kills) or read from the boss addons and the journal;
// nothing is hand-written, and nothing is fetched from Warcraft Logs for a page view
// (see lib/bossPage.ts). A section whose data is not cached is left out.

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ difficulty?: string }>;
}

const SITE = 'https://hotsbbtalents.io';
const BOSS_ICON = (id: number) => `https://assets.rpglogs.com/img/warcraft/bosses/${id}-icon.jpg`;
const ABILITY_ICON = (icon: string) => `https://assets.rpglogs.com/img/warcraft/abilities/${icon}`;
const WOWHEAD = (spellId: number) => `https://www.wowhead.com/spell=${spellId}`;
// The DPS tier list's own thresholds (app/tier-list/page.tsx).
const DPS_TIERS = { S: 95, A: 88, B: 78 };
// Fewer cached specs than this and a ranking would be a ranking of whatever happened
// to be cached; the section gives way to a link to the tier list.
const MIN_RANKED_SHARE = 0.8;

const clock = (sec: number) => `${Math.floor(Math.round(sec) / 60)}:${String(Math.round(sec) % 60).padStart(2, '0')}`;
const pct = (share: number) => `${Math.round(share * 100)}%`;
const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const TYPE_HEADING: Record<MechanicType, { label: string; tone: string }> = {
  avoid: { label: 'Move out of', tone: 'text-red-300 border-red-500/30 bg-red-500/10' },
  soak: { label: 'Soak', tone: 'text-sky-300 border-sky-500/30 bg-sky-500/10' },
  spread: { label: 'Spread out', tone: 'text-orange-300 border-orange-500/30 bg-orange-500/10' },
  gather: { label: 'Stack up', tone: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' },
  interrupt: { label: 'Interrupt', tone: 'text-violet-300 border-violet-500/30 bg-violet-500/10' },
  dispel: { label: 'Dispel', tone: 'text-teal-300 border-teal-500/30 bg-teal-500/10' },
  add: { label: 'Adds', tone: 'text-amber-300 border-amber-500/30 bg-amber-500/10' },
  fixate: { label: 'Fixate', tone: 'text-pink-300 border-pink-500/30 bg-pink-500/10' },
  targeted: { label: 'Targeted', tone: 'text-pink-300 border-pink-500/30 bg-pink-500/10' },
  debuff: { label: 'Personal debuff', tone: 'text-zinc-300 border-zinc-600/50 bg-zinc-800/50' },
  tank: { label: 'Tanks', tone: 'text-blue-300 border-blue-500/30 bg-blue-500/10' },
  defensive: { label: 'Use a defensive', tone: 'text-yellow-200 border-yellow-500/30 bg-yellow-500/10' },
  raidwide: { label: 'Raid-wide damage', tone: 'text-zinc-300 border-zinc-600/50 bg-zinc-800/50' },
  unknown: { label: 'Other', tone: 'text-zinc-300 border-zinc-600/50 bg-zinc-800/50' },
};

async function resolveBoss(slug: string): Promise<{ boss: RaidBoss | null; bosses: RaidBoss[] }> {
  const bosses = await getRaidBosses();
  return { boss: bosses.find(b => b.slug === slug) ?? null, bosses };
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const [{ slug }, sp, season] = await Promise.all([params, searchParams, getSeasonState()]);
  // The name comes from the roster; the slug only selects it.
  const boss = await resolveBoss(slug).then(r => r.boss).catch(() => null);
  if (!boss) return { title: 'Boss not found | HotsBB', robots: { index: false, follow: true } };
  const diff = parseRaidDifficulty(sp.difficulty, season.defaultRaidDifficulty);
  const diffLabel = diff === 4 ? 'Heroic' : 'Mythic';
  const title = `${boss.name} ${diffLabel}: Spec Rankings, Meta Builds and Mechanics | HotsBB`;
  const description = `${diffLabel} ${boss.name} in ${boss.zoneName}: DPS spec rankings and kill times from top parses, the meta talent build for every spec, and the mechanics by type from the boss addons.`;
  return {
    title,
    description,
    alternates: { canonical: bossCanonical({ slug: boss.slug, difficulty: diff, defaultDifficulty: season.defaultRaidDifficulty }) },
    ...ogImageMeta({
      title, description,
      imageTitle: boss.name,
      subtitle: 'Spec rankings, meta builds for every spec and the mechanics by type, from top logs',
      kicker: `${diffLabel} · ${boss.zoneName}`,
    }),
  };
}

export default async function BossPage({ params, searchParams }: PageProps) {
  const [{ slug }, sp, season] = await Promise.all([params, searchParams, getSeasonState()]);
  const { boss, bosses } = await resolveBoss(slug);
  if (!boss) notFound();

  const difficulty = parseRaidDifficulty(sp.difficulty, season.defaultRaidDifficulty);
  const diffLabel = difficulty === 4 ? 'Heroic' : 'Mythic';
  const [stats, mechanics] = await Promise.all([getBossStats(boss.id, difficulty), getBossMechanics(boss)]);

  const index = bosses.findIndex(b => b.id === boss.id);
  const raidBosses = bosses.filter(b => b.zoneName === boss.zoneName);
  const href = (b: RaidBoss, d = difficulty) => bossHref(b.slug, d, season.defaultRaidDifficulty);
  const tierListHref = (role: 'dps' | 'tanks' | 'healers') => tierListCanonical({ role, difficulty, defaultDifficulty: season.defaultRaidDifficulty, boss: boss.id, bossName: boss.name });
  const buildHref = (cls: string, spec: string) => raidCanonical({ cls, spec, difficulty, boss: boss.id, bossName: boss.name });

  // Spec rankings, tiered the way the tier list tiers them.
  const ranked = stats && stats.specs.length >= Math.ceil(stats.specsTotal * MIN_RANKED_SHARE) ? stats.specs : [];
  const tiers = ranked.length ? fixedTierAssignments(ranked.map(s => s.avg), DPS_TIERS) : [];
  const peak = ranked[0]?.avg ?? 0;

  // DBM's type for an ability the top raids' logs list, where the names agree.
  const typeByName = new Map<string, MechanicType>();
  for (const g of mechanics?.groups ?? []) for (const m of g.items) typeByName.set(normalizeName(m.name), g.type);
  // The damage table also lists what players do to themselves (a trinket's backlash,
  // Shadow Word: Death, falling). With a journal list for the boss, only abilities it or
  // the addons name are kept; without one, anything whose spell id is far below the
  // fight's own (an old player spell) is dropped.
  const allRows = stats?.mech?.rows ?? [];
  const known = new Set(mechanics?.abilityNames ?? []);
  const ids = allRows.map(r => r.spellId).sort((a, b) => a - b);
  const medianId = ids[Math.floor(ids.length / 2)] ?? 0;
  const mechRows = known.size >= 5 ? allRows.filter(r => known.has(normalizeName(r.name))) : allRows.filter(r => r.spellId >= medianId / 2);
  const tankOnly = (r: BossMechRow) => r.tankShare >= 0.6 && r.share <= 0.3;
  const takeGroups: Array<{ key: string; label: string; note: string; rows: BossMechRow[] }> = [
    { key: 'all', label: 'Nearly everyone takes it', note: 'Raid damage to heal through, not something to dodge.', rows: mechRows.filter(r => r.share >= 0.9) },
    { key: 'some', label: 'Part of the raid takes it', note: 'Assigned, targeted, or avoidable and not always avoided, even in these kills.', rows: mechRows.filter(r => r.share < 0.9 && r.share > 0.25 && !tankOnly(r)) },
    { key: 'few', label: 'Top raids mostly avoid it', note: 'A quarter of the raid or fewer were touched by it.', rows: mechRows.filter(r => r.share <= 0.25 && !tankOnly(r)) },
    { key: 'tank', label: 'Tanks only', note: 'Hits the tanks and almost nobody else.', rows: mechRows.filter(tankOnly) },
  ].filter(g => g.rows.length);

  const mechanicCount = (mechanics?.groups ?? []).reduce((n, g) => n + g.items.length, 0);
  const tiles: Array<{ label: string; value: string; note: string }> = [];
  if (stats?.killTimes) tiles.push({ label: 'Top kill time', value: clock(stats.killTimes.medianSec), note: `median · middle half ${clock(stats.killTimes.p25Sec)} to ${clock(stats.killTimes.p75Sec)}` });
  if (stats?.lust) {
    const l = stats.lust;
    tiles.push(l.onPull >= l.kills / 2
      ? { label: 'Bloodlust', value: 'On the pull', note: `in ${l.onPull} of ${l.kills} top kills` }
      : { label: 'Bloodlust', value: l.laterMedianSec != null ? `Around ${clock(l.laterMedianSec)}` : 'Varies', note: `held past the pull in ${l.kills - l.onPull} of ${l.kills} top kills` });
  }
  if (ranked.length) tiles.push({ label: 'Top DPS spec', value: `${ranked[0].spec} ${ranked[0].cls}`, note: `${fmtDps(ranked[0].avg)} avg of its top ${ranked[0].n}` });
  if (mechanicCount) tiles.push({ label: 'Mechanics', value: String(mechanicCount), note: 'with an addon warning, by type below' });

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'HotsBB Raid Talents', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Raid Bosses', item: `${SITE}/boss` },
      { '@type': 'ListItem', position: 3, name: boss.name, item: `${SITE}/boss/${boss.slug}` },
    ],
  };

  const sectionHead = 'text-lg font-black text-zinc-100 tracking-tight';
  const sectionSub = 'text-xs text-zinc-500 leading-relaxed max-w-2xl';

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <header className="border-b border-zinc-800/70 bg-black/70 backdrop-blur-md sticky top-0 z-50">
        <div className="px-4 md:px-5 h-12 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link href="/" className="font-black text-amber-400 tracking-widest uppercase text-xs hover:text-amber-300 transition-colors whitespace-nowrap">
              HotsBB<span className="hidden min-[360px]:inline"> Talents</span>
            </Link>
            <span className="hidden sm:inline text-zinc-700">/</span>
            <Link href="/boss" className="hidden sm:inline text-xs font-black text-zinc-300 hover:text-zinc-100 uppercase tracking-widest transition-colors">Raid Bosses</Link>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <SiteNavLinks active="bosses" difficulty={difficulty} />
            <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5 border border-zinc-800/80">
              <Link href={href(boss, 4)} className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${difficulty === 4 ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}>Heroic</Link>
              <Link href={href(boss, 5)} className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${difficulty === 5 ? 'bg-purple-500/15 text-purple-400 border border-purple-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}>Mythic</Link>
            </div>
          </div>
        </div>
      </header>

      <SiteShell difficulty={difficulty}>
        <div className="max-w-screen-md mx-auto px-4 md:px-6 py-6 space-y-10">
          <div className="space-y-5">
            <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
              <Link href="/boss" className="hover:text-zinc-300 transition-colors">Raid bosses</Link>
              <span className="text-zinc-700">/</span>
              <span>{boss.zoneName}</span>
              <span className="text-zinc-700">/</span>
              <span className="text-zinc-300">{boss.name}</span>
            </nav>

            <div className="flex items-start gap-4">
              <Image src={BOSS_ICON(boss.id)} alt="" width={64} height={64} unoptimized className="w-14 h-14 md:w-16 md:h-16 rounded-2xl object-cover border border-zinc-800 shrink-0" />
              <div className="min-w-0 space-y-1.5">
                <h1 className="text-2xl md:text-3xl font-black tracking-tight leading-tight">
                  {boss.name} <span className={difficulty === 5 ? 'text-purple-400' : 'text-amber-400'}>{diffLabel}</span>
                </h1>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  {boss.zoneName} · boss {raidBosses.findIndex(b => b.id === boss.id) + 1} of {raidBosses.length}. Spec rankings, the meta build for every spec and the
                  mechanics by type. Measured from top Warcraft Logs kills and read from the boss addons, not a written guide.
                </p>
              </div>
            </div>

            {tiles.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {tiles.map(t => (
                  <div key={t.label} className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-3 py-2.5 min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{t.label}</p>
                    <p className="text-base font-black text-zinc-100 leading-tight mt-0.5 break-words">{t.value}</p>
                    <p className="text-[11px] text-zinc-500 leading-snug mt-0.5">{t.note}</p>
                  </div>
                ))}
              </div>
            )}
            {(stats?.killTimes || stats?.lust) && (
              <p className="text-[11px] text-zinc-600 leading-relaxed">
                {stats.killTimes && <>Kill time: the length of the {stats.killTimes.kills} {diffLabel} kills behind the top 50 parses of each DPS spec. Those are the fastest raids in the world, so expect your own kill to run longer. </>}
                {stats.lust && <>Bloodlust: when it went out in {stats.lust.kills} top {diffLabel} kills, the ones the Log Review has already read for the top {stats.lust.specs.join(', ')} players.</>}
              </p>
            )}
          </div>

          {mechanics && (mechanics.groups.length > 0 || mechanics.other.length > 0) && (
            <section className="space-y-4" aria-labelledby="mechanics">
              <div className="space-y-1">
                <h2 id="mechanics" className={sectionHead}>{boss.name} mechanics at a glance</h2>
                <p className={sectionSub}>
                  {mechanics.groups.length > 0
                    ? <>Grouped by what Deadly Boss Mods tells you to do when it warns for each ability; the descriptions are the dungeon journal&apos;s. This is every ability with a typed warning, not every ability in the fight.</>
                    : <>Deadly Boss Mods has no typed warnings for this boss yet, so this is the dungeon journal&apos;s ability list. The note in amber after a name is how this site reads the ability from the journal&apos;s wording; an ability without one is not given advice either way.</>}
                </p>
              </div>
              {mechanics.overview && (
                <p className="text-sm text-zinc-400 leading-relaxed border-l-2 border-zinc-700 pl-3">
                  {mechanics.overview} <span className="text-zinc-600">(Dungeon journal)</span>
                </p>
              )}
              {mechanics.groups.map(g => (
                <div key={g.type} className="space-y-2">
                  <h3 className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-black uppercase tracking-widest ${TYPE_HEADING[g.type].tone}`}>{TYPE_HEADING[g.type].label}</h3>
                  <ul className="space-y-1.5">
                    {g.items.map(m => <MechanicItem key={m.spellId} m={m} />)}
                  </ul>
                </div>
              ))}
              {mechanics.other.length > 0 && (mechanics.groups.length > 0 ? (
                <details className="group">
                  <summary className="cursor-pointer text-xs font-bold text-amber-400/90 hover:text-amber-300 select-none list-none">
                    <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span> {mechanics.other.length} more abilities in the journal without a typed warning
                  </summary>
                  <ul className="space-y-1.5 mt-2">
                    {mechanics.other.map(m => <MechanicItem key={m.spellId} m={m} />)}
                  </ul>
                </details>
              ) : (
                <ul className="space-y-1.5">
                  {mechanics.other.map(m => <MechanicItem key={m.spellId} m={m} />)}
                </ul>
              ))}
              {mechanics.failures.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Debuffs that mean something went wrong</h3>
                  <ul className="space-y-1.5">
                    {mechanics.failures.map(f => (
                      <li key={f.spellId} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2 text-sm">
                        <a href={WOWHEAD(f.spellId)} target="_blank" rel="noopener noreferrer" className="font-bold text-zinc-100 hover:text-amber-200">{f.name}</a>
                        {f.mythicOnly && <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-purple-400">Mythic</span>}
                        <span className="block text-xs text-zinc-400 leading-relaxed">{f.note}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-zinc-600">BigWigs&apos; own notes on each debuff.</p>
                </div>
              )}
            </section>
          )}

          {stats?.mech && takeGroups.length > 0 && (
            <section className="space-y-4" aria-labelledby="taken">
              <div className="space-y-1">
                <h2 id="taken" className={sectionHead}>What top raids take and avoid</h2>
                <p className={sectionSub}>
                  The share of players in {stats.mech.n} top {stats.mech.n === 1 ? 'raid' : 'raids'}&apos; {diffLabel} {stats.mech.n === 1 ? 'kill' : 'kills'} who took any damage from each ability, averaged over the {stats.mech.n === 1 ? 'kill' : 'kills'}.
                  One tick counts the same as ten hits: this shows who gets touched, not how hard. {stats.mech.n === 1 ? 'One kill' : `${stats.mech.n} kills`} is a small sample, so read it as a guide to what is avoidable, not as a target.
                  {known.size >= 5 && <> Only abilities the dungeon journal or the boss addons list are shown.</>}
                </p>
              </div>
              {takeGroups.map(g => (
                <div key={g.key} className="space-y-2">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400">{g.label}</h3>
                    <p className="text-[11px] text-zinc-600">{g.note}</p>
                  </div>
                  <ul className="space-y-1">
                    {g.rows.map(r => {
                      const type = typeByName.get(normalizeName(r.name));
                      return (
                        <li key={`${r.name}-${r.spellId}`} className="flex items-center gap-3 rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
                          {r.icon
                            ? <Image src={ABILITY_ICON(r.icon)} alt="" width={28} height={28} unoptimized className="w-7 h-7 rounded-md border border-zinc-800 shrink-0" />
                            : <span className="w-7 h-7 rounded-md bg-zinc-900 border border-zinc-800 shrink-0" />}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              <a href={WOWHEAD(r.spellId)} target="_blank" rel="noopener noreferrer" className="text-sm font-bold text-zinc-100 hover:text-amber-200">{r.name}</a>
                              {type && <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{TYPE_HEADING[type].label}</span>}
                            </div>
                            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden mt-1.5">
                              <div className="h-full rounded-full bg-amber-500/70" style={{ width: `${Math.max(2, Math.round(r.share * 100))}%` }} />
                            </div>
                          </div>
                          <div className="text-right shrink-0 w-24">
                            <p className="text-sm font-black tabular-nums text-zinc-100">{pct(r.share)}</p>
                            <p className="text-[10px] text-zinc-500">{g.key === 'tank' ? `${pct(r.tankShare)} of them tanks` : 'of players hit'}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              <p className="text-[11px] text-zinc-600">Read from Warcraft Logs on {day(stats.mech.fetchedAt)}. The kills are the logs of the top-ranked players the Log Review compares against.</p>
            </section>
          )}

          <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-transparent p-5 md:p-6 space-y-3" aria-labelledby="review">
            <div className="space-y-1">
              <p className="text-xs font-bold uppercase tracking-widest text-amber-400">Log Review · preview</p>
              <h2 id="review" className="text-lg md:text-xl font-black text-zinc-100 leading-snug">How did your raid do on {boss.name}?</h2>
              <p className="text-sm text-zinc-400 leading-relaxed max-w-xl">
                Paste your Warcraft Logs report. You get who died to what, which mechanics were failed and by whom, and a review of each player against the top players of their spec on this boss.
              </p>
            </div>
            <form action="/analyze" method="get" className="flex flex-col sm:flex-row gap-2">
              <label htmlFor="report" className="sr-only">Warcraft Logs report link</label>
              <input
                id="report" name="report" type="text" autoComplete="off" spellCheck={false}
                placeholder="https://www.warcraftlogs.com/reports/…"
                className="flex-1 min-w-0 rounded-lg bg-zinc-900 border border-zinc-800 focus:border-amber-500/60 focus:outline-none px-4 py-2.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-600"
              />
              <button type="submit" className="rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-black text-sm px-5 py-2.5 transition-colors whitespace-nowrap">Review my log</button>
            </form>
          </section>

          <section className="space-y-4" aria-labelledby="rankings">
            <div className="space-y-1">
              <h2 id="rankings" className={sectionHead}>DPS spec rankings on {diffLabel} {boss.name}</h2>
              <p className={sectionSub}>
                {ranked.length > 0
                  ? <>Average DPS of each spec&apos;s top 50 {diffLabel} parses on this boss, all regions. Tiers are the share of the best spec&apos;s number: S from 95%, A from 88%, B from 78%. Each row opens that spec&apos;s meta build for this boss.</>
                  : <>The rankings for this boss on {diffLabel} are not cached right now, and this page does not fetch them on demand. The tier list has them.</>}
              </p>
            </div>
            {ranked.length > 0 && (
              <ol className="space-y-1">
                {ranked.map((s, i) => {
                  const color = POPULAR_SPECS.find(c => c.class === s.cls)?.color ?? 'text-zinc-200';
                  const cfg = TIER_CONFIG[tiers[i]];
                  return (
                    <li key={`${s.cls}:${s.spec}`}>
                      <Link href={buildHref(s.cls, s.spec)} className="flex items-center gap-3 bg-zinc-900/40 border border-zinc-800/50 rounded-xl px-3 py-2 hover:bg-zinc-900/80 hover:border-zinc-700/70 transition-all group">
                        <span className="text-xs font-mono text-zinc-600 w-5 text-right shrink-0">{i + 1}</span>
                        <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black border shrink-0 ${cfg.color} ${cfg.bg} ${cfg.border}`}>{tiers[i]}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-1.5 mb-1">
                            <span className={`text-sm font-black ${color}`}>{s.spec}</span>
                            <span className="text-xs text-zinc-500 truncate">{s.cls}</span>
                          </div>
                          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${Math.round((s.avg / peak) * 100)}%`, backgroundColor: classHex(color), opacity: 0.7 }} />
                          </div>
                        </div>
                        <div className="text-right shrink-0 w-20">
                          <p className={`text-sm font-black tabular-nums ${cfg.color}`}>{fmtDps(s.avg)}</p>
                          <p className="text-[10px] font-bold tabular-nums text-zinc-600">{i === 0 ? 'peak' : `${((1 - s.avg / peak) * 100).toFixed(1)}% behind`}</p>
                        </div>
                        <span className="text-zinc-700 group-hover:text-zinc-400 transition-colors text-sm shrink-0">→</span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="text-xs text-zinc-500 leading-relaxed">
              {ranked.length > 0 && stats && ranked.length < stats.specsTotal && <>{stats.specsTotal - ranked.length} of {stats.specsTotal} DPS specs are missing: no cached rankings, or fewer than five parses. </>}
              {ranked.length > 0 && stats?.rankingsAt && <>Rankings read from Warcraft Logs on or after {day(stats.rankingsAt)}. </>}
              Full lists for this boss:{' '}
              <Link href={tierListHref('dps')} className="text-amber-400/90 hover:text-amber-300 underline underline-offset-2">DPS tier list</Link>,{' '}
              <Link href={tierListHref('tanks')} className="text-amber-400/90 hover:text-amber-300 underline underline-offset-2">tanks</Link>,{' '}
              <Link href={tierListHref('healers')} className="text-amber-400/90 hover:text-amber-300 underline underline-offset-2">healers</Link>.
              {ranked.length > 0 && <>Augmentation Evoker&apos;s personal DPS reads lower than what it adds to a raid.</>}
            </p>
          </section>

          <section className="space-y-4" aria-labelledby="builds">
            <div className="space-y-1">
              <h2 id="builds" className={sectionHead}>Meta talent build for every spec on {boss.name}</h2>
              <p className={sectionSub}>The consensus talents and gear of the top {diffLabel} parses on this boss, per spec, with the import string.</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
              {POPULAR_SPECS.map(cls => (
                <div key={cls.class} className="min-w-0">
                  <p className={`text-xs font-black uppercase tracking-wider ${cls.color}`}>{cls.class}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {cls.specs.map(spec => (
                      <Link key={spec} href={buildHref(cls.class, spec)} title={`${spec} ${cls.class} talents for ${diffLabel} ${boss.name}`}
                        className="px-2.5 py-1.5 rounded-lg border border-zinc-800/70 bg-zinc-900/40 text-xs font-semibold text-zinc-300 hover:text-white hover:border-zinc-600 transition-colors">
                        {spec}<span className="text-zinc-600"> · {roleOf(cls.class, spec)}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <nav className="space-y-3" aria-labelledby="other-bosses">
            <h2 id="other-bosses" className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">Other bosses in {boss.zoneName}</h2>
            <div className="flex flex-wrap gap-1.5">
              {bosses.map(b => (
                <Link key={b.id} href={href(b)} aria-current={b.id === boss.id ? 'page' : undefined}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all border ${b.id === boss.id ? 'bg-zinc-800 border-zinc-600 text-zinc-100' : 'border-zinc-800/60 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'}`}>
                  <Image src={BOSS_ICON(b.id)} alt="" width={16} height={16} unoptimized className="w-4 h-4 rounded object-cover shrink-0" />
                  {b.name}
                </Link>
              ))}
            </div>
            <div className="flex justify-between gap-3 text-xs font-semibold">
              {index > 0 ? <Link href={href(bosses[index - 1])} className="text-zinc-400 hover:text-zinc-200 transition-colors">← {bosses[index - 1].name}</Link> : <span />}
              {index < bosses.length - 1 ? <Link href={href(bosses[index + 1])} className="text-zinc-400 hover:text-zinc-200 transition-colors text-right">{bosses[index + 1].name} →</Link> : <span />}
            </div>
          </nav>

          <p className="text-[11px] text-zinc-600 leading-relaxed">
            Sources: parse rankings and fight data from Warcraft Logs
            {mechanics?.sources.dbm && <>, mechanic types from Deadly Boss Mods</>}
            {mechanics?.sources.bigwigs && <>, debuff notes from BigWigs</>}
            {mechanics?.sources.journal && <>, ability text from Blizzard&apos;s dungeon journal and Wowhead</>}.
          </p>

          <SiteFooter difficulty={difficulty} />
        </div>
      </SiteShell>
    </div>
  );
}

function roleOf(cls: string, spec: string): string {
  if (TANK_SPECS.some(s => s.class === cls && s.spec === spec)) return 'tank';
  if (HEALER_SPECS.some(s => s.class === cls && s.spec === spec)) return 'healer';
  return DPS_SPECS.some(s => s.class === cls && s.spec === spec) ? 'dps' : '';
}

function MechanicItem({ m }: { m: BossMechanic }) {
  return (
    <li className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
      <p className="text-sm">
        <a href={WOWHEAD(m.spellId)} target="_blank" rel="noopener noreferrer" className="font-bold text-zinc-100 hover:text-amber-200">{m.name}</a>
        {m.alt && <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{m.alt}</span>}
        {m.reading && <span className="ml-2 text-[11px] font-semibold text-amber-300/90">{m.reading}</span>}
      </p>
      {m.description && <p className="text-xs text-zinc-400 leading-relaxed mt-0.5">{m.description}</p>}
    </li>
  );
}
