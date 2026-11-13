'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useIsTouch } from './useIsTouch';

export interface ClassNavSpec { name: string; href: string; iconUrl: string }
export interface ClassNavClass {
  name: string;
  href: string;
  iconUrl: string;
  color: string;
  activeBg: string;
  specs: ClassNavSpec[];
}

interface Flyout { cls: ClassNavClass; rect: DOMRect }

// The class sidebar. On desktop, hovering (or keyboard-focusing) a class opens a
// flyout to its right listing that class's specs, so a spec is one click from
// anywhere instead of class → spec. The sidebar scrolls and clips its overflow, so
// the flyout is portalled to <body> and positioned from the item's rect, like the
// talent tooltips. Touch devices and the phone layout (horizontal strip) keep the
// plain tap-the-class behaviour.
//
// Clicks navigate inside a transition (same as BossPicker) so the clicked row can
// show a spinner until the next page arrives. A plain <Link> gave no sign the click
// had registered: the flyout closed and the old page sat there until the server
// answered, which read as "clicking a spec does nothing".
export default function ClassNav({
  classes,
  activeClass,
  activeSpec,
}: {
  classes: ClassNavClass[];
  activeClass: string | null;
  activeSpec: string | null;
}) {
  const isTouch = useIsTouch();
  const [openFlyout, setFlyout] = useState<Flyout | null>(null);
  const router = useRouter();
  const [isNavigating, startNavigation] = useTransition();
  const [picked, setPicked] = useState<{ cls: string; spec: string | null } | null>(null);
  const pending = isNavigating ? picked : null;
  // A pick leaves the flyout open so its row can show the spinner, and marks it to
  // close once the page has arrived. Derived, not an effect: opening any flyout again
  // clears the mark.
  const [closeWhenArrived, setCloseWhenArrived] = useState(false);
  const flyout = closeWhenArrived && !isNavigating ? null : openFlyout;
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  useEffect(() => clearTimers, []);

  const desktopHover = () => !isTouch && window.matchMedia('(min-width: 768px)').matches;

  const open = (cls: ClassNavClass, el: HTMLElement, delay: number) => {
    if (!desktopHover()) return;
    clearTimers();
    const rect = el.getBoundingClientRect();
    openTimer.current = setTimeout(() => { setCloseWhenArrived(false); setFlyout({ cls, rect }); }, delay);
  };
  // A short grace period so the pointer can cross the gap into the flyout.
  const scheduleClose = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => setFlyout(null), 160);
  };
  const cancelClose = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };

  // Modified and non-primary clicks (new tab, new window) keep the browser's behaviour.
  const go = (e: React.MouseEvent, href: string, cls: string, spec: string | null) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setPicked({ cls, spec });
    setCloseWhenArrived(true);
    startNavigation(() => router.push(href));
  };

  return (
    <>
      <nav className="flex md:flex-col p-2 gap-1 md:gap-0 md:space-y-0.5 md:pt-3 w-max md:w-auto">
        {classes.map(cls => {
          const isActive = activeClass === cls.name;
          const isOpen = flyout?.cls.name === cls.name;
          return (
            <Link
              key={cls.name}
              href={cls.href}
              onClick={(e) => go(e, cls.href, cls.name, null)}
              onMouseEnter={(e) => open(cls, e.currentTarget, 90)}
              onMouseLeave={scheduleClose}
              onFocus={(e) => open(cls, e.currentTarget, 0)}
              onBlur={scheduleClose}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              className={`flex items-center gap-2.5 whitespace-nowrap px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                isActive
                  ? `${cls.activeBg} ${cls.color} font-black`
                  : isOpen
                    ? 'text-zinc-200 bg-zinc-900/60'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/50'
              }`}
            >
              {cls.iconUrl && <Image src={cls.iconUrl} alt="" width={20} height={20} className="w-5 h-5 rounded-sm flex-shrink-0" />}
              <span className="flex-1">{cls.name}</span>
              {pending?.cls === cls.name
                ? <span className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin flex-shrink-0" role="status" aria-label="Loading" />
                : <span className={`hidden md:inline text-[10px] ${isActive || isOpen ? 'text-zinc-500' : 'text-zinc-700'}`} aria-hidden="true">›</span>}
            </Link>
          );
        })}
      </nav>
      {flyout && <SpecFlyout flyout={flyout} activeClass={activeClass} activeSpec={activeSpec} onEnter={cancelClose} onLeave={scheduleClose} onPick={go} pendingSpec={pending?.cls === flyout.cls.name ? pending.spec : null} />}
    </>
  );
}

function SpecFlyout({
  flyout, activeClass, activeSpec, onEnter, onLeave, onPick, pendingSpec,
}: {
  flyout: Flyout;
  activeClass: string | null;
  activeSpec: string | null;
  onEnter: () => void;
  onLeave: () => void;
  onPick: (e: React.MouseEvent, href: string, cls: string, spec: string | null) => void;
  pendingSpec: string | null;
}) {
  const { cls, rect } = flyout;
  const GAP = 6;
  const MARGIN = 8;
  // Header row + one row per spec; clamp so the panel never runs off the bottom.
  const estHeight = 40 + cls.specs.length * 36 + 8;
  const top = Math.max(MARGIN, Math.min(rect.top, window.innerHeight - estHeight - MARGIN));
  return createPortal(
    <div
      role="menu"
      aria-label={`${cls.name} specs`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      style={{ position: 'fixed', top, left: rect.right + GAP, zIndex: 60, minWidth: 180 }}
      className="bg-zinc-950 border border-zinc-700/80 rounded-xl shadow-2xl shadow-black/60"
    >
      {/* Invisible bridge over the gap so the pointer doesn't "leave" en route. The
          panel must not clip its overflow, or this is clipped away with it. */}
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: -GAP - 1, width: GAP + 1 }} />
      <div className={`px-3 py-2 border-b rounded-t-xl border-zinc-800 flex items-center gap-2 text-xs font-black uppercase tracking-widest ${cls.color}`}>
        {cls.iconUrl && <Image src={cls.iconUrl} alt="" width={16} height={16} className="w-4 h-4 rounded-sm" />}
        {cls.name}
      </div>
      <div className="p-1">
        {cls.specs.map(spec => {
          const isActive = activeClass === cls.name && activeSpec === spec.name;
          return (
            <Link
              key={spec.name}
              href={spec.href}
              role="menuitem"
              onClick={(e) => onPick(e, spec.href, cls.name, spec.name)}
              className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
                isActive
                  ? `${cls.activeBg} ${cls.color} font-black`
                  : 'text-zinc-300 hover:text-white hover:bg-zinc-800/70'
              }`}
            >
              {spec.iconUrl
                ? <Image src={spec.iconUrl} alt="" width={18} height={18} className="w-[18px] h-[18px] rounded-sm flex-shrink-0" />
                : <span className="w-[18px] h-[18px] rounded-sm bg-zinc-800 flex-shrink-0" />}
              <span className="flex-1">{spec.name}</span>
              {pendingSpec === spec.name && (
                <span className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin flex-shrink-0" role="status" aria-label="Loading" />
              )}
            </Link>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
