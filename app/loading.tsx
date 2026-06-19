export default function Loading() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">
      <header className="h-12 border-b border-zinc-800/70 bg-black/70 px-5 flex items-center justify-between shrink-0">
        <div className="h-3.5 w-28 bg-zinc-800 rounded animate-pulse" />
        <div className="h-8 w-36 bg-zinc-900 rounded-lg animate-pulse" />
      </header>

      <div className="flex" style={{ height: 'calc(100vh - 48px)' }}>
        <aside className="w-48 shrink-0 border-r border-zinc-800/60 bg-black/30 p-2 pt-3 space-y-1">
          {Array.from({ length: 13 }).map((_, i) => (
            <div
              key={i}
              className="h-7 bg-zinc-900/60 rounded-lg animate-pulse"
              style={{ animationDelay: `${i * 40}ms` }}
            />
          ))}
        </aside>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
            <div className="flex gap-2">
              {[88, 110, 96].map((w, i) => (
                <div
                  key={i}
                  className="h-8 bg-zinc-900 rounded-full animate-pulse"
                  style={{ width: w, animationDelay: `${i * 80}ms` }}
                />
              ))}
            </div>

            <div className="space-y-2">
              <div className="h-2.5 w-24 bg-zinc-900 rounded animate-pulse mb-3" />
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-10 bg-zinc-900/40 rounded-xl animate-pulse"
                    style={{ animationDelay: `${i * 50}ms` }}
                  />
                ))}
              </div>
            </div>

            <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl p-8 flex items-center justify-center gap-3">
              <div className="w-3 h-3 rounded-full bg-amber-500/40 animate-pulse" />
              <span className="text-sm text-zinc-600">Fetching top parses…</span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
