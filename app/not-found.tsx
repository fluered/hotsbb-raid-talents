import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Page not found | HotsBB' };

// Without this file Next serves its default 404: black text on a white page, with
// no way back into the site.
export default function NotFound() {
  const linkCls = 'px-3 py-1.5 rounded-lg border border-zinc-800/60 text-xs font-bold text-zinc-300 hover:text-white hover:border-zinc-600 transition-colors';
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased flex items-center justify-center">
      <div className="text-center space-y-4 px-8">
        <p className="text-[10px] font-black text-zinc-600 uppercase tracking-widest">404</p>
        <h1 className="text-2xl font-black text-zinc-100">This page does not exist</h1>
        <p className="text-sm text-zinc-500">The link may be old, or the address was mistyped.</p>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <Link href="/" className={`${linkCls} text-amber-400 border-amber-500/30`}>Talent builds</Link>
          <Link href="/tier-list" className={linkCls}>Tier lists</Link>
          <Link href="/addon" className={linkCls}>Addon</Link>
        </div>
      </div>
    </div>
  );
}
