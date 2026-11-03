import { getOrSetPersistent } from './persistentCache';
import { balanced, kw } from './lorrgsSpells';
import { normalizeName } from './bossMechanics';

// ─── lorrgs' per-boss cast definitions ───────────────────────────────────────
//
// lorrgs.io draws a boss lane above every spec timeline from hand-curated files in
// lorgs/data/expansions/<expansion>/raids/<zone>/<boss>.py: one RaidBoss(id=<WCL
// encounter id>) and a handful of boss.add_cast / add_buff / add_debuff entries with
// the spell id, the mechanic's window (duration) and a colour. The author's own
// one-line comment above each entry ("# Group Soak", "# Tank", "# Burn Window") is
// kept as a note. The files are discovered by listing the repository, never by
// building a path, so a new expansion or raid needs no change here; a boss lorrgs has
// not written up simply has no lane. Cached a day per zone; a failed read is not cached.

export interface LorrgsBossCast {
  spellId: number;
  ids: number[];        // spell id plus lorrgs' variations
  name: string;
  durationSec: number;  // the mechanic's window, not the cast time (0 when none)
  color: string;
  icon: string;
  show: boolean;        // lorrgs' default toggle; hidden rows are tank hits and rotational casts
  kind: 'cast' | 'buff' | 'debuff';
  note: string;         // lorrgs' comment above the entry, e.g. "Group Soak"
}

export interface LorrgsBoss { encounterId: number; name: string; casts: LorrgsBossCast[] }

const CONTENTS = 'https://api.github.com/repos/gitarrg/lorrgs/contents/lorgs/data/expansions';
const HEADERS = { 'User-Agent': 'hotsbb-raid-talents (log review; lorrgs credited)', Accept: 'application/vnd.github+json' };
const TTL_SECONDS = 86400;
export const LORRGS_BOSS_CREDIT = 'boss casts from lorrgs.io’s encounter definitions';

async function listing(path: string): Promise<Array<{ name: string; type: string; download_url?: string }>> {
  const r = await fetch(`${CONTENTS}${path}`, { headers: HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`lorrgs listing ${path}: ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

// The comment line(s) directly above an entry, "# Group Soak" → "Group Soak".
function noteAbove(src: string, at: number): string {
  const before = src.slice(0, at).split('\n');
  const lines: string[] = [];
  for (let i = before.length - 2; i >= 0; i--) {
    const l = before[i].trim();
    if (!l.startsWith('#')) break;
    if (/^#{3,}/.test(l)) break;
    lines.unshift(l.replace(/^#\s?/, '').trim());
  }
  const note = lines.join(' ').trim();
  // A section heading ("Stage One: …", "Spells") or a description is not a label.
  if (!note || note.length > 40 || /^(stage|intermission|phase|spells?|trinkets?)\b/i.test(note)) return '';
  return note;
}

export function parseLorrgsBossFile(src: string): LorrgsBoss | null {
  const head = src.match(/RaidBoss\(/);
  if (!head) return null;
  const args = balanced(src, head.index! + head[0].length - 1) ?? '';
  const id = Number(kw(args, 'id'));
  const name = (kw(args, 'name') ?? '').replace(/^["']|["']$/g, '');
  if (!id || !name) return null;
  const casts: LorrgsBossCast[] = [];
  const byVar = new Map<string, LorrgsBossCast>();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:(\w+)\s*=\s*)?boss\.add_(cast|spell|buff|debuff)\(/g)) {
    const a = balanced(src, m.index! + m[0].length - 1);
    if (a == null) continue;
    const spellId = Number(kw(a, 'spell_id'));
    const nm = (kw(a, 'name') ?? '').replace(/^["']|["']$/g, '');
    if (!spellId || !nm) continue;
    const c: LorrgsBossCast = {
      spellId, ids: [spellId], name: nm,
      durationSec: Number(kw(a, 'duration') ?? 0) || 0,
      color: (kw(a, 'color') ?? '').replace(/^["']|["']$/g, ''),
      icon: (kw(a, 'icon') ?? '').replace(/^["']|["']$/g, ''),
      show: kw(a, 'show') !== 'False',
      kind: m[2] === 'buff' ? 'buff' : m[2] === 'debuff' ? 'debuff' : 'cast',
      note: noteAbove(src, m.index! + m[0].lastIndexOf('boss.add_')),
    };
    casts.push(c);
    if (m[1]) byVar.set(m[1], c);
  }
  for (const m of src.matchAll(/(\w+)\.add_variation\(\s*(\d+)/g)) {
    const c = byVar.get(m[1]);
    if (c && !c.ids.includes(Number(m[2]))) c.ids.push(Number(m[2]));
  }
  return { encounterId: id, name, casts };
}

// Every boss lorrgs has written up for the zone, keyed by WCL encounter id.
async function fetchZone(expansionName: string, zoneName: string): Promise<Record<string, LorrgsBoss>> {
  const exps = await listing('');
  const wantExp = normalizeName(expansionName);
  const exp = exps.find(d => d.type === 'dir' && normalizeName(d.name) === wantExp)
    ?? exps.find(d => d.type === 'dir' && (wantExp.includes(normalizeName(d.name)) || normalizeName(d.name).includes(wantExp)));
  if (!exp) throw new Error(`lorrgs has no expansion folder for ${expansionName}`);
  const raids = await listing(`/${exp.name}/raids`);
  const wantZone = normalizeName(zoneName);
  const zone = raids.find(d => d.type === 'dir' && normalizeName(d.name) === wantZone)
    ?? raids.find(d => d.type === 'dir' && (wantZone.includes(normalizeName(d.name)) || normalizeName(d.name).includes(wantZone)));
  if (!zone) throw new Error(`lorrgs has no raid folder for ${zoneName}`);
  const files = (await listing(`/${exp.name}/raids/${zone.name}`)).filter(f => f.type === 'file' && f.name.endsWith('.py') && !f.name.startsWith('__') && f.download_url);
  const out: Record<string, LorrgsBoss> = {};
  await Promise.all(files.map(async f => {
    const r = await fetch(f.download_url!, { headers: HEADERS, cache: 'no-store' });
    if (!r.ok) return;
    const boss = parseLorrgsBossFile(await r.text());
    if (boss) out[String(boss.encounterId)] = boss;
  }));
  return out;
}

// The boss's lorrgs lane, or null when lorrgs has none for it (or GitHub is unreachable).
export async function getLorrgsBossCasts(expansionName: string, zoneName: string, encounterId: number): Promise<LorrgsBoss | null> {
  if (!expansionName || !zoneName || !encounterId) return null;
  try {
    const zone = await getOrSetPersistent<Record<string, LorrgsBoss>>(`lorrgs-bosses-v1-${normalizeName(expansionName)}-${normalizeName(zoneName)}`, TTL_SECONDS, () => fetchZone(expansionName, zoneName));
    return zone?.[String(encounterId)] ?? null;
  } catch (err) {
    console.error('lorrgs boss casts unavailable', err);
    return null;
  }
}
