import React, { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getWclToken, getRaidStructure, MIDNIGHT_RAIDS, DPS_SPECS } from '../../lib/wow';
import TierListContent from './TierListContent';
import OverallTierListContent from './OverallTierListContent';

interface PageProps {
  searchParams: Promise<{ boss?: string; bossName?: string; difficulty?: string; region?: string }>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const sp = await searchParams;
  const bossName = sp.bossName;
  const diff = sp.difficulty ? parseInt(sp.difficulty) : 5;
  const diffLabel = diff === 4 ? 'Heroic' : 'Mythic';
  const title = bossName
    ? `${diffLabel} ${bossName} DPS Tier List | HotsBB`
    : 'WoW Raid DPS Tier List | HotsBB';
  const description = bossName
    ? `DPS spec tier list for ${diffLabel} ${bossName} — ranked by avg DPS of top 50 parses.`
    : 'DPS spec tier lists for every WoW Mythic raid boss, ranked by top parse performance.';
  return { title, description };
}

export default async function TierListPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const activeDifficulty = sp.difficulty ? parseInt(sp.difficulty) : 5;
  const activeRegion = sp.region ?? 'us';
  const activeBossId = sp.boss ? parseInt(sp.boss) : null;

  const wclToken = await getWclToken();
  const zones = await getRaidStructure(wclToken);

  const encounters: Array<{ id: number; name: string; zoneName: string }> = zones
    .filter((z: any) => z.name in MIDNIGHT_RAIDS)
    .flatMap((z: any) => (z.encounters ?? []).map((enc: any) => ({ id: enc.id, name: enc.name, zoneName: z.name })));

  const selectedBoss = activeBossId ? (encounters.find(e => e.id === activeBossId) ?? null) : null;

  const url = (overrides: { boss?: number; bossName?: string; difficulty?: number; region?: string }) => {
    const b = overrides.boss ?? selectedBoss?.id;
    const bn = overrides.bossName ?? selectedBoss?.name;
    const d = overrides.difficulty ?? activeDifficulty;
    const r = overrides.region ?? activeRegion;
    const p: string[] = [`difficulty=${d}`];
    if (r !== 'us') p.push(`region=${r}`);
    if (b) p.push(`boss=${b}`);
    if (bn) p.push(`bossName=${encodeURIComponent(bn)}`);
    return `/tier-list?${p.join('&')}`;
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">
      {/* Header */}
      <header className="border-b border-zinc-800/70 bg-black/70 backdrop-blur-md sticky top-0 z-50">
        <div className="px-4 md:px-5 h-12 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link href="/" className="font-black text-amber-400 tracking-widest uppercase text-xs hover:text-amber-300 transition-colors whitespace-nowrap">
              <span className="hidden sm:inline">HotsBB Raid Talents</span>
              <span className="sm:hidden">Raid Talents</span>
            </Link>
            <span className="hidden sm:inline text-zinc-700">/</span>
            <span className="hidden sm:inline text-xs font-black text-zinc-300 uppercase tracking-widest">DPS Tier List</span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Link href="/" className="hidden sm:block text-[11px] font-bold text-zinc-500 hover:text-zinc-300 transition-colors uppercase tracking-widest px-2">Raid Talents</Link>
            {/* Role switcher */}
            {(() => {
              const qs = `difficulty=${activeDifficulty}${activeRegion !== 'us' ? `&region=${activeRegion}` : ''}${selectedBoss ? `&boss=${selectedBoss.id}&bossName=${encodeURIComponent(selectedBoss.name ?? '')}` : ''}`;
              return (
                <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5 border border-zinc-800/80">
                  <span className="px-3 py-1 rounded-md text-xs font-bold bg-zinc-700/50 text-zinc-200">DPS</span>
                  <Link href={`/tier-list/tanks?${qs}`} className="px-3 py-1 rounded-md text-xs font-bold text-zinc-500 hover:text-zinc-300 transition-colors">Tanks</Link>
                  <Link href={`/tier-list/healers?${qs}`} className="px-3 py-1 rounded-md text-xs font-bold text-zinc-500 hover:text-zinc-300 transition-colors">Healers</Link>
                </div>
              );
            })()}
            {/* Region */}
            <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5 border border-zinc-800/80">
              {(['us', 'eu'] as const).map(r => (
                <Link key={r} href={url({ region: r })}
                  className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${activeRegion === r ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}>
                  {r.toUpperCase()}
                </Link>
              ))}
            </div>
            {/* Difficulty */}
            <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5 border border-zinc-800/80">
              <Link href={url({ difficulty: 4 })}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${activeDifficulty === 4 ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}>
                Heroic
              </Link>
              <Link href={url({ difficulty: 5 })}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${activeDifficulty === 5 ? 'bg-purple-500/15 text-purple-400 border border-purple-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}>
                Mythic
              </Link>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-screen-md mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Boss selector */}
        <div className="flex flex-wrap gap-1.5">
          {encounters.map(enc => (
            <Link
              key={enc.id}
              href={url({ boss: enc.id, bossName: enc.name })}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
                selectedBoss?.id === enc.id
                  ? 'bg-zinc-800 border-zinc-600 text-zinc-100'
                  : 'border-zinc-800/60 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
              }`}
            >
              <img src={`https://assets.rpglogs.com/img/warcraft/bosses/${enc.id}-icon.jpg`} alt="" className="w-4 h-4 rounded object-cover flex-shrink-0" />
              {enc.name}
            </Link>
          ))}
        </div>

        {selectedBoss ? (
          <Suspense fallback={<TierListSkeleton />}>
            <TierListContent
              bossId={selectedBoss.id}
              bossName={selectedBoss.name}
              difficulty={activeDifficulty}
              region={activeRegion}
              wclToken={wclToken}
              specs={DPS_SPECS}
              thresholds={{ S: 95, A: 88, B: 78 }}
              footerNote="Tiers by avg DPS relative to peak spec · excludes tanks and healers · Augmentation Evoker personal DPS will appear lower than actual raid contribution · click any row to view the consensus talent build"
            />
          </Suspense>
        ) : (
          <Suspense fallback={<TierListSkeleton />}>
            <OverallTierListContent
              wclToken={wclToken}
              bossIds={encounters.map(e => e.id)}
              specs={DPS_SPECS}
              difficulty={activeDifficulty}
              region={activeRegion}
              role="dps"
              thresholds={{ S: 95, A: 88, B: 78 }}
              title="Midnight Season 1 Raid DPS Tier List"
              footerNote="Avg DPS per spec across all Midnight bosses · excludes tanks and healers · Augmentation Evoker personal DPS appears lower than actual raid contribution · click any row to view talent builds"
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function TierListSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-1">
        <div className="h-6 w-40 bg-zinc-800 rounded" />
        <div className="h-3 w-64 bg-zinc-800/60 rounded" />
      </div>
      {(['S', 'A', 'B', 'C'] as const).map((tier, ti) => (
        <div key={tier} className="space-y-1.5">
          <div className="h-6 w-16 bg-zinc-800 rounded-lg" />
          {Array.from({ length: ti === 0 ? 2 : ti === 1 ? 4 : ti === 2 ? 6 : 4 }).map((_, i) => (
            <div key={i} className="h-14 bg-zinc-900/40 border border-zinc-800/50 rounded-xl" />
          ))}
        </div>
      ))}
    </div>
  );
}
