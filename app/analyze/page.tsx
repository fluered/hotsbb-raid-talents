import React, { Suspense } from 'react';
import Loading from './loading';
import LinkPending from '../../components/LinkPending';
import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Script from 'next/script';
import SiteFooter from '../../components/SiteFooter';
import SiteShell from '../../components/SiteShell';
import SiteNavLinks from '../../components/SiteNavLinks';
import TimelineChart from '../../components/TimelineChart';
import { getWclToken, getBlizzardToken, getTalentTreeId, getCachedTalentLayout, loadEntryTalentMap, getRaidStructure, getSeasonState, mapConcurrent, POPULAR_SPECS } from '../../lib/wow';
import { getBossKnowledge, getItemOnUse, getSpellInfo, isCombatPotion, isHealingPotionSpell, type BossKnowledge } from '../../lib/bossMechanics';
import { isDefensive, defensiveKey, registerHealingPotionNames } from '../../lib/defensives';
import {
  parseReportInput, getReportOverview, getFightPlayers, getPlayerProfile, getPoolSummary, getRaidMechanicStats,
  DIFFICULTY_LABELS, type ReportFight, type ReportOverview, type FightPlayer, type PoolSummary, type RaidMechanicStats,
} from '../../lib/analyze';
import { reviewPlayer, registerPotionNames, buffFamily, fmtClock, median, type Finding, type Review, type Timeline, type TalentContext } from '../../lib/analyzeRules';
import { getRaidFightData, buildRaidReview, buildMechanicItems, buildPlayerMechanicItems, composeRaidSummary, type RaidReview, type RaidItem } from '../../lib/raidReview';
import { composeSummary, costOf, paceClause } from '../../lib/summary';
import { getLorrgsSpells, lorrgsMajorsForSpec, lorrgsNonMajorsForSpec } from '../../lib/lorrgsSpells';
import { getWipefestFightConfig, wipefestCredit, type WipefestFightConfig } from '../../lib/wipefestConfig';
import { evaluateInsights, fetchFightEvents, summariseComparison, type MechanicComparison, type MechanicInsight } from '../../lib/wipefestInsights';
import { getOrSetPersistent } from '../../lib/persistentCache';
import { unstable_cache } from 'next/cache';

// Log review (preview). Unlisted while it's being built: no nav link, no indexing.
// Flow is three steps on one URL — paste a report, pick the pull, pick yourself —
// and every step is a plain link, so a WCL URL with #fight=…&source=… lands straight
// on the review.

// A cold boss/spec builds a 30-member pool, raid stats and item lookups: ~100s. Vercel's
// plan allows 300 (see app/page.tsx).
export const maxDuration = 300;

export const metadata: Metadata = {
  title: 'Log Review (preview) | HotsBB',
  description: 'Paste a Warcraft Logs report and get a plain-English read on what went right and wrong in your pull.',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ report?: string; fight?: string; player?: string; view?: string; debug?: string }>;
}

const ABILITY_ICON = (icon: string) => `https://assets.rpglogs.com/img/warcraft/abilities/${icon}`;
const BOSS_ICON = (encounterId: number) => `https://assets.rpglogs.com/img/warcraft/bosses/${encounterId}-icon.jpg`;
const classColor = (className: string) => POPULAR_SPECS.find(c => c.class === className)?.color ?? 'text-zinc-200';

// A change of search params is the same route segment, so loading.tsx alone never shows
// for a click from the pull list to a pull, or from a pull to a player: the old page
// just sits there while the server works. A Suspense boundary keyed on the params
// streams the loading screen first on every such navigation.
export default async function AnalyzePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const key = [sp.report, sp.fight, sp.player, sp.view].map(v => v ?? '').join('|');
  return (
    <Suspense key={key} fallback={<Loading />}>
      <AnalyzeContent sp={sp} />
    </Suspense>
  );
}

async function AnalyzeContent({ sp }: { sp: Awaited<PageProps['searchParams']> }) {
  const raw = sp.report ?? '';
  const ref = raw ? parseReportInput(raw) : null;

  // Normalise a pasted URL into clean params so the address bar is shareable.
  if (ref && raw !== ref.code) {
    const qs = new URLSearchParams({ report: ref.code });
    const fightId = ref.fightId ?? (sp.fight || null);
    if (fightId != null) qs.set('fight', String(fightId));
    const playerId = ref.sourceId ?? (sp.player || null);
    if (playerId != null) qs.set('player', String(playerId));
    redirect(`/analyze?${qs.toString()}`);
  }

  // Data loading happens here; JSX is built afterwards from the resulting state, so a
  // thrown WCL error (rate limit, private report) becomes a message instead of a 500.
  type PageState =
    | { kind: 'landing'; error: string | null; initial?: string }
    | { kind: 'fights'; overview: ReportOverview }
    | { kind: 'players'; overview: ReportOverview; fight: ReportFight; players: FightPlayer[] }
    | { kind: 'review'; overview: ReportOverview; fight: ReportFight; player: FightPlayer; review: Review; mechanics: RaidItem[] }
    | { kind: 'raid'; overview: ReportOverview; fight: ReportFight; players: FightPlayer[]; review: RaidReview; debug?: unknown };
  let state: PageState;
  if (!ref) {
    state = { kind: 'landing', error: raw ? 'That does not look like a Warcraft Logs report link or code.' : null };
  } else {
    try {
      const token = await getWclToken();
      const overview = await getReportOverview(token, ref.code);
      if (!overview) {
        state = { kind: 'landing', error: 'Could not open that report. It may be private, deleted, or still uploading.', initial: raw };
      } else {
        const fight = sp.fight === 'last'
          ? overview.fights[overview.fights.length - 1]
          : sp.fight ? overview.fights.find(f => f.id === parseInt(sp.fight!)) : undefined;
        if (!fight) {
          state = { kind: 'fights', overview };
        } else {
          const players = await getFightPlayers(token, overview.code, fight.id);
          const player = sp.player ? players.find(p => p.id === parseInt(sp.player!)) : undefined;
          // A pull opens on the raid summary; the player list is one tab over.
          if (!player && sp.view !== 'players') {
            const [data, boss, raidStats, mech] = await Promise.all([
              getRaidFightData(token, overview.code, fight, players),
              loadBossKnowledge(token, fight),
              loadRaidStatsForFight(token, fight, players),
              loadMechanicInsights(token, overview.code, fight, players),
            ]);
            // Top raids' numbers for the same definitions (3 same-difficulty pulls, cached a week).
            const comparison = mech.config && raidStats.fights.length ? await loadMechanicComparison(token, fight, raidStats.fights, mech.config) : null;
            const [{ cooldowns, charges }] = await Promise.all([
              loadSpellFacts(Object.values(data.defensives).flat()),
              registerPotions(Object.entries(data.friendlyCasts).map(([name, c]) => ({ name, spellId: c.spellId, icon: c.icon }))),
            ]);
            const review = buildRaidReview({ fight, data, boss, raidStats: raidStats.raidStats, cooldowns, charges, potionNorm: potionNormOf(raidStats.pool, raidStats.poolSpec) });
            const wipeDeaths = fight.kill ? 0 : data.raidDeaths.filter(d => data.raidDeaths.filter(x => x.killer === d.killer && Math.abs(x.atSec - d.atSec) <= 3).length >= 5).length;
            if (mech.insights.length) {
              const cards = buildMechanicItems(mech.insights, comparison, players.length);
              // The definition-based cards replace our own type-guessed cards for the same abilities.
              const covered = cards.map(c => c.title.toLowerCase());
              const subject = (t: string) => t.replace(/^(dispelled|interrupted|soaked) /i, '').replace(/ (hit|soaked by|picked|soaked) .*$/i, '').replace(/ d+ of d+ times?$/i, '').toLowerCase();
              review.items = review.items.filter(i => i.group !== 'mechanics' || !covered.some(t => t.includes(subject(i.title))));
              review.items.push(...cards);
              review.sourcesNote = [review.sourcesNote?.replace(/\.$/, ''), wipefestCredit(mech.config)].filter(Boolean).join(', ') + '.';
            }
            composeRaidSummary(review, fight, { topMedianSec: raidStats.topMedianSec, deaths: data.raidDeaths.length, wipeDeaths });
            state = { kind: 'raid', overview, fight, players, review, debug: { summary: review.summaryDebug, wipefest: !!mech.config, insights: mech.insights.map(i => `${i.configId} ${i.type} n=${i.totalEvents} | ${i.title} | ${i.stats.map(s => `${s.name}=${s.display}${s.unit ? ' ' + s.unit : ''}`).join(', ')}`), errors: mech.errors, comparisonN: comparison?.n ?? 0, comparison: comparison?.byConfig } };
          } else if (!player) {
            state = { kind: 'players', overview, fight, players };
          } else {
            const poolDifficulty = fight.difficulty >= 4 ? fight.difficulty : 4;
            const [profile, { pool, raidStats }, talents, boss, lorrgs, mech] = await Promise.all([
              getPlayerProfile(token, overview.code, fight, player),
              loadPoolWithRaidStats(token, fight, player, poolDifficulty),
              loadTalentContext(player, fight, poolDifficulty),
              loadBossKnowledge(token, fight),
              getLorrgsSpells(),
              loadMechanicInsights(token, overview.code, fight, players),
            ]);
            const topFights = (pool?.fights ?? []).filter(f => f.difficulty === fight.difficulty).slice(0, 3);
            const mechComparison = mech.config && topFights.length >= 2 ? await loadMechanicComparison(token, fight, topFights, mech.config) : null;
            const mechanics = mech.insights.length ? buildPlayerMechanicItems(mech.insights, mechComparison, player.id, players.length) : [];
            const majorSpells = lorrgs ? lorrgsMajorsForSpec(lorrgs, player.className, player.spec) : null;
            const notMajorSpells = lorrgs ? lorrgsNonMajorsForSpec(lorrgs, player.className, player.spec) : null;
            // Which casts are combat potions, by Wowhead's text (names change every season).
            await registerPotions([
              ...profile.casts,
              ...Object.entries(pool?.casts ?? {}).map(([name, e]) => ({ name, spellId: e.spellId, icon: e.icon })),
            ]);
            // Cooldown lengths for every cooldown-shaped cast the top players press (and the
            // player's defensives): cast ids first, since their tooltips state the cooldown.
            const { cooldowns, charges } = await loadSpellFacts([
              ...profile.casts.filter(c => isDefensive(c.name) || pool?.castStarts?.[c.name] || c.total <= 20).map(c => ({ name: defensiveKey(c.name), spellId: c.spellId })),
              ...Object.entries(pool?.casts ?? {}).filter(([name]) => isDefensive(name) || pool?.castStarts?.[name]).map(([name, e]) => ({ name: defensiveKey(name), spellId: e.spellId })),
              ...profile.buffs.filter(b => isDefensive(b.name)).map(b => ({ name: defensiveKey(b.name), spellId: b.spellId })),
              ...Object.entries(pool?.buffs ?? {}).filter(([name]) => isDefensive(name)).map(([name, e]) => ({ name: defensiveKey(name), spellId: e.spellId })),
              // Cooldown-shaped self-buffs (a dozen windows or fewer): candidates for a buff row.
              ...profile.buffs.filter(b => b.bands.length >= 1 && b.bands.length <= 12).map(b => ({ name: b.name, spellId: b.spellId })),
              ...Object.entries(pool?.buffs ?? {}).filter(([, e]) => median(e.starts.map(x => x.length)) >= 1 && median(e.starts.map(x => x.length)) <= 12).map(([name, e]) => ({ name, spellId: e.spellId })),
            ]);
            const noUse = { onUse: false, cooldownSec: null, useSpellId: null, useSpellName: null, effectNames: [] as string[] };
            // Every equipped item, the player's and the pool's: any slot can carry an on-use
            // effect. Lookups are cached a week per item, so only the first review of a spec
            // pays for them.
            const [trinkets, poolTrinketUses] = await Promise.all([
              mapConcurrent(profile.gear?.slots ?? [], 8, async g => ({ name: g.name, itemId: g.id, slot: g.slot, ...(await getItemOnUse(g.id).catch(() => noUse)) })),
              mapConcurrent(pool?.trinkets ?? [], 8, async t => ({ name: t.name, ...(await getItemOnUse(t.id).catch(() => noUse)) })),
            ]);
            const poolItemUses = Object.fromEntries(poolTrinketUses.filter(t => t.onUse || t.effectNames.length).map(t => [t.name, { useSpellId: t.useSpellId, useSpellName: t.useSpellName, effectNames: t.effectNames }]));
            const review = reviewPlayer({ player, fight, profile, pool, talents, boss, raidStats, cooldowns, charges, trinkets, poolItemUses, majorSpells, notMajorSpells, context: { mechanicEvents: mechanics.flatMap(m => m.events ?? []), phases: mech.phases } });
            if (mechanics.length) {
              // The definition-based cards replace the type-guessed mechanic findings for the same abilities.
              const covered = mechanics.map(m => m.title.toLowerCase());
              const coveredIds = new Set(mechanics.map(m => m.spellId).filter((x): x is number => !!x));
              const subject = (t: string) => t.replace(/^(too much damage from|needless damage from|hit by|soaked|took) /i, '').replace(/ (hit you|picked you|soaked|took|dealt|hit|without).*$/i, '').toLowerCase();
              review.findings = review.findings.filter(f => f.category !== 'mechanics' || !((f.spellId && coveredIds.has(f.spellId)) || covered.some(t => t.includes(subject(f.title)))));
              if (mech.config) review.sourcesNote = [review.sourcesNote?.replace(/\.$/, ''), wipefestCredit(mech.config)].filter(Boolean).join(', ') + '.';
            }
            {
              const pace = fight.kill ? paceClause(fight.durationMs / 1000, topKillMedianSec(pool, fight.difficulty)) : '';
              const verdict = `${review.verdict}${pace ? `; the kill was ${pace}` : ''}`;
              // Problems rank by category cost; strengths rank the other way round (a survival
              // win says more than a build note).
              const fromFindings = review.findings.filter(f => f.id !== 'output').map(f => ({ severity: f.severity, brief: f.title, cost: f.severity === 'good' ? 1 / Math.max(0.3, Math.abs(costOf(f.category, 'warn'))) : Math.abs(costOf(f.category, f.severity)) }));
              const fromMechanics = mechanics.map(m => ({ severity: m.severity, brief: m.brief ?? m.title, cost: m.cost ?? 2 }));
              review.summary = composeSummary({ verdict, subject: 'you', problems: [...fromFindings, ...fromMechanics], strengths: [...fromFindings, ...fromMechanics] });
            }
            state = { kind: 'review', overview, fight, player, review, mechanics };
          }
        }
      }
    } catch (err: unknown) {
      const e = err as { isRateLimit?: boolean; message?: string };
      state = {
        kind: 'landing', initial: raw,
        error: e?.isRateLimit
          ? 'Warcraft Logs is rate-limiting us right now. Give it a few minutes and try again.'
          : `Something went wrong reading that log: ${e?.message ?? 'unknown error'}`,
      };
    }
  }

  const crumbs: Array<{ label: string; href?: string }> = [];
  if (state.kind !== 'landing') crumbs.push({ label: state.overview.title, href: `/analyze?report=${state.overview.code}` });
  if (state.kind === 'players' || state.kind === 'review' || state.kind === 'raid') {
    crumbs.push({ label: `${state.fight.name} (${state.fight.kill ? 'kill' : `${Math.round(state.fight.fightPercentage)}%`})`, href: `/analyze?report=${state.overview.code}&fight=${state.fight.id}` });
  }
  if (state.kind === 'review') crumbs.push({ label: state.player.name });
  if (state.kind === 'players') crumbs.push({ label: 'Players' });

  const body: React.ReactNode =
    state.kind === 'landing' ? <Landing error={state.error} initial={state.initial} />
    : state.kind === 'fights' ? <FightList overview={state.overview} />
    : state.kind === 'players' ? <PlayerList overview={state.overview} fight={state.fight} players={state.players} />
    : state.kind === 'raid' ? <RaidView review={state.review} fight={state.fight} overview={state.overview} />
    : <ReviewView review={state.review} mechanics={state.mechanics} player={state.player} fight={state.fight} overview={state.overview} reportCode={state.overview.code} />;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">
      <header className="border-b border-zinc-800/70 bg-black/70 backdrop-blur-md sticky top-0 z-50">
        <div className="px-4 md:px-5 h-12 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link href="/" className="font-black text-amber-400 tracking-widest uppercase text-xs hover:text-amber-300 transition-colors whitespace-nowrap">
              HotsBB Talents
            </Link>
            <span className="hidden sm:inline text-zinc-700">/</span>
            <Link href="/analyze" className="hidden sm:inline text-xs font-black text-zinc-300 uppercase tracking-widest hover:text-zinc-100 transition-colors">Log Review</Link>
            <span className="hidden sm:inline px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] font-bold uppercase tracking-wider text-amber-300">preview</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <SiteNavLinks active="analyze" />
          </div>
        </div>
      </header>

      <SiteShell>
        <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-8">
          {crumbs.length > 0 && (
            <nav className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 mb-5">
              <Link href="/analyze" className="hover:text-zinc-300 transition-colors">Log Review</Link>
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>
                  <span className="text-zinc-700">/</span>
                  {c.href && i < crumbs.length - 1
                    ? <Link href={c.href} className="hover:text-zinc-300 transition-colors truncate max-w-[14rem]">{c.label}</Link>
                    : <span className="text-zinc-300 truncate max-w-[14rem]">{c.label}</span>}
                </React.Fragment>
              ))}
            </nav>
          )}
          {body}
          {sp.debug === '1' && process.env.NODE_ENV !== 'production' && state.kind === 'raid' && (
            <pre className="mt-8 text-[11px] text-zinc-500 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-x-auto">{JSON.stringify(state.debug, null, 2)}</pre>
          )}
          {sp.debug === '1' && process.env.NODE_ENV !== 'production' && state.kind === 'review' && (
            <pre className="mt-8 text-[11px] text-zinc-500 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-x-auto">{JSON.stringify(state.review.debug, null, 2)}</pre>
          )}
          <SiteFooter />
        </div>
      </SiteShell>
    </div>
  );
}

// Cooldown and charges by name, from Wowhead's tooltip for the first spell id seen
// under each name. Cached a week per spell, so this is usually instant.
async function loadSpellFacts(entries: Array<{ name: string; spellId: number }>): Promise<{ cooldowns: Record<string, number>; charges: Record<string, number> }> {
  const byName = new Map<string, number>();
  for (const e of entries) if (e.spellId && !byName.has(e.name)) byName.set(e.name, e.spellId);
  const cooldowns: Record<string, number> = {};
  const charges: Record<string, number> = {};
  await mapConcurrent([...byName.entries()], 8, async ([name, id]) => {
    const info = await getSpellInfo(id).catch(() => null);
    if (info) cooldowns[name] = info.cooldownSec ?? 0; // 0: known to have no cooldown (Hunter's Mark), so no re-use-gap guessing
    if (info?.charges && info.charges > 1) charges[name] = info.charges;
  });
  return { cooldowns, charges };
}

// Item-effect casts with alchemy or potion art are checked against Wowhead once (cached
// a week per spell) and the potions among them registered for the consumable rules.
async function registerPotions(casts: Array<{ name: string; spellId: number; icon: string }>): Promise<void> {
  const seen = new Set<string>();
  const candidates = casts.filter(c => c.spellId && !seen.has(c.name) && seen.add(c.name) && /potion|alchemy|flask|drink|draught|elixir|health/i.test(`${c.icon} ${c.name}`));
  const names: string[] = [];
  const healing: string[] = [];
  await mapConcurrent(candidates, 8, async c => {
    const info = await getSpellInfo(c.spellId).catch(() => null);
    if (isHealingPotionSpell(info)) healing.push(c.name);
    else if (isCombatPotion(info)) names.push(c.name);
  });
  registerPotionNames(names);
  registerHealingPotionNames(healing);
}

// The pool is an enhancement, never a blocker: any failure (rate limit mid-build, a
// spec/boss with no rankings) degrades to a log-only review.
async function loadPool(token: string, encounterId: number, player: FightPlayer, difficulty: number): Promise<PoolSummary | null> {
  try {
    let pool = await getPoolSummary(token, encounterId, player.className, player.spec, difficulty);
    if (pool.n < 3 && difficulty === 5) pool = await getPoolSummary(token, encounterId, player.className, player.spec, 4);
    return pool;
  } catch (err) {
    console.error('analyze: pool unavailable', err);
    return null;
  }
}

// Raid-level mechanic stats reuse the pool's own top fights, so they follow the pool.
async function loadPoolWithRaidStats(token: string, fight: ReportFight, player: FightPlayer, difficulty: number) {
  const pool = await loadPool(token, fight.encounterID, player, difficulty);
  const raidStats = pool?.fights?.length
    ? await getRaidMechanicStats(token, fight.encounterID, pool.difficulty, pool.fights).catch(err => { console.error('analyze: raid stats unavailable', err); return null; })
    : null;
  return { pool, raidStats };
}

// The raid view has no spec of its own; the first DPS player's spec pool supplies the
// top fights (and gets warmed for their own review in the process).
async function loadRaidStatsForFight(token: string, fight: ReportFight, players: FightPlayer[]): Promise<{ raidStats: RaidMechanicStats | null; fights: Array<{ code: string; fightId: number; difficulty: number }>; topMedianSec: number | null; pool: PoolSummary | null; poolSpec: string }> {
  const pick = players.find(p => p.role === 'dps') ?? players[0];
  if (!pick) return { raidStats: null, fights: [], topMedianSec: null, pool: null, poolSpec: '' };
  const { pool, raidStats } = await loadPoolWithRaidStats(token, fight, pick, fight.difficulty >= 4 ? fight.difficulty : 4);
  const same = (pool?.fights ?? []).filter(f => f.difficulty === fight.difficulty);
  return { raidStats, fights: (same.length >= 2 ? same : pool?.fights ?? []).slice(0, 3), topMedianSec: topKillMedianSec(pool, fight.difficulty), pool, poolSpec: `${pick.spec} ${pick.className}` };
}

// What the top players of one spec on this boss do with potions: how many a pull, and
// how many of them had one running at the pull. Facts from their buff tables, nothing
// hand-written — pre-potting is not a rule, it is whatever the top players do here.
function potionNormOf(pool: PoolSummary | null, spec: string): { n: number; spec: string; perPull: number; prePotShare: number } | null {
  if (!pool || pool.n < 5) return null;
  const potionBuffs = Object.entries(pool.buffs).filter(([name]) => buffFamily(name) === 'potion').map(([, e]) => e);
  if (!potionBuffs.length) return null;
  const perMember = Array.from({ length: pool.n }, (_, i) => potionBuffs.reduce((s, e) => s + (e.starts[i]?.length ?? 0), 0));
  const prePot = Array.from({ length: pool.n }, (_, i) => potionBuffs.some(e => (e.atPull[i] ?? 0) > 0)).filter(Boolean).length;
  return { n: pool.n, spec, perPull: median(perMember), prePotShare: prePot / pool.n };
}

// Median kill time of the top parses on this difficulty, for "35 seconds slower than…".
function topKillMedianSec(pool: PoolSummary | null, difficulty: number): number | null {
  if (!pool) return null;
  const same = pool.durations.filter((_, i) => pool.memberDifficulty[i] === difficulty);
  const use = same.length >= 3 ? same : [];
  return use.length ? median(use) / 1000 : null;
}

// Wipefest's mechanic definitions for this boss, evaluated against this pull. Cached a
// week per pull: the events behind it are the heavy part, the result is small.
async function loadMechanicInsights(token: string, code: string, fight: ReportFight, players: FightPlayer[]): Promise<{ config: WipefestFightConfig | null; insights: MechanicInsight[]; errors: string[]; phases: Array<{ name: string; fromSec: number; toSec: number }> }> {
  const config = await getWipefestFightConfig(fight.encounterID);
  const errors: string[] = [];
  if (!config) return { config: null, insights: [], errors, phases: [] };
  try {
    const { insights, phases } = await unstable_cache(
      async () => {
        const ev = await fetchFightEvents(token, code, fight, players, config);
        const names = new Map(config.eventConfigs.filter(c => c.filter?.type === 'phase' && c.filter.phase?.id != null).map(c => [c.filter.phase!.id, c.name]));
        const sorted = ev.phases.slice().sort((a, b) => a.startTime - b.startTime);
        const phases = sorted.map((p, i) => ({ name: names.get(p.id) ?? `Phase ${p.id}`, fromSec: Math.max(0, (p.startTime - ev.startTime) / 1000), toSec: ((sorted[i + 1]?.startTime ?? ev.endTime) - ev.startTime) / 1000 }));
        return { insights: evaluateInsights(fight, ev, players, config, errors), phases };
      },
      [`analyze-wf-v15-${code}-${fight.id}`],
      { revalidate: 7 * 86400 },
    )();
    return { config, insights, errors, phases };
  } catch (err) {
    console.error('analyze: mechanic insights unavailable', err);
    errors.push(String((err as Error)?.message ?? err));
    return { config, insights: [], errors, phases: [] };
  }
}

// The same definitions run over the top raids' pulls of this boss, so each card can
// say what the best raids manage. Keyed by boss and difficulty, kept a week.
async function loadMechanicComparison(token: string, fight: ReportFight, fights: Array<{ code: string; fightId: number; difficulty: number }>, config: WipefestFightConfig): Promise<MechanicComparison | null> {
  try {
    return await getOrSetPersistent<MechanicComparison>(`analyze-wfcmp-v15-${fight.encounterID}-${fight.difficulty}`, 7 * 86400, async () => {
      const runs = await mapConcurrent(fights, 2, async f => {
        const ps = await getFightPlayers(token, f.code, f.fightId);
        const stub: ReportFight = { id: f.fightId, encounterID: fight.encounterID, name: fight.name, difficulty: f.difficulty, kill: true, fightPercentage: 0, startTime: 0, endTime: 0, durationMs: 0 };
        return evaluateInsights(stub, await fetchFightEvents(token, f.code, stub, ps, config), ps, config);
      });
      return summariseComparison(runs);
    });
  } catch (err) {
    console.error('analyze: mechanic comparison unavailable', err);
    return null;
  }
}

// Talent names per node from the Blizzard layout the finder caches, so "never used X"
// can be told apart from "doesn't take the talent for X". Optional like the pool.
async function loadTalentContext(player: FightPlayer, fight: ReportFight, difficulty: number): Promise<TalentContext | null> {
  try {
    const blizzToken = await getBlizzardToken();
    const ids = await getTalentTreeId(player.spec, player.className, blizzToken);
    if (!ids) return null;
    const [{ layout }, entryToTalent] = await Promise.all([
      getCachedTalentLayout(ids.treeId, ids.specId, blizzToken),
      loadEntryTalentMap().catch(() => ({} as Record<number, number>)),
    ]);
    const nodeNames: Record<string, string[]> = {};
    const descriptionsByName: Record<string, string> = {};
    const talentIdToName = new Map<number, string>();
    for (const n of layout) {
      const names = [n.name, n.choiceB?.name].filter((x): x is string => !!x);
      if (names.length) nodeNames[String(n.nodeID)] = names;
      if (n.name && n.description) descriptionsByName[n.name] = n.description;
      if (n.choiceB?.name && n.choiceB.description) descriptionsByName[n.choiceB.name] = n.choiceB.description;
      // Choice nodes: Blizzard talent ids for each side, so a WCL trait entry id that
      // the bridge map resolves to one of them names exactly the side taken.
      if (n.isChoice) {
        if (n.choiceAEntryId && n.name) talentIdToName.set(n.choiceAEntryId, n.name);
        if (n.choiceBEntryId && n.choiceB?.name) talentIdToName.set(n.choiceBEntryId, n.choiceB.name);
      }
    }
    const entryNames: Record<string, string> = {};
    for (const [entry, talentId] of Object.entries(entryToTalent)) {
      const name = talentIdToName.get(Number(talentId));
      if (name) entryNames[entry] = name;
    }
    const q = new URLSearchParams({ class: player.className, spec: player.spec, boss: String(fight.encounterID), bossName: fight.name, difficulty: String(difficulty) });
    return { nodeNames, entryNames, descriptionsByName, buildsHref: `/?${q.toString()}` };
  } catch (err) {
    console.error('analyze: talent layout unavailable', err);
    return null;
  }
}

// DBM mechanic labels + Blizzard journal text for this boss. Needs the zone name
// (from the cached WCL zone list) and the expansion (from season state) to find the
// right DBM folder. Optional like everything else around the core review.
async function loadBossKnowledge(token: string, fight: ReportFight): Promise<BossKnowledge | null> {
  try {
    const [zones, season, blizzToken] = await Promise.all([getRaidStructure(token), getSeasonState(), getBlizzardToken()]);
    const zone = (zones as Array<{ name: string; encounters?: Array<{ id: number }> }>).find(z => (z.encounters ?? []).some(e => e.id === fight.encounterID));
    if (!zone) return null;
    return await getBossKnowledge({ expansionName: season.expansionName, zoneName: zone.name, bossName: fight.name, blizzToken });
  } catch (err) {
    console.error('analyze: boss knowledge unavailable', err);
    return null;
  }
}

// ─── Step 1: paste a report ───────────────────────────────────────────────────

function Landing({ error, initial }: { error: string | null; initial?: string }) {
  return (
    <div className="space-y-10">
      <section className="space-y-4 pt-4">
        <p className="text-xs font-bold uppercase tracking-widest text-amber-400">Log Review</p>
        <h1 className="text-3xl md:text-4xl font-black tracking-tight leading-tight">
          What went right, what went wrong,<br className="hidden md:block" /> in plain English.
        </h1>
        <p className="text-zinc-400 leading-relaxed max-w-xl">
          Paste a Warcraft Logs report. Pick your pull and your character. We compare what you did against
          the top players of your spec on that boss and tell you the few things that actually mattered.
          Or open the raid summary of a pull: who died to what, which mechanics were failed and by whom, who skipped potions.
        </p>
      </section>

      <form action="/analyze" method="get" className="space-y-3">
        <label htmlFor="report" className="block text-xs font-bold uppercase tracking-widest text-zinc-500">Warcraft Logs report link</label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="report"
            name="report"
            type="text"
            defaultValue={initial ?? ''}
            placeholder="https://www.warcraftlogs.com/reports/AbC123…#fight=12&source=5"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-0 rounded-lg bg-zinc-900 border border-zinc-800 focus:border-amber-500/60 focus:outline-none px-4 py-3 text-sm font-mono text-zinc-100 placeholder:text-zinc-600"
          />
          <button type="submit" className="rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-black text-sm px-5 py-3 transition-colors whitespace-nowrap">
            Review my pull
          </button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <p className="text-xs text-zinc-600">
          No log handy? <Link href="/analyze?report=Vx2X4yNajJgYzCrw&fight=3&player=8" className="text-amber-500/80 hover:text-amber-400 underline underline-offset-2">See an example review</Link> of a top-ranked kill.
        </p>
        <p className="text-xs text-zinc-600">
          A link with <span className="font-mono text-zinc-500">#fight=…&amp;source=…</span> on the end goes straight to that player&apos;s review. Private logs are not supported yet.
        </p>
      </form>

      <section className="grid sm:grid-cols-3 gap-4">
        {[
          ['Measured, not opinion', 'Every judgement is a comparison with the top-ranked players of your spec on the same boss. No hand-written rules that rot every patch.'],
          ['The few things that matter', 'Deaths first, then avoidable damage, then cooldowns you sat on. Sorted by what it cost you, capped so it stays readable.'],
          ['What you did right, too', 'Clean mechanics, matched uptime and cooldown usage get called out. A review should read like a coach, not a scold.'],
        ].map(([title, text]) => (
          <div key={title} className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-4 space-y-1.5">
            <p className="font-bold text-zinc-100 text-sm">{title}</p>
            <p className="text-xs text-zinc-400 leading-relaxed">{text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

// ─── Step 2: pick the pull ────────────────────────────────────────────────────

function FightList({ overview }: { overview: ReportOverview }) {
  if (overview.fights.length === 0) {
    return (
      <EmptyState title="No boss pulls in this report" text="Only raid boss encounters can be reviewed. Trash and dungeon runs are skipped." />
    );
  }
  // Group by boss in first-seen order, number the pulls within each.
  const groups = new Map<string, ReportFight[]>();
  for (const f of overview.fights) {
    const key = `${f.encounterID}-${f.difficulty}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-black tracking-tight">{overview.title}</h1>
        <p className="text-sm text-zinc-500">{overview.fights.length} boss {overview.fights.length === 1 ? 'pull' : 'pulls'} · pick the one to review</p>
      </div>
      {[...groups.values()].map(fights => {
        const first = fights[0];
        const kills = fights.filter(f => f.kill).length;
        return (
          <section key={`${first.encounterID}-${first.difficulty}`} className="space-y-2">
            <div className="flex items-center gap-3">
              <img src={BOSS_ICON(first.encounterID)} alt="" className="w-8 h-8 rounded-lg object-cover" />
              <div className="min-w-0">
                <h2 className="font-bold text-zinc-100 leading-tight">{first.name}</h2>
                <p className="text-xs text-zinc-500">{DIFFICULTY_LABELS[first.difficulty] ?? ''} · {fights.length} {fights.length === 1 ? 'pull' : 'pulls'}{kills ? ` · ${kills} kill${kills === 1 ? '' : 's'}` : ''}</p>
              </div>
            </div>
            <ul className="grid sm:grid-cols-2 gap-1.5">
              {fights.map((f, i) => (
                <li key={f.id}>
                  <Link
                    href={`/analyze?report=${overview.code}&fight=${f.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/40 hover:bg-zinc-900 hover:border-zinc-700 px-3 py-2 transition-colors"
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <span className="text-xs font-mono text-zinc-500 w-6 shrink-0">#{i + 1}</span>
                      <span className={`text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded ${f.kill ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>
                        {f.kill ? 'Kill' : 'Wipe'}
                      </span>
                      {!f.kill && <span className="text-sm text-zinc-300">{Math.round(f.fightPercentage)}% left</span>}
                    </span>
                    <span className="flex items-center gap-3 shrink-0"><LinkPending label="opening" /><span className="text-xs font-mono text-zinc-500">{fmtClock(f.durationMs / 1000)}</span></span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ─── Step 3: pick yourself ────────────────────────────────────────────────────

function PlayerList({ overview, fight, players }: { overview: ReportOverview; fight: ReportFight; players: FightPlayer[] }) {
  const groups: Array<[string, FightPlayer[]]> = [
    ['Tanks', players.filter(p => p.role === 'tank')],
    ['Healers', players.filter(p => p.role === 'healer')],
    ['Damage', players.filter(p => p.role === 'dps')],
  ];
  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <img src={BOSS_ICON(fight.encounterID)} alt="" className="w-10 h-10 rounded-lg object-cover" />
        <div>
          <h1 className="text-2xl font-black tracking-tight leading-tight">{fight.name}</h1>
          <p className="text-sm text-zinc-500">
            {DIFFICULTY_LABELS[fight.difficulty] ?? ''} · {fight.kill ? 'Kill' : `Wipe at ${Math.round(fight.fightPercentage)}%`} · {fmtClock(fight.durationMs / 1000)} · who are you?
          </p>
        </div>
      </div>
      <FightTabs overview={overview} fight={fight} active="players" />
      {players.length === 0 && <EmptyState title="No players found in this pull" text="The log may still be processing on Warcraft Logs." />}
      {groups.filter(([, list]) => list.length).map(([label, list]) => (
        <section key={label} className="space-y-2">
          <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">{label}</h2>
          <ul className="grid sm:grid-cols-2 gap-1.5">
            {list.sort((a, b) => a.name.localeCompare(b.name)).map(p => (
              <li key={p.id}>
                <Link
                  href={`/analyze?report=${overview.code}&fight=${fight.id}&player=${p.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/40 hover:bg-zinc-900 hover:border-zinc-700 px-3 py-2 transition-colors"
                >
                  <span className="min-w-0">
                    <span className={`font-bold ${classColor(p.className)}`}>{p.name}</span>
                    <span className="block text-xs text-zinc-500 truncate">{p.spec} {p.className}{p.server ? ` · ${p.server}` : ''}</span>
                  </span>
                  <span className="flex items-center gap-3 shrink-0"><LinkPending label="reviewing" />{p.ilvl > 0 && <span className="text-xs font-mono text-zinc-500">{Math.round(p.ilvl)} ilvl</span>}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ─── The review ───────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<Finding['category'], string> = {
  survival: 'Survival', mechanics: 'Mechanics', cooldowns: 'Cooldowns', rotation: 'Rotation', buffs: 'Buffs',
  prep: 'Consumables', gear: 'Gear', build: 'Talents', uptime: 'Uptime', utility: 'Utility', output: 'Output',
};

const SEVERITY_STYLE: Record<Finding['severity'], { border: string; dot: string }> = {
  bad:  { border: 'border-l-red-500/70',     dot: 'bg-red-400' },
  warn: { border: 'border-l-amber-500/70',   dot: 'bg-amber-400' },
  good: { border: 'border-l-emerald-500/70', dot: 'bg-emerald-400' },
  info: { border: 'border-l-zinc-600',       dot: 'bg-zinc-500' },
};

function ReviewView({ review, mechanics, player, fight, overview, reportCode }: { review: Review; mechanics: RaidItem[]; player: FightPlayer; fight: ReportFight; overview: ReportOverview; reportCode: string }) {
  const sections: Array<{ key: string; label: string; items: Finding[] }> = [
    { key: 'fix', label: 'Fix these first', items: review.findings.filter(f => f.severity === 'bad' || f.severity === 'warn') },
    { key: 'good', label: 'What went right', items: review.findings.filter(f => f.severity === 'good') },
    { key: 'info', label: 'Context', items: review.findings.filter(f => f.severity === 'info') },
  ];
  const wclUrl = `https://www.warcraftlogs.com/reports/${reportCode}#fight=${fight.id}&source=${player.id}`;

  return (
    <div className="space-y-8">
      <WowheadTooltips />
      <header className="space-y-3">
        <div className="flex items-start gap-3">
          <img src={BOSS_ICON(fight.encounterID)} alt="" className="w-12 h-12 rounded-xl object-cover mt-0.5" />
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl md:text-3xl font-black tracking-tight leading-tight">
              <span className={classColor(player.className)}>{player.name}</span>
              <span className="text-zinc-400 font-bold"> · {player.spec} {player.className}</span>
            </h1>
            <p className="text-sm text-zinc-400">
              {fight.name} · {DIFFICULTY_LABELS[fight.difficulty] ?? ''} {fight.kill ? 'kill' : `wipe at ${Math.round(fight.fightPercentage)}%`} · {fmtClock(fight.durationMs / 1000)}
              {' · '}
              <Link href={`/analyze?report=${overview.code}&fight=${fight.id}&view=players`} className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">other player</Link>
              {' · '}
              <Link href={`/analyze?report=${overview.code}&fight=${fight.id}`} className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">raid summary</Link>
              {' · '}
              <Link href={`/analyze?report=${overview.code}`} className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">other pull</Link>
            </p>
          </div>
        </div>
      </header>

      <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-transparent p-5 md:p-6 space-y-2">
        <p className="text-xs font-bold uppercase tracking-widest text-amber-400">The short version</p>
        <p className="text-lg md:text-xl leading-snug text-zinc-100 font-medium">{review.summary}</p>
        {review.poolNote && <p className="text-xs text-zinc-500 pt-1">{review.poolNote}</p>}
      </section>

      <StatsGrid stats={review.stats} cols="grid-cols-3 sm:grid-cols-4 lg:grid-cols-7" />

      {review.defensives.length > 0 && <DefensivesPanel rows={review.defensives} />}

      {/* The cooldown timeline sits under "Fix these first" when there is one, otherwise it leads. */}
      {!sections[0].items.length && review.timeline && review.timeline.rows.length > 0 && <TimelineView timeline={review.timeline} />}
      {!sections[0].items.length && mechanics.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Boss mechanics, for you</h2>
          <ul className="space-y-2">
            {mechanics.map(item => <ReviewCard key={item.id} {...item} rowHref={id => `/analyze?report=${reportCode}&fight=${fight.id}&player=${id}`} />)}
          </ul>
        </section>
      )}
      {sections.filter(s => s.items.length).map(s => (
        <React.Fragment key={s.key}>
          <section className="space-y-2.5">
            <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">{s.label}</h2>
            <ul className="space-y-2">
              {s.items.map(f => <ReviewCard key={f.id} {...f} category={CATEGORY_LABEL[f.category]} />)}
            </ul>
          </section>
          {s.key === 'fix' && review.timeline && review.timeline.rows.length > 0 && <TimelineView timeline={review.timeline} />}
          {s.key === 'fix' && mechanics.length > 0 && (
            <section className="space-y-2.5">
              <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Boss mechanics, for you</h2>
              <ul className="space-y-2">
                {mechanics.map(item => <ReviewCard key={item.id} {...item} rowHref={id => `/analyze?report=${reportCode}&fight=${fight.id}&player=${id}`} />)}
              </ul>
            </section>
          )}
        </React.Fragment>
      ))}

      <p className="text-xs text-zinc-600">
        {review.sourcesNote ? `${review.sourcesNote} ` : ''}Numbers come from the fight tables on Warcraft Logs.{' '}
        <a href={wclUrl} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">Open this pull on Warcraft Logs</a>
        {' '}to see the raw data behind any of it.
      </p>
    </div>
  );
}

// Wowhead tooltips on every ability link: hover an ability name to see what it is.
function WowheadTooltips() {
  return (
    <Script id="wowhead-tooltips" strategy="afterInteractive">{`window.whTooltips={colorLinks:false,iconizeLinks:false,renameLinks:false};var s=document.createElement('script');s.src='https://wow.zamimg.com/js/tooltips.js';s.async=true;document.head.appendChild(s);`}</Script>
  );
}

function StatsGrid({ stats, cols }: { stats: Array<{ label: string; value: string; note?: string }>; cols: string }) {
  return (
    <section className={`grid ${cols} gap-2`}>
      {stats.map(s => (
        <div key={s.label} className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 px-3 py-2.5 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 truncate">{s.label}</p>
          <p className="text-lg font-black text-zinc-100 tabular-nums leading-tight">{s.value}</p>
          {s.note && <p className="text-[10px] text-zinc-500 truncate">{s.note}</p>}
        </div>
      ))}
    </section>
  );
}

const EXPLAIN_MAX = 240;

// One card for both reviews: a player finding (category chip, evidence, link) or a
// raid item (comparison line, expandable per-player rows).
interface ReviewCardProps {
  severity: Finding['severity'];
  title: string;
  text: string;
  icon?: string;
  spellId?: number;
  explain?: string;
  evidence?: string;
  comparison?: string;
  category?: string;
  href?: string;
  hrefLabel?: string;
  rows?: RaidItem['rows'];
  rowsLabel?: string;
  rowsLayout?: 'list';
  rowHref?: (id: number) => string;
  events?: Array<{ atSec: number; text: string }>;
  tip?: string;
  id?: string;
}

function ReviewCard(c: ReviewCardProps) {
  const style = SEVERITY_STYLE[c.severity];
  const wowhead = c.spellId ? `https://www.wowhead.com/spell=${c.spellId}` : null;
  const icon = c.icon
    ? <img src={ABILITY_ICON(c.icon)} alt="" className="w-9 h-9 rounded-lg shrink-0 mt-0.5 border border-zinc-800" />
    : <span className="w-9 h-9 rounded-lg shrink-0 mt-0.5 bg-zinc-900 border border-zinc-800 flex items-center justify-center"><span className={`w-2 h-2 rounded-full ${style.dot}`} /></span>;
  const rows = c.rows ?? [];
  return (
    <li data-item={c.id} className={`rounded-xl border border-zinc-800/70 border-l-4 ${style.border} bg-zinc-900/40 p-4 flex gap-3`}>
      {wowhead ? <a href={wowhead} target="_blank" rel="noopener noreferrer" className="shrink-0">{icon}</a> : icon}
      <div className="min-w-0 space-y-1 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="font-bold text-zinc-100 leading-snug">
            {wowhead
              ? <a href={wowhead} target="_blank" rel="noopener noreferrer" className="hover:text-amber-200 underline decoration-zinc-700 underline-offset-4 decoration-dotted">{c.title}</a>
              : c.title}
          </p>
          {c.category && <span className="shrink-0 mt-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{c.category}</span>}
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed">{c.text}</p>
        {c.explain && <p className="text-xs text-zinc-500 italic leading-relaxed pt-0.5">{c.explain.length > EXPLAIN_MAX ? `${c.explain.slice(0, EXPLAIN_MAX - 3)}…` : c.explain}</p>}
        {c.comparison && <p className="text-xs font-mono text-zinc-500 pt-0.5">{c.comparison}</p>}
        {c.evidence && <p className="text-xs font-mono text-zinc-500 pt-0.5">{c.evidence}</p>}
        {c.tip && <p className="text-xs text-zinc-500 leading-relaxed pt-0.5">Tip: {c.tip}</p>}
        {c.href && <Link href={c.href} className="inline-block text-sm text-amber-400 hover:text-amber-300 pt-1">{c.hrefLabel ?? 'Open'} →</Link>}
        {rows.length > 0 && (
          <details className="pt-1 group">
            <summary className="cursor-pointer text-xs font-bold text-amber-400/90 hover:text-amber-300 select-none list-none">
              <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span> {rows.length} {c.rowsLabel || 'players'}
            </summary>
            <ul className={c.rowsLayout === 'list' ? 'mt-2 space-y-1 text-sm' : 'mt-2 grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm'}>
              {rows.map((r, i) => c.rowsLayout === 'list' ? (
                <li key={`${r.name}-${i}`} className="flex items-center gap-3 border-b border-zinc-800/50 py-1.5 min-w-0">
                  {r.id != null && r.id >= 0 && c.rowHref
                    ? <Link href={c.rowHref(r.id)} className={`font-semibold ${classColor(r.className)} hover:underline underline-offset-2 truncate w-28 shrink-0`}>{r.name}</Link>
                    : <span className={`font-semibold ${classColor(r.className)} truncate w-28 shrink-0`}>{r.name}</span>}
                  <span className="text-xs font-mono text-zinc-500 shrink-0 w-10">{r.value}</span>
                  {r.killer && (
                    <a href={r.killer.spellId ? `https://www.wowhead.com/spell=${r.killer.spellId}` : undefined} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 min-w-0 text-zinc-200 hover:text-amber-200">
                      {r.killer.icon && <img src={ABILITY_ICON(r.killer.icon)} alt="" className="w-5 h-5 rounded border border-zinc-700 shrink-0" />}
                      <span className="truncate">{r.killer.name}</span>
                    </a>
                  )}
                  {(r.icons?.length ?? 0) > 0 && (
                    <span className="flex items-center gap-1.5 shrink-0 ml-auto">
                      <span className="text-[10px] uppercase tracking-wider text-zinc-500 hidden sm:inline">ready</span>
                      {r.icons!.map(ic => (
                        <a key={ic.spellId || ic.name} href={ic.spellId ? `https://www.wowhead.com/spell=${ic.spellId}` : undefined} target="_blank" rel="noopener noreferrer" title={ic.name} className="shrink-0">
                          {ic.icon
                            ? <img src={ABILITY_ICON(ic.icon)} alt={ic.name} className="w-5 h-5 rounded border border-zinc-700" />
                            : <span className="inline-block w-5 h-5 rounded border border-zinc-700 bg-zinc-900 text-[9px] leading-5 text-center text-zinc-300">{ic.name.slice(0, 2)}</span>}
                        </a>
                      ))}
                    </span>
                  )}
                </li>
              ) : (
                <li key={`${r.name}-${i}`} className="flex items-center justify-between gap-3 border-b border-zinc-800/50 py-1">
                  {r.id != null && r.id >= 0 && c.rowHref
                    ? <Link href={c.rowHref(r.id)} className={`font-semibold ${classColor(r.className)} hover:underline underline-offset-2 truncate`}>{r.name}</Link>
                    : <span className={`font-semibold ${classColor(r.className)} truncate`}>{r.name}</span>}
                  <span className="flex items-center gap-1.5 shrink-0 max-w-[60%] min-w-0">
                    {r.icons?.map(ic => (
                      <a key={ic.spellId || ic.name} href={ic.spellId ? `https://www.wowhead.com/spell=${ic.spellId}` : undefined} target="_blank" rel="noopener noreferrer" title={ic.name} className="shrink-0">
                        {ic.icon
                          ? <img src={ABILITY_ICON(ic.icon)} alt={ic.name} className="w-5 h-5 rounded border border-zinc-700" />
                          : <span className="inline-block w-5 h-5 rounded border border-zinc-700 bg-zinc-900 text-[9px] leading-5 text-center text-zinc-300">{ic.name.slice(0, 2)}</span>}
                      </a>
                    ))}
                    <span className="text-xs font-mono text-zinc-400 truncate">{r.value}</span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {(c.events?.length ?? 0) > 0 && (
          <details className="pt-1 group">
            <summary className="cursor-pointer text-xs font-bold text-zinc-400 hover:text-zinc-200 select-none list-none">
              <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span> {c.events!.length} event{c.events!.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-2 space-y-0.5 text-xs font-mono text-zinc-400 max-h-72 overflow-y-auto pr-1">
              {c.events!.map((e, i) => (
                <li key={i} className="flex gap-3"><span className="text-zinc-600 shrink-0 w-10 text-right">{fmtClock(e.atSec)}</span><span>{e.text}</span></li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}

// Every personal defensive the character has, with cooldown, charges and how many
// times it was pressed against roughly how many the fight allowed.
function DefensivesPanel({ rows }: { rows: Review['defensives'] }) {
  const fmtCd = (s: number | null) => s == null ? '—' : s >= 60 ? `${Number.isInteger(s / 60) ? s / 60 : (s / 60).toFixed(1)} min` : `${s}s`;
  return (
    <section className="space-y-2.5">
      <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Your defensives</h2>
      <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 divide-y divide-zinc-800/50">
        {rows.map(r => {
          const short = r.possible != null && r.used < r.possible * 0.5;
          return (
            <div key={r.name} className="flex items-center gap-3 px-4 py-2 text-sm">
              {r.icon
                ? <img src={ABILITY_ICON(r.icon)} alt="" className="w-6 h-6 rounded border border-zinc-800 shrink-0" />
                : <span className="w-6 h-6 rounded bg-zinc-900 border border-zinc-800 shrink-0" />}
              <span className="font-semibold text-zinc-200 min-w-0 flex-1 truncate">
                {r.spellId ? <a href={`https://www.wowhead.com/spell=${r.spellId}`} target="_blank" rel="noopener noreferrer" className="hover:text-amber-200">{r.name}</a> : r.name}
              </span>
              <span className="text-xs font-mono text-zinc-500 shrink-0 hidden sm:inline">{fmtCd(r.cooldownSec)}{r.charges > 1 ? ` · ${r.charges} charges` : ''}</span>
              <span className={`text-xs font-mono shrink-0 tabular-nums ${short ? 'text-amber-300' : 'text-zinc-300'}`}>
                {r.used}{r.possible != null ? ` / ~${r.possible}` : '×'}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-zinc-500">Used against roughly how many presses the fight allowed, from each ability&apos;s cooldown and the time you were alive. Cooldowns and charges come from Wowhead and your talents.</p>
    </section>
  );
}

// When you had each cooldown running (amber) against when the top players did
// (faint ticks, one per activation per top player). Server-rendered SVG, no JS.
function TimelineView({ timeline }: { timeline: Timeline }) {
  const phases = (timeline.phases ?? []).filter(p => p.toSec > p.fromSec);
  const dur = Math.max(1, timeline.durationSec);
  const isIntermission = (name: string) => /intermission|transition/i.test(name);
  return (
    <section className="space-y-2.5">
      <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Major cooldowns and potions</h2>
      <TimelineChart timeline={timeline} />
      <p className="text-xs text-zinc-500">
        <span className="inline-block w-3 h-2 rounded-sm bg-emerald-400 align-middle mr-1.5" />a press inside the top players&apos; window ·{' '}
        <span className="inline-block w-3 h-2 rounded-sm bg-amber-500 align-middle mr-1.5" />a press outside it, or with no window to judge by ·{' '}
        <span className="inline-block w-3 h-2 rounded-sm align-middle mr-1.5" style={{ background: 'rgba(253,230,138,0.25)' }} />where the middle half of the top players press it, with{' '}
        <span className="inline-block w-0 h-0 align-middle mx-1" style={{ borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '6px solid #fde68a' }} />their median — hover any band or bar for the times
        {phases.length > 0 && <> · phases run across the top{phases.some(p => isIntermission(p.name)) ? ', intermissions in amber' : ''}</>}
        {timeline.rows.some(r => r.kind === 'buff') && <> · below the dashed line: cooldowns that show up as a buff rather than a cast</>}
        {' '}· major cooldowns only: a minute or longer, plus Bestial Wrath
        {timeline.aliveSec < dur - 2 && <> · <span className="inline-block w-3 h-2 rounded-sm bg-red-500/30 align-middle mr-1.5" />after your death</>}
      </p>
    </section>
  );
}

// ─── The raid view ────────────────────────────────────────────────────────────

function FightTabs({ overview, fight, active }: { overview: ReportOverview; fight: ReportFight; active: 'players' | 'raid' }) {
  const base = 'px-3 py-1.5 rounded-full text-xs font-bold transition-colors border';
  const on = 'bg-amber-500/15 border-amber-500/40 text-amber-300';
  const off = 'border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700';
  return (
    <div className="flex items-center gap-2">
      <Link href={`/analyze?report=${overview.code}&fight=${fight.id}`} className={`${base} ${active === 'raid' ? on : off}`}>Raid summary</Link>
      <Link href={`/analyze?report=${overview.code}&fight=${fight.id}&view=players`} className={`${base} ${active === 'players' ? on : off}`}>Player reviews</Link>
    </div>
  );
}

const RAID_GROUPS: Array<{ key: RaidItem['group']; label: string }> = [
  { key: 'ending', label: 'How the pull went' },
  { key: 'boss', label: 'Boss mechanics' },
  { key: 'mechanics', label: 'Mechanics' },
  { key: 'utility', label: 'Interrupts and dispels' },
  { key: 'prep', label: 'Consumables and gear' },
];

function RaidView({ review, fight, overview }: { review: RaidReview; fight: ReportFight; overview: ReportOverview }) {
  return (
    <div className="space-y-8">
      <WowheadTooltips />
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <img src={BOSS_ICON(fight.encounterID)} alt="" className="w-12 h-12 rounded-xl object-cover mt-0.5" />
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl md:text-3xl font-black tracking-tight leading-tight">{fight.name} <span className="text-zinc-400 font-bold">· raid summary</span></h1>
            <p className="text-sm text-zinc-400">
              {DIFFICULTY_LABELS[fight.difficulty] ?? ''} {fight.kill ? 'kill' : `wipe at ${Math.round(fight.fightPercentage)}%`} · {fmtClock(fight.durationMs / 1000)}
              {' · '}
              <Link href={`/analyze?report=${overview.code}`} className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">other pull</Link>
            </p>
          </div>
        </div>
        <FightTabs overview={overview} fight={fight} active="raid" />
      </header>

      <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-transparent p-5 md:p-6 space-y-2">
        <p className="text-xs font-bold uppercase tracking-widest text-amber-400">The short version</p>
        <p className="text-lg md:text-xl leading-snug text-zinc-100 font-medium">{review.summary}</p>
      </section>

      <StatsGrid stats={review.stats} cols="grid-cols-3 sm:grid-cols-5" />

      {RAID_GROUPS.map(g => {
        const items = review.items.filter(i => i.group === g.key);
        if (!items.length) return null;
        return (
          <section key={g.key} className="space-y-2.5">
            <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">{g.label}</h2>
            <ul className="space-y-2">
              {items.map(item => <ReviewCard key={item.id} {...item} rowHref={id => `/analyze?report=${overview.code}&fight=${fight.id}&player=${id}`} />)}
            </ul>
          </section>
        );
      })}

      <p className="text-xs text-zinc-600">
        {review.sourcesNote ? `${review.sourcesNote} ` : ''}Numbers come from the fight tables on Warcraft Logs.{' '}
        <a href={`https://www.warcraftlogs.com/reports/${overview.code}#fight=${fight.id}`} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">Open this pull on Warcraft Logs</a>.
      </p>
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-6 space-y-1">
      <p className="font-bold text-zinc-100">{title}</p>
      <p className="text-sm text-zinc-400">{text}</p>
      <Link href="/analyze" className="inline-block pt-2 text-sm text-amber-400 hover:text-amber-300">Try another report</Link>
    </div>
  );
}

