import Link from 'next/link';

export const ADDON_RELEASES_URL = 'https://github.com/fluered/hotsbb-raid-talents/releases/latest';
export const ADDON_REPO_URL = 'https://github.com/fluered/hotsbb-raid-talents';

// Shared by every page. The main finder pages scroll inside <main> (the shell is a
// fixed-height flex row), so this must be rendered INSIDE that scroll container —
// a footer in the root layout would sit below the viewport and never be reachable.
export default function SiteFooter({ difficulty }: { difficulty?: number }) {
  const diff = difficulty ? `?difficulty=${difficulty}` : '';
  const linkCls = 'text-zinc-500 hover:text-zinc-300 transition-colors';
  return (
    <footer className="mt-12 pt-6 pb-8 border-t border-zinc-800/60 text-xs text-zinc-600 space-y-4">
      <nav className="flex flex-wrap gap-x-4 gap-y-2 font-semibold">
        <Link href="/" className={linkCls}>Raid Talents</Link>
        <Link href="/dungeons" className={linkCls}>Dungeon Talents</Link>
        <Link href={`/tier-list${diff}`} className={linkCls}>DPS Tier List</Link>
        <Link href={`/tier-list/tanks${diff}`} className={linkCls}>Tank Tier List</Link>
        <Link href={`/tier-list/healers${diff}`} className={linkCls}>Healer Tier List</Link>
        <a href={ADDON_RELEASES_URL} target="_blank" rel="noopener noreferrer" className={`${linkCls} text-amber-500/80 hover:text-amber-400`}>
          In-game addon ↗
        </a>
        <a href={ADDON_REPO_URL} target="_blank" rel="noopener noreferrer" className={linkCls}>GitHub ↗</a>
      </nav>
      <p className="leading-relaxed max-w-3xl">
        Parse rankings and combat data from{' '}
        <a href="https://www.warcraftlogs.com" target="_blank" rel="noopener noreferrer" className={linkCls}>Warcraft Logs</a>.
        Talent trees, items, spells, and artwork from the{' '}
        <a href="https://develop.battle.net/documentation/world-of-warcraft" target="_blank" rel="noopener noreferrer" className={linkCls}>Blizzard Battle.net API</a>.
        Item and spell links open on{' '}
        <a href="https://www.wowhead.com" target="_blank" rel="noopener noreferrer" className={linkCls}>Wowhead</a>.
        Hero talent portraits from{' '}
        <a href="https://warcraft.wiki.gg" target="_blank" rel="noopener noreferrer" className={linkCls}>Warcraft Wiki</a>.
      </p>
      <p className="leading-relaxed max-w-3xl">
        World of Warcraft® and Blizzard Entertainment® are trademarks or registered trademarks of Blizzard Entertainment, Inc.
        HotsBB Talents is a fan project and is not affiliated with or endorsed by Blizzard Entertainment or Warcraft Logs.
      </p>
    </footer>
  );
}
