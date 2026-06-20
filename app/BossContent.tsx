import React from 'react';
import BossView, { type HeroVariant } from '../components/BossView';
import {
  getWclToken, getBlizzardToken, getWclRankings, getHistoricalFightTelemetry,
  getTalentTreeId, getTalentTreeLayout,
  computeConsensus, getActiveHeroTreeId, makeTelemetry, computeFrequencyPct, scoreAgainstMap,
  SPEC_IDS, ENCHANT_SLOT_LABELS, ENCHANT_SLOT_ORDER,
} from '../lib/wow';

function stripWowCodes(text: string): string {
  return text
    .replace(/\|A:[^|]+\|a/gi, '')             // atlas texture icons
    .replace(/\|T:[^|]+\|t/gi, '')             // texture files
    .replace(/\|H[^|]+\|h([^|]*)\|h/gi, '$1') // hyperlinks (keep text)
    .replace(/\|c[0-9A-Fa-f]{8}/gi, '')        // color start
    .replace(/\|r/gi, '')                       // color reset
    .trim();
}

export default async function BossContent({
  bossId,
  className,
  spec,
  difficulty,
  nodeColors,
  region = 'us',
  wclZoneId,
}: {
  bossId: number;
  className: string;
  spec: string;
  difficulty: number;
  nodeColors: { color: string; border: string; activeBg: string };
  region?: string;
  wclZoneId?: number | null;
}) {
  try {
    const [wclToken, blizzardToken] = await Promise.all([getWclToken(), getBlizzardToken(region)]);


    const [treeInfo, rawRankings] = await Promise.all([
      getTalentTreeId(spec, className, blizzardToken),
      getWclRankings(wclToken, bossId, className, spec, difficulty, region),
    ]);
    if (!treeInfo) {
      return <div className="text-center py-12 text-zinc-600 text-sm">Talent tree not found for this spec.</div>;
    }

    const { layout: skeletonMap, heroTreeNames: allHeroTreeNames } = await getTalentTreeLayout(treeInfo.treeId, treeInfo.specId, blizzardToken);
    const totalAvailableParses = rawRankings.length;
    if (rawRankings.length === 0) {
      const diffLabel = difficulty === 5 ? 'Mythic' : 'Heroic';
      const altDiff = difficulty === 5 ? 'Heroic' : 'Mythic';
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-2xl opacity-40">
            —
          </div>
          <div>
            <p className="text-zinc-300 font-bold">No {diffLabel} data</p>
            <p className="text-zinc-600 text-sm mt-1">
              No {diffLabel} {spec} {className} parses found for this boss.
            </p>
            <p className="text-zinc-700 text-xs mt-3">
              Try switching to {altDiff} using the toggle in the header.
            </p>
          </div>
        </div>
      );
    }

    const CONSENSUS_N = Math.min(rawRankings.length, 50);
    const DISPLAY_N = CONSENSUS_N;

    const [allTelemetryData, blizzardProfiles, blizzardEquipment, blizzardStats, blizzardMedia] = await Promise.all([
      Promise.all(
        rawRankings.slice(0, CONSENSUS_N).map((player: any) =>
          getHistoricalFightTelemetry(wclToken, player.report?.code, player.report?.fightID, player.name)
        )
      ),
      Promise.all(
        rawRankings.slice(0, DISPLAY_N).map(async (player: any) => {
          const realm = (player.server?.slug ?? player.server?.name ?? '').toLowerCase().replace(/\s+/g, '-').replace(/'/g, '');
          const name = player.name.toLowerCase();
          try {
            const r = await fetch(
              `https://${region}.api.blizzard.com/profile/wow/character/${realm}/${name}/specializations?namespace=profile-${region}&locale=en_US`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 3600 } }
            );
            return r.ok ? r.json() : null;
          } catch { return null; }
        })
      ),
      Promise.all(
        rawRankings.slice(0, CONSENSUS_N).map(async (player: any) => {
          const realm = (player.server?.slug ?? player.server?.name ?? '').toLowerCase().replace(/\s+/g, '-').replace(/'/g, '');
          const name = player.name.toLowerCase();
          try {
            const r = await fetch(
              `https://${region}.api.blizzard.com/profile/wow/character/${realm}/${name}/equipment?namespace=profile-${region}&locale=en_US`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 3600 } }
            );
            if (!r.ok) return null;
            return r.json();
          } catch { return null; }
        })
      ),
      Promise.all(
        rawRankings.slice(0, CONSENSUS_N).map(async (player: any) => {
          const realm = (player.server?.slug ?? player.server?.name ?? '').toLowerCase().replace(/\s+/g, '-').replace(/'/g, '');
          const name = player.name.toLowerCase();
          try {
            const r = await fetch(
              `https://${region}.api.blizzard.com/profile/wow/character/${realm}/${name}/statistics?namespace=profile-${region}&locale=en_US`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 3600 } }
            );
            return r.ok ? r.json() : null;
          } catch { return null; }
        })
      ),
      Promise.all(
        rawRankings.slice(0, DISPLAY_N).map(async (player: any) => {
          const realm = (player.server?.slug ?? player.server?.name ?? '').toLowerCase().replace(/\s+/g, '-').replace(/'/g, '');
          const name = player.name.toLowerCase();
          try {
            const r = await fetch(
              `https://${region}.api.blizzard.com/profile/wow/character/${realm}/${name}/character-media?namespace=profile-${region}&locale=en_US`,
              { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 3600 } }
            );
            return r.ok ? r.json() : null;
          } catch { return null; }
        })
      ),
    ]);

    // Extract bonus IDs, ilvl, and icon per item from WCL combatant info gear
    // Keyed by itemId, keeps the highest ilvl instance seen across all players
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

    // Build display player records
    const detailedRankings = rawRankings.slice(0, DISPLAY_N).map((player: any, idx: number) => {
      const telemetryData = allTelemetryData[idx];
      const profileData = blizzardProfiles[idx];
      const fightTalents: Array<{ nodeID: number; rank: number }> = telemetryData?.event?.talentTree || [];
      const fightMap = new Map<number, number>();
      for (const t of fightTalents) fightMap.set(t.nodeID, Math.max(fightMap.get(t.nodeID) ?? 0, t.rank));

      let talentString: string | null = null;
      let bestScore = -1;
      for (const sp of profileData?.specializations ?? []) {
        for (const loadout of sp.loadouts ?? []) {
          if (!loadout.talent_loadout_code) continue;
          const nodes = [
            ...(loadout.selected_class_talents ?? []),
            ...(loadout.selected_spec_talents ?? []),
            ...(loadout.selected_hero_talents ?? []),
          ];
          let score = 0;
          for (const node of nodes) {
            if (fightMap.get(node.id) === node.rank) score++;
          }
          if (score > bestScore) { bestScore = score; talentString = loadout.talent_loadout_code; }
        }
      }
      const renderUrl: string | null = blizzardMedia[idx]?.assets?.find((a: any) => a.key === 'avatar')?.value ?? null;
      return { ...player, telemetry: telemetryData, talentString, renderUrl };
    });

    // Aggregate trinkets — keyed by "name|ilvl" so each ilvl tier is a separate entry
    const trinketPlayerSets = new Map<string, { players: Set<number>; itemId: number; ilvl: number; name: string }>();
    // Aggregate gems
    const gemPlayerSets = new Map<string, { players: Set<number>; itemId: number }>();
    // Aggregate embellishments (crafted items — detected by crafted_quality field)
    const embellishmentMap = new Map<string, { players: Set<number>; itemId: number }>();
    // Aggregate gear slots — keyed by "name|ilvl" so each ilvl tier is a separate entry
    const TRACKED_GEAR_SLOTS = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER', 'MAIN_HAND', 'OFF_HAND'];
    const slotItemMaps: Record<string, Map<string, { players: Set<number>; itemId: number; quality: string; ilvl: number; name: string }>> = {};
    for (const s of TRACKED_GEAR_SLOTS) slotItemMaps[s] = new Map();
    // Descriptions from equipped items (scaled to actual ilvl), keyed by itemId
    // bonus_list from the highest-ilvl instance is used to fetch the correct scaled tooltip from Blizzard API
    const itemDescFromEquip = new Map<number, { text: string; ilvl: number }>();
    const itemBonusLists = new Map<number, number[]>();

    for (let i = 0; i < blizzardEquipment.length; i++) {
      const equip = blizzardEquipment[i];
      if (!equip) continue;
      for (const item of equip.equipped_items ?? []) {
        const slot = item.slot?.type ?? '';
        const eqItemId: number = item.item?.id ?? 0;
        // item_level may be a plain number or { value, display_string } depending on API version
        const rawIlvl = item.item_level ?? item.level;
        const eqIlvl: number = (rawIlvl !== null && typeof rawIlvl === 'object' ? rawIlvl.value : rawIlvl) ?? 0;

        if (slot === 'TRINKET_1' || slot === 'TRINKET_2') {
          const itemName: string = item.name;
          if (itemName && eqIlvl > 0) {
            const key = `${itemName}|${eqIlvl}`;
            if (!trinketPlayerSets.has(key)) trinketPlayerSets.set(key, { players: new Set(), itemId: eqItemId, ilvl: eqIlvl, name: itemName });
            trinketPlayerSets.get(key)!.players.add(i);
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
        // Extract spell descriptions and actual scaled stats from the profile equipment response
        if (eqItemId && eqIlvl > 0) {
          const existing = itemDescFromEquip.get(eqItemId);
          if (!existing || existing.ilvl < eqIlvl) {
            const spellDescs = (item.spells ?? []).map((s: any) => stripWowCodes(s.description ?? '')).filter(Boolean);
            // item.stats in the profile API has actual scaled values; display_string may or may not be populated
            // Only use display_string — raw `value` is an unscaled base float (e.g. 13.23 for Mastery)
            // that gives wrong numbers when rounded. display_string has the correct scaled value.
            const statsStr = (item.stats ?? [])
              .filter((s: any) => s.is_negated !== true)
              .map((s: any) => s.display?.display_string ?? '')
              .filter(Boolean)
              .join(' · ')
              // Normalise primary stat name so Holy Pally, Balance Druid, etc. all show correctly
              .replace(/\+(\d[\d,]*) (?:\[[^\]]+\]|Strength|Intellect|Agility)/g, '+$1 Primary Stat');
            // Include both: stats line first, then equip/proc descriptions
            // Profile API spell descriptions ARE scaled to the player's actual ilvl
            const text = [statsStr, spellDescs.join('\n')].filter(Boolean).join('\n');
            if (text) itemDescFromEquip.set(eqItemId, { text, ilvl: eqIlvl });
          }
        }
      }
    }
    const equipPlayerCount = blizzardEquipment.filter(Boolean).length;

    // For players where Blizzard equipment API failed, aggregate gear from WCL telemetry instead.
    // WCL CombatantInfo gear[] is 0-indexed matching WoW slot IDs offset by 1.
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
      if (blizzardEquipment[i]) continue; // already have Blizzard data for this player
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

    // Aggregate enchants
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
          // Use display_string as the grouping key; source_item.name is the human-readable name
          const key = `${slotLabel}::${displayStr}`;
          if (!enchantCounts.has(key)) {
            enchantCounts.set(key, {
              players: new Set(), slot: slotLabel,
              sourceItemId: enchant.source_item?.id,
              enchantId: enchant.enchantment_id,
              sourceName: enchant.source_item?.name,
            });
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
      // Prefer source_item.name (e.g. "Enchant Legs - Writ of Speed") over the raw display_string (e.g. "+41 Agility…")
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

    // Aggregate secondary stats
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

    // Consumable tracking from CombatantInfo auras (flask, food, augment rune)
    type ConsumeType = 'flask' | 'food' | 'rune';
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

    // Compute overall consensus
    const allFightTrees = allTelemetryData.map(t => (t?.event?.talentTree || []) as Array<{ nodeID: number; rank: number }>);
    const validTrees = allFightTrees.filter(t => t.length > 0);
    const totalConsensusPlayers = validTrees.length;

    const usedHeroTreeIds = new Set<number>();
    for (const tel of validTrees) {
      const treeId = getActiveHeroTreeId(tel, skeletonMap);
      if (treeId != null) usedHeroTreeIds.add(treeId);
    }
    const heroTreeNames = allHeroTreeNames.filter(ht => usedHeroTreeIds.has(ht.id));

    let consensusTelemetry: { event: { talentTree: Array<{ nodeID: number; rank: number }> } } | null = null;
    let metaTalentString: string | null = null;
    let metaFrequencyPct: Record<number, number> = {};
    const heroTreeConsensus: Array<any> = [];

    if (validTrees.length >= 3) {
      const consensusMap = computeConsensus(validTrees, 0.5);
      consensusTelemetry = makeTelemetry(consensusMap);
      metaFrequencyPct = computeFrequencyPct(validTrees);

      let bestScore = -1;
      for (const player of detailedRankings) {
        if (!player.talentString) continue;
        const score = scoreAgainstMap(player.telemetry?.event?.talentTree || [], consensusMap);
        if (score > bestScore) { bestScore = score; metaTalentString = player.talentString; }
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

        let htStr: string | null = null;
        if (hasData) {
          let htBest = -1;
          for (const player of detailedRankings) {
            if (!player.talentString) continue;
            if (getActiveHeroTreeId(player.telemetry?.event?.talentTree || [], skeletonMap) !== id) continue;
            const score = scoreAgainstMap(player.telemetry?.event?.talentTree || [], htMap);
            if (score > htBest) { htBest = score; htStr = player.talentString; }
          }
        }

        const treeEquipIndices: number[] = [];
        for (let i = 0; i < CONSENSUS_N; i++) {
          const tel = allTelemetryData[i]?.event?.talentTree || [];
          if (tel.length > 0 && getActiveHeroTreeId(tel, skeletonMap) === id) treeEquipIndices.push(i);
        }
        const treeTopPlayers = detailedRankings.filter((player: any) =>
          getActiveHeroTreeId(player.telemetry?.event?.talentTree || [], skeletonMap) === id
        );

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
        const validEquipInTree = treeEquipIndices.filter(i => blizzardEquipment[i] != null).length;
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
                if (!entry.sourceItemId && enchant.source_item?.id) { entry.sourceItemId = enchant.source_item.id; entry.sourceName = enchant.source_item.name; }
              }
              treeEnchantCounts.get(key)!.players.add(i);
            }
          }
        }
        const treeEnchantsBySlot = new Map<string, Array<{ name: string; count: number; pct: number; sourceItemId?: number }>>();
        for (const [key, { players, slot, sourceItemId, sourceName }] of treeEnchantCounts) {
          const displayStr = key.slice(slot.length + 2);
          const eName = sourceName ?? displayStr;
          if (!treeEnchantsBySlot.has(slot)) treeEnchantsBySlot.set(slot, []);
          treeEnchantsBySlot.get(slot)!.push({ name: eName, count: players.size, pct: Math.round(players.size / Math.max(validEquipInTree, 1) * 100), sourceItemId });
        }
        const treeEnchants = ENCHANT_SLOT_ORDER
          .filter(slot => treeEnchantsBySlot.has(slot))
          .map(slot => {
            const best = treeEnchantsBySlot.get(slot)!.sort((a, b) => b.count - a.count)[0];
            return { slot, name: best.name, count: best.count, pct: best.pct, sourceItemId: best.sourceItemId, iconUrl: '', description: '' };
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

        heroTreeConsensus.push({
          id, name, imageUrl, count: group.length, totalPlayers: totalConsensusPlayers,
          talentString: htStr, telemetry: htTelemetry, hasData,
          gear: {
            trinkets: treeTrinkets,
            gems: treeGems,
            enchants: treeEnchants,
            consumables: treeConsumables,
            avgItemLevel: treeAvgItemLevel,
            stats: tsc > 0 ? {
              haste: Math.round(ths / tsc * 10) / 10,
              crit: Math.round(tcs / tsc * 10) / 10,
              mastery: Math.round(tms / tsc * 10) / 10,
              versatility: Math.round(tvs / tsc * 10) / 10,
            } : null,
            playerCount: treeEquipIndices.length,
            gearBySlotRaw: treeGearBySlotRaw,
          },
          frequencyPct: htFrequencyPct,
          topPlayers: treeTopPlayers,
        });
      }

      // Icon + description fetch for trinkets and gems
      const allItemIds = new Set<number>();
      for (const t of topTrinketsRaw) if (t.itemId) allItemIds.add(t.itemId);
      for (const g of topGemsRaw) if (g.itemId) allItemIds.add(g.itemId);
      for (const e of topEmbellishmentsRaw) if (e.itemId) allItemIds.add(e.itemId);
      for (const build of heroTreeConsensus) {
        for (const t of build.gear?.trinkets ?? []) if (t.itemId) allItemIds.add(t.itemId);
        for (const g of build.gear?.gems ?? []) if (g.itemId) allItemIds.add(g.itemId);
        for (const items of Object.values(build.gear?.gearBySlotRaw ?? {})) {
          for (const item of items as any[]) if (item.itemId) allItemIds.add(item.itemId);
        }
      }
      for (const items of Object.values(gearBySlotRaw)) {
        for (const item of items) if (item.itemId) allItemIds.add(item.itemId);
      }
      for (const id of wclFallbackItemIds) allItemIds.add(id);
      // For enchants without source_item, search the Blizzard item DB by name.
      // Enchant scrolls (e.g. "Enchant Ring - Eyes of the Eagle") are real items with spell descriptions.
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

      // Description-only fetch for enchants (no icons — tooltip shows stats instead)
      const enchantDescIds = new Set<number>();
      for (const e of topEnchants) if (e.sourceItemId) enchantDescIds.add(e.sourceItemId);
      for (const build of heroTreeConsensus) {
        for (const e of build.gear?.enchants ?? []) if (e.sourceItemId) enchantDescIds.add(e.sourceItemId);
      }

      const consumableSpellIds = new Set<number>();
      for (const c of topConsumablesRaw) if (c.spellId) consumableSpellIds.add(c.spellId);
      for (const build of heroTreeConsensus) {
        for (const c of build.gear?.consumables ?? []) if (c.spellId) consumableSpellIds.add(c.spellId);
      }

      const iconById = new Map<number, string>();
      const descById = new Map<number, string>();
      const nameById = new Map<number, string>();
      const qualityById = new Map<number, string>();
      const consumableIconById = new Map<number, string>();
      // WCL gear data includes icon filenames (already with extension) — use zamimg CDN directly
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

            // Skip Blizzard media call if icon already pre-populated from WCL gear data
            const mediaFetch = iconById.has(itemId)
              ? Promise.resolve(null)
              : fetch(`https://us.api.blizzard.com/data/wow/media/item/${itemId}?namespace=static-us`,
                  { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } });

            const [mediaRes, itemRes, wowheadRes] = await Promise.all([
              mediaFetch,
              fetch(`https://us.api.blizzard.com/data/wow/item/${itemId}?namespace=static-us&locale=en_US${bonusParams}`,
                { headers: { 'Authorization': `Bearer ${blizzardToken}` }, next: { revalidate: 86400 } }),
              // Wowhead returns correctly scaled proc/equip descriptions that Blizzard's API cannot
              fetch(`https://nether.wowhead.com/tooltip/item/${itemId}${bonusStr ? `?bonus=${bonusStr}` : ''}`,
                { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 86400 } }),
            ]);

            if (mediaRes?.ok) iconById.set(itemId, (await mediaRes.json()).assets?.[0]?.value ?? '');

            // Parse Wowhead tooltip HTML for Equip:/Use: descriptions with scaled proc values
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
              // Only use display_string from Blizzard item API — the raw `value` field is unscaled
              // and gives wrong numbers (e.g. "+13 Mastery" instead of "+123 Mastery")
              const blizzardStatsStr = (preview.stats ?? [])
                .filter((s: any) => s.is_negated !== true)
                .map((s: any) => s.display?.display_string ?? '')
                .filter(Boolean).join(' · ')
                .replace(/\+(\d[\d,]*) (?:\[[^\]]+\]|Strength|Intellect|Agility)/g, '+$1 Primary Stat');
              // Priority: Wowhead proc text → profile API stats (correctly scaled to actual ilvl)
              //           → Blizzard display_string stats → gem bonus → description
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

      // Merge WCL-sourced gear into gearBySlotRaw and topTrinketsRaw for players
      // where the Blizzard equipment API returned no data (e.g. EU players on US endpoint)
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

      const applyTrinketIcons = (trinkets: Array<{ itemId: number; iconUrl: string }>) =>
        trinkets.map(t => ({ ...t, iconUrl: iconById.get(t.itemId) ?? '', description: descById.get(t.itemId) ?? '' }));

      for (const build of heroTreeConsensus) {
        if (!build.gear) continue;
        build.gear.trinkets = applyTrinketIcons(build.gear.trinkets);
        build.gear.gems = (build.gear.gems ?? []).map((g: any) => ({ ...g, iconUrl: iconById.get(g.itemId) ?? '', description: descById.get(g.itemId) ?? '' }));
        build.gear.consumables = (build.gear.consumables ?? []).map((c: any) => ({ ...c, iconUrl: consumableIconById.get(c.spellId) ?? '' }));
        for (const e of build.gear.enchants ?? []) {
          e.description = e.sourceItemId ? (descById.get(e.sourceItemId) ?? '') : '';
        }
        const treeGearBySlot: Record<string, any[]> = {};
        for (const [slotKey, items] of Object.entries(build.gear.gearBySlotRaw ?? {})) {
          treeGearBySlot[slotKey] = (items as any[]).map(item => ({ ...item, iconUrl: iconById.get(item.itemId) ?? '', description: descById.get(item.itemId) ?? '' }));
        }
        build.gear.gearBySlot = treeGearBySlot;
        delete build.gear.gearBySlotRaw;
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
      const wclUrl = wclZoneId
        ? `https://www.warcraftlogs.com/zone/rankings/${wclZoneId}#class=${encodeURIComponent(className)}&spec=${encodeURIComponent(spec)}&difficulty=${difficulty}&boss=${bossId}`
        : null;

      // Build hero variants
      const heroVariants: HeroVariant[] = [];
      heroVariants.push({
        id: null,
        name: 'All',
        count: totalConsensusPlayers,
        totalPlayers: totalConsensusPlayers,
        consensus: { telemetry: consensusTelemetry, talentString: metaTalentString, frequencyPct: metaFrequencyPct },
        gear: { trinkets: topTrinkets, stats: avgStats, enchants: topEnchants, avgItemLevel, gems: topGems, consumables: topConsumables, embellishments: topEmbellishments, playerCount: totalGearPlayerCount, gearBySlot },
        players: detailedRankings,
      });
      for (const htc of heroTreeConsensus) {
        heroVariants.push({
          id: htc.id,
          name: htc.name,
          imageUrl: htc.imageUrl,
          count: htc.count,
          totalPlayers: htc.totalPlayers,
          consensus: (htc.hasData && htc.telemetry.event.talentTree.length > 0) ? {
            telemetry: htc.telemetry,
            talentString: htc.talentString,
            frequencyPct: htc.frequencyPct ?? {},
          } : null,
          gear: htc.gear ?? null,
          players: htc.topPlayers ?? [],
          hasData: htc.hasData,
        });
      }

      return (
        <BossView
          variants={heroVariants}
          layout={skeletonMap}
          colors={nodeColors}
          difficulty={difficulty}
          spec={spec}
          totalParses={totalAvailableParses}
          wclUrl={wclUrl ?? undefined}
          wowClass={className}
        />
      );
    }

    // Not enough data for consensus
    if (detailedRankings.length > 0) {
      const heroVariants: HeroVariant[] = [{
        id: null,
        name: 'All',
        count: totalConsensusPlayers,
        totalPlayers: totalConsensusPlayers,
        consensus: null,
        gear: null,
        players: detailedRankings,
      }];
      return (
        <BossView
          variants={heroVariants}
          layout={skeletonMap}
          colors={nodeColors}
          difficulty={difficulty}
          spec={spec}
          totalParses={totalAvailableParses}
          wclUrl={wclUrl ?? undefined}
          wowClass={className}
        />
      );
    }

    const diffLabel2 = difficulty === 5 ? 'Mythic' : 'Heroic';
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-2xl opacity-40">
          —
        </div>
        <div>
          <p className="text-zinc-300 font-bold">No {diffLabel2} data</p>
          <p className="text-zinc-600 text-sm mt-1">
            No {diffLabel2} {spec} {className} parses found for this boss.
          </p>
          <p className="text-zinc-700 text-xs mt-3">
            Try switching to {difficulty === 5 ? 'Heroic' : 'Mythic'} using the toggle in the header.
          </p>
        </div>
      </div>
    );
  } catch (err: any) {
    return (
      <div className="bg-red-950/40 border border-red-800/50 text-red-300 px-4 py-3 rounded-xl text-sm">
        <span className="font-bold">Error: </span>{err.message}
      </div>
    );
  }
}
