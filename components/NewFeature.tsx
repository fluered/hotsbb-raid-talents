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
        <p className="px-3 py-2 text-[11px] text-zinc-300 leading-relaxed whitespace-pre-line">{node.description}</p>
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
  heroTreeImageUrl,
  heroTreeName,
  wowClass,
  specName,
  heroTrees,
  onHeroTreeClick,
  topPlayerTelemetry,
}: {
  telemetry: any;
  layout: any[];
  colors: { color: string; border: string; activeBg: string };
  frequencyMap?: Record<number, number>;
  heroOnly?: boolean;
  heroTreeImageUrl?: string;
  heroTreeName?: string;
  wowClass?: string;
  specName?: string;
  heroTrees?: Array<{ name: string; imageUrl?: string; pct: number }>;
  onHeroTreeClick?: (name: string) => void;
  topPlayerTelemetry?: any;
}) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const activeNodes = telemetry?.event?.talentTree || [];
  const activeNodeIds = new Set<number>(activeNodes.map((t: any) => t.nodeID));

  // Nodes where the #1 parser diverges from consensus: they take it but consensus doesn't (or vice versa)
  const topPlayerNodeIds = topPlayerTelemetry
    ? new Set<number>((topPlayerTelemetry?.event?.talentTree || []).map((t: any) => t.nodeID))
    : null;
  const divergentNodeIds = topPlayerNodeIds
    ? new Set<number>([...activeNodeIds, ...topPlayerNodeIds].filter(id => activeNodeIds.has(id) !== topPlayerNodeIds!.has(id)))
    : null;

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

  // 1 label row only — portrait is absolutely positioned so it doesn't affect class/spec layout
  const HERO_ROW_OFFSET = (!heroOnly && hasSections) ? 1 : 0;

  // Shift hero nodes so they start below the portrait (row 4+) when a portrait is shown.
  // Portrait is 4.5rem tall starting at 1.875rem, clearing at ~row 4 (7.625rem from top).
  // When no portrait, fall back to the old "bring nodes close to class nodes" heuristic.
  const classMinRow  = classSectionNodes.length > 0 ? Math.min(...classSectionNodes.map((n: any) => n.row)) : 1;
  const heroMinRow   = heroSectionNodes.length  > 0 ? Math.min(...heroSectionNodes.map((n: any) => n.row))  : 1;
  const hasPortrait  = HERO_ROW_OFFSET > 0 && (!!heroTreeImageUrl || (heroTrees != null && heroTrees.length > 0));
  // With portrait: heroRowShift may be negative to push nodes DOWN so they clear the image.
  // Target: first hero mapped row = max(4, classMinRow + 3), i.e. heroRowShift = heroMinRow - max(3, classMinRow + 2).
  // Without portrait: keep old behaviour (clamp to 0, only shift up).
  const heroRowShift = hasPortrait
    ? heroMinRow - Math.max(3, classMinRow + 2)
    : Math.max(0, heroMinRow - classMinRow - 2);

  function getMappedRow(node: any): number {
    if (hasSections && !heroOnly && node.section === 'hero' && heroMaxCol > 0) {
      return node.row - heroRowShift + HERO_ROW_OFFSET;
    }
    return node.row + HERO_ROW_OFFSET;
  }

  // Center any hero node that is the only node in its row
  const heroRows         = [...new Set(heroSectionNodes.map((n: any) => n.row))].sort((a: number, b: number) => a - b);
  const heroCenterCol    = Math.ceil(heroMaxCol / 2);
  const heroSingleRows   = new Set<number>(
    heroRows.filter(row => heroSectionNodes.filter((n: any) => n.row === row).length === 1)
  );
  const heroGatewayIds   = new Set<number>(
    heroSectionNodes.filter((n: any) => heroSingleRows.has(n.row)).map((n: any) => n.nodeID)
  );

  function getMappedCol(node: any): number {
    if (heroOnly) return heroOnlyColMap!.get(node.column) ?? 1;
    if (!hasSections) return legacyColMap!.get(node.column) ?? 1;
    if (node.section === 'class') return classColMap.get(node.column) ?? 1;
    if (node.section === 'hero') {
      // For even heroMaxCol, gateway start col is the left-center column (span 2 finishes centering)
      // For odd heroMaxCol, gateway start col is the exact center column (span 1)
      const col = heroGatewayIds.has(node.nodeID) ? heroCenterCol : (heroColMap.get(node.column) ?? 1);
      return heroOffset + col;
    }
    return specOffset + (specColMap.get(node.column) ?? 1);
  }

  // Gateway nodes in even-column hero sections span 2 columns so the icon floats
  // in the gap between the two center nodes of each regular row.
  function getColSpan(node: any): number {
    if (hasSections && !heroOnly && node.section === 'hero' && heroGatewayIds.has(node.nodeID) && heroMaxCol % 2 === 0) {
      return 2;
    }
    return 1;
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
        className="grid gap-1.5 py-1 mx-auto relative"
        style={{
          gridTemplateColumns: `repeat(${effectiveTotalCols}, 2.5rem)`,
          gridTemplateRows: HERO_ROW_OFFSET === 1 ? '1.25rem' : undefined,
          width: 'max-content',
        }}
      >
        {/* Section labels — all in row 1, perfectly aligned */}
        {HERO_ROW_OFFSET > 0 && (
          <>
            {wowClass && classMaxCol > 0 && (
              <div
                style={{ gridRow: 1, gridColumn: `1 / span ${classMaxCol}` }}
                className="flex items-center justify-center"
              >
                <span className={`text-[11px] font-bold tracking-widest uppercase ${colors.color}`}>{wowClass}</span>
              </div>
            )}
            {heroMaxCol > 0 && (
              <div
                style={{ gridRow: 1, gridColumn: `${heroOffset + 1} / span ${heroMaxCol}` }}
                className="flex items-center justify-center"
              >
                <span className={`text-[11px] font-bold tracking-widest uppercase ${colors.color}`}>
                  {heroTreeName ?? (heroTrees && heroTrees.length === 1 ? heroTrees[0].name : heroTrees && heroTrees.length > 1 ? 'Hero Talents' : undefined)}
                </span>
              </div>
            )}
            {specName && specMaxCol > 0 && (
              <div
                style={{ gridRow: 1, gridColumn: `${specOffset + 1} / span ${specMaxCol}` }}
                className="flex items-center justify-center"
              >
                <span className={`text-[11px] font-bold tracking-widest uppercase ${colors.color}`}>{specName}</span>
              </div>
            )}
          </>
        )}

        {/* Portrait / multi-icons: absolutely positioned over the hero column's natural empty space */}
        {HERO_ROW_OFFSET > 0 && heroMaxCol > 0 && (heroTreeImageUrl || (heroTrees && heroTrees.length > 0)) && (
          <div
            style={{
              position: 'absolute',
              // py-1 top padding (0.25rem) + label row (1.25rem) + grid gap (0.375rem)
              top: '1.875rem',
              left: `${heroOffset * 2.875}rem`,
              width: `${heroMaxCol * 2.875 - 0.375}rem`,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'flex-start',
              pointerEvents: 'none',
            }}
          >
            {heroTreeImageUrl ? (
              <img
                src={heroTreeImageUrl}
                alt={heroTreeName ?? ''}
                style={{ width: '4.5rem', height: '4.5rem' }}
                className="rounded-full object-cover ring-2 ring-zinc-600"
              />
            ) : heroTrees && heroTrees.length > 0 ? (
              <div className="flex items-start gap-3">
                {heroTrees.map(ht => (
                  <div
                    key={ht.name}
                    className={`flex flex-col items-center gap-0.5 ${onHeroTreeClick ? 'cursor-pointer group' : ''}`}
                    style={onHeroTreeClick ? { pointerEvents: 'auto' } : undefined}
                    onClick={onHeroTreeClick ? () => onHeroTreeClick(ht.name) : undefined}
                  >
                    {ht.imageUrl
                      ? <img src={ht.imageUrl} alt={ht.name} className={`w-16 h-16 rounded-full object-cover ring-1 ring-zinc-600 ${onHeroTreeClick ? 'group-hover:ring-2 group-hover:ring-zinc-400 transition-all' : ''}`} />
                      : <div className="w-16 h-16 rounded-full bg-zinc-800 ring-1 ring-zinc-600" />
                    }
                    <span className="text-[10px] font-bold text-zinc-400">{ht.pct}%</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}

        {renderNodes.map((node: any) => {
          const activeNode = activeNodes.find((t: any) => t.nodeID === node.nodeID);
          const isActive = !!activeNode;
          const rank = activeNode?.rank ?? 0;
          const showRank = isActive && node.maxRanks > 1;
          const mappedColumn = getMappedCol(node);
          const colSpan = getColSpan(node);
          const freq = frequencyMap?.[node.nodeID];
          const isDivergent = divergentNodeIds?.has(node.nodeID) ?? false;
          // true = top player takes this but consensus doesn't; false = consensus takes it but top player skips
          const topPlayerTakes = isDivergent && (topPlayerNodeIds?.has(node.nodeID) ?? false);

          return (
            <div
              key={node.nodeID}
              style={{
                gridRow: getMappedRow(node),
                gridColumn: colSpan > 1 ? `${mappedColumn} / span ${colSpan}` : mappedColumn,
              }}
              className={colSpan > 1 ? 'flex justify-center' : undefined}
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
                {isDivergent && (
                  <div className={`absolute top-0 right-0 w-2.5 h-2.5 rounded-full border border-zinc-900 ${topPlayerTakes ? 'bg-amber-400' : 'bg-zinc-600'}`} />
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
