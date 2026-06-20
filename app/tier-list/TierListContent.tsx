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

// Find the 3 largest gaps in a sorted DPS list and use them as S/A/B/C boundaries.
// Minimum gap of 2% of peak to count as a tier break.
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

export default async function TierListContent({
  bossId,
  bossName,
  difficulty,
  region,
  wclToken,
  specs,
  footerNote,
  metric,
  thresholds,
}: {
  bossId: number;
  bossName: string;
  difficulty: number;
  region: string;
  wclToken: string;
  specs: Array<{ class: string; spec: string }>;
  footerNote: string;
  metric?: string;
  thresholds?: { S: number; A: number; B: number };
}) {
  const blizzardToken = await getBlizzardToken();

  const [rankingResults, specIcons] = await Promise.all([
    Promise.all(
      specs.map(({ class: cls, spec }) =>
        unstable_cache(
          () => getWclRankings(wclToken, bossId, cls, spec, difficulty, region, metric),
          [`wcl-rankings-${bossId}-${cls}-${spec}-${difficulty}-${region}${metric ? `-${metric}` : ''}`],
          { revalidate: 604800 }
        )().then(rankings => ({ cls, spec, rankings })).catch(() => ({ cls, spec, rankings: [] }))
      )
    ),
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

  const specData = rankingResults
    .map(({ cls, spec, rankings }) => {
      const top = (rankings as any[]).slice(0, 50);
      if (top.length < 5) return null;
      const avgDps = Math.round(top.reduce((s, r) => s + (r.amount ?? 0), 0) / top.length);
      if (avgDps === 0) return null;
      const classObj = POPULAR_SPECS.find(c => c.class === cls)!;
      return { cls, spec, avgDps, sampleSize: top.length, color: classObj.color, hex: classHex(classObj.color) };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.avgDps - a.avgDps);

  if (specData.length === 0) {
    return (
      <p className="text-sm text-zinc-600 py-12 text-center">
        No data for this boss on {difficulty === 5 ? 'Mythic' : 'Heroic'} yet.
      </p>
    );
  }

  const maxDps = specData[0].avgDps;
  const dpsValues = specData.map(s => s.avgDps);
  const tierAssignments = thresholds
    ? fixedTierAssignments(dpsValues, thresholds)
    : computeTierAssignments(dpsValues);
  const tiered = specData.map((s, globalRank) => ({
    ...s,
    globalRank: globalRank + 1,
    iconUrl: specIcons[`${s.cls}:${s.spec}`] ?? '',
    barPct: Math.round((s.avgDps / maxDps) * 100),
    tier: tierAssignments[globalRank],
    delta: globalRank === 0 ? null : -((1 - s.avgDps / maxDps) * 100),
  }));

  const diffLabel = difficulty === 5 ? 'Mythic' : 'Heroic';

  const schemaData = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${diffLabel} ${bossName} Tier List`,
    description: `${diffLabel} spec rankings for ${bossName} · avg DPS of top 50 parses · ${region.toUpperCase()}`,
    itemListElement: tiered.map(s => ({
      '@type': 'ListItem',
      position: s.globalRank,
      name: `${s.spec} ${s.cls} — ${s.tier} tier · ${fmtDps(s.avgDps)} avg DPS`,
    })),
  };

  return (
    <div className="space-y-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schemaData) }} />
      <div>
        <h1 className="text-xl font-black text-white">{bossName}</h1>
        <p className="text-xs text-zinc-500 mt-1">
          {diffLabel} · avg DPS of top 50 parses per spec · {region.toUpperCase()}
        </p>
      </div>

      <div className="space-y-6">
        {(['S', 'A', 'B', 'C'] as const).map(tier => {
          const specs = tiered.filter(s => s.tier === tier);
          if (specs.length === 0) return null;
          const cfg = TIER_CONFIG[tier];

          return (
            <div key={tier}>
              {/* Tier header */}
              <div className="flex items-center gap-3 mb-3">
                <div className={`${tier === 'S' ? 'w-11 h-11 text-lg ring-1 ring-amber-500/25 shadow-lg shadow-amber-500/10' : 'w-9 h-9 text-base'} rounded-xl flex items-center justify-center font-black border flex-shrink-0 ${cfg.color} ${cfg.bg} ${cfg.border}`}>
                  {tier}
                </div>
                <div
                  className="flex-1 h-px"
                  style={{ background: `linear-gradient(to right, ${cfg.hex}50, transparent)` }}
                />
                <span className="text-[10px] font-semibold text-zinc-700 flex-shrink-0">
                  {specs.length} spec{specs.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Spec rows */}
              <div className="space-y-1.5">
                {specs.map(s => {
                  const mainPageUrl = `/?boss=${bossId}&bossName=${encodeURIComponent(bossName)}&class=${encodeURIComponent(s.cls)}&spec=${encodeURIComponent(s.spec)}&difficulty=${difficulty}${region !== 'us' ? `&region=${region}` : ''}`;
                  return (
                    <Link
                      key={`${s.cls}:${s.spec}`}
                      href={mainPageUrl}
                      className="flex items-center gap-3 bg-zinc-900/40 border border-zinc-800/50 rounded-xl px-3 py-3 hover:bg-zinc-900/80 hover:border-zinc-700/70 transition-all group"
                    >
                      {/* Global rank */}
                      <span className="text-xs font-mono text-zinc-700 w-5 text-right flex-shrink-0">
                        {s.globalRank}
                      </span>

                      {/* Spec icon */}
                      {s.iconUrl
                        ? <img src={s.iconUrl} alt="" className="w-8 h-8 rounded-lg flex-shrink-0 border border-zinc-700/60" />
                        : <div className="w-8 h-8 rounded-lg bg-zinc-800 flex-shrink-0 border border-zinc-700/60" />
                      }

                      {/* Name + bar */}
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

                      {/* DPS + delta */}
                      <div className="text-right shrink-0 w-20">
                        <p className={`text-sm font-black tabular-nums ${cfg.color}`}>{fmtDps(s.avgDps)}</p>
                        <p className={`text-[10px] font-bold tabular-nums ${s.delta === null ? 'text-amber-500/70' : 'text-zinc-600'}`}>
                          {s.delta === null ? 'peak' : `${Math.abs(s.delta).toFixed(1)}% behind`}
                        </p>
                      </div>

                      {/* Hover arrow */}
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
