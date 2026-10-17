import React from 'react';
import { unstable_cache } from 'next/cache';
import ClassNav from './ClassNav';
import { getBlizzardToken, POPULAR_SPECS, SPEC_IDS, CLASS_IDS } from '../lib/wow';

// The finder's class/spec sidebar, for pages that aren't the finder (tier lists, the
// addon guide). Same cache keys as app/page.tsx so the icon lookups are shared; every
// link goes back to the finder at the chosen class/spec. Without this, those pages had
// no way back to the builds except the small logo link in the header.
async function loadIconMaps() {
  const classIconMap: Record<string, string> = {};
  const specIconMap: Record<string, string> = {};
  try {
    const blizzardToken = await getBlizzardToken();
    await Promise.all([
      ...Object.entries(CLASS_IDS).map(async ([className, classId]) => {
        const iconUrl = await unstable_cache(
          async () => {
            const r = await fetch(
              `https://us.api.blizzard.com/data/wow/media/playable-class/${classId}?namespace=static-us`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` } }
            );
            if (!r.ok) throw new Error(`Blizzard class icon fetch failed: ${r.status}`);
            return (await r.json()).assets?.[0]?.value ?? '';
          },
          [`blizzard-class-icon-v2-${classId}`],
          { revalidate: 86400 }
        )().catch(() => '');
        if (iconUrl) classIconMap[className] = iconUrl;
      }),
      ...POPULAR_SPECS.flatMap(cls => cls.specs.map(async spec => {
        const id = SPEC_IDS[cls.class]?.[spec];
        if (!id) return;
        const iconUrl = await unstable_cache(
          async () => {
            const r = await fetch(
              `https://us.api.blizzard.com/data/wow/media/playable-specialization/${id}?namespace=static-us`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` } }
            );
            if (!r.ok) throw new Error(`Blizzard spec icon fetch failed: ${r.status}`);
            return (await r.json()).assets?.[0]?.value ?? '';
          },
          [`blizzard-spec-icon-${id}`],
          { revalidate: 86400 }
        )().catch(() => '');
        if (iconUrl) specIconMap[`${cls.class}/${spec}`] = iconUrl;
      })),
    ]);
  } catch {
    // Icons are decoration; the sidebar still renders names and links without them.
  }
  return { classIconMap, specIconMap };
}

export default async function SiteShell({ children, difficulty }: { children: React.ReactNode; difficulty?: number }) {
  const { classIconMap, specIconMap } = await loadIconMaps();
  const diff = difficulty ? `&difficulty=${difficulty}` : '';
  const href = (cls: string, spec?: string) =>
    `/?class=${encodeURIComponent(cls)}${spec ? `&spec=${encodeURIComponent(spec)}` : ''}${diff}`;

  return (
    <div className="flex flex-col md:flex-row" style={{ height: 'calc(100vh - 48px)' }}>
      <aside className="shrink-0 border-b md:border-b-0 md:border-r border-zinc-800/60 bg-black/30 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto md:w-48">
        <ClassNav
          classes={POPULAR_SPECS.map(cls => ({
            name: cls.class,
            href: href(cls.class),
            iconUrl: classIconMap[cls.class] ?? '',
            color: cls.color,
            activeBg: cls.activeBg,
            specs: cls.specs.map(spec => ({
              name: spec,
              href: href(cls.class, spec),
              iconUrl: specIconMap[`${cls.class}/${spec}`] ?? '',
            })),
          }))}
          activeClass={null}
          activeSpec={null}
        />
      </aside>
      <main className="flex-1 overflow-y-auto min-h-0">
        {children}
      </main>
    </div>
  );
}
