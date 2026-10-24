import Link from 'next/link';

// Section links for page headers: Builds · Tier Lists · Addon, with the current one
// lit. The finder and dungeons headers carry their own copy of the last two (they have
// extra toggles to fit around); this is for every other page so no section is a dead end.
export default function SiteNavLinks({ active, difficulty }: { active: 'builds' | 'tiers' | 'addon' | 'analyze'; difficulty?: number }) {
  const diff = difficulty ? `?difficulty=${difficulty}` : '';
  const base = 'hidden sm:inline-flex px-2.5 py-1 rounded-md text-xs font-bold transition-colors whitespace-nowrap';
  const idle = 'text-zinc-400 hover:text-zinc-200';
  const lit = 'text-zinc-100 bg-zinc-800/80';
  return (
    <nav className="flex items-center gap-0.5 mr-1">
      <Link href="/" className={`${base} ${active === 'builds' ? lit : idle}`}>Builds</Link>
      <Link href={`/tier-list${diff}`} className={`${base} ${active === 'tiers' ? lit : idle}`}>Tier Lists</Link>
      <Link href="/addon" className={`${base} ${active === 'addon' ? lit : 'text-amber-500/80 hover:text-amber-400'}`}>Addon</Link>
    </nav>
  );
}
