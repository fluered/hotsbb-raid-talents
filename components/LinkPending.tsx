'use client';

import { useLinkStatus } from 'next/link';

// Rendered inside a <Link>: shows that the click registered while the next page is
// still being built on the server. A review can take a minute or two the first time
// a boss and spec are seen, and without this the click looks like it did nothing.
export default function LinkPending({ label = 'loading' }: { label?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-amber-300 shrink-0" aria-live="polite">
      <span className="inline-block w-3 h-3 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
      {label}
    </span>
  );
}
