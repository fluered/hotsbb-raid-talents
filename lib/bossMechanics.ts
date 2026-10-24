/* eslint-disable @typescript-eslint/no-explicit-any */ // raw GitHub / Blizzard / Wowhead JSON
import { getOrSetPersistent } from './persistentCache';
import { mapConcurrent } from './wow';

// ─── Boss mechanic knowledge: what each boss ability IS ───────────────────────
//
// Automated sources, no hand-written per-boss files:
//
// 1. Deadly Boss Mods. Every special warning in a DBM boss module carries the
//    mechanic's type twice — in the constructor name (NewSpecialWarningDodge…,
//    …Soak…, …Defensive…) and in the voice-pack key at the end ("watchstep",
//    "helpsoak", "stilldanger"). One regex over the raid's modules gives a
//    spell-id → mechanic map that DBM's own team keeps current within days of a
//    raid opening. DBM is "All Rights Reserved": only this derived data table is
//    kept, none of their code, and the source is credited on the page.
//
// 2. Blizzard's Encounter Journal for the official ability list (name + spell id
//    per boss). Its sections carry no description text and Blizzard's spell
//    endpoint 404s for boss spells (verified live), so…
//
// 3. Wowhead's tooltip JSON supplies the name and description for any spell id,
//    which is what resolves DBM's cast ids to names and gives the "what it is"
//    sentence under a finding. The site already credits Wowhead for spell links.
//
// Everything is cached a day (labels) or a week (journal) in Redis per raid/boss,
// so a review never waits on GitHub or Wowhead.

export type MechanicType =
  | 'avoid' | 'soak' | 'raidwide' | 'defensive' | 'tank' | 'add'
  | 'spread' | 'gather' | 'interrupt' | 'dispel' | 'fixate' | 'debuff' | 'targeted' | 'unknown';

export interface MechanicLabel {
  spellId: number;
  name: string;        // '' when unresolved
  type: MechanicType;
  fn: string;          // DBM constructor suffix, e.g. "DodgeCount"
  key: string;         // DBM voice key, e.g. "watchstep"
  boss: string;        // DBM module file stem, e.g. "Ulatek"
}

export interface JournalAbility {
  spellId: number;
  name: string;
  description: string;
}

export interface BossKnowledge {
  bossName: string;
  labels: MechanicLabel[];
  journal: JournalAbility[];   // journal abilities + DBM-labelled abilities, with descriptions where known
  overview: string | null;
  sources: { dbm: boolean; journal: boolean; descriptions: boolean };
}

export const MECHANIC_WORDS: Record<MechanicType, string> = {
  avoid: 'something to move out of',
  soak: 'a soak',
  raidwide: 'unavoidable raid-wide damage',
  defensive: 'a big hit to use a defensive for',
  tank: 'a tank mechanic',
  add: 'an add to switch to',
  spread: 'a spread mechanic',
  gather: 'a stack-and-share mechanic',
  interrupt: 'an interruptible cast',
  dispel: 'something to dispel',
  fixate: 'a fixate',
  debuff: 'a personal debuff',
  targeted: 'a targeted mechanic',
  unknown: 'a mechanic',
};

// Voice keys seen across DBM's Midnight raid modules plus the common historical
// ones. Anything unmapped stays 'unknown' (still recorded, so it can be mapped later).
const VOICE_TYPES: Record<string, MechanicType> = {
  watchstep: 'avoid', watchwave: 'avoid', watchorb: 'avoid', watchfeet: 'avoid', frontal: 'avoid',
  justrun: 'avoid', runout: 'avoid', runaway: 'avoid', lineyou: 'avoid', farfromline: 'avoid',
  beamincoming: 'avoid', chargeyou: 'avoid', moveaway: 'avoid', getout: 'avoid', watchorbs: 'avoid',
  scatter: 'spread', bombyou: 'spread', spreadout: 'spread',
  gathershare: 'gather', gather: 'gather', stack: 'gather', movein: 'gather', runin: 'gather',
  helpsoak: 'soak', soakincoming: 'soak', soakpool: 'soak', soakyou: 'soak',
  defensive: 'defensive', shieldsoon: 'defensive',
  stilldanger: 'raidwide', aesoon: 'raidwide', aoesoon: 'raidwide', bigaoe: 'raidwide',
  tankcombo: 'tank', tauntboss: 'tank', tankbuster: 'tank', tauntother: 'tank',
  mobsoon: 'add', bigmob: 'add', killmob: 'add', dpshard: 'add', findmc: 'add', attackshield: 'add', targetchange: 'add', switchboss: 'add',
  kickcast: 'interrupt', interrupt: 'interrupt',
  helpdispel: 'dispel', dispelnow: 'dispel',
  fixateyou: 'fixate',
  debuffyou: 'debuff',
};

// Constructor name beats the voice key when it is specific.
function typeFromConstructor(fn: string): MechanicType | null {
  if (/moveto|stack/i.test(fn)) return 'gather';
  if (/dodge|run|moveaway/i.test(fn)) return 'avoid';
  if (/soak/i.test(fn)) return 'soak';
  if (/defensive/i.test(fn)) return 'defensive';
  if (/taunt|tankbuster/i.test(fn)) return 'tank';
  if (/switch/i.test(fn)) return 'add';
  if (/spread/i.test(fn)) return 'spread';
  if (/interrupt/i.test(fn)) return 'interrupt';
  if (/dispel/i.test(fn)) return 'dispel';
  return null;
}

export const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ─── Wowhead tooltip JSON: name + description for any spell id ────────────────

const UA = { 'User-Agent': 'hotsbb-talents-log-review (hotsbbtalents.io)' };

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function wowheadSpell(spellId: number): Promise<{ name: string; description: string } | null> {
  try {
    const r = await fetch(`https://nether.wowhead.com/tooltip/spell/${spellId}?dataEnv=1&locale=0`, { headers: UA, next: { revalidate: 7 * 86400 } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.name) return null;
    // The tooltip is two tables: the header (name, range, cast time) and the body.
    const tables = String(j.tooltip ?? '').split('</table>');
    const body = tables.length > 1 ? tables.slice(1).join(' ') : '';
    return { name: String(j.name), description: stripHtml(body) };
  } catch {
    return null;
  }
}

// "2 min cooldown" / "45 sec cooldown" from the tooltip header; null when the id is a
// buff with no cooldown text of its own. Cached a week per spell id.
export async function getSpellCooldownSec(spellId: number): Promise<number | null> {
  if (!spellId) return null;
  const key = `spell-cd-v1-${spellId}`;
  const v = await getOrSetPersistent<number>(key, 7 * 86400, async () => {
    try {
      const r = await fetch(`https://nether.wowhead.com/tooltip/spell/${spellId}?dataEnv=1&locale=0`, { headers: UA, next: { revalidate: 7 * 86400 } });
      if (!r.ok) return -1;
      const j = await r.json();
      const head = stripHtml(String(j?.tooltip ?? '').split('</table>')[0] ?? '');
      const m = head.match(/(\d+(?:\.\d+)?)\s*(sec|min|hr)\s*cooldown/i);
      if (!m) return -1;
      const n = parseFloat(m[1]);
      return m[2].toLowerCase() === 'hr' ? n * 3600 : m[2].toLowerCase() === 'min' ? n * 60 : n;
    } catch {
      return -1;
    }
  });
  return v > 0 ? v : null;
}

// Whether an equipped item has a "Use:" effect and its cooldown, from Wowhead's item
// tooltip. Cached a week per item id.
// The on-use effect is its own spell, often with a different name from the item
// ("Vile Vial of Volatile Venom" casts "Empowering Venom"), so the id is what the
// log is matched on.
export interface ItemUse { onUse: boolean; cooldownSec: number | null; useSpellId: number | null; useSpellName: string | null; effectNames: string[] }
export async function getItemOnUse(itemId: number): Promise<ItemUse> {
  if (!itemId) return { onUse: false, cooldownSec: null, useSpellId: null, useSpellName: null, effectNames: [] };
  const key = `item-use-v6-${itemId}`;
  return getOrSetPersistent<ItemUse>(key, 7 * 86400, async () => {
      const r = await fetch(`https://nether.wowhead.com/tooltip/item/${itemId}?dataEnv=1&locale=0`, { headers: UA, next: { revalidate: 7 * 86400 } });
      if (r.status === 404) return { onUse: false, cooldownSec: null, useSpellId: null, useSpellName: null, effectNames: [] };
      if (!r.ok) throw new Error(`wowhead item ${itemId}: ${r.status}`); // not cached; callers catch and treat as unknown for this request
      const raw = String((await r.json())?.tooltip ?? '');
      const txt = stripHtml(raw);
      const onUse = /Use:\s/.test(txt); // tags strip to nothing, so "AgilityUse:" has no word boundary
      const m = txt.match(/\((\d+(?:\.\d+)?)\s*(sec|min)\s*cooldown\)/i);
      const cooldownSec = m ? (m[2].toLowerCase() === 'min' ? parseFloat(m[1]) * 60 : parseFloat(m[1])) : null;
      const use = onUse ? raw.match(/useText[^>]*>Use:[\s\S]*?<a href="\/spell=(\d+)\//) : null;
      const useSpellId = use ? Number(use[1]) : null;
      const useSpellName = useSpellId ? (await wowheadSpell(useSpellId))?.name ?? null : null;
      const linked = [...new Set([...raw.matchAll(/\/spell=(\d+)\//g)].map(m => Number(m[1])))].slice(0, 6);
      const effectNames: string[] = [];
      await mapConcurrent(linked, 4, async id => { const s = await wowheadSpell(id); if (s?.name) effectNames.push(s.name); });
      return { onUse, cooldownSec, useSpellId, useSpellName, effectNames };
  });
}

// Consumables are recognised from Wowhead's spell text, not their names: this season's
// combat potions are called Light's Potential, Liquid Luster and Draught of Rampant
// Abandon, with "Item Effect … Drink to increase your primary stat". Cached a week.
export interface SpellInfo { name: string; itemEffect: boolean; cooldownSec: number | null; charges: number | null; text: string }
export async function getSpellInfo(spellId: number): Promise<SpellInfo | null> {
  if (!spellId) return null;
  const key = `spell-info-v5-${spellId}`;
  let v: SpellInfo | { none: true };
  try {
    v = await getOrSetPersistent<SpellInfo | { none: true }>(key, 7 * 86400, async () => {
      const r = await fetch(`https://nether.wowhead.com/tooltip/spell/${spellId}?dataEnv=1&locale=0`, { headers: UA, next: { revalidate: 7 * 86400 } });
      if (r.status === 404) return { none: true };
      if (!r.ok) throw new Error(`wowhead spell ${spellId}: ${r.status}`);
      const j = await r.json();
      if (!j?.name) return { none: true };
      const tables = String(j.tooltip ?? '').split('</table>');
      // The header table can be just the name and level; "Item Effect" and the cooldown
      // may sit in the next one, so both are read from the whole text.
      const head = stripHtml(tables.join(' '));
      const m = head.match(/(\d+(?:\.\d+)?)\s*(sec|min|hr)\s*cooldown/i);
      const cooldownSec = m ? (m[2].toLowerCase() === 'hr' ? parseFloat(m[1]) * 3600 : m[2].toLowerCase() === 'min' ? parseFloat(m[1]) * 60 : parseFloat(m[1])) : null;
      // Some tooltips put the description in the first table, so the whole text is kept.
      const ch = head.match(/(\d+)\s*Charges?\b/i);
      return { name: String(j.name), itemEffect: /Item Effect/i.test(head), cooldownSec, charges: ch ? Number(ch[1]) : null, text: stripHtml(tables.join(' ')) };
    });
  } catch {
    return null; // this request only; nothing cached
  }
  return 'none' in v ? null : v;
}
export function isHealingPotionSpell(info: SpellInfo | null): boolean {
  if (!info || !info.itemEffect) return false;
  return /restores? .{0,40}health|heals? you for/i.test(`${info.name} ${info.text}`) && !/mana/i.test(info.name);
}
export function isCombatPotion(info: SpellInfo | null): boolean {
  if (!info || !info.itemEffect) return false;
  const all = `${info.name} ${info.text}`;
  if (/healing potion|health potion|mana potion|restores? .{0,30}(health|mana)/i.test(all)) return false;
  return /\b(drink|potion)\b/i.test(all) && (info.cooldownSec == null || info.cooldownSec >= 120);
}

// ─── DBM ──────────────────────────────────────────────────────────────────────

const GITHUB_CONTENTS = 'https://api.github.com/repos/DeadlyBossMods/DeadlyBossMods/contents';
const GITHUB_HEADERS = { ...UA, Accept: 'application/vnd.github+json' };

async function githubJson(path: string): Promise<any> {
  const r = await fetch(`${GITHUB_CONTENTS}/${path}`, { headers: GITHUB_HEADERS, next: { revalidate: 86400 } });
  if (!r.ok) throw new Error(`GitHub ${path}: HTTP ${r.status}`);
  return r.json();
}

interface RawLabel { spellId: number; fn: string; key: string; boss: string }

function parseDbmModule(src: string, boss: string): RawLabel[] {
  const out: RawLabel[] = [];
  const re = /mod:NewSpecialWarning(\w*)\(\s*(\d+)([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const quoted = [...m[3].matchAll(/"([a-z0-9]+)"/g)].map(x => x[1]);
    out.push({ spellId: Number(m[2]), fn: m[1], key: quoted[quoted.length - 1] ?? '', boss });
  }
  return out;
}

interface DbmRaid { labels: MechanicLabel[]; descriptions: Record<string, string> }

// GitHub paths are case-sensitive and DBM's folder names don't always match a display
// name stripped of spaces ("WarWithin" vs "The War Within"), so both levels are found
// by listing and matching normalised names, never by building the path blind.
async function resolveDbmZoneDir(expansionName: string, zoneName: string): Promise<string> {
  const rootListing: any[] = await githubJson('');
  const raidDirs = rootListing.filter(f => f?.type === 'dir' && /^DBM-Raids-/i.test(f.name ?? ''));
  const wantExp = normalizeName(expansionName);
  const expDir = raidDirs.find(f => normalizeName(f.name.replace(/^DBM-Raids-/i, '')) === wantExp)
    ?? raidDirs.find(f => wantExp.includes(normalizeName(f.name.replace(/^DBM-Raids-/i, ''))))
    ?? (raidDirs.length === 1 ? raidDirs[0] : null);
  if (!expDir) throw new Error(`no DBM raid folder for expansion ${expansionName}`);
  const zoneListing: any[] = await githubJson(expDir.name);
  const wantZone = normalizeName(zoneName);
  const zoneDir = zoneListing.find(f => f?.type === 'dir' && normalizeName(f.name ?? '') === wantZone);
  if (!zoneDir) throw new Error(`no DBM folder for zone ${zoneName} under ${expDir.name}`);
  return `${expDir.name}/${zoneDir.name}`;
}

// All labels for one raid zone (every boss), from DBM-Raids-<expansion>/<Zone>/.
async function getDbmRaidLabels(expansionName: string, zoneName: string): Promise<DbmRaid> {
  const key = `dbm-labels-v3-${normalizeName(expansionName)}-${normalizeName(zoneName)}`;
  return getOrSetPersistent(key, 86400, async () => {
    const dir = await resolveDbmZoneDir(expansionName, zoneName);
    const listing: any[] = await githubJson(dir);
    const files = listing.filter(f => typeof f?.name === 'string' && f.name.endsWith('.lua') && f.download_url);
    const raw: RawLabel[] = [];
    await mapConcurrent(files, 4, async f => {
      const r = await fetch(f.download_url, { headers: GITHUB_HEADERS, next: { revalidate: 86400 } });
      if (!r.ok) return;
      raw.push(...parseDbmModule(await r.text(), f.name.replace(/\.lua$/, '')));
    });
    const ids = [...new Set(raw.map(l => l.spellId))];
    const info = new Map<number, { name: string; description: string }>();
    await mapConcurrent(ids, 6, async id => { const s = await wowheadSpell(id); if (s) info.set(id, s); });
    const descriptions: Record<string, string> = {};
    for (const [id, s] of info) if (s.description) descriptions[String(id)] = s.description;
    const labels = raw.map(l => ({
      spellId: l.spellId,
      name: info.get(l.spellId)?.name ?? '',
      type: typeFromConstructor(l.fn) ?? VOICE_TYPES[l.key] ?? 'unknown',
      fn: l.fn,
      key: l.key,
      boss: l.boss,
    }));
    return { labels, descriptions };
  });
}

// ─── Blizzard Encounter Journal (official ability list) + Wowhead descriptions ──

async function blizzard(path: string, blizzToken: string): Promise<any> {
  const r = await fetch(`https://us.api.blizzard.com${path}${path.includes('?') ? '&' : '?'}namespace=static-us&locale=en_US`, {
    headers: { Authorization: `Bearer ${blizzToken}` }, next: { revalidate: 86400 },
  });
  if (!r.ok) throw new Error(`Blizzard ${path}: HTTP ${r.status}`);
  return r.json();
}

function cleanJournalText(s: string | undefined): string {
  return String(s ?? '')
    .replace(/\$bullet;/g, '• ')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJournal(zoneName: string, bossName: string, blizzToken: string): Promise<{ abilities: JournalAbility[]; overview: string | null }> {
  const key = `journal-v2-${normalizeName(zoneName)}-${normalizeName(bossName)}`;
  return getOrSetPersistent(key, 7 * 86400, async () => {
    const index = await blizzard('/data/wow/journal-instance/index', blizzToken);
    const inst = (index?.instances ?? []).find((i: any) => normalizeName(i.name ?? '') === normalizeName(zoneName));
    if (!inst) return { abilities: [], overview: null };
    const instance = await blizzard(`/data/wow/journal-instance/${inst.id}`, blizzToken);
    const enc = (instance?.encounters ?? []).find((e: any) => normalizeName(e.name ?? '') === normalizeName(bossName));
    if (!enc) return { abilities: [], overview: null };
    const journal = await blizzard(`/data/wow/journal-encounter/${enc.id}`, blizzToken);
    const abilities = new Map<number, JournalAbility>();
    let overview: string | null = null;
    const walk = (sections: any[]) => {
      for (const s of sections ?? []) {
        if (!overview && /^overview$/i.test(s.title ?? '') && s.body_text) overview = cleanJournalText(s.body_text);
        if (s.spell?.id && !abilities.has(s.spell.id)) {
          abilities.set(s.spell.id, { spellId: s.spell.id, name: s.spell.name ?? s.title ?? '', description: cleanJournalText(s.body_text) });
        }
        walk(s.sections);
      }
    };
    walk(journal?.sections);
    // Journal sections carry no text for spells; Wowhead's tooltip does.
    const list = [...abilities.values()];
    await mapConcurrent(list.filter(a => !a.description), 6, async a => {
      const s = await wowheadSpell(a.spellId);
      if (s?.description) a.description = s.description;
    });
    return { abilities: list, overview };
  });
}

// ─── Combined lookup ──────────────────────────────────────────────────────────

export async function getBossKnowledge(opts: { expansionName: string; zoneName: string; bossName: string; blizzToken: string }): Promise<BossKnowledge> {
  const [dbm, journal] = await Promise.all([
    getDbmRaidLabels(opts.expansionName, opts.zoneName).catch(err => { console.error('dbm labels unavailable', err); return null; }),
    getJournal(opts.zoneName, opts.bossName, opts.blizzToken).catch(err => { console.error('journal unavailable', err); return null; }),
  ]);
  const bossKey = normalizeName(opts.bossName);
  // Prefer this boss's module, but keep the whole raid's labels as a fallback:
  // shared trash/add abilities sometimes live in another file.
  const labels = (dbm?.labels ?? []).slice().sort((a, b) => Number(normalizeName(b.boss) === bossKey) - Number(normalizeName(a.boss) === bossKey));
  const journalList: JournalAbility[] = [...(journal?.abilities ?? [])];
  const seen = new Set(journalList.map(j => normalizeName(j.name)));
  for (const l of labels) {
    if (!l.name || seen.has(normalizeName(l.name))) continue;
    const description = dbm?.descriptions[String(l.spellId)] ?? '';
    journalList.push({ spellId: l.spellId, name: l.name, description });
    seen.add(normalizeName(l.name));
  }
  return {
    bossName: opts.bossName,
    labels,
    journal: journalList,
    overview: journal?.overview ?? null,
    sources: {
      dbm: !!dbm && dbm.labels.length > 0,
      journal: !!journal && journal.abilities.length > 0,
      descriptions: journalList.some(j => !!j.description),
    },
  };
}

export function lookupLabel(k: BossKnowledge | null | undefined, name: string, spellId?: number): MechanicLabel | null {
  if (!k) return null;
  const byId = spellId ? k.labels.find(l => l.spellId === spellId && l.type !== 'unknown') : undefined;
  if (byId) return byId;
  const n = normalizeName(name);
  return k.labels.find(l => l.name && normalizeName(l.name) === n && l.type !== 'unknown') ?? null;
}

export function lookupJournal(k: BossKnowledge | null | undefined, name: string, spellId?: number): JournalAbility | null {
  if (!k) return null;
  const byId = spellId ? k.journal.find(j => j.spellId === spellId) : undefined;
  if (byId) return byId;
  const n = normalizeName(name);
  return k.journal.find(j => normalizeName(j.name) === n) ?? null;
}
