import React, { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getWclToken, getRaidStructure, MIDNIGHT_RAIDS, TANK_SPECS } from '../../../lib/wow';
import TierListContent from '../TierListContent';
import OverallTierListContent from '../OverallTierListContent';

interface PageProps {
  searchParams: Promise<{ boss?: string; bossName?: string; difficulty?: string; region?: string }>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const sp = await searchParams;
  const bossName = sp.bossName;
  const diff = sp.difficulty ? parseInt(sp.difficulty) : 5;
  const diffLabel = diff === 4 ? 'Heroic' : 'Mythic';
  const title = bossName
    ? `${diffLabel} ${bossName} Tank Tier List | HotsBB`
    : 'Midnight Season 1 Tank DPS Tier List — All Bosses | HotsBB';
  const description = bossName
    ? `Tank spec tier list for ${diffLabel} ${bossName} — ranked by avg DPS of top 50 parses.`
    : 'Overall tank spec tier list for WoW Midnight Season 1 — avg DPS across all raid bosses, ranked from top parses.';
  return { title, description };
}

export default async function TankTierListPage({ searchParams }: PageProps) {
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
    return `/tier-list/tanks?${p.join('&')}`;
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'HotsBB Raid Talents', item: 'https://hotsbbtalents.io' },
      { '@type': 'ListItem', position: 2, name: 'Tank Tier List', item: 'https://hotsbbtalents.io/tier-list/tanks' },
      ...(selectedBoss ? [{ '@type': 'ListItem', position: 3, name: selectedBoss.name, item: `https://hotsbbtalents.io/tier-list/tanks?boss=${selectedBoss.id}` }] : []),
    ],
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      {/* Header */}
      <header className="border-b border-zinc-800/70 bg-black/70 backdrop-blur-md sticky top-0 z-50">
        <div className="px-4 md:px-5 h-12 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link href="/" className="font-black text-amber-400 tracking-widest uppercase text-xs hover:text-amber-300 transition-colors whitespace-nowrap">
              <span className="hidden sm:inline">HotsBB Raid Talents</span>
              <span className="sm:hidden">HotsBB</span>
            </Link>
            <span className="hidden sm:inline text-zinc-700">/</span>
            <Link href={`/tier-list/tanks?difficulty=${activeDifficulty}${activeRegion !== 'us' ? `&region=${activeRegion}` : ''}`} className="hidden sm:inline text-xs font-black text-zinc-300 hover:text-zinc-100 uppercase tracking-widest transition-colors">Tank Tier List</Link>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Link href="/" className="hidden sm:block text-[11px] font-bold text-zinc-500 hover:text-zinc-300 transition-colors uppercase tracking-widest px-2">Raid Talents</Link>
            {/* Role switcher */}
            {(() => {
              const qs = `difficulty=${activeDifficulty}${activeRegion !== 'us' ? `&region=${activeRegion}` : ''}${selectedBoss ? `&boss=${selectedBoss.id}&bossName=${encodeURIComponent(selectedBoss.name ?? '')}` : ''}`;
              return (
                <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5 border border-zinc-800/80">
                  <Link href={`/tier-list?${qs}`} className="px-3 py-1 rounded-md text-xs font-bold text-zinc-500 hover:text-zinc-300 transition-colors">DPS</Link>
                  <span className="px-3 py-1 rounded-md text-xs font-bold bg-zinc-700/50 text-zinc-200">Tanks</span>
                  <Link href={`/tier-list/healers?${qs}`} className="px-3 py-1 rounded-md text-xs font-bold text-zinc-500 hover:text-zinc-300 transition-colors">Healers</Link>
                </div>
              );
            })()}
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
        <div className="space-y-2">
          <p className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">Per-boss breakdown</p>
          <div className="flex overflow-x-auto scrollbar-none gap-1.5 pb-1 -mx-4 px-4 md:mx-0 md:px-0 md:flex-wrap md:pb-0">
            {encounters.map(enc => (
              <Link
                key={enc.id}
                href={url({ boss: enc.id, bossName: enc.name })}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all border flex-shrink-0 ${
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
        </div>

        {selectedBoss ? (
          <Suspense fallback={<TierListSkeleton />}>
            <TierListContent
              bossId={selectedBoss.id}
              bossName={selectedBoss.name}
              difficulty={activeDifficulty}
              region={activeRegion}
              wclToken={wclToken}
              specs={TANK_SPECS}
              footerNote="Tiers by avg DPS relative to peak tank spec on this boss · excludes DPS and healer roles · click any row to view the consensus talent build"
            />
          </Suspense>
        ) : (
          <Suspense fallback={<TierListSkeleton />}>
            <OverallTierListContent
              wclToken={wclToken}
              bossIds={encounters.map(e => e.id)}
              specs={TANK_SPECS}
              difficulty={activeDifficulty}
              region={activeRegion}
              role="tank"
              title="Midnight Season 1 Raid Tank DPS Tier List"
              footerNote="Avg DPS per spec across all Midnight bosses · excludes DPS and healers · click any row to view talent builds"
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
        <div className="h-6 w-40 bg-sky-500/10 rounded" />
        <div className="h-3 w-64 bg-zinc-800/60 rounded" />
      </div>
      {(['S', 'A', 'B', 'C'] as const).map((tier, ti) => (
        <div key={tier} className="space-y-1.5">
          <div className={`h-9 rounded-xl ${ti === 0 ? 'w-11 bg-sky-500/20' : 'w-9 bg-zinc-800'}`} />
          {Array.from({ length: ti === 0 ? 1 : 2 }).map((_, i) => (
            <div key={i} className="h-14 bg-zinc-900/40 border border-sky-500/10 rounded-xl" />
          ))}
        </div>
      ))}
    </div>
  );
}
