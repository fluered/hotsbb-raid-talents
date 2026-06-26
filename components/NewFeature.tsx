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
  activeHeroTreeId,
  consensusEntryIds,
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
  activeHeroTreeId?: number;
  consensusEntryIds?: Record<number, number>;
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

  // Server-provided activeHeroTreeId takes priority over client-side node-ID matching.
  // Node-ID matching is unreliable when nodes are shared or mis-labelled across trees.
  const effectiveHeroTreeIds: Set<number> =
    activeHeroTreeId != null
      ? new Set([activeHeroTreeId])
      : activeHeroTreeIds.size === 1
        ? activeHeroTreeIds
        : new Set();

  // Keep only the active hero tree (or all if none active).
  // Shared gateway nodes (heroTreeId === null) always show regardless of which tree is active.
  const visibleLayout = layout.filter((n: any) => {
    if (n.section !== 'hero') return true;
    if (effectiveHeroTreeIds.size === 0) return true;
    if (n.heroTreeId === null) return true;
    return effectiveHeroTreeIds.has(n.heroTreeId);
  });

  if (process.env.NODE_ENV === 'development') {
    const allHeroNodes = layout.filter((n: any) => n.section === 'hero');
    const visibleHeroNodes = visibleLayout.filter((n: any) => n.section === 'hero');
    const heroTreeIdSet = new Set(allHeroNodes.map((n: any) => n.heroTreeId));
    console.log('[HeroTree]', {
      activeHeroTreeId,
      activeHeroTreeIds: [...activeHeroTreeIds],
      effectiveHeroTreeIds: [...effectiveHeroTreeIds],
      heroTreeIdsInLayout: [...heroTreeIdSet],
      totalHeroNodes: allHeroNodes.length,
      visibleHeroNodes: visibleHeroNodes.length,
    });
  }

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

  // Class nodes whose raw column matches any active hero node column are bridge nodes
  // (e.g. Evoker "Mass Disintegrate" at col 23, same column as Scalecommander hero nodes).
  // Stored by nodeID to avoid any column-type ambiguity in later lookups.
  const heroColValues = heroSectionNodes.map((n: any) => n.column);
  const bridgeClassNodeIds = new Set<number>(
    classSectionNodes
      .filter((n: any) => heroColValues.includes(n.column))
      .map((n: any) => n.nodeID as number)
  );

  // Full set of columns used by ANY hero tree (including inactive ones).
  // Used to suppress class nodes that are bridges for a different hero tree than the active one.
  const allHeroColSet = new Set(
    layout.filter((n: any) => n.section === 'hero').map((n: any) => n.column)
  );

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
  // Portrait is 4.5rem tall starting at 1.875rem. Hero nodes must start after it clears.
  // Use the 2nd distinct class row to determine when the portrait is clear — specs like Evoker
  // have a gap at class row 3 (rows: 2, 4, 5…) which means classMinRow alone underestimates
  // how far down the portrait extends relative to the first hero row.
  const classSortedRows = classSectionNodes.length > 0
    ? [...new Set(classSectionNodes.map((n: any) => n.row as number))].sort((a, b) => a - b)
    : [1];
  // Only normalize rows for specs with outlier class columns (those whose column appears in any
  // hero tree). This handles Evoker's Mass Disintegrate (col 23, in Scalecommander hero cols)
  // without affecting specs like BM Hunter that have no class-hero column overlap.
  const hasOutlierClassCol = classSectionNodes.some((n: any) => allHeroColSet.has(n.column));
  const classRowOffset = hasOutlierClassCol ? (classMinRow - 1) : 0;
  // When a bridge class node is present (e.g. Scalecommander), it occupies one row above the
  // first hero row, so the hero section naturally starts one row lower. When there's no bridge
  // (e.g. Flameshaper) but the class tree has a row gap (classRowOffset > 0), shift the hero
  // section up by 1 so both views align at the same starting row.
  const heroBridgeAdjust = (hasPortrait && classRowOffset > 0 && bridgeClassNodeIds.size === 0) ? 1 : 0;
  const heroRowShift = hasPortrait
    ? heroMinRow - Math.max(3, (classSortedRows[1] ?? classMinRow + 1) + 1) + heroBridgeAdjust
    : Math.max(0, heroMinRow - classMinRow - 2);

  function getMappedRow(node: any): number {
    const r = node.row - classRowOffset;
    if (hasSections && !heroOnly && heroMaxCol > 0) {
      if (node.section === 'hero') return r - heroRowShift + HERO_ROW_OFFSET;
      if (node.section === 'class' && bridgeClassNodeIds.has(node.nodeID)) {
        return r - heroRowShift + HERO_ROW_OFFSET;
      }
    }
    return r + HERO_ROW_OFFSET;
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
    if (node.section === 'class') {
      const raw = node.column as number;
      // Bridge nodes: class nodes whose raw column overlaps the active hero tree columns.
      // Reposition them into the hero section area so they align with the hero nodes below.
      if (heroMaxCol > 0 && heroColMap.has(raw)) {
        // Bridge class nodes are visually centered like gateway hero nodes
        return heroOffset + heroCenterCol;
      }
      return classColMap.get(raw) ?? 1;
    }
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
          gridAutoRows: '2.5rem',
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

          // Suppress class nodes that share a column with a different hero tree's nodes.
          // e.g. Evoker "Mass Disintegrate" at col 23 is a Scalecommander bridge; hide it in Flameshaper view.
          const isOrphanBridge = node.section === 'class' &&
            allHeroColSet.has(node.column) &&
            !bridgeClassNodeIds.has(node.nodeID);
          if (isOrphanBridge) return null;

          const isClassBridge = hasSections && !heroOnly && heroMaxCol > 0 &&
            node.section === 'class' && mappedColumn > heroOffset;
          // Bridge class nodes get span 2 (same as gateway nodes) so the icon centers visually
          const colSpan = isClassBridge && heroMaxCol % 2 === 0 ? 2 : getColSpan(node);
          const freq = frequencyMap?.[node.nodeID];
          const isDivergent = divergentNodeIds?.has(node.nodeID) ?? false;
          // true = top player takes this but consensus doesn't; false = consensus takes it but top player skips
          const topPlayerTakes = isDivergent && (topPlayerNodeIds?.has(node.nodeID) ?? false);
          const mappedRow = isClassBridge
            ? (node.row - classRowOffset) - heroRowShift + HERO_ROW_OFFSET
            : getMappedRow(node);

          // For choice nodes: WCL always records rank=1 for both options; use the majority
          // entry ID from WCL data to determine which option the consensus chose.
          const consensusEntryId = node.nodeID != null ? consensusEntryIds?.[node.nodeID] : undefined;
          const chosenIsB = node.isChoice && node.choiceB != null
            && node.choiceBEntryId != null
            && consensusEntryId === node.choiceBEntryId;
          const displayNode = chosenIsB
            ? { ...node, name: node.choiceB.name, spellId: node.choiceB.spellId, iconUrl: node.choiceB.iconUrl, description: node.choiceB.description, castTime: node.choiceB.castTime, range: node.choiceB.range, cost: node.choiceB.cost, cooldown: node.choiceB.cooldown }
            : node;

          return (
            <div
              key={node.nodeID}
              style={{
                gridRow: mappedRow,
                gridColumn: colSpan > 1 ? `${mappedColumn} / span ${colSpan}` : mappedColumn,
              }}
              className={colSpan > 1 ? 'flex justify-center' : undefined}
              onMouseEnter={(e) => handleMouseEnter(e, displayNode, rank, showRank, freq)}
              onMouseLeave={handleMouseLeave}
            >
              <div
                className={`w-10 h-10 rounded-full border-2 overflow-hidden transition-all relative ${
                  displayNode.spellId ? 'cursor-pointer' : 'cursor-default'
                } ${topPlayerTakes ? 'border-amber-400 shadow-[0_0_6px_1px_rgba(251,191,36,0.5)]' : isActive ? colors.border : 'border-zinc-700/20'}`}
                onClick={() => displayNode.spellId && window.open(`https://www.wowhead.com/spell=${displayNode.spellId}`, '_blank', 'noopener,noreferrer')}
              >
                {displayNode.iconUrl ? (
                  <img
                    src={displayNode.iconUrl}
                    alt={displayNode.name}
                    className="w-full h-full object-cover"
                    style={{ opacity: isActive ? 1 : 0.15 }}
                  />
                ) : (
                  <div className={`w-full h-full ${isActive ? colors.activeBg : 'bg-zinc-900/50'}`} />
                )}
                {node.isChoice && (
                  <div className="absolute top-0 right-0 w-3 h-3 rounded-full bg-zinc-900 border border-zinc-600 flex items-center justify-center" style={{ transform: 'translate(25%, -25%)' }}>
                    <span className="text-[6px] text-zinc-400 leading-none font-bold">2</span>
                  </div>
                )}
                {freq != null && freq > 0 && node.section !== 'hero' && (
                  <div className="absolute bottom-0 inset-x-0 bg-black/75 flex items-center justify-center py-0.5">
                    <span className={`text-[8px] font-bold tabular-nums leading-none ${isActive ? 'text-white' : 'text-zinc-400'}`}>{freq}%</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {divergentNodeIds && renderNodes.some(n => divergentNodeIds.has(n.nodeID) && topPlayerNodeIds?.has(n.nodeID)) && (
        <div className="flex items-center gap-1.5 mt-3 text-[9px] text-zinc-500">
          <span className="w-3.5 h-3.5 rounded-full border-2 border-amber-400 flex-shrink-0" />
          <span>Picked by top players but not part of the meta consensus build</span>
        </div>
      )}

      {tooltip && <Tooltip tip={tooltip} colors={colors} />}
    </>
  );
}
