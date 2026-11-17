import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import SiteFooter from '../../components/SiteFooter';
import SiteShell from '../../components/SiteShell';
import SiteNavLinks from '../../components/SiteNavLinks';
import { getSeasonState } from '../../lib/wow';
import { getRaidBosses, type RaidBoss } from '../../lib/bossPage';
import { bossCanonical } from '../../lib/seo';
import { ogImageMeta } from '../../lib/ogImage';

// The index of the per-boss pages: the roster and nothing else, so it costs what the
// roster costs (held in process memory, see getRaidStructure).

const SITE = 'https://hotsbbtalents.io';

export async function generateMetadata(): Promise<Metadata> {
  const season = await getSeasonState();
  const title = `${season.expansionName} Raid Bosses: Rankings, Builds and Mechanics per Boss | HotsBB`;
  const description = 'Every current raid boss on one page each: spec rankings and kill times from top parses, the meta talent build for every spec, and the mechanics by type.';
  return {
    title,
    description,
    alternates: { canonical: bossCanonical({ difficulty: season.defaultRaidDifficulty, defaultDifficulty: season.defaultRaidDifficulty }) },
    ...ogImageMeta({ title, description, imageTitle: 'Raid Bosses', subtitle: 'Spec rankings, meta builds and mechanics for every boss, from top logs', kicker: [season.expansionName, season.seasonLabel].filter(Boolean).join(' · ') }),
  };
}

export default async function BossIndexPage() {
  const bosses = await getRaidBosses().catch((): RaidBoss[] => []);
  const zones = [...new Set(bosses.map(b => b.zoneName))];

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'HotsBB Raid Talents', item: SITE },
      { '@type': 'ListItem', position: 2, name: 'Raid Bosses', item: `${SITE}/boss` },
    ],
  };

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
            <span className="hidden sm:inline text-xs font-black text-zinc-300 uppercase tracking-widest">Raid Bosses</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <SiteNavLinks active="bosses" />
          </div>
        </div>
      </header>

      <SiteShell>
        <div className="max-w-screen-md mx-auto px-4 md:px-6 py-6 space-y-8">
          <div className="space-y-2">
            <h1 className="text-2xl md:text-3xl font-black tracking-tight leading-tight">Raid bosses</h1>
            <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl">
              One page per boss with what a raider looks up before raid night: which specs do best there, the meta build for every spec,
              the mechanics by type, and what the top raids take and avoid. All of it is measured from top Warcraft Logs kills or read from the boss addons.
            </p>
          </div>

          {bosses.length === 0 && <p className="text-sm text-zinc-500">The boss list is unavailable right now. Try again in a few minutes.</p>}

          {zones.map(zone => (
            <section key={zone} className="space-y-3">
              <h2 className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">{zone}</h2>
              <ol className="grid sm:grid-cols-2 gap-2">
                {bosses.filter(b => b.zoneName === zone).map((b, i) => (
                  <li key={b.id}>
                    <Link href={`/boss/${b.slug}`} className="flex items-center gap-3 rounded-xl border border-zinc-800/70 bg-zinc-900/40 hover:bg-zinc-900 hover:border-zinc-700 px-3 py-2.5 transition-colors group">
                      <Image src={`https://assets.rpglogs.com/img/warcraft/bosses/${b.id}-icon.jpg`} alt="" width={40} height={40} unoptimized className="w-10 h-10 rounded-lg object-cover border border-zinc-800 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-bold text-zinc-100 truncate">{b.name}</span>
                        <span className="block text-xs text-zinc-500">Boss {i + 1} · rankings, builds, mechanics</span>
                      </span>
                      <span className="text-zinc-700 group-hover:text-zinc-400 transition-colors text-sm shrink-0">→</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          ))}

          <SiteFooter />
        </div>
      </SiteShell>
    </div>
  );
}
