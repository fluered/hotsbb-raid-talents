'use client';
import { useSyncExternalStore } from 'react';

// True on devices whose primary input can't hover (phones, tablets). Every hover
// tooltip on the site is useless there — and worse, a tap on a hover-and-click
// element fires the emulated mouseenter AND the click, so the tooltip flashes and
// the click's "open on Wowhead" fires immediately. Components use this to switch
// those elements to tap-to-pin behaviour.
//
// useSyncExternalStore (not useState + useEffect): the media query IS an external
// store, and the server snapshot is a constant false so SSR and hydration agree —
// the value then corrects itself on the client without a cascading effect render.
const QUERY = '(hover: none)';

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const getSnapshot = () => window.matchMedia(QUERY).matches;
const getServerSnapshot = () => false;

export function useIsTouch(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
