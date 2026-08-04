'use client';
import React, { useState, useEffect, useRef, use, Suspense } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import NewFeature from './NewFeature';
import CopyBuildButton from './CopyBuildButton';
import PlayerCard from './PlayerCard';
import type { GearPhaseResult } from '../app/BossContent';
import { loadMorePlayers } from '../app/actions/loadMorePlayers';

function hexFromTwColor(twColor: string): string {
  const m = twColor.match(/#[0-9A-Fa-f]{6}/);
  return m ? m[0] : '#888888';
}

export interface HeroVariant {
  id: number | null;
  name: string;
  imageUrl?: string;
  count: number;
  totalPlayers: number;
  consensus: {
    telemetry: { event: { talentTree: Array<{ nodeID: number; rank: number }> } };
    talentString: string | null;
    frequencyPct: Record<number, number>;
    rankDistribution?: Record<number, Record<number, number>>;
    entryIds?: Record<number, number>;
    choiceFreq?: Record<number, { aEntryId: number; bEntryId: number; aPct: number; bPct: number }>;
  } | null;
  gear: {
    trinkets: Array<{ name: string; count: number; pct: number; avgIlvl: number; itemId: number; iconUrl: string; description: string }>;
    stats: { haste: number; crit: number; mastery: number; versatility: number } | null;
    enchants?: Array<{ slot: string; name: string; count: number; pct: number; description?: string }>;
    gems?: Array<{ name: string; count: number; pct: number; itemId: number; iconUrl: string; description?: string }>;
    consumables?: Array<{ name: string; type: string; count: number; pct: number; iconUrl: string }>;
    embellishments?: Array<{ name: string; count: number; pct: number; itemId: number; iconUrl: string; description: string }>;
    avgItemLevel?: number | null;
    playerCount: number;
    gearBySlot?: Record<string, Array<{ name: string; count: number; pct: number; itemId: number; quality: string; iconUrl: string; description: string; avgIlvl: number }>>;
    trinketSynergy?: { names: [string, string]; count: number; pct: number } | null;
    ringSynergy?: { names: [string, string]; count: number; pct: number } | null;
  } | null;
  players: any[];
  hasData?: boolean;
  avgDps?: number | null;
  topDps?: number | null;
  avgPct?: number | null;
  avgScore?: number | null;
  topScore?: number | null;
}

interface ItemTip {
  name: string;
  subtitle?: string;
  iconUrl: string;
  description?: string;
  count: number;
  pct: number;
  playerCount: number;
  rect: DOMRect;
}

function ItemTooltip({ tip, accentHex }: { tip: ItemTip; accentHex: string }) {
  const TOOLTIP_W = 280;
  const MARGIN = 10;
  let left = tip.rect.left;
  if (left + TOOLTIP_W > window.innerWidth - MARGIN) left = tip.rect.right - TOOLTIP_W;
  if (left < MARGIN) left = MARGIN;
  const above = tip.rect.top > 160;
  const top = above ? tip.rect.top - 8 : tip.rect.bottom + 8;
  return createPortal(
    <div
      style={{ position: 'fixed', top, left, width: TOOLTIP_W, transform: above ? 'translateY(-100%)' : 'none', zIndex: 9999 }}
      className="bg-zinc-950 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden pointer-events-none"
    >
      <div className="px-3 py-2.5 border-b border-zinc-800 flex items-center gap-2.5">
        {tip.iconUrl && <Image src={tip.iconUrl} alt="" width={48} height={48} className="w-12 h-12 rounded flex-shrink-0 border border-zinc-700" />}
        <div>
          <div className="text-sm font-black text-white leading-tight">{tip.name}</div>
          {tip.subtitle && <div className="text-[10px] text-zinc-500 mt-0.5 uppercase tracking-wide">{tip.subtitle}</div>}
          <div className="text-xs mt-0.5 font-bold tabular-nums" style={{ color: accentHex }}>
            {tip.count}/{tip.playerCount} players · {tip.pct}%
          </div>
        </div>
      </div>
      {tip.description && (
        <p className="px-3 py-2.5 text-[11px] text-zinc-300 leading-relaxed whitespace-pre-line">{tip.description}</p>
      )}
    </div>,
    document.body
  );
}

function GearSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-52 bg-zinc-900/40 border border-zinc-800/50 rounded-2xl" />
      <div className="h-72 bg-zinc-900/40 border border-zinc-800/50 rounded-2xl" />
      <div className="h-48 bg-zinc-900/40 border border-zinc-800/50 rounded-2xl" />
    </div>
  );
}

function GearSection({
  gearPromise,
  activeIdx,
  variants,
  accentHex,
  colors,
  layout,
  wowClass,
  spec,
  wclUrl,
  metric,
  onReady,
  additionalPlayers,
  canLoadMore,
  loadMorePoolSize,
  loadingMore,
  onLoadMore,
}: {
  gearPromise: Promise<GearPhaseResult>;
  activeIdx: number;
  variants: HeroVariant[];
  accentHex: string;
  colors: { color: string; border: string; activeBg: string };
  layout: any[];
  wowClass?: string;
  spec: string;
  wclUrl?: string;
  metric: string;
  onReady: () => void;
  additionalPlayers: any[];
  canLoadMore: boolean;
  loadMorePoolSize?: number;
  loadingMore: boolean;
  onLoadMore: (alreadyShown: number) => void;
}) {
  const { variantGear, variantPlayers } = use(gearPromise);
  const [activeTip, setActiveTip] = useState<ItemTip | null>(null);

  // Signal to BossView that gear sections are now in the DOM so IntersectionObservers can re-attach
  useEffect(() => { onReady(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const safeIdx = Math.min(activeIdx, variants.length - 1);
  const active = variants[safeIdx];
  const gear = variantGear[safeIdx] ?? null;
  // additionalPlayers only ever applies to the Overall variant (see canLoadMore in the
  // parent) — appended here rather than in variantPlayers itself, since that array is
  // frozen inside the already-resolved gearPromise.
  const basePlayers: any[] = variantPlayers[safeIdx] ?? [];
  const players: any[] = active.id === null ? [...basePlayers, ...additionalPlayers] : basePlayers;
  const gearHasContent = gear && (gear.trinkets.length > 0 || gear.stats != null);

  const SLOT_LABELS: Record<string, string> = {
    HEAD: 'Head', NECK: 'Neck', SHOULDER: 'Shoulders', BACK: 'Back',
    CHEST: 'Chest', WRIST: 'Wrists', HANDS: 'Hands', WAIST: 'Waist',
    LEGS: 'Legs', FEET: 'Feet', FINGER: 'Rings', MAIN_HAND: 'Weapon', OFF_HAND: 'Off-hand',
  };
  const SLOT_ORDER = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER', 'MAIN_HAND', 'OFF_HAND'];
  const QUALITY_COLOR: Record<string, string> = {
    LEGENDARY: '#FF8000', EPIC: '#A335EE', RARE: '#0070DD', UNCOMMON: '#1EFF00', COMMON: '#9d9d9d',
  };

  return (
    <>
      {/* ── Meta Trinkets ── */}
      {gearHasContent && (() => {
        const statRows = gear!.stats ? [
          { label: 'Haste', value: gear!.stats.haste },
          { label: 'Crit Strike', value: gear!.stats.crit },
          { label: 'Mastery', value: gear!.stats.mastery },
          { label: 'Versatility', value: gear!.stats.versatility },
        ] : [];
        const maxStat = statRows.length > 0 ? Math.max(...statRows.map(s => s.value)) : 1;
        return (
          <section id="meta-trinkets" style={{ scrollMarginTop: '3rem' }}>
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-base font-black text-white tracking-tight">Meta Trinkets</h2>
              <p className="text-sm text-zinc-500">
                · {active.totalPlayers} top {active.id !== null ? `${active.name} ` : ''}parses
                {gear!.playerCount < active.totalPlayers && (
                  <span className="text-zinc-600"> · {gear!.playerCount} with gear data</span>
                )}
              </p>
            </div>
            <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl p-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Left: Trinkets + Embellishments */}
                <div className="space-y-6">
                  {gear!.trinketSynergy && (
                    <div className="flex items-start gap-2.5 bg-amber-500/5 border border-amber-500/20 rounded-xl px-3.5 py-3">
                      <span className="text-amber-400 text-sm mt-0.5">⚡</span>
                      <div>
                        <p className="text-xs font-black text-amber-400 uppercase tracking-widest mb-0.5">Synergy Pair · {gear!.trinketSynergy.pct}% of players</p>
                        <p className="text-sm text-zinc-300">{gear!.trinketSynergy.names[0]} <span className="text-zinc-600">+</span> {gear!.trinketSynergy.names[1]}</p>
                      </div>
                    </div>
                  )}
                  {gear!.trinkets.length > 0 && (
                    <div>
                      <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold mb-3">Top Trinkets</p>
                      <div className="space-y-3">
                        {gear!.trinkets.map((t, i) => (
                          <div key={i} className="flex items-center gap-2.5 cursor-pointer group"
                            onClick={() => t.itemId && window.open(`https://www.wowhead.com/item=${t.itemId}`, '_blank', 'noopener,noreferrer')}
                            onMouseEnter={(e) => {
                              const target = e.currentTarget as HTMLElement | null;
                              if (!target) return;
                              setActiveTip({ name: t.name, iconUrl: t.iconUrl, description: t.description, count: t.count, pct: t.pct, playerCount: gear!.playerCount, rect: target.getBoundingClientRect() });
                            }}
                            onMouseLeave={() => setActiveTip(null)}
                          >
                            {t.iconUrl ? <Image src={t.iconUrl} alt="" width={32} height={32} className="w-8 h-8 rounded flex-shrink-0 border border-zinc-700 group-hover:border-zinc-500 transition-colors" /> : <div className="w-8 h-8 rounded flex-shrink-0 bg-zinc-800 border border-zinc-700" />}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-2 min-w-0 pr-2">
                                  <span className="text-sm text-zinc-200 truncate group-hover:text-white transition-colors">{t.name}</span>
                                  {t.avgIlvl > 0 && <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">i{t.avgIlvl}</span>}
                                </div>
                                <span className="text-sm font-bold tabular-nums shrink-0" style={{ color: t.pct >= 75 ? accentHex : '#71717a' }}>{t.count}/{gear!.playerCount}</span>
                              </div>
                              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all" style={{ width: `${t.pct}%`, backgroundColor: accentHex + '66' }} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {gear!.embellishments && gear!.embellishments.length > 0 && (
                    <div>
                      <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold mb-3">Embellishments</p>
                      <div className="space-y-3">
                        {gear!.embellishments.map((e, i) => (
                          <div key={i} className="flex items-center gap-2.5 cursor-pointer group"
                            onClick={() => e.itemId && window.open(`https://www.wowhead.com/item=${e.itemId}`, '_blank', 'noopener,noreferrer')}
                            onMouseEnter={(ev) => {
                              const target = ev.currentTarget as HTMLElement | null;
                              if (!target) return;
                              setActiveTip({ name: e.name, iconUrl: e.iconUrl, description: e.description, count: e.count, pct: e.pct, playerCount: gear!.playerCount, rect: target.getBoundingClientRect() });
                            }}
                            onMouseLeave={() => setActiveTip(null)}
                          >
                            {e.iconUrl ? <Image src={e.iconUrl} alt="" width={32} height={32} className="w-8 h-8 rounded flex-shrink-0 border border-zinc-700 group-hover:border-zinc-500 transition-colors" /> : <div className="w-8 h-8 rounded flex-shrink-0 bg-zinc-800 border border-zinc-700" />}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-sm text-zinc-200 truncate group-hover:text-white transition-colors">{e.name}</span>
                                <span className="text-sm font-bold tabular-nums shrink-0" style={{ color: e.pct >= 75 ? accentHex : '#71717a' }}>{e.count}/{gear!.playerCount}</span>
                              </div>
                              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all" style={{ width: `${e.pct}%`, backgroundColor: accentHex + '66' }} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {/* Right: Stat Priority */}
                <div className="space-y-6">
                  {gear!.stats && (
                    <div>
                      <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold mb-3">Stat Priority</p>
                      <div className="space-y-3">
                        {statRows.map(({ label, value }) => (
                          <div key={label}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm text-zinc-400">{label}</span>
                              <span className="text-sm font-bold tabular-nums" style={{ color: value === maxStat ? accentHex : '#71717a' }}>{value}%</span>
                            </div>
                            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                              <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(value / maxStat * 100)}%`, backgroundColor: value === maxStat ? accentHex + '80' : '#3f3f46' }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        );
      })()}

      {/* ── Meta Gear (by Slot) ── */}
      {(() => {
        const gearBySlot = gear?.gearBySlot;
        if (!gearBySlot || Object.keys(gearBySlot).length === 0) return null;
        const slots = SLOT_ORDER.filter(s => gearBySlot[s]?.length > 0);
        if (slots.length === 0) return null;
        const playerCount = gear!.playerCount;
        return (
          <section id="meta-gear" style={{ scrollMarginTop: '3rem' }}>
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-base font-black text-white tracking-tight">Meta Gear</h2>
              <p className="text-sm text-zinc-500">
                · {active.totalPlayers} top {active.id !== null ? `${active.name} ` : ''}parses
                {gear!.playerCount < active.totalPlayers && (
                  <span className="text-zinc-600"> · {gear!.playerCount} with gear data</span>
                )}
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {slots.map(slotKey => {
                const items = gearBySlot[slotKey];
                const maxCount = items[0]?.count ?? 1;
                const isRings = slotKey === 'FINGER';
                return (
                  <div key={slotKey} className="bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-4">
                    <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-3">{SLOT_LABELS[slotKey] ?? slotKey}</p>
                    {isRings && gear?.ringSynergy && (
                      <div className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/20 rounded-lg px-2.5 py-2 mb-3">
                        <span className="text-amber-400 text-xs mt-px">⚡</span>
                        <div>
                          <p className="text-[10px] font-black text-amber-400 uppercase tracking-widest mb-0.5">Pair · {gear.ringSynergy.pct}% of players</p>
                          <p className="text-xs text-zinc-300">{gear.ringSynergy.names[0]} <span className="text-zinc-600">+</span> {gear.ringSynergy.names[1]}</p>
                        </div>
                      </div>
                    )}
                    <div className="space-y-2.5">
                      {items.map((item, i) => {
                        const qualityColor = QUALITY_COLOR[item.quality] ?? '#9d9d9d';
                        return (
                          <div key={i} className="flex items-center gap-2 cursor-pointer group"
                            onClick={() => item.itemId && window.open(`https://www.wowhead.com/item=${item.itemId}`, '_blank', 'noopener,noreferrer')}
                            onMouseEnter={(ev) => {
                              const target = ev.currentTarget as HTMLElement | null;
                              if (!target) return;
                              setActiveTip({ name: item.name, subtitle: item.avgIlvl ? `ilvl ${item.avgIlvl}` : undefined, iconUrl: item.iconUrl, description: item.description, count: item.count, pct: item.pct, playerCount, rect: target.getBoundingClientRect() });
                            }}
                            onMouseLeave={() => setActiveTip(null)}
                          >
                            {item.iconUrl ? <Image src={item.iconUrl} alt="" width={28} height={28} className="w-7 h-7 rounded flex-shrink-0 border border-zinc-700/60" /> : <div className="w-7 h-7 rounded flex-shrink-0 bg-zinc-800 border border-zinc-700/60" />}
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold leading-tight truncate group-hover:text-white transition-colors" style={{ color: qualityColor }}>{item.name}</p>
                              <div className="mt-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${Math.round((item.count / maxCount) * 100)}%`, backgroundColor: qualityColor, opacity: 0.7 }} />
                              </div>
                            </div>
                            <div className="flex flex-col items-end shrink-0 gap-0.5">
                              <span className="text-xs font-bold tabular-nums text-zinc-500">{item.count}/{playerCount}</span>
                              {item.avgIlvl > 0 && <span className="text-[10px] tabular-nums text-zinc-600">ilvl {item.avgIlvl}</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Gems + Enchants + Consumables below gear grid */}
            {gear && (gear.gems?.length || gear.enchants?.length || gear.consumables?.length) ? (
              <div className="mt-4 bg-zinc-900/40 border border-zinc-800/50 rounded-2xl p-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-6">
                    {gear.gems && gear.gems.length > 0 && (
                      <div>
                        <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold mb-3">Top Gems</p>
                        <div className="space-y-2">
                          {gear.gems.map((g, i) => (
                            <div key={i} className="flex items-center gap-2 cursor-default"
                              onMouseEnter={(ev) => {
                                const target = ev.currentTarget as HTMLElement | null;
                                if (!target) return;
                                setActiveTip({ name: g.name, iconUrl: g.iconUrl, description: g.description, count: g.count, pct: g.pct, playerCount, rect: target.getBoundingClientRect() });
                              }}
                              onMouseLeave={() => setActiveTip(null)}
                            >
                              {g.iconUrl ? <Image src={g.iconUrl} alt="" width={20} height={20} className="w-5 h-5 rounded flex-shrink-0 border border-zinc-700" /> : <div className="w-5 h-5 rounded flex-shrink-0 bg-zinc-800 border border-zinc-700" />}
                              <span className="text-sm text-zinc-300 truncate flex-1">{g.name}</span>
                              <span className="text-xs font-bold tabular-nums shrink-0" style={{ color: g.pct >= 75 ? accentHex : '#71717a' }}>{g.pct}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {gear.consumables && gear.consumables.length > 0 && (
                      <div>
                        <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold mb-3">Consumables</p>
                        <div className="space-y-2">
                          {gear.consumables.map((c, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 shrink-0">{c.type === 'flask' ? 'Flask' : c.type === 'food' ? 'Food' : 'Rune'}</span>
                              <span className="text-sm text-zinc-300 truncate flex-1">{c.name}</span>
                              <span className="text-xs font-bold tabular-nums shrink-0" style={{ color: c.pct >= 75 ? accentHex : '#71717a' }}>{c.pct}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-6">
                    {gear.enchants && gear.enchants.length > 0 && (
                      <div>
                        <p className="text-xs text-zinc-500 uppercase tracking-widest font-bold mb-3">Top Enchants</p>
                        <div className="space-y-2">
                          {gear.enchants.map((e, i) => {
                            const shortName = e.name.replace(/^enchant\s+\S+\s+-\s+/i, '').trim() || e.name;
                            return (
                              <div key={i} className="flex items-center justify-between gap-2"
                                onMouseEnter={(ev) => {
                                  const target = ev.currentTarget as HTMLElement | null;
                                  if (!target) return;
                                  setActiveTip({ name: shortName, subtitle: e.slot, iconUrl: '', description: e.description || e.name, count: e.count, pct: e.pct, playerCount, rect: target.getBoundingClientRect() });
                                }}
                                onMouseLeave={() => setActiveTip(null)}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 shrink-0">{e.slot}</span>
                                  <span className="text-sm text-zinc-300 truncate underline decoration-dotted decoration-zinc-600 underline-offset-2">{shortName}</span>
                                </div>
                                <span className="text-xs font-bold tabular-nums shrink-0" style={{ color: e.pct >= 75 ? accentHex : '#71717a' }}>{e.pct}%</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        );
      })()}

      {/* ── Top Players ── */}
      {players.length > 0 && (
        <section id="top-players" style={{ scrollMarginTop: '3rem' }}>
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-black text-white tracking-tight">Top Players</h2>
              <p className="text-sm text-zinc-500 mt-0.5">
                {active.id !== null
                  ? `Players using ${active.name}`
                  : 'Best parses across all hero paths'}
              </p>
            </div>
            {wclUrl && (
              <a
                href={wclUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors shrink-0 mt-0.5 flex items-center gap-1"
              >
                View on WarcraftLogs →
              </a>
            )}
          </div>
          <div className="space-y-4">
            {players.map((player: any, idx: number) => (
              <PlayerCard
                key={`${active.id ?? 'all'}-${idx}`}
                player={player}
                layout={layout}
                colors={colors}
                idx={idx}
                wowClass={wowClass}
                specName={spec}
                metric={metric}
                metaTelemetry={active.consensus?.telemetry}
                heroTrees={variants
                  .filter(v => v.id !== null)
                  .map(v => ({ id: v.id!, name: v.name, imageUrl: v.imageUrl }))}
              />
            ))}
          </div>
          {canLoadMore && loadMorePoolSize != null && players.length < loadMorePoolSize && (
            <div className="flex justify-center mt-4">
              <button
                onClick={() => onLoadMore(players.length)}
                disabled={loadingMore}
                className="text-xs font-bold text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-600 rounded-full px-4 py-2 transition-colors disabled:opacity-50 disabled:cursor-wait"
              >
                {loadingMore ? 'Loading…' : `Load 5 more (${players.length}/${loadMorePoolSize})`}
              </button>
            </div>
          )}
        </section>
      )}

      {activeTip && <ItemTooltip tip={activeTip} accentHex={accentHex} />}
    </>
  );
}

export default function BossView({
  variants,
  gearPromise,
  layout,
  colors,
  difficulty,
  spec,
  totalParses,
  dataFetchedAt,
  wclUrl,
  wowClass,
  metric = 'dps',
  bossId,
  region,
  loadMorePoolSize,
}: {
  variants: HeroVariant[];
  gearPromise?: Promise<GearPhaseResult>;
  layout: any[];
  colors: { color: string; border: string; activeBg: string };
  difficulty: number;
  spec: string;
  totalParses?: number;
  dataFetchedAt?: number;
  wclUrl?: string;
  wowClass?: string;
  metric?: string;
  // Only present for the full-consensus render path (gearPromise) — "Load more
  // players" needs the same boss/spec/difficulty/region identity the initial fetch
  // used, plus the size of the pool it can still draw from (CONSENSUS_N: everyone
  // already has WCL telemetry fetched, just not Blizzard profile/portrait yet).
  bossId?: number;
  region?: string;
  loadMorePoolSize?: number;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [fading, setFading] = useState(false);
  const [activeSection, setActiveSection] = useState('meta-build');
  const [pillsVisible, setPillsVisible] = useState(true);
  const [gearReady, setGearReady] = useState(false);
  const pillsRef = useRef<HTMLDivElement>(null);
  // Only meaningful for the "Overall" (id === null) variant — hero-tree-specific
  // variants pull from a differently-filtered player pool the on-demand action
  // doesn't know how to reproduce, so their player list stays fixed at the initial
  // batch. Reset whenever the active variant changes so switching tabs doesn't carry
  // over another variant's extra-loaded players.
  const [additionalPlayers, setAdditionalPlayers] = useState<any[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const switchVariant = (idx: number) => {
    if (idx === activeIdx) return;
    setAdditionalPlayers([]);
    setFading(true);
    setTimeout(() => { setActiveIdx(idx); setFading(false); }, 120);
  };

  const safeIdx = Math.min(activeIdx, Math.max(variants.length - 1, 0));

  useEffect(() => {
    const ids = ['meta-build', 'meta-gear', 'top-players'];
    const observers = ids.map(id => {
      const el = document.getElementById(id);
      if (!el) return null;
      const obs = new IntersectionObserver(
        ([entry]) => { if (entry.isIntersecting) setActiveSection(id); },
        { rootMargin: '-88px 0px -55% 0px', threshold: 0 }
      );
      obs.observe(el);
      return obs;
    });
    return () => observers.forEach(o => o?.disconnect());
  }, [safeIdx, gearReady]);

  useEffect(() => {
    if (!pillsRef.current) return;
    const obs = new IntersectionObserver(
      ([entry]) => setPillsVisible(entry.isIntersecting),
      { threshold: 0 }
    );
    obs.observe(pillsRef.current);
    return () => obs.disconnect();
  }, []);

  if (variants.length === 0) return null;
  const active = variants[safeIdx];
  const accentHex = hexFromTwColor(colors.color);
  const hasHeroFilter = variants.length > 1;

  const canLoadMore = active.id === null && bossId != null && region != null && loadMorePoolSize != null && wowClass != null;
  const handleLoadMore = async (alreadyShown: number) => {
    if (!canLoadMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const { players } = await loadMorePlayers({
        bossId: bossId!, className: wowClass!, spec, difficulty, region: region!, metric,
        startIdx: alreadyShown, count: 5,
      });
      setAdditionalPlayers(prev => [...prev, ...players]);
    } catch {
      // Transient failure — leave the button in place so the user can just retry.
    } finally {
      setLoadingMore(false);
    }
  };


  return (
    <div className="space-y-6 md:space-y-8">

      {/* Sticky bar: jump nav + hero tree switcher */}
      <nav className="sticky top-0 z-30 -mx-4 px-4 md:-mx-6 md:px-6 bg-[#0a0a0a]/95 backdrop-blur-sm border-b border-zinc-800/60 shadow-lg shadow-black/40">
        {/* Row 1: Jump links */}
        <div className="flex gap-4 md:gap-5 overflow-x-auto scrollbar-none">
          {([
            { href: '#meta-build',    id: 'meta-build',    label: 'Meta Build',    show: true },
            { href: '#meta-trinkets', id: 'meta-trinkets', label: 'Meta Trinkets', show: !!gearPromise },
            { href: '#meta-gear',     id: 'meta-gear',     label: 'Meta Gear',     show: !!gearPromise },
            { href: '#top-players',   id: 'top-players',   label: 'Top Players',   show: !!gearPromise || active.players.length > 0 },
          ] as { href: string; id: string; label: string; show: boolean }[]).filter(l => l.show).map(({ href, id, label }) => {
            const isActive = activeSection === id;
            return (
              <a
                key={href}
                href={href}
                className={`text-xs font-semibold py-2.5 border-b-2 transition-colors ${
                  isActive
                    ? `${colors.color} border-current`
                    : 'text-zinc-500 border-transparent hover:text-zinc-300 hover:border-zinc-600'
                }`}
              >
                {label}
              </a>
            );
          })}
        </div>

        {/* Row 2: Compact hero switcher — only appears once large pills scroll out of view */}
        {hasHeroFilter && !pillsVisible && (
          <div className="flex items-center gap-2 py-1.5 border-t border-zinc-800/40">
            {variants.map((v, i) => {
              const isActive = i === safeIdx;
              return (
                <button
                  key={i}
                  onClick={() => switchVariant(i)}
                  className={`flex items-center gap-1.5 rounded-full transition-all border px-2.5 py-1 ${
                    isActive
                      ? `${colors.activeBg} ${colors.border}`
                      : 'border-zinc-800 hover:border-zinc-600'
                  }`}
                >
                  {v.imageUrl
                    ? <Image src={v.imageUrl} alt={v.name} width={20} height={20} className={`w-5 h-5 rounded-full object-cover ${isActive ? 'opacity-100' : 'opacity-50'}`} />
                    : <span className={`text-xs font-bold ${isActive ? colors.color : 'text-zinc-500'}`}>{v.name}</span>
                  }
                </button>
              );
            })}
          </div>
        )}
      </nav>

      {/* Everything below the sticky nav fades when switching hero tree tabs */}
      <div className={`transition-opacity duration-[120ms] ${fading ? 'opacity-0' : 'opacity-100'}`}>

      {/* Large hero filter pills */}
      {hasHeroFilter && (
        <div ref={pillsRef} className="flex flex-wrap items-center gap-2">
          {variants.map((v, i) => {
            const pct = v.id !== null && v.totalPlayers > 0
              ? Math.round(v.count / v.totalPlayers * 100)
              : null;
            const isActive = i === safeIdx;
            return (
              <button
                key={i}
                onClick={() => switchVariant(i)}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold transition-all border ${
                  isActive
                    ? `${colors.activeBg} ${colors.border} ${colors.color}`
                    : 'border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                }`}
              >
                {v.imageUrl && (
                  <Image src={v.imageUrl} alt="" width={20} height={20} className={`w-5 h-5 rounded-full object-cover flex-shrink-0 ${isActive ? 'opacity-100' : 'opacity-50'}`} />
                )}
                {v.name}
                {pct !== null && (
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-mono ${
                    isActive ? 'bg-black/20' : 'bg-zinc-800 text-zinc-500'
                  }`}>
                    {pct}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Hero path performance comparison ── */}
      {(() => {
        const useScore = variants.some(v => v.id !== null && v.topScore != null);
        const trees = useScore
          ? variants.filter(v => v.id !== null && v.topScore != null)
          : variants.filter(v => v.id !== null && v.topDps != null);
        if (trees.length < 2) return null;
        const maxTop = useScore
          ? Math.max(...trees.map(v => v.topScore!))
          : Math.max(...trees.map(v => v.topDps!));
        const getTop = (v: typeof trees[0]) => useScore ? v.topScore! : v.topDps!;
        const getAvg = (v: typeof trees[0]) => useScore ? v.avgScore : v.avgDps;
        const label = useScore ? 'M+ Score by Hero Path' : `${metric.toUpperCase()} by Hero Path`;
        const fmtTop = (v: number) => useScore ? v.toFixed(1) : Math.round(v).toLocaleString();
        const fmtAvg = (v: number) => useScore ? v.toFixed(1) : Math.round(v).toLocaleString();
        return (
          <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl px-5 py-4 space-y-3">
            <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">{label}</p>
            {[...trees].sort((a, b) => getTop(b) - getTop(a)).map(v => {
              const barPct = Math.round(getTop(v) / maxTop * 100);
              const isActive = variants.indexOf(v) === safeIdx;
              const avg = getAvg(v);
              return (
                <button
                  key={v.id}
                  onClick={() => switchVariant(variants.indexOf(v))}
                  className="w-full text-left group"
                >
                  <div className="flex items-center gap-3 mb-1.5">
                    {v.imageUrl && <Image src={v.imageUrl} alt="" width={20} height={20} className="w-5 h-5 rounded-full object-cover flex-shrink-0" />}
                    <span className={`text-sm font-bold ${isActive ? colors.color : 'text-zinc-300 group-hover:text-white transition-colors'}`}>{v.name}</span>
                    <span className="ml-auto text-sm font-black tabular-nums text-emerald-400">{fmtTop(getTop(v))}</span>
                    <span className="text-[10px] text-zinc-600 w-4">top</span>
                    {avg != null && (
                      <span className="text-xs text-zinc-500 tabular-nums w-20 text-right">{fmtAvg(avg)} avg</span>
                    )}
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${barPct}%`, backgroundColor: barPct === 100 ? accentHex : '#3f3f46' }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* ── Consensus Build ── */}
      <section id="meta-build" style={{ scrollMarginTop: '3rem' }}>
        <div className="flex items-end justify-between mb-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-black uppercase tracking-widest px-2.5 py-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                {active.id === null ? 'Meta' : active.name}
              </span>
              <h2 className="text-lg font-black text-white">Consensus Build</h2>
            </div>
            {active.consensus ? (
              <p className="text-sm text-zinc-500">
                Consensus from top {active.totalPlayers} {difficulty === 10 ? 'Mythic+' : difficulty === 5 ? 'Mythic' : 'Heroic'} {spec} parses
                {active.id !== null ? ` using ${active.name}` : ''}
                {totalParses != null && totalParses > active.totalPlayers ? ` · ${totalParses} available` : ''}
                {dataFetchedAt != null && (() => {
                  const mins = Math.round((Date.now() - dataFetchedAt) / 60000);
                  if (mins < 2) return ' · just updated';
                  if (mins < 60) return ` · updated ${mins}m ago`;
                  const hrs = Math.floor(mins / 60);
                  return ` · updated ${hrs}h ago`;
                })()}
              </p>
            ) : (
              <p className="text-sm text-zinc-500">
                {active.id === null
                  ? 'Not enough parses for consensus'
                  : `Not enough ${active.name} parses — only ${active.count} of top ${active.totalPlayers} use this path`}
              </p>
            )}
          </div>
          {active.consensus && <CopyBuildButton talentString={active.consensus.talentString} />}
        </div>
        {active.consensus ? (
          <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl p-3 md:p-5 overflow-x-auto min-w-0">
            <p className="md:hidden text-[10px] text-zinc-600 text-center mb-2">← scroll to see full tree →</p>
            <NewFeature
              telemetry={active.consensus.telemetry}
              layout={layout}
              colors={colors}
              frequencyMap={active.consensus.frequencyPct}
              rankDistributionMap={active.consensus.rankDistribution}
              heroTreeImageUrl={active.id !== null ? active.imageUrl : undefined}
              heroTreeName={active.id !== null ? active.name : undefined}
              heroTrees={active.id === null
                ? variants
                    .filter(v => v.id !== null && v.totalPlayers > 0)
                    .map(v => ({ name: v.name, imageUrl: v.imageUrl, pct: Math.round(v.count / v.totalPlayers * 100) }))
                    .filter(v => v.pct > 0)
                    .sort((a, b) => b.pct - a.pct)
                : undefined}
              activeHeroTreeId={
                active.id !== null
                  ? active.id
                  : (variants.filter(v => v.id !== null).sort((a, b) => b.count - a.count)[0]?.id ?? undefined)
              }
              onHeroTreeClick={active.id === null ? (name) => {
                const idx = variants.findIndex(v => v.name === name);
                if (idx !== -1) switchVariant(idx);
              } : undefined}
              wowClass={wowClass}
              specName={spec}
              topPlayerTelemetry={active.players[0]?.telemetry}
              consensusEntryIds={active.consensus?.entryIds}
              choiceFreqMap={active.consensus?.choiceFreq}
            />
          </div>
        ) : (
          <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl p-10 flex items-center justify-center">
            <p className="text-zinc-600 text-sm">
              {active.id !== null
                ? `Insufficient data for ${active.name} consensus build`
                : 'No data available'}
            </p>
          </div>
        )}
      </section>

      {/* ── Gear + Players (streaming) ── */}
      {gearPromise ? (
        <Suspense fallback={<GearSkeleton />}>
          <GearSection
            gearPromise={gearPromise}
            activeIdx={safeIdx}
            variants={variants}
            accentHex={accentHex}
            colors={colors}
            layout={layout}
            wowClass={wowClass}
            spec={spec}
            wclUrl={wclUrl}
            metric={metric}
            onReady={() => setGearReady(true)}
            additionalPlayers={additionalPlayers}
            canLoadMore={canLoadMore}
            loadMorePoolSize={loadMorePoolSize}
            loadingMore={loadingMore}
            onLoadMore={handleLoadMore}
          />
        </Suspense>
      ) : (
        /* Fallback: render players directly when no gearPromise (no-consensus case) */
        active.players.length > 0 && (
          <section id="top-players" style={{ scrollMarginTop: '3rem' }}>
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-black text-white tracking-tight">Top Players</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  {active.id !== null
                    ? `Players using ${active.name}`
                    : 'Best parses across all hero paths'}
                </p>
              </div>
              {wclUrl && (
                <a
                  href={wclUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors shrink-0 mt-0.5 flex items-center gap-1"
                >
                  View on WarcraftLogs →
                </a>
              )}
            </div>
            <div className="space-y-4">
              {active.players.slice(0, 10).map((player: any, idx: number) => (
                <PlayerCard
                  key={`${active.id ?? 'all'}-${idx}`}
                  player={player}
                  layout={layout}
                  colors={colors}
                  idx={idx}
                  wowClass={wowClass}
                  specName={spec}
                  metric={metric}
                  metaTelemetry={active.consensus?.telemetry}
                  heroTrees={variants
                    .filter(v => v.id !== null)
                    .map(v => ({ id: v.id!, name: v.name, imageUrl: v.imageUrl }))}
                />
              ))}
            </div>
          </section>
        )
      )}

      </div>{/* end fade wrapper */}

    </div>
  );
}
