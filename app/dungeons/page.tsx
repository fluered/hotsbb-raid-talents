import React, { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import BossContent from '../BossContent';
import DungeonCardImage from '../../components/DungeonCardImage';
import {
  getBlizzardToken,
  POPULAR_SPECS, SPEC_IDS, CLASS_IDS, MIDNIGHT_DUNGEONS, MPLUS_DIFFICULTY, MPLUS_ZONE_ID,
} from '../../lib/wow';

interface PageProps {
  searchParams: Promise<{ dungeon?: string; dungeonName?: string; class?: string; spec?: string; region?: string }>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const sp = await searchParams;
  const cls = sp.class;
  const spec = sp.spec;
  const dungeonName = sp.dungeonName;

  let title: string;
  let description: string;

  if (cls && spec && dungeonName) {
    title = `Best ${spec} ${cls} Talents for ${dungeonName} M+ | HotsBB`;
    description = `Meta ${spec} ${cls} talent build for ${dungeonName} Mythic+. From top-parsing players in Midnight Season 1.`;
  } else if (cls && spec) {
    title = `${spec} ${cls} Dungeon Talents — Midnight M+ Season 1 | HotsBB`;
    description = `Best ${spec} ${cls} talent builds for every Midnight Season 1 M+ dungeon. Meta builds from top key holders.`;
  } else {
    title = `Mythic+ Dungeon Talent Finder — Midnight Season 1 | HotsBB`;
    description = `Find the meta talent build for every spec in every Midnight Season 1 Mythic+ dungeon. From top-parsing key holders.`;
  }

  return {
    title,
    description,
    openGraph: { title, description, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="flex gap-2">
        {[1, 2, 3].map(i => <div key={i} className="h-9 w-28 rounded-full bg-zinc-800/60" />)}
      </div>
      <div className="h-px bg-zinc-800/50" />
      <div className="space-y-3">
        <div className="h-5 w-48 rounded bg-zinc-800/60" />
        <div className="h-4 w-72 rounded bg-zinc-800/40" />
        <div className="h-64 rounded-2xl bg-zinc-900/40 border border-zinc-800/50" />
      </div>
    </div>
  );
}

export default async function DungeonsPage(props: PageProps) {
  const searchParams = await props.searchParams;
  const activeDungeonId = searchParams.dungeon ? parseInt(searchParams.dungeon) : null;
  const activeDungeonName = searchParams.dungeonName || null;
  const activeClass = searchParams.class || null;
  const activeSpec = searchParams.spec || null;
  const activeRegion = (searchParams.region === 'eu' ? 'eu' : 'us') as 'us' | 'eu';

  let specIconMap: Record<string, string> = {};
  let classIconMap: Record<string, string> = {};
  let dungeonImageMap: Record<number, string> = {};

  try {
    const blizzardToken = await getBlizzardToken();

    await Promise.all([
      // Dungeon images from Blizzard journal-instance media
      ...MIDNIGHT_DUNGEONS.filter(d => d.blizzardInstanceId).map(async (dungeon) => {
        try {
          const r = await fetch(
            `https://us.api.blizzard.com/data/wow/media/journal-instance/${dungeon.blizzardInstanceId}?namespace=static-us`,
            { headers: { Authorization: `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }
          );
          if (!r.ok) return;
          const assets: Array<{ key: string; value: string }> = (await r.json()).assets ?? [];
          const imgUrl = (assets.find(a => a.key === 'tile') ?? assets[0])?.value;
          if (imgUrl) dungeonImageMap[dungeon.id] = imgUrl;
        } catch {}
      }),
      // Class icons for sidebar
      ...Object.entries(CLASS_IDS).map(async ([className, classId]) => {
        try {
          const r = await fetch(
            `https://us.api.blizzard.com/data/wow/media/playable-class/${classId}?namespace=static-us`,
            { headers: { Authorization: `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }
          );
          if (r.ok) classIconMap[className] = (await r.json()).assets?.[0]?.value ?? '';
        } catch {}
      }),
      // Spec icons for selected class
      ...(activeClass
        ? (POPULAR_SPECS.find(c => c.class === activeClass)?.specs ?? []).map(async (spec) => {
            const id = SPEC_IDS[activeClass]?.[spec];
            if (!id) return;
            try {
              const r = await fetch(
                `https://us.api.blizzard.com/data/wow/media/playable-specialization/${id}?namespace=static-us`,
                { headers: { Authorization: `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }
              );
              if (r.ok) specIconMap[spec] = (await r.json()).assets?.[0]?.value ?? '';
            } catch {}
          })
        : []),
    ]);
  } catch {}

  const currentClassObj = POPULAR_SPECS.find(c => c.class === activeClass);
  const nodeColors = currentClassObj
    ? { color: currentClassObj.color, border: currentClassObj.border, activeBg: currentClassObj.activeBg }
    : { color: 'text-amber-400', border: 'border-amber-500/40', activeBg: 'bg-amber-500/10' };

  const getFilterUrl = (overrides: { dungeon?: number | null; dungeonName?: string | null; class?: string | null; spec?: string | null; region?: string }) => {
    const d = overrides.dungeon !== undefined ? overrides.dungeon : activeDungeonId;
    const dn = overrides.dungeonName !== undefined ? overrides.dungeonName : (overrides.dungeon !== undefined ? null : activeDungeonName);
    const c = overrides.class !== undefined ? overrides.class : activeClass;
    const s = overrides.spec !== undefined ? overrides.spec : activeSpec;
    const r = overrides.region !== undefined ? overrides.region : activeRegion;
    const params: string[] = [];
    if (r !== 'us') params.push(`region=${r}`);
    if (d) params.push(`dungeon=${d}`);
    if (dn) params.push(`dungeonName=${encodeURIComponent(dn)}`);
    if (c) params.push(`class=${encodeURIComponent(c)}`);
    if (s) params.push(`spec=${encodeURIComponent(s)}`);
    return `/dungeons${params.length ? `?${params.join('&')}` : ''}`;
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">

      {/* Header */}
      <header className="border-b border-zinc-800/70 bg-black/70 backdrop-blur-md sticky top-0 z-50 shrink-0">
        <div className="px-4 md:px-5 h-12 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm min-w-0 overflow-hidden">
            <Link href="/" className="font-black text-amber-400 tracking-widest uppercase text-xs hover:text-amber-300 transition-colors whitespace-nowrap">
              HotsBB Talents
            </Link>
            {activeClass && (
              <span className="hidden sm:flex items-center gap-2 min-w-0">
                <span className="text-zinc-700">/</span>
                <span className={`font-bold truncate ${currentClassObj?.color ?? 'text-zinc-300'}`}>{activeClass}</span>
              </span>
            )}
            {activeSpec && (
              <span className="hidden md:flex items-center gap-2 min-w-0">
                <span className="text-zinc-700">/</span>
                <span className="text-zinc-400 truncate">{activeSpec}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Link href="/" className="hidden sm:block text-[11px] font-bold text-zinc-500 hover:text-zinc-300 transition-colors uppercase tracking-widest px-2">
              Raid Talents
            </Link>
            {/* Region toggle */}
            <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5 border border-zinc-800/80">
              <Link
                href={getFilterUrl({ region: 'us' })}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${activeRegion === 'us' ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                US
              </Link>
              <Link
                href={getFilterUrl({ region: 'eu' })}
                className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${activeRegion === 'eu' ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                EU
              </Link>
            </div>
          </div>
        </div>
      </header>

      <div className="flex flex-col md:flex-row" style={{ height: 'calc(100vh - 48px)' }}>

        {/* Sidebar */}
        <aside className="shrink-0 border-b md:border-b-0 md:border-r border-zinc-800/60 bg-black/30 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto md:w-48">
          <nav className="flex md:flex-col p-2 gap-1 md:gap-0 md:space-y-0.5 md:pt-3 w-max md:w-auto">
            {POPULAR_SPECS.map(cls => {
              const iconUrl = classIconMap[cls.class];
              return (
                <Link
                  key={cls.class}
                  href={getFilterUrl({ class: cls.class, spec: null, dungeon: null })}
                  className={`flex items-center gap-2.5 whitespace-nowrap px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                    activeClass === cls.class
                      ? `${cls.activeBg} ${cls.color} font-black`
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/50'
                  }`}
                >
                  {iconUrl && <img src={iconUrl} alt="" className="w-5 h-5 rounded-sm flex-shrink-0" />}
                  {cls.class}
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Main */}
        <main className="flex-1 overflow-y-auto min-h-0">
          <div className="max-w-screen-xl mx-auto px-4 md:px-6 py-4 md:py-6 space-y-4 md:space-y-6">

            {!activeClass ? (
              <div className="py-10 space-y-8">
                <div className="text-center space-y-2">
                  <h1 className="text-2xl font-black text-zinc-100">Dungeon Talent Finder</h1>
                  <p className="text-sm text-zinc-500 max-w-sm mx-auto">
                    Meta talent builds from top Mythic+ key holders — per dungeon, per spec.
                  </p>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 max-w-2xl mx-auto">
                  {POPULAR_SPECS.map(cls => {
                    const iconUrl = classIconMap[cls.class];
                    return (
                      <Link
                        key={cls.class}
                        href={getFilterUrl({ class: cls.class, spec: null, dungeon: null })}
                        className="flex flex-col items-center gap-2 p-3 rounded-xl border border-zinc-800/60 bg-zinc-900/30 hover:bg-zinc-900/70 hover:border-zinc-700 transition-all group"
                      >
                        {iconUrl
                          ? <img src={iconUrl} alt={cls.class} className="w-10 h-10 rounded-lg" />
                          : <div className="w-10 h-10 rounded-lg bg-zinc-800" />
                        }
                        <span className={`text-[11px] font-bold text-center leading-tight ${cls.color} group-hover:opacity-100 opacity-80`}>
                          {cls.class}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ) : (
              <>
                {/* Spec pills */}
                <div className="flex flex-wrap gap-2">
                  {currentClassObj?.specs.map(spec => {
                    const iconUrl = specIconMap[spec];
                    return (
                      <Link
                        key={spec}
                        href={getFilterUrl({ spec, dungeon: null })}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold transition-all border ${
                          activeSpec === spec
                            ? `${currentClassObj.activeBg} ${currentClassObj.border} ${currentClassObj.color} font-black`
                            : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                        }`}
                      >
                        {iconUrl && <img src={iconUrl} alt="" className="w-4 h-4 rounded-sm flex-shrink-0" />}
                        {spec}
                      </Link>
                    );
                  })}
                </div>

                {/* Dungeon picker */}
                {activeSpec && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">Midnight Season 1 Dungeons</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                      {MIDNIGHT_DUNGEONS.map(dungeon => {
                        const isSelected = activeDungeonId === dungeon.id;
                        return (
                          <Link
                            key={dungeon.id}
                            href={getFilterUrl({ dungeon: dungeon.id, dungeonName: dungeon.name })}
                            className={`relative h-16 rounded-xl overflow-hidden flex items-end transition-all border ${
                              isSelected
                                ? 'border-amber-500/60 ring-1 ring-amber-500/20'
                                : 'border-zinc-800/60 hover:border-zinc-600'
                            }`}
                          >
                            <DungeonCardImage
                              primary={dungeonImageMap[dungeon.id]}
                              fallback={dungeon.wclCdnId ? `https://assets.rpglogs.com/img/warcraft/bosses/${dungeon.wclCdnId}-icon.jpg` : undefined}
                            />
                            <span className={`absolute inset-0 ${
                              isSelected
                                ? 'bg-gradient-to-t from-amber-950/90 via-black/50 to-transparent'
                                : 'bg-gradient-to-t from-black/90 via-black/40 to-transparent'
                            }`} />
                            <span className={`relative px-2.5 py-2 text-[11px] font-bold leading-tight ${
                              isSelected ? 'text-amber-300' : 'text-zinc-200'
                            }`}>
                              {dungeon.name}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}

                {activeSpec && !activeDungeonId && (
                  <p className="text-xs text-zinc-600 text-center py-3">Select a dungeon above to view the meta talent build</p>
                )}

                {activeDungeonId && activeSpec && (
                  <Suspense fallback={<LoadingSkeleton />}>
                    <BossContent
                      bossId={activeDungeonId}
                      className={activeClass}
                      spec={activeSpec}
                      difficulty={MPLUS_DIFFICULTY}
                      nodeColors={nodeColors}
                      region={activeRegion}
                      wclZoneId={MPLUS_ZONE_ID}
                    />
                  </Suspense>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
