'use client';

export default function TierListError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
      <div className="text-center space-y-4 px-8">
        <p className="text-zinc-400 text-sm">Tier list data is temporarily unavailable.</p>
        <p className="text-zinc-600 text-xs">WarcraftLogs may be down or rate-limiting — try again in a moment.</p>
        <button
          onClick={reset}
          className="text-xs font-bold text-amber-400 hover:text-amber-300 transition-colors uppercase tracking-widest"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
