import { unstable_cache } from 'next/cache';
import Link from 'next/link';
import { getWclRankings, getBlizzardToken, POPULAR_SPECS, SPEC_IDS } from '../../lib/wow';

function fixedTierAssignments(sortedAvgDps: number[], thresholds: { S: number; A: number; B: number }): Array<'S' | 'A' | 'B' | 'C'> {
  const top = sortedAvgDps[0];
  return sortedAvgDps.map(dps => {
    const pct = (dps / top) * 100;
    if (pct >= thresholds.S) return 'S';
    if (pct >= thresholds.A) return 'A';
    if (pct >= thresholds.B) return 'B';
    return 'C';
  });
}

function computeTierAssignments(sortedAvgDps: number[]): Array<'S' | 'A' | 'B' | 'C'> {
  const n = sortedAvgDps.length;
  if (n === 0) return [];
  const top = sortedAvgDps[0];
  const gaps = sortedAvgDps.slice(1).map((dps, i) => ({
    afterIdx: i,
    gapPct: ((sortedAvgDps[i] - dps) / top) * 100,
  }));
  const boundaries = new Set(
    gaps
      .filter(g => g.gapPct >= 2)
      .sort((a, b) => b.gapPct - a.gapPct)
      .slice(0, 3)
      .map(g => g.afterIdx)
  );
  const letters = ['S', 'A', 'B', 'C'] as const;
  let tier = 0;
  return sortedAvgDps.map((_, i) => {
    const t = letters[Math.min(tier, 3)];
    if (boundaries.has(i)) tier++;
    return t;
  });
}

function classHex(color: string): string {
  const m = color.match(/\[([^\]]+)\]/);
  return m ? m[1] : '#71717a';
}

function fmtDps(dps: number): string {
  if (dps >= 1_000_000) return `${(dps / 1_000_000).toFixed(1)}M`;
  return `${(dps / 1_000).toFixed(1)}k`;
}

const TIER_CONFIG = {
  S: { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30', hex: '#f59e0b' },
  A: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', hex: '#34d399' },
  B: { color: 'text-sky-400', bg: 'bg-sky-500/10', border: 'border-sky-500/30', hex: '#38bdf8' },
  C: { color: 'text-zinc-500', bg: 'bg-zinc-800/40', border: 'border-zinc-700/40', hex: '#52525b' },
} as const;

async function pLimit<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

async function computeOverall(
  wclToken: string,
  specs: Array<{ class: string; spec: string }>,
  bossIds: number[],
  difficulty: number,
  metric?: string
) {
  // Fetch US + EU in parallel for each spec × boss, then pool into a single top-50
  const tasks = specs.flatMap(({ class: cls, spec }) =>
    bossIds.map(bossId => async () => {
      try {
        const [usRankings, euRankings] = await Promise.all([
          getWclRankings(wclToken, bossId, cls, spec, difficulty, 'us', metric, true),
          getWclRankings(wclToken, bossId, cls, spec, difficulty, 'eu', metric, true),
        ]);
        const combined = [...(usRankings as any[]), ...(euRankings as any[])]
          .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
        const top = combined.slice(0, 50);
        if (top.length >= 5) {
          const avg = top.reduce((s: number, r: any) => s + (r.amount ?? 0), 0) / top.length;
          if (avg > 0) return { cls, spec, bossId, avgDps: avg };
        }
      } catch {}
      return { cls, spec, bossId, avgDps: 0 };
    })
  );

  const taskResults = await pLimit(tasks, 20);

  // Group by boss so we can find the peak spec per boss
  const bossDps = new Map<number, Map<string, number>>();
  for (const bossId of bossIds) bossDps.set(bossId, new Map());
  for (const { cls, spec, bossId, avgDps } of taskResults) {
    if (avgDps > 0) bossDps.get(bossId)!.set(`${cls}:${spec}`, avgDps);
  }

  // Score = sum of (spec_dps / boss_peak_dps * 100) across all bosses.
  // Specs with no data on a boss simply don't add to their score for that boss.
  // This mirrors WCL All Stars: consistency across many bosses beats cherry-picking one.
  return specs.map(({ class: cls, spec }) => {
    const specKey = `${cls}:${spec}`;
    let score = 0;
    const dpsValues: number[] = [];

    for (const [, specMap] of bossDps) {
      const peakDps = Math.max(...Array.from(specMap.values()), 0);
      if (peakDps === 0) continue;
      const dps = specMap.get(specKey);
      if (dps) {
        score += (dps / peakDps) * 100;
        dpsValues.push(dps);
      }
    }

    const avgDps = dpsValues.length > 0
      ? Math.round(dpsValues.reduce((s, v) => s + v, 0) / dpsValues.length)
      : 0;
    const peakDps = dpsValues.length > 0 ? Math.round(Math.max(...dpsValues)) : 0;

    return { cls, spec, score, avgDps, peakDps, bossCount: dpsValues.length };
  });
}

export default async function OverallTierListContent({
  wclToken,
  bossIds,
  specs,
  difficulty,
  region,
  footerNote,
  metric,
  thresholds,
  role,
  title,
}: {
  wclToken: string;
  bossIds: number[];
  specs: Array<{ class: string; spec: string }>;
  difficulty: number;
  region: string;
  footerNote: string;
  metric?: string;
  thresholds?: { S: number; A: number; B: number };
  role: string;
  title?: string;
}) {
  const blizzardToken = await getBlizzardToken();

  const [{ specs: rawResults, cachedAt }, specIcons] = await Promise.all([
    unstable_cache(
      async () => ({ specs: await computeOverall(wclToken, specs, bossIds, difficulty, metric), cachedAt: new Date().toISOString() }),
      [`wcl-overall-v6-${role}-${difficulty}-combined${metric ? `-${metric}` : ''}`],
      { revalidate: 604800 }
    )().then(r => r),
    (async () => {
      const iconMap: Record<string, string> = {};
      await Promise.all(
        specs.map(async ({ class: cls, spec }) => {
          const specId = SPEC_IDS[cls]?.[spec];
          if (!specId) return;
          try {
            const r = await fetch(
              `https://us.api.blizzard.com/data/wow/media/playable-specialization/${specId}?namespace=static-us`,
              { headers: { Authorization: `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }
            );
            if (r.ok) iconMap[`${cls}:${spec}`] = (await r.json()).assets?.[0]?.value ?? '';
          } catch {}
        })
      );
      return iconMap;
    })(),
  ]);

  const specData = rawResults
    .map(({ cls, spec, score, avgDps, peakDps, bossCount }) => {
      if (score === 0) return null;
      const classObj = POPULAR_SPECS.find(c => c.class === cls)!;
      return { cls, spec, score, avgDps, peakDps, bossCount, color: classObj.color, hex: classHex(classObj.color) };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.score - a.score);

  if (specData.length === 0) {
    return (
      <p className="text-sm text-zinc-600 py-12 text-center">
        No data available for {difficulty === 5 ? 'Mythic' : 'Heroic'} yet.
      </p>
    );
  }

  const maxScore = specData[0].score;
  const scoreValues = specData.map(s => s.score);
  const tierAssignments = thresholds
    ? fixedTierAssignments(scoreValues, thresholds)
    : computeTierAssignments(scoreValues);
  const tiered = specData.map((s, globalRank) => ({
    ...s,
    globalRank: globalRank + 1,
    iconUrl: specIcons[`${s.cls}:${s.spec}`] ?? '',
    barPct: Math.round((s.score / maxScore) * 100),
    tier: tierAssignments[globalRank],
    delta: globalRank === 0 ? null : -((1 - s.score / maxScore) * 100),
  }));

  const diffLabel = difficulty === 5 ? 'Mythic' : 'Heroic';

  const schemaData = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: title ?? `${diffLabel} Overall Tier List`,
    description: `${diffLabel} spec rankings averaged across all Midnight bosses · ${region.toUpperCase()}`,
    itemListElement: tiered.map(s => ({
      '@type': 'ListItem',
      position: s.globalRank,
      name: `${s.spec} ${s.cls} — ${s.tier} tier · ${fmtDps(s.avgDps)} avg DPS`,
    })),
  };

  return (
    <div className="space-y-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schemaData) }} />
      {title && <h1 className="text-xl font-black text-zinc-100 tracking-tight">{title}</h1>}
      <div>
        <p className="text-xs text-zinc-500">
          {diffLabel} · avg DPS across all bosses · {region.toUpperCase()} · as of {new Date(cachedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} · refreshed weekly on Mondays
        </p>
      </div>

      <div className="space-y-6">
        {(['S', 'A', 'B', 'C'] as const).map(tier => {
          const tierSpecs = tiered.filter(s => s.tier === tier);
          if (tierSpecs.length === 0) return null;
          const cfg = TIER_CONFIG[tier];

          return (
            <div key={tier}>
              <div className="flex items-center gap-3 mb-3">
                <div className={`${tier === 'S' ? 'w-11 h-11 text-lg ring-1 ring-amber-500/25 shadow-lg shadow-amber-500/10' : 'w-9 h-9 text-base'} rounded-xl flex items-center justify-center font-black border flex-shrink-0 ${cfg.color} ${cfg.bg} ${cfg.border}`}>
                  {tier}
                </div>
                <div
                  className="flex-1 h-px"
                  style={{ background: `linear-gradient(to right, ${cfg.hex}50, transparent)` }}
                />
                <span className="text-[10px] font-semibold text-zinc-700 flex-shrink-0">
                  {tierSpecs.length} spec{tierSpecs.length !== 1 ? 's' : ''}
                </span>
              </div>

              <div className="space-y-1.5">
                {tierSpecs.map(s => {
                  const talentUrl = `/?class=${encodeURIComponent(s.cls)}&spec=${encodeURIComponent(s.spec)}&difficulty=${difficulty}${region !== 'us' ? `&region=${region}` : ''}`;
                  return (
                    <Link
                      key={`${s.cls}:${s.spec}`}
                      href={talentUrl}
                      className="flex items-center gap-3 bg-zinc-900/40 border border-zinc-800/50 rounded-xl px-3 py-3 hover:bg-zinc-900/80 hover:border-zinc-700/70 transition-all group"
                    >
                      <span className="text-xs font-mono text-zinc-700 w-5 text-right flex-shrink-0">
                        {s.globalRank}
                      </span>

                      {s.iconUrl
                        ? <img src={s.iconUrl} alt="" className="w-8 h-8 rounded-lg flex-shrink-0 border border-zinc-700/60" />
                        : <div className="w-8 h-8 rounded-lg bg-zinc-800 flex-shrink-0 border border-zinc-700/60" />
                      }

                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1.5 mb-1.5">
                          <span className={`text-sm font-black ${s.color}`}>{s.spec}</span>
                          <span className="text-xs text-zinc-600">{s.cls}</span>
                        </div>
                        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${s.barPct}%`, backgroundColor: s.hex, opacity: 0.7 }}
                          />
                        </div>
                      </div>

                      <div className="text-right shrink-0 w-24">
                        <p className={`text-sm font-black tabular-nums ${cfg.color}`}>{fmtDps(s.avgDps)}</p>
                        <p className={`text-[10px] font-bold tabular-nums ${s.delta === null ? 'text-amber-500/70' : 'text-zinc-600'}`}>
                          {s.delta === null ? 'peak' : `${Math.abs(s.delta).toFixed(1)}% behind`}
                        </p>
                      </div>

                      <span className="text-zinc-700 group-hover:text-zinc-400 transition-colors text-sm flex-shrink-0">→</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-zinc-700 border-t border-zinc-800/50 pt-4">
        {footerNote}
      </p>
    </div>
  );
}
