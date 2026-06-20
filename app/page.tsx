import React, { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import BossContent from './BossContent';
import {
  getWclToken, getBlizzardToken, getRaidStructure,
  POPULAR_SPECS, SPEC_IDS, MIDNIGHT_RAIDS, CLASS_IDS,
} from '../lib/wow';

// ─── Metadata ─────────────────────────────────────────────────────────────────

interface PageProps {
  searchParams: Promise<{ boss?: string; bossName?: string; class?: string; spec?: string; difficulty?: string; region?: string }>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const sp = await searchParams;
  const cls = sp.class;
  const spec = sp.spec;
  const bossName = sp.bossName;
  const diff = sp.difficulty ? parseInt(sp.difficulty) : 5;
  const diffLabel = diff === 4 ? 'Heroic' : 'Mythic';

  let title: string;
  let description: string;

  if (cls && spec && bossName) {
    title = `Best ${spec} ${cls} Talents for ${diffLabel} ${bossName} | HotsBB`;
    description = `Best ${spec} ${cls} talent build for ${bossName} on ${diffLabel}. Consensus talents and meta gear from top World of Warcraft raid parses.`;
  } else if (cls && spec) {
    title = `${spec} ${cls} ${diffLabel} Raid Talents | HotsBB`;
    description = `Optimal ${spec} ${cls} talent builds for every ${diffLabel} raid boss in WoW. Updated from top-parsing logs across Sporefall and Midnight.`;
  } else if (cls) {
    title = `${cls} ${diffLabel} Raid Talent Builds | HotsBB`;
    description = `Best ${cls} talent builds for every ${diffLabel} raid boss in World of Warcraft. Consensus builds from top-parsing players.`;
  } else {
    title = `Best Raid Talents Finder - Meta ${diffLabel} Boss Builds For Every Class | HotsBB`;
    description = `Find the best talent builds for every ${diffLabel} raid boss in World of Warcraft. Consensus builds and meta gear from top-parsing players, per boss.`;
  }

  return {
    title,
    description,
    openGraph: { title, description, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

// ─── Loading skeleton for boss content ────────────────────────────────────────

function BossLoadingSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="flex gap-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-9 w-28 rounded-full bg-zinc-800/60" />
        ))}
      </div>
      <div className="h-px bg-zinc-800/50" />
      <div className="space-y-3">
        <div className="h-5 w-48 rounded bg-zinc-800/60" />
        <div className="h-4 w-72 rounded bg-zinc-800/40" />
        <div className="h-64 rounded-2xl bg-zinc-900/40 border border-zinc-800/50" />
      </div>
      <div className="space-y-3">
        <div className="h-5 w-32 rounded bg-zinc-800/60" />
        <div className="h-48 rounded-2xl bg-zinc-900/40 border border-zinc-800/50" />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function Home(props: PageProps) {
  const searchParams = await props.searchParams;
  const activeBossId = searchParams.boss ? parseInt(searchParams.boss) : null;
  const activeBossName = searchParams.bossName || null;
  const activeClass = searchParams.class || null;
  const activeSpec = searchParams.spec || null;
  const activeDifficulty = searchParams.difficulty ? parseInt(searchParams.difficulty) : 5;
  const activeRegion = (searchParams.region === 'eu' ? 'eu' : 'us') as 'us' | 'eu';

  // Phase 1: zone structure (always needed for sidebar + boss grid)
  let zones: any[] = [];
  let error: string | null = null;
  try {
    const wclToken = await getWclToken();
    zones = await getRaidStructure(wclToken);
  } catch (err: any) {
    error = err.message;
  }

  // Phase 2: spec icons, boss images, class icons (all fast/cached)
  let specIconMap: Record<string, string> = {};
  let bossImageMap: Record<number, string> = {};
  let classIconMap: Record<string, string> = {};
  let bossTagMap: Record<number, string[]> = {};

  try {
    const blizzardToken = await getBlizzardToken();
    const raidEncounters = zones
      .filter((z: any) => z.name in MIDNIGHT_RAIDS)
      .flatMap((z: any) => z.encounters ?? []);

    const fetches: Promise<void>[] = [
      // Class icons (always load for sidebar)
      Promise.all(Object.entries(CLASS_IDS).map(async ([className, classId]) => {
        try {
          const r = await fetch(
            `https://us.api.blizzard.com/data/wow/media/playable-class/${classId}?namespace=static-us`,
            { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }
          );
          if (r.ok) classIconMap[className] = (await r.json()).assets?.[0]?.value ?? '';
        } catch {}
      })).then(() => {}),
      // Boss thumbnail images — try Blizzard journal first, fall back to WCL CDN
      Promise.all(raidEncounters.map(async (enc: any) => {
        try {
          if (enc.journalID) {
            const r = await fetch(
              `https://us.api.blizzard.com/data/wow/journal-encounter/${enc.journalID}/media?namespace=static-us`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }
            );
            if (r.ok) {
              const url = (await r.json()).assets?.[0]?.value;
              if (url) { bossImageMap[enc.id] = url; return; }
            }
          }
          // WCL CDN fallback — uses WCL encounter ID
          bossImageMap[enc.id] = `https://assets.rpglogs.com/img/warcraft/bosses/${enc.id}-icon.jpg`;
        } catch {}
      })).then(() => {}),

      // Fight profile tags from Blizzard journal encounter
      Promise.all(raidEncounters.filter((enc: any) => enc.journalID).map(async (enc: any) => {
        try {
          const r = await fetch(
            `https://us.api.blizzard.com/data/wow/journal-encounter/${enc.journalID}?namespace=static-us&locale=en_US`,
            { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }
          );
          if (!r.ok) return;
          const data = await r.json();
          const text = (data.sections ?? [])
            .flatMap((s: any) => [
              s.title ?? '',
              s.body_text ?? '',
              ...((s.sections ?? []).flatMap((sub: any) => [sub.title ?? '', sub.body_text ?? ''])),
            ])
            .join(' ')
            .replace(/<[^>]+>/g, ' ')
            .toLowerCase();
          const tags: string[] = [];
          if (/\b(adds\b|spawn|minion|horde|multiple \w+ appear|more \w+ join)/.test(text)) tags.push('Adds');
          if (/\b(spread|dodge|soak|jump|vault away|move away|avoid)/.test(text)) tags.push('Movement');
          if (/\b(vulnerabilit|intermission|stagger|exposed window)/.test(text)) tags.push('Burst Windows');
          bossTagMap[enc.id] = tags.slice(0, 2);
        } catch {}
      })).then(() => {}),
    ];

    if (activeClass) {
      const classSpecs = POPULAR_SPECS.find(c => c.class === activeClass)?.specs ?? [];
      fetches.push(
        Promise.all(classSpecs.map(async (spec) => {
          const id = SPEC_IDS[activeClass]?.[spec];
          if (!id) return;
          try {
            const r = await fetch(
              `https://us.api.blizzard.com/data/wow/media/playable-specialization/${id}?namespace=static-us`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }
            );
            if (r.ok) specIconMap[spec] = (await r.json()).assets?.[0]?.value ?? '';
          } catch {}
        })).then(() => {})
      );

    }

    await Promise.all(fetches);
  } catch {}

  const activeRaids = zones.filter((z: any) => z.encounters?.length > 0 && z.name in MIDNIGHT_RAIDS);
  const activeZone = activeRaids.find((z: any) => z.encounters?.some((e: any) => e.id === activeBossId));
  const wclZoneId: number | null = activeZone?.id ?? null;
  const currentClassObj = POPULAR_SPECS.find(c => c.class === activeClass);
  const nodeColors = currentClassObj
    ? { color: currentClassObj.color, border: currentClassObj.border, activeBg: currentClassObj.activeBg }
    : { color: 'text-amber-400', border: 'border-amber-500/40', activeBg: 'bg-amber-500/10' };

  const getFilterUrl = (overrides: { boss?: number | null; bossName?: string | null; class?: string | null; spec?: string | null; difficulty?: number; region?: string }) => {
    const b = overrides.boss !== undefined ? overrides.boss : activeBossId;
    const bn = overrides.bossName !== undefined ? overrides.bossName : (overrides.boss !== undefined ? null : activeBossName);
    const c = overrides.class !== undefined ? overrides.class : activeClass;
    const s = overrides.spec !== undefined ? overrides.spec : activeSpec;
    const d = overrides.difficulty !== undefined ? overrides.difficulty : activeDifficulty;
    const r = overrides.region !== undefined ? overrides.region : activeRegion;
    const params: string[] = [`difficulty=${d}`];
    if (r !== 'us') params.push(`region=${r}`);
    if (b) params.push(`boss=${b}`);
    if (bn) params.push(`bossName=${encodeURIComponent(bn)}`);
    if (c) params.push(`class=${encodeURIComponent(c)}`);
    if (s) params.push(`spec=${encodeURIComponent(s)}`);
    return `?${params.join('&')}`;
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">

      {/* Header */}
      <header className="border-b border-zinc-800/70 bg-black/70 backdrop-blur-md sticky top-0 z-50 shrink-0">
        <div className="px-4 md:px-5 h-12 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm min-w-0 overflow-hidden">
            <Link href="/" className="font-black text-amber-400 tracking-widest uppercase text-xs hover:text-amber-300 transition-colors whitespace-nowrap">
              <span className="hidden sm:inline">HotsBB Raid Talents</span>
              <span className="sm:hidden">Raid Talents</span>
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
          {/* Region toggle */}
          <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5 border border-zinc-800/80">
            <Link
              href={getFilterUrl({ region: 'us' })}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                activeRegion === 'us'
                  ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              US
            </Link>
            <Link
              href={getFilterUrl({ region: 'eu' })}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                activeRegion === 'eu'
                  ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              EU
            </Link>
          </div>
          {/* Difficulty toggle */}
          <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5 border border-zinc-800/80">
            <Link
              href={getFilterUrl({ difficulty: 4 })}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                activeDifficulty === 4
                  ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Heroic
            </Link>
            <Link
              href={getFilterUrl({ difficulty: 5 })}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all ${
                activeDifficulty === 5
                  ? 'bg-violet-500/15 text-violet-400 border border-violet-500/30'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Mythic
            </Link>
          </div>
          </div>
        </div>
      </header>

      <div className="flex flex-col md:flex-row" style={{ height: 'calc(100vh - 48px)' }}>

        {/* Sidebar — vertical on md+, horizontal scrollable strip on mobile */}
        <aside className="shrink-0 border-b md:border-b-0 md:border-r border-zinc-800/60 bg-black/30 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto md:w-48">
          <nav className="flex md:flex-col p-2 gap-1 md:gap-0 md:space-y-0.5 md:pt-3 w-max md:w-auto">
            {POPULAR_SPECS.map(cls => {
              const iconUrl = classIconMap[cls.class];
              return (
                <Link
                  key={cls.class}
                  href={getFilterUrl({ class: cls.class, spec: null, boss: null })}
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
          <div className="max-w-screen-xl mx-auto px-6 py-6 space-y-6">

            {error && (
              <div className="bg-red-950/40 border border-red-800/50 text-red-300 px-4 py-3 rounded-xl text-sm">
                <span className="font-bold">Error: </span>{error}
              </div>
            )}

            {!activeClass ? (
              <div className="py-10 space-y-8">
                <div className="text-center space-y-2">
                  <h1 className="text-2xl font-black text-zinc-100">Raid Talent Finder</h1>
                  <p className="text-sm text-zinc-500 max-w-sm mx-auto">
                    Consensus talent builds and meta gear from top Mythic parses — per boss, per spec.
                  </p>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 max-w-2xl mx-auto">
                  {POPULAR_SPECS.map(cls => {
                    const iconUrl = classIconMap[cls.class];
                    return (
                      <Link
                        key={cls.class}
                        href={getFilterUrl({ class: cls.class, spec: null, boss: null })}
                        className={`flex flex-col items-center gap-2 p-3 rounded-xl border border-zinc-800/60 bg-zinc-900/30 hover:bg-zinc-900/70 hover:border-zinc-700 transition-all group`}
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
                        href={getFilterUrl({ spec, boss: null })}
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

                {/* Boss grid */}
                {activeSpec && (
                  <div className="space-y-5">
                    {activeRaids.map((raid: any, raidIdx: number) => (
                      <div key={raid.id}>
                        {/* Raid section header */}
                        <div className="flex items-center gap-3 mb-3">
                          <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest whitespace-nowrap">
                            {MIDNIGHT_RAIDS[raid.name] ?? raid.name}
                          </span>

                          <div className="flex-1 h-px bg-zinc-800/60" />
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                          {raid.encounters.map((boss: any) => {
                            const isSelected = activeBossId === boss.id;
                            const thumbUrl = bossImageMap[boss.id];
                            return (
                              <Link
                                key={boss.id}
                                href={getFilterUrl({ boss: boss.id, bossName: boss.name })}
                                className={`relative h-16 rounded-xl overflow-hidden flex items-end transition-all border ${
                                  isSelected
                                    ? 'border-amber-500/60 ring-1 ring-amber-500/20'
                                    : 'border-zinc-800/60 hover:border-zinc-600'
                                }`}
                              >
                                {/* Boss image — CSS background so 404s fail silently */}
                                <div
                                  className="absolute inset-0 bg-zinc-900"
                                  style={thumbUrl ? { backgroundImage: `url(${thumbUrl})`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'right center' } : undefined}
                                />
                                {/* Gradient overlay */}
                                <span className={`absolute inset-0 ${
                                  isSelected
                                    ? 'bg-gradient-to-t from-amber-950/90 via-black/40 to-transparent'
                                    : 'bg-gradient-to-t from-black/85 via-black/30 to-transparent'
                                }`} />
                                {/* Boss name + fight tags */}
                                <div className="relative px-2.5 py-2 flex flex-col gap-1 min-w-0">
                                  <span className={`text-[11px] font-bold leading-tight truncate ${
                                    isSelected ? 'text-amber-300' : 'text-zinc-200'
                                  }`}>
                                    {boss.name}
                                  </span>
                                  {(bossTagMap[boss.id]?.length ?? 0) > 0 && (
                                    <div className="flex gap-1">
                                      {bossTagMap[boss.id].map((tag: string) => (
                                        <span key={tag} className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-zinc-500 border border-zinc-800/50 leading-none whitespace-nowrap">
                                          {tag}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Boss-specific content — streams in via Suspense */}
                {activeBossId && activeSpec && (
                  <Suspense fallback={<BossLoadingSkeleton />}>
                    <BossContent
                      bossId={activeBossId}
                      className={activeClass}
                      spec={activeSpec}
                      difficulty={activeDifficulty}
                      nodeColors={nodeColors}
                      region={activeRegion}
                      wclZoneId={wclZoneId}
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
