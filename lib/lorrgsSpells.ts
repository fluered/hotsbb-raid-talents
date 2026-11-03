import { getOrSetPersistent } from './persistentCache';
import { HEALER_SPECS, SPEC_IDS } from './wow';

// ─── lorrgs' per-spec cooldown definitions ─────────────────────────────────────
//
// lorrgs.io (github.com/gitarrg/lorrgs) keeps a hand-maintained list of each spec's
// cooldowns in lorgs/data/retail/classes/*.py — the rows its spec-ranking timelines draw.
// We read those files straight from GitHub, parse the add_spell/add_buff/add_debuff
// calls, and cache the result a day (the repo moves with every patch). Nothing here
// guesses: a spell is "major" because lorrgs lists it as shown for the spec, or
// because Wowhead's tooltip states a cooldown of a minute or more (that rule lives
// with the caller — see isMajorCooldown).

export interface LorrgsSpell {
  specIds: number[];           // Blizzard spec ids; class-level spells carry every spec of the class
  kind: 'spell' | 'buff' | 'debuff';
  spellId: number;
  name: string;
  cooldown: number;            // seconds; 0 when lorrgs gives none (a buff with no cast, or "dynamic")
  show: boolean;               // lorrgs draws it by default
  query: boolean;              // false: a synthetic marker lorrgs generates itself
  tags: string[];              // SpellTag names: DAMAGE, DEFENSIVE, TANK, RAID_CD, MOVE, DYNAMIC_CD
  variations: number[];        // alternate spell ids for the same button
}

const CLASS_FILES = ['deathknight', 'demonhunter', 'druid', 'evoker', 'hunter', 'mage', 'monk', 'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior'];
// lorrgs moved its data under lorgs/data/retail/ on 2026-11-01 (classic lives beside it);
// the older layout is tried second so a move back costs nothing.
const RAW_BASES = ['https://raw.githubusercontent.com/gitarrg/lorrgs/main/lorgs/data/retail/', 'https://raw.githubusercontent.com/gitarrg/lorrgs/main/lorgs/data/'];
async function fetchData(relPath: string): Promise<string> {
  let last = '';
  for (const base of RAW_BASES) {
    const r = await fetch(base + relPath, { headers: { 'User-Agent': 'hotsbb-raid-talents' }, cache: 'no-store' });
    if (r.ok) return r.text();
    last = `${r.status}`;
    if (r.status !== 404) break;
  }
  throw new Error(`lorrgs ${relPath} ${last}`);
}
const KEY = 'lorrgs-spells-v2';
const TTL_SECONDS = 86400;
export const LORRGS_CREDIT = 'major cooldowns from lorrgs.io\u2019s spec definitions';

export function balanced(s: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
  }
  return null;
}

export function kw(args: string, k: string): string | null {
  const m = args.match(new RegExp(String.raw`(?:^|[,(\s])${k}\s*=\s*("[^"]*"|'[^']*'|\[[^\]]*\]|[^,\n]+)`));
  return m ? m[1].trim() : null;
}

export function parseLorrgsClassFile(src: string): LorrgsSpell[] {
  // Drop full-line comments (lorrgs comments out retired spells); a "#" inside a colour string is kept.
  src = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  const specs: Record<string, { id: number; cls: string | null }> = {};
  for (const m of src.matchAll(/(\w+)\s*=\s*WowSpec\(([^)]*)\)/g)) {
    const id = kw(m[2], 'id');
    if (id) specs[m[1]] = { id: Number(id), cls: kw(m[2], 'wow_class') };
  }
  // Specs lorrgs subclasses (Devourer, Marksmanship, the healers since 2026-10-18):
  // `class DevourerDemonHunter(WowSpec): id: int = 1480 … wow_class: WowClass = DEMONHUNTER`
  // then `DEMONHUNTER_DEVOURER = DevourerDemonHunter()`.
  const classDefs: Record<string, { id: number; cls: string | null }> = {};
  for (const m of src.matchAll(/class (\w+)\(WowSpec\):([\s\S]*?)(?=\nclass |\n[A-Z_][A-Z_0-9]* = |$)/g)) {
    const id = m[2].match(/\bid:\s*int\s*=\s*(\d+)/)?.[1];
    const cls = m[2].match(/wow_class:\s*WowClass\s*=\s*(\w+)/)?.[1] ?? null;
    if (id) classDefs[m[1]] = { id: Number(id), cls };
  }
  for (const m of src.matchAll(/(\w+)\s*=\s*(\w+)\(\)/g)) if (classDefs[m[2]]) specs[m[1]] = classDefs[m[2]];
  // Spells built once and added to several specs (Blur, Malevolence, Demolish).
  const named: Record<string, string> = {};
  for (const m of src.matchAll(/(\w+)\s*=\s*WowSpell\(/g)) {
    const args = balanced(src, m.index! + m[0].length - 1);
    if (args != null) named[m[1]] = args;
  }
  const out: LorrgsSpell[] = [];
  for (const m of src.matchAll(/(\w+)\.add_(spell|buff|debuff)\(/g)) {
    const owner = m[1];
    let args = balanced(src, m.index! + m[0].length - 1);
    if (args == null) continue;
    const first = args.trim().match(/^(\w+)\s*(,|$)/);
    if (first && named[first[1]]) args = named[first[1]] + ',' + args;
    const spellId = kw(args, 'spell_id');
    const name = kw(args, 'name');
    if (!spellId || !name) continue;
    const specIds = specs[owner] ? [specs[owner].id] : Object.values(specs).filter(s => s.cls === owner).map(s => s.id);
    if (!specIds.length) continue;
    out.push({
      specIds,
      kind: m[2] as LorrgsSpell['kind'],
      spellId: Number(spellId),
      name: name.replace(/^["']|["']$/g, ''),
      cooldown: Number(kw(args, 'cooldown') ?? 0) || 0,
      show: kw(args, 'show') !== 'False',
      query: kw(args, 'query') !== 'False',
      tags: [...args.matchAll(/SpellTag\.(\w+)/g)].map(x => x[1]),
      variations: (kw(args, 'variations') ?? '').match(/\d+/g)?.map(Number) ?? [],
    });
  }
  return out;
}

async function fetchAll(): Promise<LorrgsSpell[]> {
  const parts = await Promise.all(CLASS_FILES.map(async f => {
    const spells = parseLorrgsClassFile(await fetchData(`classes/${f}.py`));
    if (!spells.length) throw new Error(`lorrgs ${f}.py parsed to nothing`);
    return spells;
  }));
  const all = parts.flat();
  // Source drift guard: lorrgs refactors its data files from time to time (specs became
  // subclasses on 2026-10-18 and silently vanished). A parse that covers too few specs
  // is a broken parse, not a quiet day; refuse it so nothing wrong gets cached.
  const covered = new Set(all.flatMap(s => s.specIds)).size;
  if (covered < 30) throw new Error(`lorrgs parse covers only ${covered} specs — data format changed?`);
  return all;
}

// ─── lorrgs' externals: buffs other players put on you ─────────────────────────
//
// lorgs/data/externals.py lists the external defensives (Pain Suppression, Ironbark,
// Blessing of Protection…), the power gains (Power Infusion, Blessing of Summer/Autumn)
// and the healer-only ones (Innervate, Spatial Paradox), with the spell id each is logged
// under. Bloodlust lives there too, tracked as the Sated debuff.
export interface LorrgsExternal { spellId: number; ids: number[]; name: string; cooldown: number; duration: number; kind: 'buff' | 'debuff' }

export function parseLorrgsExternals(src: string): LorrgsExternal[] {
  const out: LorrgsExternal[] = [];
  const byVar = new Map<string, LorrgsExternal>();
  for (const m of src.matchAll(/(?:(\w+)\s*=\s*)?OTHER_EXTERNALS\.add_(buff|debuff)\(/g)) {
    const args = balanced(src, m.index! + m[0].length - 1);
    if (args == null) continue;
    const spellId = Number(kw(args, 'spell_id'));
    const name = (kw(args, 'name') ?? '').replace(/^["']|["']$/g, '');
    if (!spellId || !name) continue;
    const e: LorrgsExternal = { spellId, ids: [spellId], name, cooldown: Number(kw(args, 'cooldown') ?? 0) || 0, duration: Number(kw(args, 'duration') ?? 0) || 0, kind: m[2] as 'buff' | 'debuff' };
    out.push(e);
    if (m[1]) byVar.set(m[1], e);
  }
  for (const m of src.matchAll(/(\w+)\.add_variation\(\s*(\d+)/g)) {
    const e = byVar.get(m[1]);
    if (e && !e.ids.includes(Number(m[2]))) e.ids.push(Number(m[2]));
  }
  return out;
}

// The externals list, or null when GitHub is unreachable. A failed fetch is not cached.
export async function getLorrgsExternals(): Promise<LorrgsExternal[] | null> {
  try {
    const list = await getOrSetPersistent<LorrgsExternal[]>('lorrgs-externals-v1', TTL_SECONDS, async () => {
      const parsed = parseLorrgsExternals(await fetchData('externals.py'));
      if (parsed.length < 5) throw new Error('lorrgs externals.py parsed to too little — format changed?');
      return parsed;
    });
    return list?.length ? list : null;
  } catch {
    return null;
  }
}

// All of lorrgs' spells, or null when GitHub is unreachable (callers then fall back
// to Wowhead's cooldown rule alone). A failed fetch is not cached.
export async function getLorrgsSpells(): Promise<LorrgsSpell[] | null> {
  try {
    const all = await getOrSetPersistent<LorrgsSpell[]>(KEY, TTL_SECONDS, fetchAll);
    return all?.length ? all : null;
  } catch {
    return null;
  }
}

export interface MajorSpell { spellId: number; name: string; ids: number[]; cooldown: number; kind: LorrgsSpell['kind'] }

// lorrgs' spells for the spec that are explicitly not major cooldowns: tagged defensive
// or movement, or a raid cooldown on a non-healer (Rallying Cry, Darkness).
export function lorrgsNonMajorsForSpec(all: LorrgsSpell[], className: string, spec: string): MajorSpell[] {
  const specId = SPEC_IDS[className]?.[spec];
  if (!specId) return [];
  const healer = HEALER_SPECS.some(h => h.class === className && h.spec === spec);
  const out: MajorSpell[] = [];
  for (const s of all) {
    if (!s.specIds.includes(specId)) continue;
    const denied = s.tags.includes('DEFENSIVE') || s.tags.includes('MOVE') || (s.tags.includes('RAID_CD') && !healer);
    if (!denied || out.some(o => o.spellId === s.spellId)) continue;
    out.push({ spellId: s.spellId, name: s.name, ids: [s.spellId, ...s.variations], cooldown: s.cooldown, kind: s.kind });
  }
  return out;
}

// Minimum cooldown, in seconds, for a button to count as a major cooldown. The user's
// rule: "the only cooldown under 60 seconds that is a major cooldown is Bestial Wrath".
export const MAJOR_CD_SEC = 60;
export const MAJOR_UNDER_60 = new Set(['Bestial Wrath']);

// lorrgs' shown rows for a spec, narrowed to the ones that are major cooldowns here:
// not defensives or movement; healers' raid cooldowns count (they are a healer's
// majors), nobody else's; a lorrgs cooldown under a minute drops out (Firestorm,
// Fire Breath, Wake of Ashes) unless lorrgs gives no cooldown at all (Void
// Metamorphosis, a buff without a cast).
export function lorrgsMajorsForSpec(all: LorrgsSpell[], className: string, spec: string): MajorSpell[] {
  const specId = SPEC_IDS[className]?.[spec];
  if (!specId) return [];
  const healer = HEALER_SPECS.some(h => h.class === className && h.spec === spec);
  const out: MajorSpell[] = [];
  for (const s of all) {
    // `show` is only lorrgs' default toggle for the row, not a judgement of importance
    // (Divine Toll, Apotheosis and the tank cooldowns ship hidden); a buff or debuff
    // that no button presses (Purgatory, Last Resort) is a proc, not a cooldown.
    if (!s.specIds.includes(specId) || !s.query || s.kind === 'debuff') continue;
    if (s.tags.includes('DEFENSIVE') || s.tags.includes('MOVE')) continue;
    if (s.tags.includes('RAID_CD') && !healer) continue;
    if (s.cooldown > 0 && s.cooldown < MAJOR_CD_SEC && !MAJOR_UNDER_60.has(s.name)) continue;
    if (out.some(o => o.spellId === s.spellId)) continue;
    out.push({ spellId: s.spellId, name: s.name, ids: [s.spellId, ...s.variations], cooldown: s.cooldown, kind: s.kind });
  }
  if (!out.some(o => MAJOR_UNDER_60.has(o.name))) {
    for (const s of all) if (s.specIds.includes(specId) && MAJOR_UNDER_60.has(s.name) && !out.some(o => o.spellId === s.spellId)) out.push({ spellId: s.spellId, name: s.name, ids: [s.spellId, ...s.variations], cooldown: s.cooldown, kind: s.kind });
  }
  return out;
}
