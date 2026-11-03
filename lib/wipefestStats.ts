/* eslint-disable @typescript-eslint/no-explicit-any */ // raw Wipefest JSON
import { getOrSetPersistent } from './persistentCache';

// ─── Wipefest's percentile buckets ────────────────────────────────────────────
//
// For every insight statistic on a boss, Wipefest publishes 101 percentile buckets
// built from the fights it has analysed (api.wipefest.gg/statistics/buckets?boss=…,
// public, no auth; ~1 MB per boss, verified 2026-10-25). Bucket p holds the range of
// values that sat at the p-th percentile among those raids, per difficulty. Placing
// our own figure for the same statistic in those buckets says where this raid sits
// among the raids Wipefest has seen, without fetching any of their logs. Kept a day
// per boss as a compact table; a failed fetch is not cached.

export interface WipefestBuckets {
  encounterId: number;
  fetchedAt: number;
  date: string;
  // "insightId|statistic|Difficulty" → the 101 buckets' [bottomValue, topValue], index = percentile.
  byKey: Record<string, Array<[number, number]>>;
  higherIsBetter: Record<string, boolean>;
}

const API = 'https://api.wipefest.gg';
const HEADERS = { 'User-Agent': 'hotsbb-raid-talents (log review; definitions credited)', 'x-wipefest-game-version': 'warcraft-live', accept: 'application/json' };
const TTL_SECONDS = 86400;
export const bucketKey = (insightId: string, statistic: string, difficulty: string) => `${insightId}|${statistic}|${difficulty}`;

export async function getWipefestBuckets(encounterId: number): Promise<WipefestBuckets | null> {
  if (!encounterId) return null;
  try {
    const v = await getOrSetPersistent<WipefestBuckets | { none: true }>(`wipefest-buckets-v1-${encounterId}`, TTL_SECONDS, async () => {
      const r = await fetch(`${API}/statistics/buckets?boss=${encounterId}`, { headers: HEADERS, cache: 'no-store' });
      if (r.status === 404 || r.status === 400) return { none: true };
      if (!r.ok) throw new Error(`wipefest buckets ${encounterId}: ${r.status}`);
      const j = await r.json();
      const rows: any[] = Array.isArray(j) ? j : [];
      if (!rows.length) return { none: true };
      const byKey: WipefestBuckets['byKey'] = {};
      const higherIsBetter: Record<string, boolean> = {};
      let date = '';
      for (const row of rows) {
        const c = row?.criteria;
        if (!c?.insightId || !c?.name || !c?.difficulty || !Array.isArray(row.percentiles)) continue;
        const key = bucketKey(String(c.insightId), String(c.name), String(c.difficulty));
        const arr: Array<[number, number]> = new Array(101).fill(null).map(() => [NaN, NaN]);
        for (const p of row.percentiles) {
          const i = Number(p?.percentile);
          if (i >= 0 && i <= 100) arr[i] = [Number(p.bottomValue), Number(p.topValue)];
        }
        byKey[key] = arr;
        higherIsBetter[key] = !!c.higherIsBetter;
        if (row.date && !date) date = String(row.date).slice(0, 10);
      }
      return { encounterId, fetchedAt: Date.now(), date, byKey, higherIsBetter };
    });
    return 'none' in v ? null : v;
  } catch (err) {
    console.error('wipefest buckets unavailable', err);
    return null;
  }
}

// Where a value sits among Wipefest's raids: the percentile whose bucket holds it
// (0 = the worst raids, 100 = the best), or null when the statistic has no buckets.
export function wipefestPercentile(b: WipefestBuckets | null, insightId: string, statistic: string, difficulty: string, value: number): number | null {
  if (!b || !Number.isFinite(value)) return null;
  const arr = b.byKey[bucketKey(insightId, statistic, difficulty)];
  if (!arr) return null;
  const hib = b.higherIsBetter[bucketKey(insightId, statistic, difficulty)];
  let best: number | null = null;
  for (let p = 0; p <= 100; p++) {
    const [bottom, top] = arr[p];
    if (!Number.isFinite(bottom) || !Number.isFinite(top)) continue;
    const lo = Math.min(bottom, top), hi = Math.max(bottom, top);
    if (value >= lo && value <= hi) best = p;
  }
  if (best != null) return best;
  // Outside every bucket: better than all of them, or worse.
  const valid = arr.map((x, p) => ({ p, lo: Math.min(x[0], x[1]), hi: Math.max(x[0], x[1]) })).filter(x => Number.isFinite(x.lo) && Number.isFinite(x.hi));
  if (!valid.length) return null;
  const first = valid[0], last = valid[valid.length - 1];
  if (hib) return value > last.hi ? 100 : value < first.lo ? 0 : null;
  return value < last.lo ? 100 : value > first.hi ? 0 : null;
}

export const ordinalWord = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
