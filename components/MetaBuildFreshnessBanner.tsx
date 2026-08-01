'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// Meta builds shift with balance patches, not minute to minute — polling every 5 minutes
// catches updates promptly without adding meaningful load. Skips polling while the tab
// isn't visible so a backgrounded tab doesn't keep quietly hitting the API.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

export default function MetaBuildFreshnessBanner({
  className,
  spec,
  bossId,
  difficulty,
  region = 'us',
  metric = 'dps',
  fetchedAt,
}: {
  className: string;
  spec: string;
  bossId: number;
  difficulty: number;
  region?: string;
  metric?: string;
  fetchedAt?: number;
}) {
  const router = useRouter();
  const [stale, setStale] = useState(false);
  const knownFetchedAt = useRef(fetchedAt);

  // The page's own data just changed underneath us (e.g. the user clicked Refresh, or
  // navigated) — resync the baseline and clear any stale banner from before.
  useEffect(() => {
    knownFetchedAt.current = fetchedAt;
    setStale(false);
  }, [fetchedAt]);

  useEffect(() => {
    if (fetchedAt == null) return;

    let cancelled = false;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const params = new URLSearchParams({
          class: className, spec, boss: String(bossId), difficulty: String(difficulty), region, metric,
        });
        const res = await fetch(`/api/meta-build?${params}`, { cache: 'no-store' });
        const json = await res.json();
        const latest = json?.data?.fetchedAt;
        if (!cancelled && latest && knownFetchedAt.current && latest > knownFetchedAt.current) {
          setStale(true);
        }
      } catch {
        // Transient — just try again on the next interval.
      }
    };

    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [className, spec, bossId, difficulty, region, metric, fetchedAt]);

  if (!stale) return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-amber-950/60 border border-amber-800/50 text-amber-300 text-sm px-4 py-2.5 rounded-xl mb-4 shadow-lg">
      <span className="font-semibold">A newer meta build is available.</span>
      <button
        onClick={() => { setStale(false); router.refresh(); }}
        className="px-3 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 font-semibold transition-colors flex-shrink-0"
      >
        Refresh
      </button>
    </div>
  );
}
