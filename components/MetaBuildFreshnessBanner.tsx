'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// Meta builds shift with balance patches, not minute to minute, so there's little value
// in catching a change that happens *during* someone's few-minute visit — and a recurring
// poll costs something for every open tab regardless. A single check shortly after load
// still catches the one case that matters: the page was served from data that went stale
// moments before it rendered.
const CHECK_DELAY_MS = 5000;

// The page renders from its own 24h unstable_cache pipeline, while /api/meta-build
// answers from the separate Redis-backed crawl pipeline — the two recompute at
// independent times, so the API's fetchedAt being merely newer is normal and does NOT
// mean a refresh would deliver anything different (the page's cache entry may still be
// valid; clicking Refresh would re-serve the identical page). Only when the API's data
// is more than a full page-TTL newer is the page's entry guaranteed expired — then a
// refresh genuinely picks up new data, and the banner is telling the truth.
const PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export default function MetaBuildFreshnessBanner({
  className,
  spec,
  bossId,
  difficulty,
  region = 'global',
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
    const id = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          class: className, spec, boss: String(bossId), difficulty: String(difficulty), region, metric,
        });
        const res = await fetch(`/api/meta-build?${params}`, { cache: 'no-store' });
        const json = await res.json();
        const latest = json?.data?.fetchedAt;
        if (!cancelled && latest && knownFetchedAt.current && latest > knownFetchedAt.current + PAGE_CACHE_TTL_MS) {
          setStale(true);
        }
      } catch {
        // Transient — not worth retrying for a one-shot check.
      }
    }, CHECK_DELAY_MS);
    return () => { cancelled = true; clearTimeout(id); };
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
