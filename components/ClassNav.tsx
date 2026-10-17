'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
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
  const [flyout, setFlyout] = useState<Flyout | null>(null);
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
    openTimer.current = setTimeout(() => setFlyout({ cls, rect }), delay);
  };
  // A short grace period so the pointer can cross the gap into the flyout.
  const scheduleClose = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => setFlyout(null), 160);
  };
  const cancelClose = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
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
              <span className={`hidden md:inline text-[10px] ${isActive || isOpen ? 'text-zinc-500' : 'text-zinc-700'}`} aria-hidden="true">›</span>
            </Link>
          );
        })}
      </nav>
      {flyout && <SpecFlyout flyout={flyout} activeClass={activeClass} activeSpec={activeSpec} onEnter={cancelClose} onLeave={scheduleClose} onPick={() => { clearTimers(); setFlyout(null); }} />}
    </>
  );
}

function SpecFlyout({
  flyout, activeClass, activeSpec, onEnter, onLeave, onPick,
}: {
  flyout: Flyout;
  activeClass: string | null;
  activeSpec: string | null;
  onEnter: () => void;
  onLeave: () => void;
  onPick: () => void;
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
      className="bg-zinc-950 border border-zinc-700/80 rounded-xl shadow-2xl shadow-black/60 overflow-hidden"
    >
      {/* Invisible bridge over the gap so the pointer doesn't "leave" en route. */}
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: -GAP, width: GAP }} />
      <div className={`px-3 py-2 border-b border-zinc-800 flex items-center gap-2 text-xs font-black uppercase tracking-widest ${cls.color}`}>
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
              onClick={onPick}
              className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
                isActive
                  ? `${cls.activeBg} ${cls.color} font-black`
                  : 'text-zinc-300 hover:text-white hover:bg-zinc-800/70'
              }`}
            >
              {spec.iconUrl
                ? <Image src={spec.iconUrl} alt="" width={18} height={18} className="w-[18px] h-[18px] rounded-sm flex-shrink-0" />
                : <span className="w-[18px] h-[18px] rounded-sm bg-zinc-800 flex-shrink-0" />}
              {spec.name}
            </Link>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
