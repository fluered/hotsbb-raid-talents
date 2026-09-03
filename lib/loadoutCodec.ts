// In-game talent loadout string codec — reverse-engineered and validated bit-exact
// against 40 real player strings across Monk/Warrior/Druid (2026-09-02; see the
// corpus round-trip in the session that built this).
//
// Format (serialization version 2): a bitstream packed LSB-first into 6-bit chars of
// CHARSET. Header: version(8), specId(16), treeHash(128). Then one record per node of
// the FULL CLASS tree (every spec's class+spec+hero nodes, ascending node id):
//   selected(1) — 0 for unselected AND granted-only nodes (current exporter style)
//   if selected: purchased(1)=1, partiallyRanked(1) [+ranksPurchased(6) if partial],
//                isChoice(1) [+entryIndex(2) if choice]
// Three inputs can't come from Blizzard's API and are HARVESTED from live profile
// strings into Redis (self-teaching, like the entry→node and trait→talent maps):
//   - the 128-bit tree hash (identical across every same-class string of a build)
//   - hero subtree-selector nodes and their heroTreeId→entryIndex mapping (the API
//     shows them as plain nodes; their entry order matches nothing else observable —
//     Druid's is [Elune's Chosen, Keeper], neither id- nor API-ordered)
//   - apex rank caps (API maxRanks undercounts tiered capstones like Tigereye Brew)
import { getPersistentReadOnly, setPersistentValue } from './persistentCache';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHAR_IDX: Record<string, number> = Object.fromEntries([...CHARSET].map((c, i) => [c, i]));

const FORMAT_KEY = 'loadout-format-v1';
const FORMAT_MEMO_MS = 5 * 60 * 1000;
let formatMemo: { data: LoadoutFormatData; at: number } | null = null;

export interface LoadoutFormatData {
  bySpec: Record<number, { version: number; hash: number[] }>;
  selectors: Record<number, Record<number, number>>;
  apexCaps: Record<number, number>;
}

async function loadFormatData(): Promise<LoadoutFormatData> {
  if (formatMemo && Date.now() - formatMemo.at < FORMAT_MEMO_MS) return formatMemo.data;
  const data = (await getPersistentReadOnly<LoadoutFormatData>(FORMAT_KEY)) ?? { bySpec: {}, selectors: {}, apexCaps: {} };
  formatMemo = { data, at: Date.now() };
  return data;
}

// Plain-number bit IO: the accumulator never holds more than ~22 bits (largest field
// is 16, plus at most 5 pending), safely inside JS 32-bit bitwise range — no BigInt.
function bitReader(code: string) {
  let acc = 0, bits = 0, pos = 0;
  const read = (n: number): number => {
    while (bits < n) {
      const v = CHAR_IDX[code[pos++]];
      if (v === undefined) throw new Error('bad char');
      acc |= v << bits;
      bits += 6;
    }
    const out = acc & ((1 << n) - 1);
    acc >>>= n;
    bits -= n;
    return out;
  };
  const cleanEnd = () => {
    if (acc !== 0) return false;
    while (pos < code.length) if (CHAR_IDX[code[pos++]] !== 0) return false;
    return true;
  };
  return { read, cleanEnd };
}

function bitWriter() {
  let acc = 0, bits = 0, out = '';
  return {
    write(n: number, v: number) {
      acc |= v << bits;
      bits += n;
      while (bits >= 6) {
        out += CHARSET[acc & 63];
        acc >>>= 6;
        bits -= 6;
      }
    },
    finish() {
      if (bits > 0) out += CHARSET[acc & 63];
      return out;
    },
  };
}

export interface ClassTreeNode {
  maxRanks: number;
  granted: number;
  // Blizzard talent-catalog ids in API option order; null for non-choice nodes.
  choiceTalentIds: number[] | null;
  isHero: boolean;
  heroTreeId: number | null;
}
// Keyed by node id; always iterated sorted ascending.
export type ClassTree = Record<number, ClassTreeNode>;

// Decode a real string against a class tree. Used by the harvester and as the
// encoder's self-check. Returns null unless the stream ends exactly on zero padding —
// a stale-tree string must never teach the harvester anything.
export function decodeLoadoutString(code: string, tree: ClassTree): null | {
  version: number;
  specId: number;
  hash: number[];
  records: Map<number, { purchased: number; ranks: number | null; choiceIdx: number | null }>;
} {
  try {
    const { read, cleanEnd } = bitReader(code);
    const version = read(8);
    const specId = read(16);
    const hash = Array.from({ length: 16 }, () => read(8));
    const records = new Map<number, { purchased: number; ranks: number | null; choiceIdx: number | null }>();
    for (const key of Object.keys(tree).map(Number).sort((a, b) => a - b)) {
      if (!read(1)) continue;
      const purchased = read(1);
      let ranks: number | null = null;
      let choiceIdx: number | null = null;
      if (purchased) {
        if (read(1)) ranks = read(6);
        if (read(1)) choiceIdx = read(2);
      }
      records.set(key, { purchased, ranks, choiceIdx });
    }
    if (!cleanEnd()) return null;
    return { version, specId, hash, records };
  } catch {
    return null;
  }
}

// Harvest format data from a live profile string that decodes cleanly against the
// current tree: the spec's hash+version, selector idx pairs, apex caps. Awaited by
// callers (Vercel post-response freeze). Cheap no-op when nothing is new.
export async function harvestLoadoutFormat(code: string, tree: ClassTree): Promise<void> {
  const dec = decodeLoadoutString(code, tree);
  if (!dec) return;
  const data = await loadFormatData();
  let grew = false;
  const existing = data.bySpec[dec.specId];
  if (!existing || existing.version !== dec.version || existing.hash.join(',') !== dec.hash.join(',')) {
    data.bySpec[dec.specId] = { version: dec.version, hash: dec.hash };
    grew = true;
  }
  let activeHero: number | null = null;
  for (const id of dec.records.keys()) {
    const m = tree[id];
    if (m?.isHero) { activeHero = m.heroTreeId; break; }
  }
  for (const [id, r] of dec.records) {
    const meta = tree[id];
    if (!meta) continue;
    if (r.choiceIdx != null && !meta.choiceTalentIds && activeHero != null) {
      const cur = (data.selectors[id] ??= {});
      if (cur[activeHero] !== r.choiceIdx) {
        cur[activeHero] = r.choiceIdx;
        grew = true;
      }
    }
    if (r.ranks != null && (data.apexCaps[id] ?? 0) < r.ranks + 1) {
      // Partially-ranked record: the true cap exceeds the written rank.
      data.apexCaps[id] = r.ranks + 1;
      grew = true;
    }
  }
  if (grew) {
    formatMemo = { data, at: Date.now() };
    await setPersistentValue(FORMAT_KEY, data);
  }
}

export interface EncodeSelection {
  nodeId: number;
  ranksPurchased: number;
  // For choice nodes: the chosen option's Blizzard talent-catalog id (bridge-translated).
  choiceTalentId?: number | null;
}

// Encode a loadout string, or null when any required knowledge is missing — a
// missing string is always better than a confidently wrong one (same rule as the
// profile matcher's 80% floor). Self-checks by decoding its own output.
export async function encodeLoadoutString(
  specId: number,
  tree: ClassTree,
  selections: EncodeSelection[]
): Promise<string | null> {
  const data = await loadFormatData();
  const spec = data.bySpec[specId];
  if (!spec) return null; // hash not yet harvested for this spec

  const byNode = new Map<number, EncodeSelection>();
  for (const s of selections) if (s.ranksPurchased > 0) byNode.set(s.nodeId, s);

  let activeHero: number | null = null;
  for (const s of selections) {
    const m = tree[s.nodeId];
    if (m?.isHero) { activeHero = m.heroTreeId; break; }
  }

  const w = bitWriter();
  w.write(8, spec.version);
  w.write(16, specId);
  for (const b of spec.hash) w.write(8, b);
  for (const key of Object.keys(tree).map(Number).sort((a, b) => a - b)) {
    const meta = tree[key];
    if (data.selectors[key] !== undefined) {
      // Subtree selector node: required whenever a hero tree is active.
      if (activeHero == null) { w.write(1, 0); continue; }
      const selectorIdx = data.selectors[key][activeHero];
      if (selectorIdx === undefined) return null; // mapping not harvested yet
      w.write(1, 1); w.write(1, 1); w.write(1, 0); w.write(1, 1); w.write(2, selectorIdx);
      continue;
    }
    const sel = byNode.get(key);
    if (!sel) { w.write(1, 0); continue; }
    w.write(1, 1);
    w.write(1, 1);
    const cap = Math.max(meta.maxRanks - meta.granted, data.apexCaps[key] ?? 0);
    const partial = sel.ranksPurchased < cap;
    w.write(1, partial ? 1 : 0);
    if (partial) w.write(6, sel.ranksPurchased);
    if (meta.choiceTalentIds) {
      const idx = sel.choiceTalentId != null ? meta.choiceTalentIds.indexOf(sel.choiceTalentId) : -1;
      if (idx < 0) return null; // chosen option unknown — refuse, never guess
      w.write(1, 1);
      w.write(2, idx);
    } else {
      w.write(1, 0);
    }
  }
  const out = w.finish();

  // Self-check: our own decode must reproduce the selections exactly.
  const back = decodeLoadoutString(out, tree);
  if (!back || back.specId !== specId) return null;
  for (const [id, sel] of byNode) {
    const r = back.records.get(id);
    if (!r || !r.purchased) return null;
    if (r.ranks != null && r.ranks !== sel.ranksPurchased) return null;
  }
  return out;
}
