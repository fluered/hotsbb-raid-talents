'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Boss {
  id: number;
  name: string;
  href: string;
  imageUrl: string;
  tags: string[];
}

interface Raid {
  id: number;
  displayName: string;
  bosses: Boss[];
}

export default function BossPicker({
  raids,
  activeBossId,
  activeBossName,
  activeBossImageUrl,
}: {
  raids: Raid[];
  activeBossId: number | null;
  activeBossName: string | null;
  activeBossImageUrl: string | null;
}) {
  const [expanded, setExpanded] = useState(!activeBossId);

  useEffect(() => {
    setExpanded(!activeBossId);
  }, [activeBossId]);

  return (
    <div className="space-y-5">
      {/* Mobile collapsed chip — shown when a boss is selected and picker is closed */}
      {activeBossId && !expanded && (
        <div className="md:hidden flex items-center gap-2.5 px-3 py-2 bg-zinc-900/60 border border-zinc-700/50 rounded-xl">
          {activeBossImageUrl && (
            <img src={activeBossImageUrl} alt="" className="w-7 h-7 rounded-lg object-cover flex-shrink-0" />
          )}
          <span className="text-sm font-bold text-amber-300 flex-1 truncate">{activeBossName}</span>
          <button
            onClick={() => setExpanded(true)}
            className="text-[11px] font-semibold text-zinc-500 hover:text-zinc-300 transition-colors whitespace-nowrap"
          >
            change
          </button>
        </div>
      )}

      {/* Full grid — always on desktop, conditionally on mobile */}
      <div className={activeBossId && !expanded ? 'hidden md:block' : 'space-y-5'}>
        {raids.map(raid => (
          <div key={raid.id}>
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest whitespace-nowrap">
                {raid.displayName}
              </span>
              <div className="flex-1 h-px bg-zinc-800/60" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
              {raid.bosses.map(boss => {
                const isSelected = activeBossId === boss.id;
                return (
                  <Link
                    key={boss.id}
                    href={boss.href}
                    onClick={() => setExpanded(false)}
                    className={`relative h-16 rounded-xl overflow-hidden flex items-end transition-all border ${
                      isSelected
                        ? 'border-amber-500/60 ring-1 ring-amber-500/20'
                        : 'border-zinc-800/60 hover:border-zinc-600'
                    }`}
                  >
                    <div
                      className="absolute inset-0 bg-zinc-900"
                      style={boss.imageUrl ? {
                        backgroundImage: `url(${boss.imageUrl})`,
                        backgroundSize: 'contain',
                        backgroundRepeat: 'no-repeat',
                        backgroundPosition: 'right center',
                      } : undefined}
                    />
                    <span className={`absolute inset-0 ${
                      isSelected
                        ? 'bg-gradient-to-t from-amber-950/90 via-black/40 to-transparent'
                        : 'bg-gradient-to-t from-black/85 via-black/30 to-transparent'
                    }`} />
                    <div className="relative px-2.5 py-2 flex flex-col gap-1 min-w-0">
                      <span className={`text-[11px] font-bold leading-tight truncate ${
                        isSelected ? 'text-amber-300' : 'text-zinc-200'
                      }`}>
                        {boss.name}
                      </span>
                      {boss.tags.length > 0 && (
                        <div className="flex gap-1">
                          {boss.tags.map((tag: string) => (
                            <span key={tag} className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-zinc-500 border border-zinc-800/50 leading-none whitespace-nowrap">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
