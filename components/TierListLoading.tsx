import LoadingProgress, { tierListStages, type LoadingAccent } from './LoadingProgress';

// Streams in place of a tier list while its rankings are fetched: the staged bar
// says what is being pulled, and the grey rows underneath hold the tier shape.
const ROW_TINT: Record<LoadingAccent, { head: string; badge: string; row: string }> = {
  amber: { head: 'bg-amber-500/10', badge: 'bg-amber-500/20', row: 'border-amber-500/10' },
  sky: { head: 'bg-sky-500/10', badge: 'bg-sky-500/20', row: 'border-sky-500/10' },
  emerald: { head: 'bg-emerald-500/10', badge: 'bg-emerald-500/20', row: 'border-emerald-500/10' },
};

export default function TierListLoading({ accent, scope, role, specCount, bossCount, rows = [2, 4, 6, 4] }: {
  accent: LoadingAccent; scope: 'boss' | 'overall'; role: string; specCount: number; bossCount?: number; rows?: number[];
}) {
  const t = ROW_TINT[accent];
  return (
    <div className="space-y-6">
      <div className="space-y-1 animate-pulse">
        <div className={`h-6 w-40 rounded ${t.head}`} />
        <div className="h-3 w-64 bg-zinc-800/60 rounded" />
      </div>
      <LoadingProgress accent={accent} stages={tierListStages({ scope, role, specCount, bossCount })} />
      <div className="space-y-6 animate-pulse" aria-hidden="true">
        {rows.map((n, ti) => (
          <div key={ti} className="space-y-1.5">
            <div className={ti === 0 ? `h-9 rounded-xl w-11 ${t.badge}` : 'h-9 rounded-xl w-9 bg-zinc-800'} />
            {Array.from({ length: n }).map((_, i) => (
              <div key={i} className={`h-14 bg-zinc-900/40 border rounded-xl ${t.row}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
