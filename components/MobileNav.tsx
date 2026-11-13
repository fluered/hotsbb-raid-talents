'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// The section menu for phones. Below `sm` the header links (Builds, Tier Lists,
// Addon) are hidden to leave room for the toggles, which left the footer as the only
// way to move between sections. Rendered inside the sticky <header>, which is the
// panel's positioning parent — `fixed` would not work here: the header's
// backdrop-filter makes it the containing block for fixed descendants anyway.
//
// `children` is for a page's own secondary controls (the finder's region toggle)
// that do not fit in a phone header once the menu button is there.
export default function MobileNav({ difficulty, children }: { difficulty?: number; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const diff = difficulty ? `?difficulty=${difficulty}` : '';
  const links: Array<{ label: string; href: string; path: string; accent?: boolean }> = [
    { label: 'Raid builds', href: '/', path: '/' },
    { label: 'Dungeon builds', href: '/dungeons', path: '/dungeons' },
    { label: 'DPS tier list', href: `/tier-list${diff}`, path: '/tier-list' },
    { label: 'Tank tier list', href: `/tier-list/tanks${diff}`, path: '/tier-list/tanks' },
    { label: 'Healer tier list', href: `/tier-list/healers${diff}`, path: '/tier-list/healers' },
    { label: 'In-game addon', href: '/addon', path: '/addon', accent: true },
  ];

  return (
    <div ref={ref} className="sm:hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-colors ${
          open ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-800/80 bg-zinc-900 text-zinc-400'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
          {open
            ? <path d="M4 4l8 8M12 4l-8 8" />
            : <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />}
        </svg>
      </button>
      {open && (
        <div
          id="mobile-nav-panel"
          // Any link in the panel (ours or a page's own controls) closes it.
          onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setOpen(false); }}
          className="absolute left-0 right-0 top-full border-b border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60 px-4 py-3 space-y-3"
        >
          <nav className="grid grid-cols-2 gap-1.5">
            {links.map(l => {
              const isCurrent = pathname === l.path;
              return (
                <Link
                  key={l.path}
                  href={l.href}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={`px-3 py-2.5 rounded-lg border text-sm font-bold transition-colors ${
                    isCurrent
                      ? 'border-zinc-600 bg-zinc-800/80 text-zinc-100'
                      : `border-zinc-800/60 bg-zinc-900/40 ${l.accent ? 'text-amber-400' : 'text-zinc-300'}`
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
          {children}
        </div>
      )}
    </div>
  );
}
