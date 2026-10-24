import LoadingProgress, { TIER_LIST_STAGES } from '../../components/LoadingProgress';

// Streams in place of a tier-list page on its first load (the per-list fallback in
// the page handles later boss and role switches). Same shell as the page: header,
// role tabs, boss chips, then the staged bar where the list will be.
export default function Loading() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">
      <header className="h-12 border-b border-zinc-800/70 bg-black/70 px-5 flex items-center justify-between shrink-0">
        <div className="h-3.5 w-28 bg-zinc-800 rounded animate-pulse" />
        <div className="h-8 w-36 bg-zinc-900 rounded-lg animate-pulse" />
      </header>
      <div className="max-w-screen-md mx-auto px-4 md:px-6 py-6 space-y-6">
        <div className="flex items-center gap-1 bg-zinc-900/60 rounded-xl p-1 border border-zinc-800/60 w-fit animate-pulse">
          {[52, 58, 68].map((w, i) => (
            <div key={i} className="h-8 rounded-lg bg-zinc-800/60" style={{ width: w }} />
          ))}
        </div>
        <div className="space-y-2 animate-pulse">
          <div className="h-2.5 w-28 bg-zinc-900 rounded" />
          <div className="flex flex-wrap gap-1.5">
            {[150, 140, 160, 130, 90, 120, 130, 80, 150, 70].map((w, i) => (
              <div key={i} className="h-8 rounded-lg border border-zinc-800/60 bg-zinc-900/30" style={{ width: w, animationDelay: `${i * 40}ms` }} />
            ))}
          </div>
        </div>
        <LoadingProgress stages={TIER_LIST_STAGES} />
        <div className="space-y-6 animate-pulse" aria-hidden="true">
          {[2, 4, 6].map((n, ti) => (
            <div key={ti} className="space-y-1.5">
              <div className={ti === 0 ? 'h-9 rounded-xl w-11 bg-amber-500/20' : 'h-9 rounded-xl w-9 bg-zinc-800'} />
              {Array.from({ length: n }).map((_, i) => (
                <div key={i} className="h-14 bg-zinc-900/40 border border-zinc-800/50 rounded-xl" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
