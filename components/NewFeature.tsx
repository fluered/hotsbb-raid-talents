'use client';
import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

function makeColMap(nodes: any[]): Map<number, number> {
  const unique = [...new Set(nodes.map((n: any) => n.column as number))].sort((a, b) => a - b);
  return new Map(unique.map((c, i) => [c, i + 1]));
}

interface TooltipState {
  node: any;
  rank: number;
  showRank: boolean;
  rect: DOMRect;
  freq?: number;
}

function Tooltip({ tip, colors }: { tip: TooltipState; colors: { color: string } }) {
  const TOOLTIP_W = 256;
  const MARGIN = 10;
  const { node, rank, showRank, rect, freq } = tip;

  // Horizontal: prefer left-aligned to node, clamp to viewport
  let left = rect.left;
  if (left + TOOLTIP_W > window.innerWidth - MARGIN) left = rect.right - TOOLTIP_W;
  if (left < MARGIN) left = MARGIN;

  // Vertical: show above if enough space, else below
  const above = rect.top > 180;
  const top = above ? rect.top - 8 : rect.bottom + 8;
  const transform = above ? 'translateY(-100%)' : 'none';

  return createPortal(
    <div
      style={{ position: 'fixed', top, left, width: TOOLTIP_W, transform, zIndex: 9999 }}
      className="bg-zinc-950 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden pointer-events-none"
    >
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
        {node.iconUrl && (
          <img src={node.iconUrl} alt="" className="w-7 h-7 rounded flex-shrink-0" />
        )}
        <div>
          <div className={`text-sm font-black ${colors.color}`}>{node.name}</div>
          <div className="flex items-center gap-2 mt-0.5">
            {showRank && <span className="text-[10px] text-zinc-500">Rank {rank}/{node.maxRanks}</span>}
            {freq != null && (
              <span className={`text-[10px] font-bold ${
                freq >= 90 ? 'text-white' : freq >= 70 ? colors.color : 'text-zinc-500'
              }`}>
                {freq}% of top players
              </span>
            )}
          </div>
        </div>
      </div>
      {(node.castTime || node.range || node.cost || node.cooldown) && (
        <div className="px-3 pt-2 flex flex-wrap gap-x-3 gap-y-0.5">
          {node.castTime && <span className="text-[10px] text-zinc-400">{node.castTime}</span>}
          {node.range && <span className="text-[10px] text-zinc-400">{node.range}</span>}
          {node.cost && <span className="text-[10px] text-zinc-400">{node.cost}</span>}
          {node.cooldown && <span className="text-[10px] text-zinc-400">{node.cooldown}</span>}
        </div>
      )}
      {node.description && (
        <p className="px-3 py-2 text-[11px] text-zinc-300 leading-relaxed">{node.description}</p>
      )}
    </div>,
    document.body
  );
}

export default function NewFeature({
  telemetry,
  layout,
  colors,
  frequencyMap,
  heroOnly = false,
}: {
  telemetry: any;
  layout: any[];
  colors: { color: string; border: string; activeBg: string };
  frequencyMap?: Record<number, number>;
  heroOnly?: boolean;
}) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const activeNodes = telemetry?.event?.talentTree || [];
  const activeNodeIds = new Set<number>(activeNodes.map((t: any) => t.nodeID));

  // Determine which hero tree the player is using
  const activeHeroTreeIds = new Set<number>();
  for (const node of layout) {
    if (node.section === 'hero' && node.heroTreeId != null && activeNodeIds.has(node.nodeID)) {
      activeHeroTreeIds.add(node.heroTreeId);
    }
  }

  // Keep only the active hero tree (or all if none active)
  const visibleLayout = layout.filter((n: any) => {
    if (n.section !== 'hero') return true;
    if (activeHeroTreeIds.size === 0) return true;
    return activeHeroTreeIds.has(n.heroTreeId);
  });

  // Per-section sequential column normalization
  const classSectionNodes = visibleLayout.filter((n: any) => n.section === 'class');
  const heroSectionNodes  = visibleLayout.filter((n: any) => n.section === 'hero');
  const specSectionNodes  = visibleLayout.filter((n: any) => n.section === 'spec');

  const classColMap = makeColMap(classSectionNodes);
  const heroColMap  = makeColMap(heroSectionNodes);
  const specColMap  = makeColMap(specSectionNodes);

  const classMaxCol = classColMap.size || 0;
  const heroMaxCol  = heroColMap.size  || 0;
  const specMaxCol  = specColMap.size  || 0;

  const SEP = 2;
  const heroOffset = classMaxCol + SEP;
  const specOffset = heroOffset + (heroMaxCol > 0 ? heroMaxCol + SEP : 0);
  const totalCols  = specOffset + specMaxCol;

  const hasSections = classSectionNodes.length > 0 && specSectionNodes.length > 0;

  let legacyColMap: Map<number, number> | null = null;
  let legacyMaxCol = 0;
  if (!hasSections) {
    const uniqueCols = [...new Set(visibleLayout.map((n: any) => n.column || 0))].sort((a, b) => a - b);
    let remapped = 0;
    legacyColMap = new Map();
    for (let i = 0; i < uniqueCols.length; i++) {
      remapped += i === 0 ? 1 : Math.min(uniqueCols[i] - uniqueCols[i - 1], 2);
      legacyColMap.set(uniqueCols[i], remapped);
    }
    legacyMaxCol = remapped;
  }

  // In heroOnly mode: show just the active hero tree, columns starting at 1
  const heroOnlyColMap = heroOnly ? makeColMap(heroSectionNodes) : null;
  const effectiveTotalCols = heroOnly
    ? (heroOnlyColMap!.size || 1)
    : hasSections ? totalCols : legacyMaxCol;

  const renderNodes = heroOnly ? heroSectionNodes : visibleLayout;

  function getMappedCol(node: any): number {
    if (heroOnly) return heroOnlyColMap!.get(node.column) ?? 1;
    if (!hasSections) return legacyColMap!.get(node.column) ?? 1;
    if (node.section === 'class') return classColMap.get(node.column) ?? 1;
    if (node.section === 'hero')  return heroOffset + (heroColMap.get(node.column) ?? 1);
    return specOffset + (specColMap.get(node.column) ?? 1);
  }

  const handleMouseEnter = useCallback((e: React.MouseEvent, node: any, rank: number, showRank: boolean, freq?: number) => {
    if (!node.name) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({ node, rank, showRank, rect, freq });
  }, []);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  return (
    <>
      <div
        className="grid gap-1.5 py-1 mx-auto"
        style={{ gridTemplateColumns: `repeat(${effectiveTotalCols}, 2.5rem)`, width: 'max-content' }}
      >
        {renderNodes.map((node: any) => {
          const activeNode = activeNodes.find((t: any) => t.nodeID === node.nodeID);
          const isActive = !!activeNode;
          const rank = activeNode?.rank ?? 0;
          const showRank = isActive && node.maxRanks > 1;
          const mappedColumn = getMappedCol(node);
          const freq = frequencyMap?.[node.nodeID];

          return (
            <div
              key={node.nodeID}
              style={{ gridRow: node.row, gridColumn: mappedColumn }}
              onMouseEnter={(e) => handleMouseEnter(e, node, rank, showRank, freq)}
              onMouseLeave={handleMouseLeave}
            >
              <div
                className={`w-10 h-10 rounded-full border-2 overflow-hidden transition-all relative ${
                  node.spellId ? 'cursor-pointer' : 'cursor-default'
                } ${isActive ? colors.border : 'border-zinc-700/20'}`}
                onClick={() => node.spellId && window.open(`https://www.wowhead.com/spell=${node.spellId}`, '_blank', 'noopener,noreferrer')}
              >
                {node.iconUrl ? (
                  <img
                    src={node.iconUrl}
                    alt={node.name}
                    className="w-full h-full object-cover"
                    style={{ opacity: isActive ? 1 : 0.15 }}
                  />
                ) : (
                  <div className={`w-full h-full ${isActive ? colors.activeBg : 'bg-zinc-900/50'}`} />
                )}
                {freq != null && freq > 0 && (
                  <div className="absolute bottom-0 inset-x-0 bg-black/75 flex items-center justify-center py-0.5">
                    <span className={`text-[8px] font-bold tabular-nums leading-none ${isActive ? 'text-white' : 'text-zinc-400'}`}>{freq}%</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {tooltip && <Tooltip tip={tooltip} colors={colors} />}
    </>
  );
}
