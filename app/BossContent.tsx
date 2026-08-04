import React from 'react';
import { unstable_cache } from 'next/cache';
import BossView, { type HeroVariant } from '../components/BossView';
import MetaBuildFreshnessBanner from '../components/MetaBuildFreshnessBanner';
import {
  getWclToken, getBlizzardToken, getWclRankingsForRegionMode, getHistoricalFightTelemetry,
  getTalentTreeId, getCachedTalentLayout, playerRegion, getBlizzardTokensForRegions,
  computeConsensus, getActiveHeroTreeId, makeTelemetry, computeFrequencyPct, computeRankDistribution,
  mapConcurrent, normalizeTalentTree, deriveTalentStringAndProfileNodes, blizzardCharacterProfileFetch,
  selectPlayersWithValidTelemetry,
  SPEC_IDS, ENCHANT_SLOT_LABELS, ENCHANT_SLOT_ORDER,
} from '../lib/wow';

function stripWowCodes(text: string): string {
  return text
    .replace(/\|A:[^|]+\|a/gi, '')
    .replace(/\|T:[^|]+\|t/gi, '')
    .replace(/\|H[^|]+\|h([^|]*)\|h/gi, '$1')
    .replace(/\|c[0-9A-Fa-f]{8}/gi, '')
    .replace(/\|r/gi, '')
    .trim();
}

// Extracted from the inner closure so it can be shared across phases (also used by lib/metaBuild.ts)
export function scorePlayerTree(tree: any[], cMap: Map<number, number>): number {
  const rankMap = new Map<number, number>();
  for (const t of normalizeTalentTree(tree)) rankMap.set(t.nodeID, t.rank);
  let score = 0;
  for (const [nodeID, rank] of cMap) {
    if (rankMap.get(nodeID) === rank) score++;
  }
  return score;
}

interface HeroTreeConsensusBase {
  id: number;
  name: string;
  imageUrl: string | undefined;
  hasData: boolean;
  count: number;
  treeEquipIndices: number[];
  talentString: string | null;
  telemetry: any;
  entryIds: Record<number, number>;
  frequencyPct: Record<number, number>;
  rankDistribution: Record<number, Record<number, number>>;
  avgDps: number | null;
  topDps: number | null;
  avgScore: number | null;
  topScore: number | null;
  avgPct: number | null;
}

export type GearPhaseResult = {
  variantGear: Array<HeroVariant['gear']>;
  variantPlayers: Array<any[]>;
};

async function computeGearPhase({
  blizzardEquipmentP,
  blizzardStatsP,
  blizzardMediaP,
  allTelemetryData,
  wclItemData,
  detailedRankingsBase,
  heroTreeConsensusBase,
  blizzardToken,
  CONSENSUS_N,
  DISPLAY_N,
  skeletonMap,
}: {
  blizzardEquipmentP: Promise<any[]>;
  blizzardStatsP: Promise<any[]>;
  blizzardMediaP: Promise<any[]>;
  allTelemetryData: any[];
  wclItemData: Map<number, { ilvl: number; bonusIds: number[]; icon: string }>;
  detailedRankingsBase: any[];
  heroTreeConsensusBase: HeroTreeConsensusBase[];
  blizzardToken: string;
  CONSENSUS_N: number;
  DISPLAY_N: number;
  skeletonMap: any[];
}): Promise<GearPhaseResult> {
  const [blizzardEquipment, blizzardStats, blizzardMedia] = await Promise.all([
    blizzardEquipmentP, blizzardStatsP, blizzardMediaP,
  ]);

  // Enrich player records with avatar URLs now that media is available
  const detailedRankings = detailedRankingsBase.map((player: any, idx: number) => ({
    ...player,
    renderUrl: blizzardMedia[idx]?.assets?.find((a: any) => a.key === 'avatar')?.value ?? null,
  }));

  const TRACKED_GEAR_SLOTS = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER', 'MAIN_HAND', 'OFF_HAND'];
  type ConsumeType = 'flask' | 'food' | 'rune';

  // ── Overall gear aggregation ──────────────────────────────────────────────
  const trinketPlayerSets = new Map<string, { players: Set<number>; itemId: number; ilvl: number; name: string }>();
  const playerTrinketNames = new Map<number, string[]>();
  const playerRingNames = new Map<number, string[]>();
  const gemPlayerSets = new Map<string, { players: Set<number>; itemId: number }>();
  const embellishmentMap = new Map<string, { players: Set<number>; itemId: number }>();
  const slotItemMaps: Record<string, Map<string, { players: Set<number>; itemId: number; quality: string; ilvl: number; name: string }>> = {};
  for (const s of TRACKED_GEAR_SLOTS) slotItemMaps[s] = new Map();
  const itemDescFromEquip = new Map<number, { text: string; ilvl: number }>();
  const itemBonusLists = new Map<number, number[]>();

  for (let i = 0; i < blizzardEquipment.length; i++) {
    const equip = blizzardEquipment[i];
    if (!equip) continue;
    for (const item of equip.equipped_items ?? []) {
      const slot = item.slot?.type ?? '';
      const eqItemId: number = item.item?.id ?? 0;
      const rawIlvl = item.item_level ?? item.level;
      const eqIlvl: number = (rawIlvl !== null && typeof rawIlvl === 'object' ? rawIlvl.value : rawIlvl) ?? 0;

      if (slot === 'TRINKET_1' || slot === 'TRINKET_2') {
        const itemName: string = item.name;
        if (itemName && eqIlvl > 0) {
          const key = `${itemName}|${eqIlvl}`;
          if (!trinketPlayerSets.has(key)) trinketPlayerSets.set(key, { players: new Set(), itemId: eqItemId, ilvl: eqIlvl, name: itemName });
          trinketPlayerSets.get(key)!.players.add(i);
          if (!playerTrinketNames.has(i)) playerTrinketNames.set(i, []);
          playerTrinketNames.get(i)!.push(itemName);
        }
      }
      if (slot === 'FINGER_1' || slot === 'FINGER_2') {
        const itemName: string = item.name;
        if (itemName) {
          if (!playerRingNames.has(i)) playerRingNames.set(i, []);
          playerRingNames.get(i)!.push(itemName);
        }
      }
      for (const socket of item.sockets ?? []) {
        const gemName: string = socket.item?.name ?? '';
        const gemId: number = socket.item?.id ?? 0;
        if (!gemName) continue;
        if (!gemPlayerSets.has(gemName)) gemPlayerSets.set(gemName, { players: new Set(), itemId: gemId });
        gemPlayerSets.get(gemName)!.players.add(i);
      }
      if (item.crafted_quality) {
        const itemName: string = item.name ?? '';
        if (itemName && eqItemId) {
          if (!embellishmentMap.has(itemName)) embellishmentMap.set(itemName, { players: new Set(), itemId: eqItemId });
          embellishmentMap.get(itemName)!.players.add(i);
        }
      }
      const normalizedSlot = (slot === 'FINGER_1' || slot === 'FINGER_2') ? 'FINGER' : slot;
      if (slotItemMaps[normalizedSlot]) {
        const itemName: string = item.name ?? '';
        const quality: string = item.quality?.type ?? 'COMMON';
        if (itemName && eqItemId && eqIlvl > 0) {
          const key = `${itemName}|${eqIlvl}`;
          if (!slotItemMaps[normalizedSlot].has(key)) {
            slotItemMaps[normalizedSlot].set(key, { players: new Set(), itemId: eqItemId, quality, ilvl: eqIlvl, name: itemName });
          }
          slotItemMaps[normalizedSlot].get(key)!.players.add(i);
        }
      }
      if (eqItemId && eqIlvl > 0) {
        const existing = itemDescFromEquip.get(eqItemId);
        if (!existing || existing.ilvl < eqIlvl) {
          const spellDescs = (item.spells ?? []).map((s: any) => stripWowCodes(s.description ?? '')).filter(Boolean);
          const statsStr = (item.stats ?? [])
            .filter((s: any) => s.is_negated !== true)
            .map((s: any) => s.display?.display_string ?? '')
            .filter(Boolean)
            .join(' · ')
            .replace(/\+(\d[\d,]*) (?:\[[^\]]+\]|Strength|Intellect|Agility)/g, '+$1 Primary Stat');
          const text = [statsStr, spellDescs.join('\n')].filter(Boolean).join('\n');
          if (text) itemDescFromEquip.set(eqItemId, { text, ilvl: eqIlvl });
        }
      }
      if (eqItemId && item.bonus_list?.length) {
        if (!itemBonusLists.has(eqItemId)) itemBonusLists.set(eqItemId, item.bonus_list);
      }
    }
  }
  const equipPlayerCount = blizzardEquipment.filter(Boolean).length;

  // WCL fallback gear (for players where Blizzard equipment API failed)
  const WCL_SLOT_MAP: Record<number, string> = {
    0: 'HEAD', 1: 'NECK', 2: 'SHOULDER', 4: 'CHEST', 5: 'WAIST',
    6: 'LEGS', 7: 'FEET', 8: 'WRIST', 9: 'HANDS',
    10: 'FINGER_1', 11: 'FINGER_2', 12: 'TRINKET_1', 13: 'TRINKET_2',
    14: 'BACK', 15: 'MAIN_HAND', 16: 'OFF_HAND',
  };
  const wclSlotAggr = new Map<string, Map<string, { players: Set<number>; itemId: number; ilvl: number }>>();
  const wclTrinketAggr = new Map<string, { players: Set<number>; itemId: number; ilvl: number }>();
  const wclFallbackItemIds = new Set<number>();
  let wclGearPlayerCount = 0;
  for (let i = 0; i < allTelemetryData.length; i++) {
    if (blizzardEquipment[i]) continue;
    const gear = (allTelemetryData[i]?.event?.gear ?? []) as any[];
    if (!gear.length) continue;
    wclGearPlayerCount++;
    gear.forEach((slot: any, idx: number) => {
      const itemId: number = slot.id ?? 0;
      const ilvl: number = slot.itemLevel ?? 0;
      if (!itemId) return;
      wclFallbackItemIds.add(itemId);
      const rawSlotName = WCL_SLOT_MAP[idx];
      if (!rawSlotName) return;
      if (rawSlotName === 'TRINKET_1' || rawSlotName === 'TRINKET_2') {
        const tkey = `${itemId}|${ilvl}`;
        if (!wclTrinketAggr.has(tkey)) wclTrinketAggr.set(tkey, { players: new Set(), itemId, ilvl });
        wclTrinketAggr.get(tkey)!.players.add(i);
      }
      const normalizedSlot = (rawSlotName === 'FINGER_1' || rawSlotName === 'FINGER_2') ? 'FINGER' : rawSlotName;
      if (TRACKED_GEAR_SLOTS.includes(normalizedSlot)) {
        if (!wclSlotAggr.has(normalizedSlot)) wclSlotAggr.set(normalizedSlot, new Map());
        const slotMap = wclSlotAggr.get(normalizedSlot)!;
        const skey = `${itemId}|${ilvl}`;
        if (!slotMap.has(skey)) slotMap.set(skey, { players: new Set(), itemId, ilvl });
        slotMap.get(skey)!.players.add(i);
      }
    });
  }
  const totalGearPlayerCount = Math.max(equipPlayerCount + wclGearPlayerCount, 1);

  const gearBySlotRaw: Record<string, Array<{ name: string; count: number; pct: number; itemId: number; quality: string; iconUrl: string; avgIlvl: number }>> = {};
  for (const [slotKey, map] of Object.entries(slotItemMaps)) {
    const items = Array.from(map.values())
      .map(({ players, itemId, quality, ilvl, name }) => ({
        name, itemId, quality, iconUrl: '',
        count: players.size,
        pct: Math.round(players.size / Math.max(equipPlayerCount, 1) * 100),
        avgIlvl: ilvl,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    if (items.length > 0) gearBySlotRaw[slotKey] = items;
  }
  const topEmbellishmentsRaw = Array.from(embellishmentMap.entries())
    .map(([name, { players, itemId }]) => ({ name, itemId, count: players.size, pct: Math.round(players.size / Math.max(equipPlayerCount, 1) * 100), iconUrl: '', description: '' }))
    .filter(e => e.pct >= 5)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Trinket pair synergy
  const trinketPairCounts = new Map<string, { names: [string, string]; count: number }>();
  for (const [, names] of playerTrinketNames) {
    const unique = [...new Set(names)].sort();
    if (unique.length >= 2) {
      const key = `${unique[0]}||${unique[1]}`;
      if (!trinketPairCounts.has(key)) trinketPairCounts.set(key, { names: [unique[0], unique[1]], count: 0 });
      trinketPairCounts.get(key)!.count++;
    }
  }
  const totalGearPlayersForPairs = playerTrinketNames.size;
  const topTrinketPair = Array.from(trinketPairCounts.values())
    .map(p => ({ ...p, pct: Math.round(p.count / Math.max(totalGearPlayersForPairs, 1) * 100) }))
    .sort((a, b) => b.count - a.count)
    .find(p => p.pct >= 30) ?? null;

  // Ring pair synergy
  const ringPairCounts = new Map<string, { names: [string, string]; count: number }>();
  for (const [, names] of playerRingNames) {
    const unique = [...new Set(names)].sort();
    if (unique.length >= 2) {
      const key = `${unique[0]}||${unique[1]}`;
      if (!ringPairCounts.has(key)) ringPairCounts.set(key, { names: [unique[0], unique[1]], count: 0 });
      ringPairCounts.get(key)!.count++;
    }
  }
  const totalRingPlayers = playerRingNames.size;
  const topRingPair = Array.from(ringPairCounts.values())
    .map(p => ({ ...p, pct: Math.round(p.count / Math.max(totalRingPlayers, 1) * 100) }))
    .sort((a, b) => b.count - a.count)
    .find(p => p.pct >= 20) ?? null;

  const topTrinketsRaw = Array.from(trinketPlayerSets.values())
    .map(({ players, itemId, ilvl, name }) => ({
      name, count: players.size, itemId,
      pct: Math.round(players.size / Math.max(equipPlayerCount, 1) * 100),
      avgIlvl: ilvl,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const topGemsRaw = Array.from(gemPlayerSets.entries())
    .map(([name, { players, itemId }]) => ({ name, count: players.size, itemId, pct: Math.round(players.size / Math.max(equipPlayerCount, 1) * 100) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  // Average item level
  let ilvlSum = 0, ilvlPlayerCount = 0;
  for (const equip of blizzardEquipment) {
    if (!equip) continue;
    let itemSum = 0, itemCount = 0;
    for (const item of equip.equipped_items ?? []) {
      const il = item.item_level ?? item.level;
      const v: number = (il !== null && typeof il === 'object' ? il.value : il) ?? 0;
      if (v > 0) { itemSum += v; itemCount++; }
    }
    if (itemCount > 0) { ilvlSum += itemSum / itemCount; ilvlPlayerCount++; }
  }
  const avgItemLevel = ilvlPlayerCount > 0 ? Math.round(ilvlSum / ilvlPlayerCount) : null;

  // Enchants
  const enchantCounts = new Map<string, { players: Set<number>; slot: string; sourceItemId?: number; enchantId?: number; sourceName?: string }>();
  for (let i = 0; i < blizzardEquipment.length; i++) {
    const equip = blizzardEquipment[i];
    if (!equip) continue;
    for (const item of equip.equipped_items ?? []) {
      const slotLabel = ENCHANT_SLOT_LABELS[item.slot?.type ?? ''];
      if (!slotLabel) continue;
      for (const enchant of item.enchantments ?? []) {
        if (enchant.enchantment_slot?.type !== 'PERMANENT') continue;
        const displayStr = stripWowCodes(enchant.display_string ?? '').replace(/^Enchanted[:,]?\s*/i, '').trim();
        if (!displayStr) continue;
        const key = `${slotLabel}::${displayStr}`;
        if (!enchantCounts.has(key)) {
          enchantCounts.set(key, { players: new Set(), slot: slotLabel, sourceItemId: enchant.source_item?.id, enchantId: enchant.enchantment_id, sourceName: enchant.source_item?.name });
        } else {
          const entry = enchantCounts.get(key)!;
          if (!entry.sourceItemId && enchant.source_item?.id) {
            entry.sourceItemId = enchant.source_item.id;
            entry.sourceName = enchant.source_item.name;
          }
        }
        enchantCounts.get(key)!.players.add(i);
      }
    }
  }
  const enchantsBySlot = new Map<string, Array<{ name: string; count: number; pct: number; sourceItemId?: number; enchantId?: number }>>();
  for (const [key, { players, slot, sourceItemId, enchantId, sourceName }] of enchantCounts) {
    const displayStr = key.slice(slot.length + 2);
    const name = sourceName ?? displayStr;
    if (!enchantsBySlot.has(slot)) enchantsBySlot.set(slot, []);
    enchantsBySlot.get(slot)!.push({ name, count: players.size, pct: Math.round(players.size / Math.max(equipPlayerCount, 1) * 100), sourceItemId, enchantId });
  }
  const topEnchants = ENCHANT_SLOT_ORDER
    .filter(slot => enchantsBySlot.has(slot))
    .map(slot => {
      const best = enchantsBySlot.get(slot)!.sort((a, b) => b.count - a.count)[0];
      return { slot, name: best.name, count: best.count, pct: best.pct, sourceItemId: best.sourceItemId, enchantId: best.enchantId, iconUrl: '' as string, description: '' as string };
    });

  // Secondary stats
  let statCount = 0, hasteSum = 0, critSum = 0, masterySum = 0, versSum = 0;
  for (const stats of blizzardStats) {
    if (!stats) continue;
    const haste = stats.spell_haste?.value ?? stats.melee_haste?.value ?? stats.ranged_haste?.value ?? 0;
    const crit = stats.spell_crit?.value ?? stats.melee_crit?.value ?? stats.ranged_crit?.value ?? 0;
    const mastery = stats.mastery?.value ?? 0;
    const vers = stats.versatility_damage_done_bonus ?? 0;
    if (haste + crit + mastery + vers > 0) {
      hasteSum += haste; critSum += crit; masterySum += mastery; versSum += vers; statCount++;
    }
  }
  const avgStats = statCount > 0 ? {
    haste: Math.round(hasteSum / statCount * 10) / 10,
    crit: Math.round(critSum / statCount * 10) / 10,
    mastery: Math.round(masterySum / statCount * 10) / 10,
    versatility: Math.round(versSum / statCount * 10) / 10,
  } : null;

  // Consumables from CombatantInfo auras
  const consumableMap = new Map<string, { players: Set<number>; spellId: number; type: ConsumeType }>();
  for (let i = 0; i < allTelemetryData.length; i++) {
    for (const aura of (allTelemetryData[i]?.event?.auras ?? []) as any[]) {
      const name: string = aura.name ?? '';
      if (!name) continue;
      let type: ConsumeType | null = null;
      if (/flask/i.test(name)) type = 'flask';
      else if (/well.?fed/i.test(name)) type = 'food';
      else if (/augment rune/i.test(name)) type = 'rune';
      if (!type) continue;
      if (!consumableMap.has(name)) consumableMap.set(name, { players: new Set(), spellId: aura.ability ?? 0, type });
      consumableMap.get(name)!.players.add(i);
    }
  }
  const consumableBase = Math.max(allTelemetryData.filter(t => (t?.event?.auras?.length ?? 0) > 0).length, 1);
  const topConsumablesRaw: Array<{ name: string; type: ConsumeType; count: number; pct: number; spellId: number; iconUrl: string }> = [];
  for (const type of ['flask', 'food', 'rune'] as ConsumeType[]) {
    const best = Array.from(consumableMap.entries())
      .filter(([, v]) => v.type === type)
      .map(([name, { players, spellId }]) => ({ name, type, count: players.size, pct: Math.round(players.size / consumableBase * 100), spellId, iconUrl: '' }))
      .sort((a, b) => b.count - a.count)[0];
    if (best && best.pct >= 10) topConsumablesRaw.push(best);
  }

  // ── Per-hero-tree gear aggregation ──────────────────────────────────────
  const heroTreeGear: Array<{
    gear: {
      trinkets: any[]; gems: any[]; enchants: any[]; consumables: any[];
      avgItemLevel: number | null;
      stats: { haste: number; crit: number; mastery: number; versatility: number } | null;
      playerCount: number; gearBySlotRaw: Record<string, any[]>;
    };
    topPlayers: any[];
  }> = [];

  for (const htBase of heroTreeConsensusBase) {
    const { id, treeEquipIndices } = htBase;

    const treeTopPlayers = detailedRankings.filter((player: any) =>
      getActiveHeroTreeId(player.telemetry?.event?.talentTree || [], skeletonMap) === id
    );

    const validEquipInTree = treeEquipIndices.filter(i => blizzardEquipment[i] != null).length;

    // Trinkets per hero path
    const treeTrinketSets = new Map<string, { players: Set<number>; itemId: number }>();
    for (const i of treeEquipIndices) {
      const equip = blizzardEquipment[i];
      if (!equip) continue;
      for (const item of equip.equipped_items ?? []) {
        const slot = item.slot?.type ?? '';
        if (slot === 'TRINKET_1' || slot === 'TRINKET_2') {
          const itemName: string = item.name;
          if (!itemName) continue;
          if (!treeTrinketSets.has(itemName)) treeTrinketSets.set(itemName, { players: new Set(), itemId: item.item?.id ?? 0 });
          treeTrinketSets.get(itemName)!.players.add(i);
        }
      }
    }
    const treeTrinkets = Array.from(treeTrinketSets.entries())
      .map(([n, { players, itemId }]) => ({ name: n, count: players.size, pct: Math.round(players.size / Math.max(validEquipInTree, 1) * 100), itemId, iconUrl: '' }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    // Gems per hero path
    const treeGemSets = new Map<string, { players: Set<number>; itemId: number }>();
    for (const i of treeEquipIndices) {
      const equip = blizzardEquipment[i];
      if (!equip) continue;
      for (const item of equip.equipped_items ?? []) {
        for (const socket of item.sockets ?? []) {
          const gemName: string = socket.item?.name ?? '';
          const gemId: number = socket.item?.id ?? 0;
          if (!gemName) continue;
          if (!treeGemSets.has(gemName)) treeGemSets.set(gemName, { players: new Set(), itemId: gemId });
          treeGemSets.get(gemName)!.players.add(i);
        }
      }
    }
    const treeGems = Array.from(treeGemSets.entries())
      .map(([n, { players, itemId }]) => ({ name: n, count: players.size, itemId, pct: Math.round(players.size / Math.max(validEquipInTree, 1) * 100), iconUrl: '', description: '' }))
      .sort((a, b) => b.count - a.count).slice(0, 6);

    // Enchants per hero path
    const treeEnchantCounts = new Map<string, { players: Set<number>; slot: string; sourceItemId?: number; sourceName?: string }>();
    for (const i of treeEquipIndices) {
      const equip = blizzardEquipment[i];
      if (!equip) continue;
      for (const item of equip.equipped_items ?? []) {
        const slotLabel = ENCHANT_SLOT_LABELS[item.slot?.type ?? ''];
        if (!slotLabel) continue;
        for (const enchant of item.enchantments ?? []) {
          if (enchant.enchantment_slot?.type !== 'PERMANENT') continue;
          const displayStr = stripWowCodes(enchant.display_string ?? '').replace(/^Enchanted[:,]?\s*/i, '').trim();
          if (!displayStr) continue;
          const key = `${slotLabel}::${displayStr}`;
          if (!treeEnchantCounts.has(key)) {
            treeEnchantCounts.set(key, { players: new Set(), slot: slotLabel, sourceItemId: enchant.source_item?.id, sourceName: enchant.source_item?.name });
          } else {
            const entry = treeEnchantCounts.get(key)!;
            if (!entry.sourceItemId && enchant.source_item?.id) {
              entry.sourceItemId = enchant.source_item.id;
              entry.sourceName = enchant.source_item.name;
            }
          }
          treeEnchantCounts.get(key)!.players.add(i);
        }
      }
    }
    const treeEnchantsBySlot = new Map<string, Array<{ name: string; count: number; pct: number; sourceItemId?: number }>>();
    for (const [key, { players, slot, sourceItemId, sourceName }] of treeEnchantCounts) {
      const displayStr = key.slice(slot.length + 2);
      const name = sourceName ?? displayStr;
      if (!treeEnchantsBySlot.has(slot)) treeEnchantsBySlot.set(slot, []);
      treeEnchantsBySlot.get(slot)!.push({ name, count: players.size, pct: Math.round(players.size / Math.max(validEquipInTree, 1) * 100), sourceItemId });
    }
    const treeEnchants = ENCHANT_SLOT_ORDER
      .filter(slot => treeEnchantsBySlot.has(slot))
      .map(slot => {
        const best = treeEnchantsBySlot.get(slot)!.sort((a, b) => b.count - a.count)[0];
        return { slot, name: best.name, count: best.count, pct: best.pct, sourceItemId: best.sourceItemId, iconUrl: '' as string, description: '' as string };
      });

    // Consumables per hero path
    const treeConsumableMap = new Map<string, { players: Set<number>; spellId: number; type: ConsumeType }>();
    for (const i of treeEquipIndices) {
      for (const aura of (allTelemetryData[i]?.event?.auras ?? []) as any[]) {
        const auraName: string = aura.name ?? '';
        if (!auraName) continue;
        let auraType: ConsumeType | null = null;
        if (/flask/i.test(auraName)) auraType = 'flask';
        else if (/well.?fed/i.test(auraName)) auraType = 'food';
        else if (/augment rune/i.test(auraName)) auraType = 'rune';
        if (!auraType) continue;
        if (!treeConsumableMap.has(auraName)) treeConsumableMap.set(auraName, { players: new Set(), spellId: aura.ability ?? 0, type: auraType });
        treeConsumableMap.get(auraName)!.players.add(i);
      }
    }
    const treeConsumableBase = Math.max(treeEquipIndices.filter(i => (allTelemetryData[i]?.event?.auras?.length ?? 0) > 0).length, 1);
    const treeConsumables: Array<{ name: string; type: ConsumeType; count: number; pct: number; spellId: number; iconUrl: string }> = [];
    for (const ctype of ['flask', 'food', 'rune'] as ConsumeType[]) {
      const best = Array.from(treeConsumableMap.entries())
        .filter(([, v]) => v.type === ctype)
        .map(([n, { players, spellId }]) => ({ name: n, type: ctype, count: players.size, pct: Math.round(players.size / treeConsumableBase * 100), spellId, iconUrl: '' }))
        .sort((a, b) => b.count - a.count)[0];
      if (best && best.pct >= 10) treeConsumables.push(best);
    }

    // Avg item level per hero path
    let treeIlvlSum = 0, treeIlvlCount = 0;
    for (const i of treeEquipIndices) {
      const equip = blizzardEquipment[i];
      if (!equip) continue;
      let itemSum = 0, itemCount = 0;
      for (const item of equip.equipped_items ?? []) {
        const il2 = item.item_level ?? item.level;
        const v2: number = (il2 !== null && typeof il2 === 'object' ? il2.value : il2) ?? 0;
        if (v2 > 0) { itemSum += v2; itemCount++; }
      }
      if (itemCount > 0) { treeIlvlSum += itemSum / itemCount; treeIlvlCount++; }
    }
    const treeAvgItemLevel = treeIlvlCount > 0 ? Math.round(treeIlvlSum / treeIlvlCount) : null;

    let tsc = 0, ths = 0, tcs = 0, tms = 0, tvs = 0;
    for (const i of treeEquipIndices) {
      const stats = blizzardStats[i];
      if (!stats) continue;
      const h = stats.spell_haste?.value ?? stats.melee_haste?.value ?? 0;
      const c = stats.spell_crit?.value ?? stats.melee_crit?.value ?? 0;
      const m = stats.mastery?.value ?? 0;
      const v = stats.versatility_damage_done_bonus ?? 0;
      if (h + c + m + v > 0) { ths += h; tcs += c; tms += m; tvs += v; tsc++; }
    }

    // Gear by slot per hero path
    const treeSlotMaps: Record<string, Map<string, { players: Set<number>; itemId: number; quality: string }>> = {};
    for (const s of TRACKED_GEAR_SLOTS) treeSlotMaps[s] = new Map();
    for (const i of treeEquipIndices) {
      const equip = blizzardEquipment[i];
      if (!equip) continue;
      for (const item of equip.equipped_items ?? []) {
        const slot = item.slot?.type ?? '';
        const normalizedSlot = (slot === 'FINGER_1' || slot === 'FINGER_2') ? 'FINGER' : slot;
        if (treeSlotMaps[normalizedSlot]) {
          const itemName: string = item.name ?? '';
          const itemId: number = item.item?.id ?? 0;
          const quality: string = item.quality?.type ?? 'COMMON';
          if (itemName && itemId) {
            if (!treeSlotMaps[normalizedSlot].has(itemName)) treeSlotMaps[normalizedSlot].set(itemName, { players: new Set(), itemId, quality });
            treeSlotMaps[normalizedSlot].get(itemName)!.players.add(i);
          }
        }
      }
    }
    const treeGearBySlotRaw: Record<string, Array<{ name: string; count: number; pct: number; itemId: number; quality: string; iconUrl: string }>> = {};
    for (const [slotKey, map] of Object.entries(treeSlotMaps)) {
      const items = Array.from(map.entries())
        .map(([name, { players, itemId, quality }]) => ({
          name, itemId, quality, iconUrl: '',
          count: players.size,
          pct: Math.round(players.size / Math.max(validEquipInTree, 1) * 100),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      if (items.length > 0) treeGearBySlotRaw[slotKey] = items;
    }

    heroTreeGear.push({
      gear: {
        trinkets: treeTrinkets, gems: treeGems, enchants: treeEnchants,
        consumables: treeConsumables, avgItemLevel: treeAvgItemLevel,
        stats: tsc > 0 ? {
          haste: Math.round(ths / tsc * 10) / 10,
          crit: Math.round(tcs / tsc * 10) / 10,
          mastery: Math.round(tms / tsc * 10) / 10,
          versatility: Math.round(tvs / tsc * 10) / 10,
        } : null,
        playerCount: treeEquipIndices.length,
        gearBySlotRaw: treeGearBySlotRaw,
      },
      topPlayers: treeTopPlayers,
    });
  }

  // ── Icon + description fetching ──────────────────────────────────────────
  const allItemIds = new Set<number>();
  for (const t of topTrinketsRaw) if (t.itemId) allItemIds.add(t.itemId);
  for (const g of topGemsRaw) if (g.itemId) allItemIds.add(g.itemId);
  for (const e of topEmbellishmentsRaw) if (e.itemId) allItemIds.add(e.itemId);
  for (const htGear of heroTreeGear) {
    for (const t of htGear.gear?.trinkets ?? []) if (t.itemId) allItemIds.add(t.itemId);
    for (const g of htGear.gear?.gems ?? []) if (g.itemId) allItemIds.add(g.itemId);
    for (const items of Object.values(htGear.gear?.gearBySlotRaw ?? {})) {
      for (const item of items as any[]) if (item.itemId) allItemIds.add(item.itemId);
    }
  }
  for (const items of Object.values(gearBySlotRaw)) {
    for (const item of items) if (item.itemId) allItemIds.add(item.itemId);
  }
  for (const id of wclFallbackItemIds) allItemIds.add(id);

  const enchantsMissingId = topEnchants.filter(e => !e.sourceItemId && /^enchant\s+\S+\s+-\s+/i.test(e.name));
  await Promise.all(enchantsMissingId.map(async (e) => {
    try {
      const r = await fetch(
        `https://us.api.blizzard.com/data/wow/search/item?namespace=static-us&name.en_US=${encodeURIComponent(e.name)}&_pageSize=1`,
        { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }
      );
      if (r.ok) {
        const data = await r.json();
        const itemId: number | undefined = data.results?.[0]?.data?.id;
        if (itemId) e.sourceItemId = itemId;
      }
    } catch {}
  }));

  const enchantDescIds = new Set<number>();
  for (const e of topEnchants) if (e.sourceItemId) enchantDescIds.add(e.sourceItemId);
  for (const htGear of heroTreeGear) {
    for (const e of htGear.gear?.enchants ?? []) if (e.sourceItemId) enchantDescIds.add(e.sourceItemId);
  }

  const consumableSpellIds = new Set<number>();
  for (const c of topConsumablesRaw) if (c.spellId) consumableSpellIds.add(c.spellId);
  for (const htGear of heroTreeGear) {
    for (const c of htGear.gear?.consumables ?? []) if (c.spellId) consumableSpellIds.add(c.spellId);
  }

  const iconById = new Map<number, string>();
  const descById = new Map<number, string>();
  const nameById = new Map<number, string>();
  const qualityById = new Map<number, string>();
  const consumableIconById = new Map<number, string>();

  for (const [id, { icon }] of wclItemData) {
    if (icon) iconById.set(id, `https://wow.zamimg.com/images/wow/icons/large/${icon}`);
  }

  await Promise.all([
    ...Array.from(consumableSpellIds).map(async (spellId) => {
      try {
        const r = await fetch(`https://us.api.blizzard.com/data/wow/media/spell/${spellId}?namespace=static-us`,
          { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } });
        if (r.ok) consumableIconById.set(spellId, (await r.json()).assets?.[0]?.value ?? '');
      } catch {}
    }),
    ...Array.from(allItemIds).map(async (itemId) => {
      try {
        const bonusList = wclItemData.get(itemId)?.bonusIds ?? itemBonusLists.get(itemId) ?? [];
        const bonusParams = bonusList.length ? `&${bonusList.map((b: number) => `bonus[]=${b}`).join('&')}` : '';
        const bonusStr = bonusList.join(':');

        const mediaFetch = iconById.has(itemId)
          ? Promise.resolve(null)
          : fetch(`https://us.api.blizzard.com/data/wow/media/item/${itemId}?namespace=static-us`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } });

        const [mediaRes, itemRes, wowheadRes] = await Promise.all([
          mediaFetch,
          fetch(`https://us.api.blizzard.com/data/wow/item/${itemId}?namespace=static-us&locale=en_US${bonusParams}`,
            { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }),
          fetch(`https://nether.wowhead.com/tooltip/item/${itemId}${bonusStr ? `?bonus=${bonusStr}` : ''}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 86400 } }),
        ]);

        if (mediaRes?.ok) iconById.set(itemId, (await mediaRes.json()).assets?.[0]?.value ?? '');

        let wowheadDesc = '';
        if (wowheadRes.ok) {
          try {
            const whData = await wowheadRes.json();
            const html: string = whData.tooltip ?? '';
            const matches = [...html.matchAll(/<span class="q2">([\s\S]*?)<\/span>/g)];
            wowheadDesc = matches
              .map(m => m[1]
                .replace(/<[^>]+>/g, '')
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
                .replace(/\s+/g, ' ').trim())
              .filter(t => /^(Equip:|Use:|Chance:)/i.test(t))
              .join('\n');
          } catch {}
        }

        if (itemRes.ok) {
          const itemData = await itemRes.json();
          nameById.set(itemId, itemData.name ?? '');
          qualityById.set(itemId, itemData.quality?.type ?? 'EPIC');
          const preview = itemData.preview_item ?? itemData;
          const gemBonus = stripWowCodes(preview.gem_properties?.bonus?.name ?? preview.gem_properties?.bonus?.properties ?? '');
          const blizzardStatsStr = (preview.stats ?? [])
            .filter((s: any) => s.is_negated !== true)
            .map((s: any) => s.display?.display_string ?? '')
            .filter(Boolean).join(' · ')
            .replace(/\+(\d[\d,]*) (?:\[[^\]]+\]|Strength|Intellect|Agility)/g, '+$1 Primary Stat');
          descById.set(itemId, wowheadDesc || itemDescFromEquip.get(itemId)?.text || blizzardStatsStr || gemBonus || stripWowCodes(preview.description ?? ''));
        } else {
          const fallback = wowheadDesc || itemDescFromEquip.get(itemId)?.text;
          if (fallback) descById.set(itemId, fallback);
        }
      } catch {}
    }),
    ...Array.from(enchantDescIds).map(async (itemId) => {
      try {
        const r = await fetch(`https://us.api.blizzard.com/data/wow/item/${itemId}?namespace=static-us&locale=en_US`,
          { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } });
        if (r.ok) {
          const itemData = await r.json();
          const preview = itemData.preview_item ?? itemData;
          const spellDescs: string[] = (preview.spells ?? []).map((s: any) => stripWowCodes(s.description ?? '')).filter(Boolean);
          descById.set(itemId, spellDescs.join('\n') || stripWowCodes(preview.description ?? ''));
        }
      } catch {}
    }),
  ]);

  // ── Merge WCL-sourced gear ───────────────────────────────────────────────
  if (wclGearPlayerCount > 0) {
    for (const [slotName, itemMap] of wclSlotAggr) {
      for (const { players, itemId, ilvl } of itemMap.values()) {
        const name = nameById.get(itemId);
        if (!name) continue;
        if (!gearBySlotRaw[slotName]) gearBySlotRaw[slotName] = [];
        const existing = gearBySlotRaw[slotName].find((x: any) => x.itemId === itemId && x.avgIlvl === ilvl);
        if (existing) {
          existing.count += players.size;
        } else {
          gearBySlotRaw[slotName].push({
            name, itemId, quality: qualityById.get(itemId) ?? 'EPIC',
            iconUrl: '', count: players.size, pct: 0, avgIlvl: ilvl,
          });
        }
      }
      gearBySlotRaw[slotName] = gearBySlotRaw[slotName]
        .map((item: any) => ({ ...item, pct: Math.round(item.count / totalGearPlayerCount * 100) }))
        .sort((a: any, b: any) => b.count - a.count)
        .slice(0, 5);
    }
    for (const { players, itemId, ilvl } of wclTrinketAggr.values()) {
      const name = nameById.get(itemId);
      if (!name) continue;
      const existing = topTrinketsRaw.find(t => t.itemId === itemId && t.avgIlvl === ilvl);
      if (existing) {
        existing.count += players.size;
      } else {
        topTrinketsRaw.push({ name, count: players.size, itemId, pct: 0, avgIlvl: ilvl });
      }
    }
    topTrinketsRaw.forEach(t => { t.pct = Math.round(t.count / totalGearPlayerCount * 100); });
    topTrinketsRaw.sort((a, b) => b.count - a.count);
    topTrinketsRaw.splice(8);
  }

  // ── Apply icons ──────────────────────────────────────────────────────────
  const applyTrinketIcons = (trinkets: Array<{ itemId: number; iconUrl: string }>) =>
    trinkets.map(t => ({ ...t, iconUrl: iconById.get(t.itemId) ?? '', description: descById.get(t.itemId) ?? '' }));

  for (const htGear of heroTreeGear) {
    if (!htGear.gear) continue;
    htGear.gear.trinkets = applyTrinketIcons(htGear.gear.trinkets);
    htGear.gear.gems = (htGear.gear.gems ?? []).map((g: any) => ({ ...g, iconUrl: iconById.get(g.itemId) ?? '', description: descById.get(g.itemId) ?? '' }));
    htGear.gear.consumables = (htGear.gear.consumables ?? []).map((c: any) => ({ ...c, iconUrl: consumableIconById.get(c.spellId) ?? '' }));
    for (const e of htGear.gear.enchants ?? []) {
      e.description = e.sourceItemId ? (descById.get(e.sourceItemId) ?? '') : '';
    }
    const treeGearBySlot: Record<string, any[]> = {};
    for (const [slotKey, items] of Object.entries(htGear.gear.gearBySlotRaw ?? {})) {
      treeGearBySlot[slotKey] = (items as any[]).map(item => ({ ...item, iconUrl: iconById.get(item.itemId) ?? '', description: descById.get(item.itemId) ?? '' }));
    }
    (htGear.gear as any).gearBySlot = treeGearBySlot;
    delete (htGear.gear as any).gearBySlotRaw;
  }

  const topTrinkets = applyTrinketIcons(topTrinketsRaw);
  const topGems = topGemsRaw.map(g => ({ ...g, iconUrl: iconById.get(g.itemId) ?? '', description: descById.get(g.itemId) ?? '' }));
  const gearBySlot: Record<string, Array<{ name: string; count: number; pct: number; itemId: number; quality: string; iconUrl: string; description: string; avgIlvl: number }>> = {};
  for (const [slotKey, items] of Object.entries(gearBySlotRaw)) {
    gearBySlot[slotKey] = items.map(item => ({ ...item, iconUrl: iconById.get(item.itemId) ?? '', description: descById.get(item.itemId) ?? '' }));
  }
  const topConsumables = topConsumablesRaw.map(c => ({ ...c, iconUrl: consumableIconById.get(c.spellId) ?? '' }));
  const topEmbellishments = topEmbellishmentsRaw.map(e => ({ ...e, iconUrl: iconById.get(e.itemId) ?? '', description: descById.get(e.itemId) ?? '' }));
  for (const e of topEnchants) {
    e.iconUrl = '';
    e.description = e.sourceItemId ? (descById.get(e.sourceItemId) ?? '') : '';
  }

  // ── Build GearPhaseResult ────────────────────────────────────────────────
  const variantGear: Array<HeroVariant['gear']> = [];
  const variantPlayers: Array<any[]> = [];

  // [0] = All
  variantGear.push({
    trinkets: topTrinkets, stats: avgStats, enchants: topEnchants,
    avgItemLevel, gems: topGems, consumables: topConsumables,
    embellishments: topEmbellishments, playerCount: totalGearPlayerCount,
    gearBySlot, trinketSynergy: topTrinketPair, ringSynergy: topRingPair,
  });
  variantPlayers.push(detailedRankings.slice(0, DISPLAY_N));

  // [1+] = Per hero tree (same order as heroTreeConsensusBase)
  for (let i = 0; i < heroTreeConsensusBase.length; i++) {
    const htBase = heroTreeConsensusBase[i];
    const { gear, topPlayers } = heroTreeGear[i];
    variantGear.push(htBase.hasData ? {
      trinkets: gear.trinkets, gems: gear.gems, enchants: gear.enchants,
      consumables: gear.consumables, avgItemLevel: gear.avgItemLevel,
      stats: gear.stats, playerCount: gear.playerCount,
      gearBySlot: (gear as any).gearBySlot,
    } : null);
    variantPlayers.push(topPlayers.slice(0, DISPLAY_N));
  }

  return { variantGear, variantPlayers };
}

export default async function BossContent({
  bossId,
  className,
  spec,
  difficulty,
  nodeColors,
  region = 'global',
  wclZoneId,
  metric = 'dps',
}: {
  bossId: number;
  className: string;
  spec: string;
  difficulty: number;
  nodeColors: { color: string; border: string; activeBg: string };
  region?: string; // region MODE: 'global' (all regions pooled) | 'us-eu' (US+EU pooled)
  wclZoneId?: number | null;
  metric?: string;
}) {
  try {
    // Static game data (talent tree layout) is identical across regions — a fixed 'us'
    // token authenticates it regardless of which rankings region mode is selected.
    const [wclToken, staticBlizzardToken] = await Promise.all([getWclToken(), getBlizzardToken('us')]);

    const [treeInfo, rankingsResult] = await Promise.all([
      getTalentTreeId(spec, className, staticBlizzardToken),
      unstable_cache(
        async () => ({ rankings: await getWclRankingsForRegionMode(wclToken, bossId, className, spec, difficulty, region, metric, true), fetchedAt: Date.now() }),
        [`wcl-rankings-v4-${bossId}-${className}-${spec}-${difficulty}-${region}-${metric}`],
        { revalidate: 86400 }
      )(),
    ]);
    if (!treeInfo) {
      return <div className="text-center py-12 text-zinc-600 text-sm">Talent tree not found for this spec.</div>;
    }

    const { layout: skeletonMap, heroTreeNames: allHeroTreeNames } = await getCachedTalentLayout(treeInfo.treeId, treeInfo.specId, staticBlizzardToken);
    const rawRankings = rankingsResult.rankings;
    const dataFetchedAt = rankingsResult.fetchedAt;
    if (rawRankings.length === 0) {
      const isRaidDifficulty = difficulty === 4 || difficulty === 5;
      const diffLabel = isRaidDifficulty ? (difficulty === 5 ? 'Mythic' : 'Heroic') : 'Mythic+';
      const altDiff = isRaidDifficulty ? (difficulty === 5 ? 'Heroic' : 'Mythic') : null;
      const contentNoun = isRaidDifficulty ? 'boss' : 'dungeon';
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-2xl opacity-40">
            —
          </div>
          <div>
            <p className="text-zinc-300 font-bold">No {diffLabel} data</p>
            <p className="text-zinc-600 text-sm mt-1">
              No {diffLabel} {spec} {className} parses found for this {contentNoun}.
            </p>
            {altDiff && (
              <p className="text-zinc-700 text-xs mt-3">
                Try switching to {altDiff} using the toggle in the header.
              </p>
            )}
          </div>
        </div>
      );
    }

    const CONSENSUS_N = Math.min(rawRankings.length, 50);
    // Only the first 5 player cards get their (expensive: 2 Blizzard API calls each)
    // talentString/renderUrl fetched upfront now — "Load more" (loadMorePlayers action)
    // fetches the rest on demand, up to CONSENSUS_N, only if someone actually clicks it.
    const DISPLAY_N = Math.min(rawRankings.length, 5);

    // Guarantees the consensus sample actually reaches CONSENSUS_N players whenever the
    // ranking pool is large enough to support it — backfilling past rank 50 for any
    // individual fetch that comes back empty, rather than silently reporting "49 of 50."
    // Bounded concurrency rather than a bare Promise.all — firing ~50 telemetry lookups
    // at once reliably trips WCL's burst rate limit (distinct from its points budget).
    const consensusSelection = await selectPlayersWithValidTelemetry(
      rawRankings,
      CONSENSUS_N,
      (player: any) =>
        unstable_cache(
          async () => getHistoricalFightTelemetry(wclToken, player.report?.code, player.report?.fightID, player.name),
          [`wcl-telemetry-${player.report?.code}-${player.report?.fightID}`],
          { revalidate: 86400 }
        )(),
      5
    );
    const consensusRankings = consensusSelection.map(s => s.player);
    const allTelemetryData = consensusSelection.map(s => s.telemetry);

    // A Global (or US+EU) pool can span players from several regions, each needing their
    // own region's Blizzard token — consensusRankings (post-backfill) is a superset of
    // DISPLAY_N's slice, so fetching tokens for its regions covers every profile fetch below.
    const blizzardTokensByRegion = await getBlizzardTokensForRegions(
      consensusRankings.map((p: any) => playerRegion(p, 'us'))
    );

    function blizzardProfileFetch(player: any, endpoint: string, cacheTag: string) {
      return blizzardCharacterProfileFetch(player, blizzardTokensByRegion, endpoint, cacheTag);
    }

    // ── Start remaining fetch groups concurrently ─────────────────────────────
    // Equipment/stats/media start immediately so they run in parallel with profiles.
    // We only await profiles for the fast talent-tree path.
    const _profilesP = Promise.all(
      consensusRankings.slice(0, DISPLAY_N).map((player: any) => blizzardProfileFetch(player, 'specializations', 'spec'))
    );
    const _equipP = Promise.all(
      consensusRankings.map((player: any) => blizzardProfileFetch(player, 'equipment', 'equip'))
    );
    const _statsP = Promise.all(
      consensusRankings.map((player: any) => blizzardProfileFetch(player, 'statistics', 'stats'))
    );
    const _mediaP = Promise.all(
      consensusRankings.slice(0, DISPLAY_N).map((player: any) => blizzardProfileFetch(player, 'character-media', 'media'))
    );

    const blizzardProfiles = await _profilesP;

    // ── wclItemData from telemetry (icon pre-population) ─────────────────
    const wclItemData = new Map<number, { ilvl: number; bonusIds: number[]; icon: string }>();
    for (const tel of allTelemetryData) {
      for (const slot of (tel?.event?.gear ?? []) as any[]) {
        const itemId: number = slot.id ?? 0;
        const ilvl: number = slot.itemLevel ?? 0;
        if (!itemId || !ilvl) continue;
        const existing = wclItemData.get(itemId);
        if (!existing || existing.ilvl < ilvl) {
          wclItemData.set(itemId, { ilvl, bonusIds: slot.bonusIDs ?? [], icon: slot.icon ?? '' });
        }
      }
    }

    // ── Build detailedRankingsBase (renderUrl = null; filled in gear phase) ─
    const detailedRankingsBase = consensusRankings.map((player: any, idx: number) => {
      const telemetryData = allTelemetryData[idx];
      const profileData = blizzardProfiles[idx];
      const { talentString, profileNodes } = deriveTalentStringAndProfileNodes(telemetryData, profileData, treeInfo.specId);
      return { ...player, telemetry: telemetryData, talentString, renderUrl: null, profileNodes };
    });

    // ── Choice node frequency (phase-1 only) ─────────────────────────────
    const choiceFreqRaw: Record<number, { aEntryId: number; bEntryId: number; aCount: number; bCount: number }> = {};
    for (const n of skeletonMap) {
      const node = n as any;
      if (node.isChoice && node.choiceAEntryId != null && node.choiceBEntryId != null)
        choiceFreqRaw[node.nodeID] = { aEntryId: node.choiceAEntryId, bEntryId: node.choiceBEntryId, aCount: 0, bCount: 0 };
    }
    for (const player of detailedRankingsBase) {
      for (const pn of (player as any).profileNodes ?? []) {
        const entry = choiceFreqRaw[pn.id];
        if (!entry) continue;
        const eid: number = pn.tooltip?.talent?.id;
        if (eid === entry.aEntryId) entry.aCount++;
        else if (eid === entry.bEntryId) entry.bCount++;
      }
    }
    const metaChoiceFreq: Record<number, { aEntryId: number; bEntryId: number; aPct: number; bPct: number }> = {};
    for (const [nodeIdStr, entry] of Object.entries(choiceFreqRaw)) {
      const total = entry.aCount + entry.bCount;
      if (total === 0) continue;
      metaChoiceFreq[Number(nodeIdStr)] = {
        aEntryId: entry.aEntryId, bEntryId: entry.bEntryId,
        aPct: Math.round(entry.aCount / total * 100),
        bPct: Math.round(entry.bCount / total * 100),
      };
    }

    // ── Consensus computation ─────────────────────────────────────────────
    const allFightTrees = allTelemetryData.map(t => normalizeTalentTree(t?.event?.talentTree || []));
    const validTrees = allFightTrees.filter(t => t.length > 0);
    const totalConsensusPlayers = validTrees.length;

    // A few "apex"/capstone nodes have a real max rank Blizzard's tree API doesn't
    // expose (it reports node.ranks.length, which undercounts these specifically) —
    // the only way to know the true max is what's actually observed in real samples.
    // Only ever raises maxRanks, never lowers it, so normal nodes are untouched.
    const observedMaxRanks = new Map<number, number>();
    for (const tree of validTrees) {
      for (const { nodeID, rank } of tree) {
        if (rank > (observedMaxRanks.get(nodeID) ?? 0)) observedMaxRanks.set(nodeID, rank);
      }
    }
    // A node only needs this correction because it's a Tiered node — multiple separate
    // underlying entries sharing one visual icon, each independently ranked — which is
    // exactly the thing worth flagging distinctly in the UI so "3/4" doesn't read like
    // an arbitrary number. isTieredApex is true only for nodes actually corrected here.
    const correctedSkeletonMap = skeletonMap.map((n: any) => {
      const observed = observedMaxRanks.get(n.nodeID);
      return observed != null && observed > n.maxRanks
        ? { ...n, maxRanks: observed, isTieredApex: true }
        : n;
    });

    const usedHeroTreeIds = new Set<number>();
    for (const tel of validTrees) {
      const treeId = getActiveHeroTreeId(tel, skeletonMap);
      if (treeId != null) usedHeroTreeIds.add(treeId);
    }
    const heroTreeNames = allHeroTreeNames.filter(ht => usedHeroTreeIds.has(ht.id));

    let consensusTelemetry: { event: { talentTree: Array<{ nodeID: number; rank: number }> } } | null = null;
    let metaTalentString: string | null = null;
    let metaFrequencyPct: Record<number, number> = {};
    let metaRankDistribution: Record<number, Record<number, number>> = {};
    const heroTreeConsensusBase: HeroTreeConsensusBase[] = [];
    const wclUrl = wclZoneId
      ? `https://www.warcraftlogs.com/zone/rankings/${wclZoneId}#class=${encodeURIComponent(className)}&spec=${encodeURIComponent(spec)}&difficulty=${difficulty}&boss=${bossId}`
      : null;

    if (validTrees.length >= 3) {
      const consensusMap = computeConsensus(validTrees, 0.5);
      consensusTelemetry = makeTelemetry(consensusMap);
      metaFrequencyPct = computeFrequencyPct(validTrees);
      metaRankDistribution = computeRankDistribution(validTrees);

      let bestScore = -1;
      for (const player of detailedRankingsBase) {
        if (!player.talentString) continue;
        const score = scorePlayerTree(player.telemetry?.event?.talentTree || [], consensusMap);
        if (score > bestScore) bestScore = score;
      }
      const metaStrFreq = new Map<string, number>();
      for (const player of detailedRankingsBase) {
        if (!player.talentString) continue;
        if (scorePlayerTree(player.telemetry?.event?.talentTree || [], consensusMap) === bestScore) {
          metaStrFreq.set(player.talentString, (metaStrFreq.get(player.talentString) ?? 0) + 1);
        }
      }
      for (const [str, freq] of metaStrFreq) {
        if (freq > (metaStrFreq.get(metaTalentString ?? '') ?? 0)) metaTalentString = str;
      }

      const metaPlayer = detailedRankingsBase.find(
        (p: any) => p.talentString === metaTalentString && (p as any).profileNodes?.length > 0
      );
      const consensusEntryIds: Record<number, number> = {};
      for (const node of (metaPlayer as any)?.profileNodes ?? []) {
        const entryId = node.tooltip?.talent?.id;
        if (entryId != null) consensusEntryIds[node.id] = entryId;
      }

      const heroGroups = new Map<number, Array<Array<{ nodeID: number; rank: number }>>>();
      for (const tel of validTrees) {
        const treeId = getActiveHeroTreeId(tel, skeletonMap);
        if (treeId != null) {
          if (!heroGroups.has(treeId)) heroGroups.set(treeId, []);
          heroGroups.get(treeId)!.push(tel);
        }
      }

      for (const { id, name, imageUrl } of heroTreeNames) {
        const group = heroGroups.get(id) ?? [];
        const hasData = group.length >= 2;
        const htMap = hasData ? computeConsensus(group, 0.5) : new Map<number, number>();
        const htTelemetry = hasData ? makeTelemetry(htMap) : { event: { talentTree: [] as Array<{ nodeID: number; rank: number }> } };
        const htFrequencyPct = hasData ? computeFrequencyPct(group) : {};
        const htRankDistribution = hasData ? computeRankDistribution(group) : {};

        let htStr: string | null = null;
        if (hasData) {
          let htBest = -1;
          for (const player of detailedRankingsBase) {
            if (!player.talentString) continue;
            if (getActiveHeroTreeId(player.telemetry?.event?.talentTree || [], skeletonMap) !== id) continue;
            const score = scorePlayerTree(player.telemetry?.event?.talentTree || [], htMap);
            if (score > htBest) htBest = score;
          }
          const htStrFreq = new Map<string, number>();
          for (const player of detailedRankingsBase) {
            if (!player.talentString) continue;
            if (getActiveHeroTreeId(player.telemetry?.event?.talentTree || [], skeletonMap) !== id) continue;
            if (scorePlayerTree(player.telemetry?.event?.talentTree || [], htMap) === htBest) {
              htStrFreq.set(player.talentString, (htStrFreq.get(player.talentString) ?? 0) + 1);
            }
          }
          for (const [str, freq] of htStrFreq) {
            if (freq > (htStrFreq.get(htStr ?? '') ?? 0)) htStr = str;
          }
        }

        const htMetaPlayer = detailedRankingsBase.find(
          (p: any) => p.talentString === htStr && (p as any).profileNodes?.length > 0
            && getActiveHeroTreeId(p.telemetry?.event?.talentTree || [], skeletonMap) === id
        );
        const htEntryIds: Record<number, number> = {};
        for (const node of (htMetaPlayer as any)?.profileNodes ?? []) {
          const entryId = node.tooltip?.talent?.id;
          if (entryId != null) htEntryIds[node.id] = entryId;
        }

        // Which player indices (into blizzardEquipment/allTelemetryData) use this hero tree
        const treeEquipIndices: number[] = [];
        for (let i = 0; i < CONSENSUS_N; i++) {
          const tel = allTelemetryData[i]?.event?.talentTree || [];
          if (tel.length > 0 && getActiveHeroTreeId(tel, skeletonMap) === id) treeEquipIndices.push(i);
        }

        // DPS/score stats from telemetry (phase-1 data)
        const treeTopPlayers = detailedRankingsBase.filter((player: any) =>
          getActiveHeroTreeId(player.telemetry?.event?.talentTree || [], skeletonMap) === id
        );
        const treeDps = treeTopPlayers.length > 0
          ? Math.round(treeTopPlayers.reduce((s: number, p: any) => s + (p.amount ?? 0), 0) / treeTopPlayers.length)
          : null;
        const treeTopDps = treeTopPlayers.length > 0
          ? Math.round(Math.max(...treeTopPlayers.map((p: any) => p.amount ?? 0)))
          : null;
        const hasScore = treeTopPlayers.some((p: any) => p.score != null);
        const treeAvgScore = hasScore && treeTopPlayers.length > 0
          ? treeTopPlayers.reduce((s: number, p: any) => s + (p.score ?? 0), 0) / treeTopPlayers.length
          : null;
        const treeTopScore = hasScore && treeTopPlayers.length > 0
          ? Math.max(...treeTopPlayers.map((p: any) => p.score ?? 0))
          : null;
        const treeAvgPct = treeTopPlayers.length > 0
          ? Math.round(treeTopPlayers.reduce((s: number, p: any) => s + (p.rankPercent ?? 0), 0) / treeTopPlayers.length)
          : null;

        heroTreeConsensusBase.push({
          id, name, imageUrl, hasData, count: treeEquipIndices.length,
          treeEquipIndices, talentString: htStr, telemetry: htTelemetry,
          entryIds: htEntryIds, frequencyPct: htFrequencyPct, rankDistribution: htRankDistribution,
          avgDps: treeDps, topDps: treeTopDps,
          avgScore: treeAvgScore, topScore: treeTopScore, avgPct: treeAvgPct,
        });
      }

      // ── Build talent-only heroVariants (gear/players available via gearPromise) ──
      const talentVariants: HeroVariant[] = [];
      talentVariants.push({
        id: null,
        name: 'All',
        count: totalConsensusPlayers,
        totalPlayers: totalConsensusPlayers,
        consensus: { telemetry: consensusTelemetry, talentString: metaTalentString, frequencyPct: metaFrequencyPct, rankDistribution: metaRankDistribution, entryIds: consensusEntryIds, choiceFreq: metaChoiceFreq },
        gear: null,
        // Include phase-1 players so topPlayerTelemetry is available for the talent tree overlay
        players: detailedRankingsBase.slice(0, DISPLAY_N),
      });
      for (const htBase of heroTreeConsensusBase) {
        const htTopPlayers = detailedRankingsBase.filter((player: any) =>
          getActiveHeroTreeId(player.telemetry?.event?.talentTree || [], skeletonMap) === htBase.id
        ).slice(0, DISPLAY_N);
        talentVariants.push({
          id: htBase.id,
          name: htBase.name,
          imageUrl: htBase.imageUrl,
          count: htBase.count,
          totalPlayers: totalConsensusPlayers,
          consensus: (htBase.hasData && htBase.telemetry.event.talentTree.length > 0) ? {
            telemetry: htBase.telemetry,
            talentString: htBase.talentString,
            frequencyPct: htBase.frequencyPct ?? {},
            rankDistribution: htBase.rankDistribution ?? {},
            entryIds: htBase.entryIds,
            choiceFreq: metaChoiceFreq,
          } : null,
          gear: null,
          players: htTopPlayers,
          hasData: htBase.hasData,
          avgDps: htBase.avgDps ?? null,
          topDps: htBase.topDps ?? null,
          avgScore: htBase.avgScore ?? null,
          topScore: htBase.topScore ?? null,
          avgPct: htBase.avgPct ?? null,
        });
      }

      // Gear fetches are already running — pass their promises to computeGearPhase
      const gearPromise: Promise<GearPhaseResult> = computeGearPhase({
        blizzardEquipmentP: _equipP,
        blizzardStatsP: _statsP,
        blizzardMediaP: _mediaP,
        allTelemetryData,
        wclItemData,
        detailedRankingsBase,
        heroTreeConsensusBase,
        blizzardToken: staticBlizzardToken,
        CONSENSUS_N,
        DISPLAY_N,
        skeletonMap,
      });

      return (
        <>
          <MetaBuildFreshnessBanner
            className={className} spec={spec} bossId={bossId} difficulty={difficulty}
            region={region} metric={metric} fetchedAt={dataFetchedAt}
          />
          <BossView
            variants={talentVariants}
            gearPromise={gearPromise}
            layout={correctedSkeletonMap}
            colors={nodeColors}
            difficulty={difficulty}
            spec={spec}
            dataFetchedAt={dataFetchedAt}
            wclUrl={wclUrl ?? undefined}
            wowClass={className}
            metric={metric}
            bossId={bossId}
            region={region}
            loadMorePoolSize={CONSENSUS_N}
          />
        </>
      );
    }

    // Not enough data for consensus
    if (detailedRankingsBase.length > 0) {
      const heroVariants: HeroVariant[] = [{
        id: null,
        name: 'All',
        count: totalConsensusPlayers,
        totalPlayers: totalConsensusPlayers,
        consensus: null,
        gear: null,
        players: detailedRankingsBase,
      }];
      return (
        <>
          <MetaBuildFreshnessBanner
            className={className} spec={spec} bossId={bossId} difficulty={difficulty}
            region={region} metric={metric} fetchedAt={dataFetchedAt}
          />
          <BossView
            variants={heroVariants}
            layout={correctedSkeletonMap}
            colors={nodeColors}
            difficulty={difficulty}
            spec={spec}
            dataFetchedAt={dataFetchedAt}
            wclUrl={wclUrl ?? undefined}
            wowClass={className}
            metric={metric}
          />
        </>
      );
    }

    const isRaidDifficulty2 = difficulty === 4 || difficulty === 5;
    const diffLabel2 = isRaidDifficulty2 ? (difficulty === 5 ? 'Mythic' : 'Heroic') : 'Mythic+';
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-2xl opacity-40">
          —
        </div>
        <div>
          <p className="text-zinc-300 font-bold">No {diffLabel2} data</p>
          <p className="text-zinc-600 text-sm mt-1">
            No {diffLabel2} {spec} {className} parses found for this {isRaidDifficulty2 ? 'boss' : 'dungeon'}.
          </p>
          {isRaidDifficulty2 && (
            <p className="text-zinc-700 text-xs mt-3">
              Try switching to {difficulty === 5 ? 'Heroic' : 'Mythic'} using the toggle in the header.
            </p>
          )}
        </div>
      </div>
    );
  } catch (err: any) {
    if (err?.isRateLimit) {
      return (
        <div className="bg-amber-950/40 border border-amber-800/50 text-amber-300 px-4 py-3 rounded-xl text-sm">
          <span className="font-bold">High demand right now — </span>
          this data source is temporarily rate-limited. Try again in a few minutes.
        </div>
      );
    }
    return (
      <div className="bg-red-950/40 border border-red-800/50 text-red-300 px-4 py-3 rounded-xl text-sm">
        <span className="font-bold">Error: </span>{err.message}
      </div>
    );
  }
}
