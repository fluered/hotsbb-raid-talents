import LoadingProgress from '../../components/LoadingProgress';

// Streams in place of the page while Warcraft Logs tables (and, on a cold boss/spec,
// the top-player pool) are fetched — seconds when cached, a minute or two cold. An
// activity bar, staged status text and an elapsed clock say what is happening instead
// of a bare skeleton, so nobody thinks it hung.
export default function Loading() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">
      <header className="h-12 border-b border-zinc-800/70 bg-black/70 px-5 flex items-center justify-between shrink-0">
        <div className="h-3.5 w-28 bg-zinc-800 rounded animate-pulse" />
        <div className="h-6 w-36 bg-zinc-900 rounded-lg animate-pulse" />
      </header>
      <div className="flex" style={{ height: 'calc(100vh - 48px)' }}>
        <aside className="hidden md:block w-48 shrink-0 border-r border-zinc-800/60 bg-black/30 p-2 pt-3 space-y-1">
          {Array.from({ length: 13 }).map((_, i) => (
            <div key={i} className="h-7 bg-zinc-900/60 rounded-lg animate-pulse" style={{ animationDelay: `${i * 40}ms` }} />
          ))}
        </aside>
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 md:px-6 py-8 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-zinc-900 animate-pulse" />
              <div className="space-y-2">
                <div className="h-5 w-64 bg-zinc-900 rounded animate-pulse" />
                <div className="h-3 w-40 bg-zinc-900/70 rounded animate-pulse" />
              </div>
            </div>
            <LoadingProgress />
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-16 rounded-xl bg-zinc-900/60 animate-pulse" style={{ animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-20 rounded-xl bg-zinc-900/50 animate-pulse" style={{ animationDelay: `${i * 90}ms` }} />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
