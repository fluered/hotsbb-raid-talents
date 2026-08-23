'use client';
import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { normalizeTalentTree } from '../lib/talentNormalize';

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
  rankDist?: Record<number, number>;
}

function Tooltip({ tip, colors }: { tip: TooltipState; colors: { color: string } }) {
  const TOOLTIP_W = 256;
  const MARGIN = 10;
  const { node, rank, showRank, rect, freq, rankDist } = tip;
  // Sorted descending (max rank first) so "4/4: 78%" reads before "3/4: 22%" — the
  // partial-investment ranks are what explain a talent that isn't uniformly maxed.
  const rankRows = rankDist
    ? Object.entries(rankDist)
        .map(([r, pct]) => ({ r: Number(r), pct }))
        .filter(row => row.pct > 0)
        .sort((a, b) => b.r - a.r)
    : [];

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
          <Image src={node.iconUrl} alt="" width={28} height={28} className="w-7 h-7 rounded flex-shrink-0" />
        )}
        <div>
          <div className={`text-sm font-black ${colors.color}`}>{node.name}</div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {node.isTieredApex && (
              <span className="text-[10px] font-bold text-violet-400">Apex Talent</span>
            )}
            {rankRows.length > 0 ? (
              rankRows.map(row => (
                <span
                  key={row.r}
                  className={`text-[10px] font-bold ${
                    row.r === node.maxRanks ? (row.pct >= 70 ? colors.color : 'text-zinc-400') : 'text-zinc-500'
                  }`}
                >
                  {row.r}/{node.maxRanks}: {row.pct}%
                </span>
              ))
            ) : (
              <>
                {showRank && <span className="text-[10px] text-zinc-500">Rank {rank}/{node.maxRanks}</span>}
                {freq != null && (
                  <span className={`text-[10px] font-bold ${
                    freq >= 90 ? 'text-white' : freq >= 70 ? colors.color : 'text-zinc-500'
                  }`}>
                    {freq}% of top players
                  </span>
                )}
              </>
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

function ChoicePopup({
  node,
  rect,
  aChosen,
  choiceFreq,
  colors,
  pinned,
  onClose,
}: {
  node: any;
  rect: DOMRect;
  aChosen: boolean;
  choiceFreq?: { aPct: number; bPct: number };
  colors: { color: string; border: string };
  pinned: boolean;
  onClose: () => void;
}) {
  const POPUP_W = 272;
  const midX = rect.left + rect.width / 2;
  let left = midX - POPUP_W / 2;
  if (left + POPUP_W > window.innerWidth - 8) left = window.innerWidth - POPUP_W - 8;
  if (left < 8) left = 8;

  const choices = [
    {
      name: node.name, iconUrl: node.iconUrl, spellId: node.spellId, isChosen: aChosen,
      pct: choiceFreq?.aPct ?? null, description: node.description,
      castTime: node.castTime, range: node.range, cost: node.cost, cooldown: node.cooldown,
    },
    {
      name: node.choiceB?.name ?? '', iconUrl: node.choiceB?.iconUrl ?? '',
      spellId: node.choiceB?.spellId ?? null, isChosen: !aChosen,
      pct: choiceFreq?.bPct ?? null, description: node.choiceB?.description ?? '',
      castTime: node.choiceB?.castTime ?? '', range: node.choiceB?.range ?? '',
      cost: node.choiceB?.cost ?? '', cooldown: node.choiceB?.cooldown ?? '',
    },
  ];

  return createPortal(
    <>
      {/* Tap/click anywhere outside to dismiss — needed since touch has no hover-out to
          close on. ONLY when pinned: rendered during plain hover, this full-screen layer
          sat on top of the node itself, so the node instantly got a mouseleave (popup
          flicker) and the click meant to pin landed on the overlay instead — pinning was
          unreachable with a mouse and the first click anywhere was silently eaten. */}
      {pinned && <div style={{ position: 'fixed', inset: 0, zIndex: 9996 }} onClick={onClose} />}
      <div
        style={{ position: 'fixed', top: rect.top - 8, left, transform: 'translateY(-100%)', zIndex: 9997, width: POPUP_W }}
        className="bg-zinc-950 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
      >
        {choices.map((c, i) => (
          <div
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              if (c.spellId) window.open(`https://www.wowhead.com/spell=${c.spellId}`, '_blank', 'noopener,noreferrer');
            }}
            className={`px-3 py-2.5 ${i === 0 ? 'border-b border-zinc-800' : ''} ${c.isChosen ? 'bg-zinc-900/50' : ''} ${c.spellId ? 'cursor-pointer active:bg-zinc-800/60' : ''}`}
          >
            <div className="flex items-center gap-2 mb-1">
              <div className={`relative w-8 h-8 rounded-full overflow-hidden border-2 flex-shrink-0 ${c.isChosen ? colors.border : 'border-zinc-700/50'}`}>
                {c.iconUrl
                  ? <Image src={c.iconUrl} alt={c.name} fill className="object-cover" />
                  : <div className="w-full h-full bg-zinc-800" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-xs font-black leading-tight ${c.isChosen ? 'text-white' : 'text-zinc-400'}`}>{c.name}</span>
                  {c.pct !== null && (
                    <span className={`text-[10px] font-black tabular-nums shrink-0 ${c.isChosen ? 'text-white' : 'text-zinc-500'}`}>{c.pct}%</span>
                  )}
                </div>
                {(c.castTime || c.range || c.cooldown || c.cost) && (
                  <div className="flex flex-wrap gap-x-2 mt-0.5">
                    {c.castTime && <span className="text-[9px] text-zinc-500">{c.castTime}</span>}
                    {c.range && <span className="text-[9px] text-zinc-500">{c.range}</span>}
                    {c.cost && <span className="text-[9px] text-zinc-500">{c.cost}</span>}
                    {c.cooldown && <span className="text-[9px] text-zinc-500">{c.cooldown}</span>}
                  </div>
                )}
              </div>
            </div>
            {c.description && (
              <p className="text-[10px] text-zinc-400 leading-relaxed whitespace-pre-line line-clamp-4 pl-10">{c.description}</p>
            )}
          </div>
        ))}
      </div>
    </>,
    document.body
  );
}

export default function NewFeature({
  telemetry,
  layout,
  colors,
  frequencyMap,
  rankDistributionMap,
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
  choiceFreqMap,
  metaTelemetry,
  searchQuery,
}: {
  telemetry: any;
  layout: any[];
  colors: { color: string; border: string; activeBg: string };
  frequencyMap?: Record<number, number>;
  rankDistributionMap?: Record<number, Record<number, number>>;
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
  choiceFreqMap?: Record<number, { aEntryId: number; bEntryId: number; aPct: number; bPct: number }>;
  // Only passed on individual player cards: the meta consensus build, so a talent this
  // player picked that ISN'T part of it can be flagged — same idea as topPlayerTelemetry
  // (which flags the reverse: a top player diverging from the shown consensus tree) but
  // for "this specific player's build has an off-meta pick."
  metaTelemetry?: { event: { talentTree: Array<{ nodeID: number; rank: number }> } } | null;
  // Talent-name search (owned by BossView so one box drives every tree on the page):
  // matching nodes get a sky ring + glow, everything else dims. A matching talent the
  // build DOESN'T take still lights up faintly — "is X in this build?" is answered
  // either way, which is the whole point of searching by name instead of by icon.
  searchQuery?: string;
}) {
  const searchNeedle = (searchQuery ?? '').trim().toLowerCase();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  // pinned = opened via click/tap and stays open until an outside tap or re-click; unpinned = mouse-hover preview
  const [choiceHover, setChoiceHover] = useState<{ node: any; rect: DOMRect; aChosen: boolean; pinned: boolean } | null>(null);
  // Normalizing here (not just upstream) matters specifically for individual player
  // cards, which feed this component a player's raw WCL telemetry directly rather than
  // the already-normalized consensus data — a no-op when the data's already clean.
  const activeNodes = normalizeTalentTree(telemetry?.event?.talentTree || []);
  const activeNodeIds = new Set<number>(activeNodes.map((t: any) => t.nodeID));

  // Nodes where the #1 parser diverges from consensus: they take it but consensus doesn't (or vice versa)
  const topPlayerNodeIds = topPlayerTelemetry
    ? new Set<number>((topPlayerTelemetry?.event?.talentTree || []).map((t: any) => t.nodeID))
    : null;
  const divergentNodeIds = topPlayerNodeIds
    ? new Set<number>([...activeNodeIds, ...topPlayerNodeIds].filter(id => activeNodeIds.has(id) !== topPlayerNodeIds!.has(id)))
    : null;

  // Nodes this specific player (the "active" tree here, on a player card) picked that
  // the meta consensus build doesn't have at all — an off-meta talent choice. Only the
  // player-has-it-but-meta-doesn't direction is flagged (not the reverse, "meta has it
  // but this player skipped it") — mirroring topPlayerTakes' asymmetry above, since
  // "picked something extra" is the noteworthy divergence, not "missing a pick."
  const metaNodeIds = metaTelemetry
    ? new Set<number>(normalizeTalentTree(metaTelemetry?.event?.talentTree || []).map((t: any) => t.nodeID))
    : null;
  const offMetaNodeIds = metaNodeIds
    ? new Set<number>([...activeNodeIds].filter(id => !metaNodeIds!.has(id)))
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

  const heroColMap  = makeColMap(heroSectionNodes);
  const specColMap  = makeColMap(specSectionNodes);

  const heroMaxCol  = heroColMap.size  || 0;
  const specMaxCol  = specColMap.size  || 0;

  // Class nodes whose raw column matches any active hero node column are bridge nodes
  // (e.g. Evoker "Mass Disintegrate" at col 23, same column as Scalecommander hero nodes).
  // Identify where the class column "main cluster" ends (first gap > 5 in sorted columns).
  // This separates genuine outlier bridge nodes (like Evoker's Mass Disintegrate at col 23,
  // gap of 16) from gateway nodes that sit just outside the main class range (like Mistweaver's
  // col-10 gateway, gap of only 3). Only nodes strictly beyond classClusterMax are treated as
  // true bridge nodes that need to be repositioned into the hero section area.
  const sortedClassCols = [...new Set(classSectionNodes.map((n: any) => n.column as number))].sort((a, b) => a - b);
  let classClusterMax = sortedClassCols.at(-1) ?? 0;
  for (let i = 1; i < sortedClassCols.length; i++) {
    if (sortedClassCols[i] - sortedClassCols[i - 1] > 5) { classClusterMax = sortedClassCols[i - 1]; break; }
  }

  // Stored by nodeID to avoid any column-type ambiguity in later lookups.
  const heroColValues = heroSectionNodes.map((n: any) => n.column);
  const bridgeClassNodeIds = new Set<number>(
    classSectionNodes
      .filter((n: any) => heroColValues.includes(n.column) && (n.column as number) > classClusterMax)
      .map((n: any) => n.nodeID as number)
  );

  // Full set of columns used by ANY hero tree (including inactive ones).
  // Used to suppress class nodes that are bridges for a different hero tree than the active one.
  const allHeroColSet = new Set(
    layout.filter((n: any) => n.section === 'hero').map((n: any) => n.column)
  );

  // Outlier class nodes (any class node at a column beyond classClusterMax that overlaps any hero
  // tree column) are repositioned into the hero section area when their tree is active, or
  // suppressed when inactive. Either way their column must not inflate classMaxCol and heroOffset.
  const classColMap = makeColMap(
    classSectionNodes.filter((n: any) => !(allHeroColSet.has(n.column) && (n.column as number) > classClusterMax))
  );
  const classMaxCol = classColMap.size || 0;

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
  // A class node is a true outlier only if it sits strictly beyond the main cluster max.
  // classClusterMax is already computed above alongside bridgeClassNodeIds.
  const hasOutlierClassCol = classSectionNodes.some((n: any) => allHeroColSet.has(n.column) && (n.column as number) > classClusterMax);
  const classRowOffset = hasOutlierClassCol ? (classMinRow - 1) : 0;
  // When the class tree has a row gap (classRowOffset > 0) but no bridge class node is visible
  // (e.g. Flameshaper view), hero nodes would start one row higher than in bridge views — apply +1
  // to compensate. Also apply +1 when a bridge exists at the *same raw row* as the first hero node
  // (Augmentation Scalecommander: bridge and hero gateway share row 2), because in that case the
  // bridge occupies the hero start row rather than the row above it.
  const heroBridgeAdjust = (hasPortrait && classRowOffset > 0 &&
    (bridgeClassNodeIds.size === 0 || classMinRow === heroMinRow)) ? 1 : 0;
  const heroRowShiftRaw = hasPortrait
    ? heroMinRow - Math.max(3, (classSortedRows[1] ?? classMinRow + 1) + 1) + heroBridgeAdjust
    : Math.max(0, heroMinRow - classMinRow - 2);
  // Clamp shift so first hero node never lands above grid row 4 (inside the portrait area).
  // firstHeroGrid = (heroMinRow - classRowOffset) - heroRowShift + 1, must be >= 4.
  const heroRowShift = hasPortrait
    ? Math.min(heroRowShiftRaw, heroMinRow - classRowOffset - 3)
    : heroRowShiftRaw;

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
      // Bridge nodes: true outlier class nodes whose column is beyond the main cluster AND
      // overlaps active hero tree columns. Reposition them into the hero section area.
      if (heroMaxCol > 0 && heroColMap.has(raw) && raw > classClusterMax) {
        // Only center bridge nodes in single-tree view — multi-tree view puts each at its actual column
        const col = effectiveHeroTreeIds.size === 1 ? heroCenterCol : (heroColMap.get(raw) ?? heroCenterCol);
        return heroOffset + col;
      }
      return classColMap.get(raw) ?? 1;
    }
    if (node.section === 'hero') {
      // Gateway centering only applies in single-tree view; multi-tree view uses natural columns
      const isGateway = heroGatewayIds.has(node.nodeID) && effectiveHeroTreeIds.size === 1;
      const col = isGateway ? heroCenterCol : (heroColMap.get(node.column) ?? 1);
      return heroOffset + col;
    }
    return specOffset + (specColMap.get(node.column) ?? 1);
  }

  // Gateway nodes in even-column hero sections span 2 columns so the icon floats
  // in the gap between the two center nodes of each regular row.
  function getColSpan(node: any): number {
    if (hasSections && !heroOnly && node.section === 'hero' && heroGatewayIds.has(node.nodeID) && heroMaxCol % 2 === 0 && effectiveHeroTreeIds.size === 1) {
      return 2;
    }
    return 1;
  }

  const handleMouseEnter = useCallback((e: React.MouseEvent, node: any, rank: number, showRank: boolean, freq?: number) => {
    if (!node.name) return;
    const target = e.currentTarget as HTMLElement | null;
    // Suspense can replay a queued hover event after its target has already been
    // unmounted (e.g. a hero-tree variant swap mid-hover) — currentTarget is null then.
    if (!target) return;
    const rect = target.getBoundingClientRect();
    // For multi-rank nodes, the sample's rank split is more useful than "X% took it at
    // all" — e.g. distinguishing "78% went 4/4" from "22% stopped at 3/4" (often because
    // those points went to a different talent entirely) is exactly what a flat presence
    // percentage can't show.
    const rankDist = node.maxRanks > 1 ? rankDistributionMap?.[node.nodeID] : undefined;
    setTooltip({ node, rank, showRank, rect, freq, rankDist });
  }, [rankDistributionMap]);

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
              <Image
                src={heroTreeImageUrl}
                alt={heroTreeName ?? ''}
                width={72}
                height={72}
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
                      ? <Image src={ht.imageUrl} alt={ht.name} width={64} height={64} className={`w-16 h-16 rounded-full object-cover ring-1 ring-zinc-600 ${onHeroTreeClick ? 'group-hover:ring-2 group-hover:ring-zinc-400 transition-all' : ''}`} />
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

          // Suppress true outlier class nodes that belong to a different hero tree than the active one.
          // e.g. Evoker "Mass Disintegrate" at col 23 is a Scalecommander bridge; hide it in Flameshaper view.
          // Only applies to nodes beyond classClusterMax — boundary gateway nodes are never orphan bridges.
          const isOrphanBridge = node.section === 'class' &&
            (node.column as number) > classClusterMax &&
            allHeroColSet.has(node.column) &&
            !bridgeClassNodeIds.has(node.nodeID);
          if (isOrphanBridge) return null;

          const isClassBridge = hasSections && !heroOnly && heroMaxCol > 0 &&
            node.section === 'class' && mappedColumn > heroOffset;
          // Bridge class nodes get span 2 (same as gateway nodes) only in single-tree view
          const colSpan = isClassBridge && heroMaxCol % 2 === 0 && effectiveHeroTreeIds.size === 1 ? 2 : getColSpan(node);
          // For a multi-rank node, "took it at all" (frequencyMap) reads ~100% even when
          // the sample is split across ranks — e.g. Benediction stuck at "100%" whether
          // everyone goes 4/4 or a chunk stops at 3/4 for Eternal Sanctity. Showing what
          // share actually matches the rank on screen (rankDistributionMap) surfaces that
          // split on the tile itself, no hover required — 78% instead of 100% is visible
          // at a glance as "not everyone agrees here."
          const rankFreq = node.maxRanks > 1 && isActive ? rankDistributionMap?.[node.nodeID]?.[rank] : undefined;
          const freq = rankFreq ?? frequencyMap?.[node.nodeID];
          // On an individual player card, a partially-invested apex node still renders at
          // full icon opacity like a maxed one — the small rank badge was the only
          // difference, easy to miss ("looks like he took all 4"). Flagging it amber
          // instead of violet makes "this player stopped short of max" visible at a glance.
          const isPartialApex = node.isTieredApex && isActive && rank < node.maxRanks;
          const isDivergent = divergentNodeIds?.has(node.nodeID) ?? false;
          // true = top player takes this but consensus doesn't; false = consensus takes it but top player skips
          const topPlayerTakes = isDivergent && (topPlayerNodeIds?.has(node.nodeID) ?? false);
          const isOffMeta = isActive && (offMetaNodeIds?.has(node.nodeID) ?? false);
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

          const isChoiceNode = node.isChoice && node.choiceB != null;

          // Either option of a choice node counts — the searcher may be looking for the
          // one this build didn't pick.
          const isSearchHit = searchNeedle.length > 0 && (
            (node.name ?? '').toLowerCase().includes(searchNeedle)
            || (node.choiceB?.name ?? '').toLowerCase().includes(searchNeedle)
          );
          const isSearchMiss = searchNeedle.length > 0 && !isSearchHit;

          return (
            <div
              key={node.nodeID}
              style={{
                gridRow: mappedRow,
                gridColumn: colSpan > 1 ? `${mappedColumn} / span ${colSpan}` : mappedColumn,
              }}
              className={`relative transition-opacity ${colSpan > 1 ? 'flex justify-center' : ''} ${isSearchMiss ? 'opacity-20' : ''}`}
              onMouseEnter={(e) => {
                if (isChoiceNode) {
                  const target = e.currentTarget as HTMLElement | null;
                  if (!target) return;
                  setChoiceHover(prev =>
                    prev?.pinned && prev.node.nodeID === node.nodeID
                      ? prev
                      : { node, rect: target.getBoundingClientRect(), aChosen: !chosenIsB, pinned: false }
                  );
                } else {
                  handleMouseEnter(e, displayNode, rank, showRank, freq);
                }
              }}
              onMouseLeave={() => {
                if (isChoiceNode) {
                  setChoiceHover(prev => (prev && prev.node.nodeID === node.nodeID && !prev.pinned) ? null : prev);
                } else {
                  handleMouseLeave();
                }
              }}
              onClick={(e) => {
                if (!isChoiceNode) return;
                const target = e.currentTarget as HTMLElement | null;
                if (!target) return;
                setChoiceHover(prev =>
                  prev && prev.node.nodeID === node.nodeID
                    ? null
                    : { node, rect: target.getBoundingClientRect(), aChosen: !chosenIsB, pinned: true }
                );
              }}
              role={isChoiceNode || displayNode.spellId ? 'button' : undefined}
              tabIndex={isChoiceNode || displayNode.spellId ? 0 : undefined}
              aria-label={displayNode.name}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                if (isChoiceNode) {
                  const target = e.currentTarget as HTMLElement | null;
                  if (!target) return;
                  setChoiceHover(prev =>
                    prev && prev.node.nodeID === node.nodeID
                      ? null
                      : { node, rect: target.getBoundingClientRect(), aChosen: !chosenIsB, pinned: true }
                  );
                } else if (displayNode.spellId) {
                  window.open(`https://www.wowhead.com/spell=${displayNode.spellId}`, '_blank', 'noopener,noreferrer');
                }
              }}
            >
              <div
                className={`w-10 h-10 rounded-full border-2 overflow-hidden transition-all relative ${
                  isChoiceNode || displayNode.spellId ? 'cursor-pointer' : 'cursor-default'
                } ${(topPlayerTakes || isOffMeta) ? 'border-amber-400 shadow-[0_0_6px_1px_rgba(251,191,36,0.5)]' : isActive ? colors.border : 'border-zinc-700/20'} ${
                  // Search hits take the ring slot outright — finding the talent you typed
                  // beats the apex marker while a search is active. Otherwise: tiered/apex
                  // nodes (e.g. Tigereye Brew, Benediction) are multiple separate underlying
                  // picks sharing one icon — a violet ring marks that at a glance,
                  // independent of the border color's existing active/divergent meaning.
                  isSearchHit
                    ? 'ring-2 ring-sky-400 shadow-[0_0_10px_2px_rgba(56,189,248,0.55)]'
                    : node.isTieredApex ? 'ring-2 ring-violet-400/70' : ''
                }`}
                onClick={() => { if (!isChoiceNode && displayNode.spellId) window.open(`https://www.wowhead.com/spell=${displayNode.spellId}`, '_blank', 'noopener,noreferrer'); }}
              >
                {displayNode.iconUrl ? (
                  <Image
                    src={displayNode.iconUrl}
                    alt={displayNode.name}
                    fill
                    className="object-cover"
                    style={{ opacity: isActive ? 1 : isSearchHit ? 0.55 : 0.15 }}
                  />
                ) : (
                  <div className={`w-full h-full ${isActive ? colors.activeBg : 'bg-zinc-900/50'}`} />
                )}
                {isChoiceNode && (
                  <>
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 text-amber-300 font-black leading-none pointer-events-none select-none" style={{ fontSize: 18, textShadow: '0 0 8px rgba(251,191,36,0.95), 0 0 4px rgba(251,191,36,0.7), 0 0 2px #000' }}>‹</span>
                    <span className="absolute right-0 top-1/2 -translate-y-1/2 text-amber-300 font-black leading-none pointer-events-none select-none" style={{ fontSize: 18, textShadow: '0 0 8px rgba(251,191,36,0.95), 0 0 4px rgba(251,191,36,0.7), 0 0 2px #000' }}>›</span>
                  </>
                )}
                {freq != null && freq > 0 && node.section !== 'hero' && (
                  <div className="absolute bottom-0 inset-x-0 bg-black/75 flex items-center justify-center py-0.5">
                    <span className={`text-[8px] font-bold tabular-nums leading-none ${isActive ? 'text-white' : 'text-zinc-400'}`}>{freq}%</span>
                  </div>
                )}
              </div>
              {showRank && (
                // Sibling of the icon circle, not a child of it — the circle's
                // overflow-hidden (needed to clip the icon image/freq band to the round
                // shape) was also clipping this badge wherever it poked past the circle's
                // edge, cutting the text off. Positioning it here, against the outer
                // (non-clipping) grid cell, keeps the full badge visible.
                <div className={`absolute -top-1.5 -right-1.5 h-[18px] px-1.5 rounded-full flex items-center justify-center border-2 z-10 whitespace-nowrap ${
                  isPartialApex
                    ? 'bg-amber-500 border-amber-300 shadow-[0_0_5px_1px_rgba(251,191,36,0.7)]'
                    : node.isTieredApex ? 'bg-violet-500 border-violet-300' : 'bg-zinc-800 border-zinc-600'
                }`}>
                  <span className="text-[11px] font-black tabular-nums leading-none text-white">{rank}/{node.maxRanks}</span>
                </div>
              )}
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

      {offMetaNodeIds && renderNodes.some(n => offMetaNodeIds.has(n.nodeID) && activeNodeIds.has(n.nodeID)) && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[9px] text-zinc-500">
          <span className="w-3.5 h-3.5 rounded-full border-2 border-amber-400 flex-shrink-0" />
          <span>This player's build includes a talent not in the meta consensus</span>
        </div>
      )}

      {renderNodes.some((n: any) => n.isTieredApex) && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[9px] text-zinc-500">
          <span className="w-3.5 h-3.5 rounded-full ring-2 ring-violet-400/70 flex-shrink-0" />
          <span>Apex Talent — some top players take fewer points here to invest elsewhere</span>
        </div>
      )}

      {choiceHover && (
        <ChoicePopup
          node={choiceHover.node}
          rect={choiceHover.rect}
          aChosen={choiceHover.aChosen}
          choiceFreq={choiceFreqMap?.[choiceHover.node.nodeID]}
          colors={colors}
          pinned={choiceHover.pinned}
          onClose={() => setChoiceHover(null)}
        />
      )}
      {tooltip && <Tooltip tip={tooltip} colors={colors} />}
    </>
  );
}
