/* eslint-disable @typescript-eslint/no-explicit-any */ // raw GitHub JSON
import { getOrSetPersistent } from './persistentCache';
import { mapConcurrent } from './wow';
import { normalizeName } from './bossMechanics';

// ─── BigWigs: what a boss debuff means ──────────────────────────────────────
//
// Every BigWigs raid module declares its debuffs in mod:SetAuraData({...}) with a
// `note` that says why a player gets it, written as a locale template plus the
// spell it refers to: "This debuff will apply to you if your group fails to soak
// %s" with Serpent's Bite, "…if you fail to interrupt the cast of %s" with Dread
// Roar, "Tank Debuff". mod:SetRenames gives the authors' one-word reading of an
// ability (dodge, soak, adds). mod:SetEncounterID ties the file to the Warcraft
// Logs encounter, so no name matching is needed.
//
// BigWigs is "All Rights Reserved: You are free to fork and modify on GitHub,
// please ask us about anything else." Only these derived facts (ids, the sentence
// each note resolves to) are kept, none of their code, and BigWigs is credited on
// the page. The current tier's modules live in the main repository under a folder
// per raid; older tiers move to BigWigs_<Expansion>, which is tried second.

export interface BigWigsNote {
  spellId: number;
  name: string;            // from the module's trailing comment; '' when absent
  note: string;            // the resolved sentence
  refSpellId: number | null; // the spell the note refers to (its name fills %s)
  dispel: string | null;   // "poison", "magic"…
  mechanic: string | null; // "stunned", "snared"…
  mythicOnly: boolean;
}

export interface BigWigsBoss {
  encounterId: number;
  journalId: number | null;
  notes: BigWigsNote[];
  renames: Record<string, string>; // spell id → the authors' word for it ("dodge", "soak", "adds")
}

export const BIGWIGS_CREDIT = 'debuff notes from BigWigs';
const API = 'https://api.github.com/repos';
const HEADERS = { 'User-Agent': 'hotsbb-talents-log-review (hotsbbtalents.io)', Accept: 'application/vnd.github+json' };
const TTL_SECONDS = 86400;

async function listing(repo: string, path: string): Promise<any[]> {
  const r = await fetch(`${API}/${repo}/contents/${path}`, { headers: HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`GitHub ${repo}/${path}: HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
async function raw(url: string): Promise<string> {
  const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`GitHub raw ${url}: HTTP ${r.status}`);
  return r.text();
}

// The text between the brace that opens at `open` and its match.
function braced(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

const stripColour = (s: string) => s.replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '');

// L.key = "text" pairs of a BigWigs locale file.
export function parseLocale(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/^\s*L\.(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/gm)) out[m[1]] = stripColour(m[2].replace(/\\"/g, '"'));
  return out;
}

export function parseBigWigsModule(src: string, locale: Record<string, string>): BigWigsBoss | null {
  const enc = src.match(/SetEncounterID\(\s*(\d+)/);
  if (!enc) return null;
  const journal = src.match(/NewBoss\(\s*"[^"]*"\s*,\s*\d+\s*,\s*(\d+)/);
  const notes: BigWigsNote[] = [];
  const ad = src.indexOf('SetAuraData(');
  if (ad >= 0) {
    const open = src.indexOf('{', ad);
    const body = open >= 0 ? braced(src, open) : null;
    for (const m of (body ?? '').matchAll(/\{\s*(\d+)([^{}]*)\}\s*,?[ \t]*(?:--[ \t]*([^\n]*))?/g)) {
      const spellId = Number(m[1]);
      const opts = m[2];
      const noteKey = opts.match(/note\s*=\s*CL\.(\w+)/)?.[1] ?? null;
      const ref = opts.match(/format\(\s*mod:SpellName\(\s*(\d+)\s*\)/)?.[1];
      const template = noteKey ? locale[noteKey] : null;
      const dispel = opts.match(/dispel\s*=\s*"(\w+)"/)?.[1] ?? null;
      const mechanic = opts.match(/mechanic\s*=\s*"(\w+)"/)?.[1] ?? null;
      const mythicOnly = /difficulty\s*=\s*"mythic"/.test(opts);
      if (!template && !dispel && !mechanic && !mythicOnly) continue;
      notes.push({ spellId, name: (m[3] ?? '').trim(), note: template ?? '', refSpellId: ref ? Number(ref) : null, dispel, mechanic, mythicOnly });
    }
  }
  const renames: Record<string, string> = {};
  const rn = src.indexOf('SetRenames(');
  if (rn >= 0) {
    const open = src.indexOf('{', rn);
    const body = open >= 0 ? braced(src, open) : null;
    for (const m of (body ?? '').matchAll(/\[(\d+)\]\s*=\s*\{\s*CL\.(\w+)/g)) {
      const word = locale[m[2]];
      if (word) renames[m[1]] = word;
    }
  }
  return { encounterId: Number(enc[1]), journalId: journal ? Number(journal[1]) : null, notes, renames };
}

// A raid's modules, keyed by Warcraft Logs encounter id. Null entries never happen:
// a boss without a module is simply absent.
async function fetchZone(expansionName: string, zoneName: string): Promise<Record<string, BigWigsBoss>> {
  const wantZone = normalizeName(zoneName);
  const repos = ['BigWigsMods/BigWigs', `BigWigsMods/BigWigs_${expansionName.replace(/[^A-Za-z0-9]/g, '')}`];
  let found: { repo: string; dir: string } | null = null;
  for (const repo of repos) {
    try {
      const root = await listing(repo, '');
      const dir = root.find(d => d?.type === 'dir' && normalizeName(d.name) === wantZone)
        ?? root.find(d => d?.type === 'dir' && d.name.length > 4 && (wantZone.includes(normalizeName(d.name)) || normalizeName(d.name).includes(wantZone)));
      if (dir) { found = { repo, dir: dir.name }; break; }
    } catch { /* the expansion repository may not exist */ }
  }
  if (!found) throw new Error(`BigWigs has no folder for ${zoneName}`);
  // The locale file's download link comes from the listing, so the branch name is never guessed.
  const [files, localeFiles] = await Promise.all([listing(found.repo, found.dir), listing('BigWigsMods/BigWigs', 'Locales')]);
  const localeFile = localeFiles.find(f => f?.name === 'enUS_common.lua' && f.download_url);
  if (!localeFile) throw new Error('BigWigs Locales/enUS_common.lua not found');
  const locale = parseLocale(await raw(localeFile.download_url));
  const out: Record<string, BigWigsBoss> = {};
  await mapConcurrent(files.filter(f => typeof f?.name === 'string' && f.name.endsWith('.lua') && !f.name.startsWith('!') && f.download_url), 4, async f => {
    const boss = parseBigWigsModule(await raw(f.download_url), locale);
    if (boss) out[String(boss.encounterId)] = boss;
  });
  return out;
}

export async function getBigWigsBoss(expansionName: string, zoneName: string, encounterId: number): Promise<BigWigsBoss | null> {
  if (!expansionName || !zoneName || !encounterId) return null;
  try {
    const zone = await getOrSetPersistent<Record<string, BigWigsBoss>>(`bigwigs-v1-${normalizeName(expansionName)}-${normalizeName(zoneName)}`, TTL_SECONDS, () => fetchZone(expansionName, zoneName));
    return zone?.[String(encounterId)] ?? null;
  } catch (err) {
    console.error('bigwigs unavailable', err);
    return null;
  }
}
