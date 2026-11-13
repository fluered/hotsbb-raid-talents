import { fetchTankHits, type FightPlayer, type PlayerProfile, type PoolSummary, type RaidMechanicStats, type ReportFight } from './analyze';
import { classifyAbility } from './analyzeRules';
import type { BossKnowledge } from './bossMechanics';
import { isDefensive } from './defensives';
import { lorrgsTaggedForSpec, type LorrgsSpell } from './lorrgsSpells';
import { mitigationCandidates, readsAsMitigation, tankAuraPlan, tankHitAbilities, type RoleData } from './roleRules';
import { mapConcurrent } from './wow';

// ─── Log review: the facts the role checks need ─────────────────────────────────
//
// lib/roleRules.ts is pure; this gathers what it cannot work out from the profile and
// the pool alone. Cost per review:
//   tank    one Warcraft Logs request (the tank's hits from tank mechanics and melee,
//           with the auras on them at each hit), plus a Wowhead tooltip per candidate
//           mitigation buff (cached a week per spell, like every other spell fact).
//   healer  nothing: the raid cooldowns are lorrgs' list, already loaded.
// Every failure is isolated: a part that cannot be read is left out and its check stays
// silent, the review itself never fails on it.

// What an aura does, in Wowhead's words for the buff itself ("Armor increased by…",
// "Block chance increased by 100%"): the `buff` text of the same tooltip JSON that
// getSpellInfo reads, which keeps only the spell's own text. Cached a week by Next's
// fetch cache; at most 16 lookups per tank review, the first time a spec is seen.
async function auraText(spellId: number): Promise<{ text: string; itemEffect: boolean } | null> {
  const r = await fetch(`https://nether.wowhead.com/tooltip/spell/${spellId}?dataEnv=1&locale=0`, { headers: { 'User-Agent': 'hotsbb-talents-log-review (hotsbbtalents.io)' }, next: { revalidate: 7 * 86400 } });
  if (!r.ok) return null;
  const j = await r.json() as { buff?: string; tooltip?: string };
  const strip = (html: string | undefined) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return { text: strip(j.buff), itemEffect: /Item Effect/i.test(strip(j.tooltip)) };
}

export async function loadRoleData(opts: {
  token: string; code: string; fight: ReportFight; player: FightPlayer; profile: PlayerProfile;
  pool: PoolSummary | null; boss: BossKnowledge | null | undefined; raidStats: RaidMechanicStats | null | undefined; lorrgs: LorrgsSpell[] | null;
}): Promise<RoleData | null> {
  const { token, code, fight, player, profile, pool, boss, raidStats, lorrgs } = opts;
  if (player.role === 'healer') {
    return { healer: { raidCooldowns: lorrgs ? lorrgsTaggedForSpec(lorrgs, player.className, player.spec, 'RAID_CD').map(s => ({ name: s.name, ids: s.ids, cooldown: s.cooldown })) : [] } };
  }
  if (player.role !== 'tank') return null;
  const tankSpells = lorrgs ? lorrgsTaggedForSpec(lorrgs, player.className, player.spec, 'TANK').map(s => ({ name: s.name, ids: s.ids, duration: s.duration })) : [];
  // Which of the candidate buffs are damage reduction, by Wowhead's tooltip. An item's
  // proc is not something the tank presses, so it does not count as active mitigation.
  // A defensive cooldown is not active mitigation either: it covers a hit as a defensive
  // (see tankAuraPlan), and its uptime is the cooldown checks' business.
  const cooldownNames = new Set(tankSpells.map(s => s.name));
  const candidates = mitigationCandidates(pool).filter(c => !isDefensive(c.name) && !cooldownNames.has(c.name));
  const verdicts = await mapConcurrent(candidates, 8, async c => {
    const aura = await auraText(c.spellId).catch(() => null);
    return !!aura && !aura.itemEffect && readsAsMitigation(aura.text);
  });
  const mitigationNames = candidates.filter((_, i) => verdicts[i]).map(c => c.name);
  const { mitigation, auras } = tankAuraPlan(profile, pool, mitigationNames, tankSpells);
  const abilities = tankHitAbilities(profile, (name, spellId) => classifyAbility(boss, raidStats, name, spellId)?.type);
  // Without a discovered mitigation buff there is nothing to check the hits against.
  const hits = mitigation.length && Object.keys(abilities).length
    ? await fetchTankHits(token, code, fight, player.id, Object.keys(abilities).map(Number), Object.keys(auras).map(Number)).catch(err => { console.error('analyze: tank hits unavailable', err); return null; })
    : null;
  return { tank: { mitigation, tankSpells, auras, abilities, hits, considered: candidates.map((c, i) => ({ name: c.name, mitigation: verdicts[i] })) } };
}
