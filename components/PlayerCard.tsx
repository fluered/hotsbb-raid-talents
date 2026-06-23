'use client';
import React from 'react';
import NewFeature from './NewFeature';
import CopyBuildButton from './CopyBuildButton';

export default function PlayerCard({
  player,
  layout,
  colors,
  idx,
  wowClass,
  specName,
  heroTrees,
}: {
  player: any;
  layout: any[];
  colors: { color: string; border: string; activeBg: string };
  idx: number;
  wowClass?: string;
  specName?: string;
  heroTrees?: Array<{ id: number; name: string; imageUrl?: string }>;
}) {
  const activeNodeIds = new Set<number>((player.telemetry?.event?.talentTree ?? []).map((t: any) => t.nodeID));
  const activeHeroTreeId = layout.find((n: any) => n.section === 'hero' && n.heroTreeId != null && activeNodeIds.has(n.nodeID))?.heroTreeId ?? null;
  const heroTree = activeHeroTreeId != null ? heroTrees?.find(ht => ht.id === activeHeroTreeId) : undefined;

  return (
    <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-zinc-800/50 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          {player.renderUrl ? (
            <img
              src={player.renderUrl}
              alt=""
              className="w-9 h-9 rounded-full object-cover object-top flex-shrink-0 border border-zinc-700"
            />
          ) : (
            <div className="w-9 h-9 rounded-full flex-shrink-0 bg-zinc-800 border border-zinc-700 flex items-center justify-center">
              <span className="text-xs text-zinc-600 font-mono">#{idx + 1}</span>
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-bold text-base ${colors.color}`}>
                {player.name}
              </span>
              {player.server?.name && (
                <span className="text-xs text-zinc-600 shrink-0">{player.server.name}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {player.score != null ? (
            /* M+ mode: show key level + score */
            <>
              {player.hardModeLevel != null && (
                <span className="text-xs font-black text-zinc-400 bg-zinc-800 border border-zinc-700 px-2 py-1 rounded-md tabular-nums">
                  +{player.hardModeLevel}
                </span>
              )}
              <div className="text-right">
                <span className="text-sm font-black text-emerald-400 tabular-nums">
                  {player.score.toFixed(1)}
                </span>
                <span className="text-[10px] text-zinc-600 ml-1">score</span>
              </div>
            </>
          ) : (
            /* Raid mode: show parse % + DPS */
            <>
              {player.rankPercent != null && (
                <span className={`text-sm font-black tabular-nums px-2.5 py-1 rounded-md border ${
                  player.rankPercent >= 99 ? 'text-amber-300 bg-amber-500/10 border-amber-500/30' :
                  player.rankPercent >= 95 ? 'text-orange-300 bg-orange-500/10 border-orange-500/30' :
                  player.rankPercent >= 75 ? 'text-violet-300 bg-violet-500/10 border-violet-500/30' :
                  player.rankPercent >= 50 ? 'text-blue-300 bg-blue-500/10 border-blue-500/30' :
                  'text-zinc-400 bg-zinc-800/50 border-zinc-700'
                }`}>
                  {Math.floor(player.rankPercent)}%
                </span>
              )}
              <div className="text-right">
                <span className="text-sm font-black text-emerald-400 tabular-nums">
                  {Math.round(player.amount).toLocaleString()}
                </span>
                <span className="text-[10px] text-zinc-600 ml-1">DPS</span>
              </div>
            </>
          )}
          <CopyBuildButton talentString={player.talentString ?? null} />
          <a
            href={`https://www.warcraftlogs.com/reports/${player.report?.code}#fight=${player.report?.fightID}&source=${player.telemetry?.sourceId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-600 hover:text-amber-400 transition-colors font-medium underline underline-offset-2"
          >
            WCL ↗
          </a>
        </div>
      </div>

      <div className="px-5 py-4 overflow-x-auto min-w-0">
        <NewFeature
          telemetry={player.telemetry}
          layout={layout}
          colors={colors}
          wowClass={wowClass}
          specName={specName}
          heroTreeImageUrl={heroTree?.imageUrl}
          heroTreeName={heroTree?.name}
        />
      </div>
    </div>
  );
}
