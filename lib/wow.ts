// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function getWclToken() {
  const response = await fetch('https://www.warcraftlogs.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.WCL_CLIENT_ID || '',
      client_secret: process.env.WCL_CLIENT_SECRET || '',
    }),
    next: { revalidate: 3600 },
  });
  if (!response.ok) throw new Error('Failed WCL Authentication');
  return (await response.json()).access_token;
}

export async function getBlizzardToken(region = 'us') {
  const clientId = process.env.BNET_CLIENT_ID;
  const clientSecret = process.env.BNET_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing BNET_CLIENT_ID or BNET_CLIENT_SECRET');
  const response = await fetch(`https://${region}.battle.net/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    next: { revalidate: 3600 },
  });
  if (!response.ok) throw new Error('Blizzard OAuth failed');
  return (await response.json()).access_token;
}

// ─── WCL ──────────────────────────────────────────────────────────────────────

export async function getRaidStructure(token: string) {
  const query = `query { worldData { zones { id name encounters { id name journalID } } } }`;
  const response = await fetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await response.json()).data?.worldData?.zones || [];
}

export async function getMplusEncounters(token: string, zoneId: number) {
  const query = `query { worldData { zone(id: ${zoneId}) { encounters { id name journalID } } } }`;
  const response = await fetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    next: { revalidate: 86400 },
  });
  return (await response.json()).data?.worldData?.zone?.encounters || [];
}

export async function getWclRankings(token: string, bossId: number, className: string, specName: string, difficulty: number, region = 'us', metric?: string, noCache = false) {
  const wclClassName = className.replace(/\s+/g, '');
  const wclSpecName = specName.replace(/\s+/g, '');
  const metricArg = metric ? `, metric: ${metric}` : '';
  const query = `
    query {
      worldData {
        encounter(id: ${bossId}) {
          characterRankings(className: "${wclClassName}", specName: "${wclSpecName}", difficulty: ${difficulty}, serverRegion: "${region.toUpperCase()}"${metricArg})
        }
      }
    }
  `;
  const response = await fetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    ...(noCache ? { cache: 'no-store' } : { next: { revalidate: 604800 } }),
  });
  return (await response.json()).data?.worldData?.encounter?.characterRankings?.rankings || [];
}

export async function getHistoricalFightTelemetry(wclToken: string, reportCode: string, fightId: number, playerName: string) {
  try {
    const query = `
      query {
        reportData {
          report(code: "${reportCode}") {
            masterData { actors(type: "Player") { id name } }
            events(fightIDs: [${fightId}], dataType: CombatantInfo, startTime: 0, endTime: 2147483647) { data }
          }
        }
      }
    `;
    const response = await fetch('https://www.warcraftlogs.com/api/v2/client', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${wclToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      next: { revalidate: 86400 },
    });
    const reportData = (await response.json()).data?.reportData?.report;
    const actors = reportData?.masterData?.actors || [];
    const events = reportData?.events?.data || [];
    const targetActor = actors.find((a: any) => a.name.toLowerCase() === playerName.toLowerCase());
    const matchedSourceId = targetActor ? targetActor.id : null;
    return { sourceId: matchedSourceId, event: events.find((e: any) => e.sourceID === matchedSourceId) || null };
  } catch {
    return { sourceId: null, event: null };
  }
}

// ─── Blizzard ─────────────────────────────────────────────────────────────────

export async function getSpellIconUrl(spellId: number, accessToken: string): Promise<string> {
  try {
    const res = await fetch(
      `https://us.api.blizzard.com/data/wow/media/spell/${spellId}?namespace=static-us`,
      { headers: { 'Authorization': `Bearer ${accessToken}` }, next: { revalidate: 86400 } }
    );
    if (!res.ok) return '';
    return (await res.json()).assets?.[0]?.value ?? '';
  } catch {
    return '';
  }
}

export async function getTalentTreeLayout(treeId: number, specId: number, accessToken: string) {
  const url = `https://us.api.blizzard.com/data/wow/talent-tree/${treeId}/playable-specialization/${specId}?namespace=static-us&locale=en_US`;
  const response = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` }, next: { revalidate: 86400 } });
  if (!response.ok) throw new Error(`Talent tree fetch failed: ${response.status}`);
  const data = await response.json();

  const heroNodeTreeMap = new Map<number, number>();
  for (const ht of (data.hero_talent_trees || [])) {
    for (const n of (ht.hero_talent_nodes || [])) heroNodeTreeMap.set(n.id, ht.id);
  }
  const heroNodeIds = new Set(heroNodeTreeMap.keys());
  const heroTreeNames: Array<{ id: number; name: string; imageUrl: string }> = (data.hero_talent_trees || []).map((ht: any) => {
    const slug = (ht.name as string).toLowerCase().replace(/\s+/g, '_');
    const imageUrl = `https://warcraft.wiki.gg/images/Hero_talent_${slug}.png`;
    return { id: ht.id, name: ht.name, imageUrl };
  });

  const allRaw = [
    ...(data.class_talent_nodes || []).map((n: any) => ({ ...n, _section: 'class', _heroTreeId: null })),
    ...(data.spec_talent_nodes || []).map((n: any) => ({
      ...n,
      _section: heroNodeIds.has(n.id) ? 'hero' : 'spec',
      _heroTreeId: heroNodeTreeMap.get(n.id) ?? null,
    })),
  ];

  const mapped = await Promise.all(allRaw.map(async (node: any) => {
    const firstRank = node.ranks?.[0];
    const tooltip = firstRank?.tooltip ?? firstRank?.choice_of_tooltips?.[0];
    const spellTooltip = tooltip?.spell_tooltip;
    const spellId = spellTooltip?.spell?.id;
    const name = tooltip?.talent?.name ?? '';
    const iconUrl = spellId ? await getSpellIconUrl(spellId, accessToken) : '';
    return {
      nodeID: node.id,
      row: node.display_row,
      column: node.display_col,
      section: node._section as 'class' | 'hero' | 'spec',
      heroTreeId: node._heroTreeId as number | null,
      name,
      maxRanks: node.ranks?.length ?? 1,
      spellId: spellId ?? null,
      iconUrl,
      description: (spellTooltip?.description ?? '').replace(/\|n/gi, '\n'),
      castTime: spellTooltip?.cast_time ?? '',
      range: spellTooltip?.range ?? '',
      cost: spellTooltip?.power_cost ?? '',
      cooldown: spellTooltip?.cooldown ?? '',
    };
  }));

  return { layout: mapped.filter(n => n.name || n.iconUrl), heroTreeNames };
}

export async function getTalentTreeId(specName: string, className: string, accessToken: string): Promise<{ treeId: number; specId: number } | null> {
  const specId = SPEC_IDS[className]?.[specName];
  if (!specId) return null;
  const response = await fetch('https://us.api.blizzard.com/data/wow/talent-tree/index?namespace=static-us&locale=en_US', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Talent tree index failed: ${response.status}`);
  const trees: any[] = (await response.json()).spec_talent_trees || [];
  const match = trees.find((t: any) => {
    const m = t.key?.href?.match(/playable-specialization\/(\d+)/);
    return m && parseInt(m[1]) === specId;
  });
  if (!match) return null;
  const hrefMatch = match.key?.href?.match(/talent-tree\/(\d+)\/playable-specialization\/(\d+)/);
  if (!hrefMatch) return null;
  return { treeId: parseInt(hrefMatch[1]), specId: parseInt(hrefMatch[2]) };
}

// ─── Consensus Helpers ────────────────────────────────────────────────────────

export function computeConsensus(
  telemetries: Array<Array<{ nodeID: number; rank: number }>>,
  threshold = 0.5
): Map<number, number> {
  if (telemetries.length === 0) return new Map();
  const freq = new Map<number, Map<number, number>>();
  for (const tel of telemetries) {
    for (const { nodeID, rank } of tel) {
      if (!freq.has(nodeID)) freq.set(nodeID, new Map());
      const rm = freq.get(nodeID)!;
      rm.set(rank, (rm.get(rank) ?? 0) + 1);
    }
  }
  const result = new Map<number, number>();
  const N = telemetries.length;
  for (const [nodeID, rankMap] of freq) {
    let bestRank = 0, bestCount = 0;
    for (const [rank, count] of rankMap) {
      if (count > bestCount) { bestCount = count; bestRank = rank; }
    }
    if (bestCount / N >= threshold) result.set(nodeID, bestRank);
  }
  return result;
}

export function getActiveHeroTreeId(talentNodes: Array<{ nodeID: number; rank: number }>, layout: any[]): number | null {
  const active = new Set(talentNodes.map(t => t.nodeID));
  for (const node of layout) {
    if (node.section === 'hero' && node.heroTreeId != null && active.has(node.nodeID)) return node.heroTreeId;
  }
  return null;
}

export function makeTelemetry(nodeMap: Map<number, number>) {
  return { event: { talentTree: Array.from(nodeMap.entries()).map(([nodeID, rank]) => ({ nodeID, rank })) } };
}

export function computeFrequencyPct(telemetries: Array<Array<{ nodeID: number; rank: number }>>): Record<number, number> {
  const counts = new Map<number, number>();
  const N = telemetries.length;
  for (const tel of telemetries) {
    const seen = new Set<number>();
    for (const { nodeID } of tel) {
      if (!seen.has(nodeID)) { counts.set(nodeID, (counts.get(nodeID) ?? 0) + 1); seen.add(nodeID); }
    }
  }
  const result: Record<number, number> = {};
  for (const [nodeID, count] of counts) result[nodeID] = Math.round((count / N) * 100);
  return result;
}

export function scoreAgainstMap(fightTalents: Array<{ nodeID: number; rank: number }>, ref: Map<number, number>): number {
  let score = 0;
  for (const { nodeID, rank } of fightTalents) {
    if (ref.get(nodeID) === rank) score++;
  }
  return score;
}

// ─── Static Data ──────────────────────────────────────────────────────────────

export const MIDNIGHT_RAIDS: Record<string, string> = {
  'Sporefall': 'Sporefall',
  'VS / DR / MQD': 'Midnight',
};

export const MPLUS_ZONE_ID = 47; // Midnight Season 1
export const MPLUS_DIFFICULTY = 10; // bracket that returns high-key parses

export const MIDNIGHT_DUNGEONS: Array<{ id: number; name: string; wclCdnId?: number; blizzardInstanceId?: number }> = [
  { id: 12805,  name: 'Windrunner Spire',          blizzardInstanceId: 1299 },
  { id: 12874,  name: 'Maisara Caverns',            wclCdnId: 12874 },
  { id: 12915,  name: 'Nexus-Point Xenas',          wclCdnId: 12915 },
  { id: 112526, name: "Algeth'ar Academy",           blizzardInstanceId: 1201 },
  { id: 12811,  name: "Magisters' Terrace",          wclCdnId: 12811,  blizzardInstanceId: 1300 },
  { id: 10658,  name: 'Pit of Saron',               wclCdnId: 10658,  blizzardInstanceId: 278 },
  { id: 361753, name: 'Seat of the Triumvirate',    blizzardInstanceId: 945 },
  { id: 61209,  name: 'Skyreach',                   blizzardInstanceId: 476 },
];

export const SPEC_IDS: Record<string, Record<string, number>> = {
  'Death Knight':  { 'Blood': 250, 'Frost': 251, 'Unholy': 252 },
  'Demon Hunter':  { 'Havoc': 577, 'Vengeance': 581, 'Devourer': 1480 },
  'Druid':         { 'Balance': 102, 'Feral': 103, 'Guardian': 104, 'Restoration': 105 },
  'Evoker':        { 'Devastation': 1467, 'Preservation': 1468, 'Augmentation': 1473 },
  'Hunter':        { 'Beast Mastery': 253, 'Marksmanship': 254, 'Survival': 255 },
  'Mage':          { 'Arcane': 62, 'Fire': 63, 'Frost': 64 },
  'Monk':          { 'Brewmaster': 268, 'Mistweaver': 270, 'Windwalker': 269 },
  'Paladin':       { 'Holy': 65, 'Protection': 66, 'Retribution': 70 },
  'Priest':        { 'Discipline': 256, 'Holy': 257, 'Shadow': 258 },
  'Rogue':         { 'Assassination': 259, 'Outlaw': 260, 'Subtlety': 261 },
  'Shaman':        { 'Elemental': 262, 'Enhancement': 263, 'Restoration': 264 },
  'Warlock':       { 'Affliction': 265, 'Demonology': 266, 'Destruction': 267 },
  'Warrior':       { 'Arms': 71, 'Fury': 72, 'Protection': 73 },
};

export const POPULAR_SPECS = [
  { class: 'Death Knight', specs: ['Blood', 'Frost', 'Unholy'], color: 'text-[#C41E3A]', border: 'border-[#C41E3A]/50', activeBg: 'bg-[#C41E3A]/10' },
  { class: 'Demon Hunter', specs: ['Havoc', 'Vengeance', 'Devourer'], color: 'text-[#A330C9]', border: 'border-[#A330C9]/50', activeBg: 'bg-[#A330C9]/10' },
  { class: 'Druid', specs: ['Balance', 'Feral', 'Guardian', 'Restoration'], color: 'text-[#FF7D0A]', border: 'border-[#FF7D0A]/50', activeBg: 'bg-[#FF7D0A]/10' },
  { class: 'Evoker', specs: ['Augmentation', 'Devastation', 'Preservation'], color: 'text-[#33937F]', border: 'border-[#33937F]/50', activeBg: 'bg-[#33937F]/10' },
  { class: 'Hunter', specs: ['Beast Mastery', 'Marksmanship', 'Survival'], color: 'text-[#ABD473]', border: 'border-[#ABD473]/50', activeBg: 'bg-[#ABD473]/10' },
  { class: 'Mage', specs: ['Arcane', 'Fire', 'Frost'], color: 'text-[#3FC7EB]', border: 'border-[#3FC7EB]/50', activeBg: 'bg-[#3FC7EB]/10' },
  { class: 'Monk', specs: ['Brewmaster', 'Mistweaver', 'Windwalker'], color: 'text-[#00FF96]', border: 'border-[#00FF96]/50', activeBg: 'bg-[#00FF96]/10' },
  { class: 'Paladin', specs: ['Holy', 'Protection', 'Retribution'], color: 'text-[#F48CBA]', border: 'border-[#F48CBA]/50', activeBg: 'bg-[#F48CBA]/10' },
  { class: 'Priest', specs: ['Discipline', 'Holy', 'Shadow'], color: 'text-white', border: 'border-white/30', activeBg: 'bg-white/5' },
  { class: 'Rogue', specs: ['Assassination', 'Outlaw', 'Subtlety'], color: 'text-[#FFF468]', border: 'border-[#FFF468]/50', activeBg: 'bg-[#FFF468]/10' },
  { class: 'Shaman', specs: ['Elemental', 'Enhancement', 'Restoration'], color: 'text-[#0070DE]', border: 'border-[#0070DE]/50', activeBg: 'bg-[#0070DE]/10' },
  { class: 'Warlock', specs: ['Affliction', 'Demonology', 'Destruction'], color: 'text-[#8787ED]', border: 'border-[#8787ED]/50', activeBg: 'bg-[#8787ED]/10' },
  { class: 'Warrior', specs: ['Arms', 'Fury', 'Protection'], color: 'text-[#C69B6D]', border: 'border-[#C69B6D]/50', activeBg: 'bg-[#C69B6D]/10' },
];

export const ENCHANT_SLOT_LABELS: Record<string, string> = {
  'MAIN_HAND': 'Weapon', 'OFF_HAND': 'Weapon',
  'FINGER_1': 'Rings', 'FINGER_2': 'Rings',
  'BACK': 'Cloak',
  'CHEST': 'Chest',
  'WRIST': 'Bracers',
  'FEET': 'Boots',
  'LEGS': 'Legs',
};

export const ENCHANT_SLOT_ORDER = ['Weapon', 'Rings', 'Cloak', 'Chest', 'Bracers', 'Boots', 'Legs'];

export const HEALER_SPECS: Array<{ class: string; spec: string }> = [
  { class: 'Druid', spec: 'Restoration' },
  { class: 'Evoker', spec: 'Preservation' },
  { class: 'Monk', spec: 'Mistweaver' },
  { class: 'Paladin', spec: 'Holy' },
  { class: 'Priest', spec: 'Discipline' },
  { class: 'Priest', spec: 'Holy' },
  { class: 'Shaman', spec: 'Restoration' },
];

export const TANK_SPECS: Array<{ class: string; spec: string }> = [
  { class: 'Death Knight', spec: 'Blood' },
  { class: 'Demon Hunter', spec: 'Vengeance' },
  { class: 'Druid', spec: 'Guardian' },
  { class: 'Monk', spec: 'Brewmaster' },
  { class: 'Paladin', spec: 'Protection' },
  { class: 'Warrior', spec: 'Protection' },
];

export const DPS_SPECS: Array<{ class: string; spec: string }> = [
  { class: 'Death Knight', spec: 'Frost' },
  { class: 'Death Knight', spec: 'Unholy' },
  { class: 'Demon Hunter', spec: 'Havoc' },
  { class: 'Demon Hunter', spec: 'Devourer' },
  { class: 'Druid', spec: 'Balance' },
  { class: 'Druid', spec: 'Feral' },
  { class: 'Evoker', spec: 'Augmentation' },
  { class: 'Evoker', spec: 'Devastation' },
  { class: 'Hunter', spec: 'Beast Mastery' },
  { class: 'Hunter', spec: 'Marksmanship' },
  { class: 'Hunter', spec: 'Survival' },
  { class: 'Mage', spec: 'Arcane' },
  { class: 'Mage', spec: 'Fire' },
  { class: 'Mage', spec: 'Frost' },
  { class: 'Monk', spec: 'Windwalker' },
  { class: 'Paladin', spec: 'Retribution' },
  { class: 'Priest', spec: 'Shadow' },
  { class: 'Rogue', spec: 'Assassination' },
  { class: 'Rogue', spec: 'Outlaw' },
  { class: 'Rogue', spec: 'Subtlety' },
  { class: 'Shaman', spec: 'Elemental' },
  { class: 'Shaman', spec: 'Enhancement' },
  { class: 'Warlock', spec: 'Affliction' },
  { class: 'Warlock', spec: 'Demonology' },
  { class: 'Warlock', spec: 'Destruction' },
  { class: 'Warrior', spec: 'Arms' },
  { class: 'Warrior', spec: 'Fury' },
];

export const CLASS_IDS: Record<string, number> = {
  'Death Knight': 6, 'Demon Hunter': 12, 'Druid': 11, 'Evoker': 13,
  'Hunter': 3, 'Mage': 8, 'Monk': 10, 'Paladin': 2, 'Priest': 5,
  'Rogue': 4, 'Shaman': 7, 'Warlock': 9, 'Warrior': 1,
};
