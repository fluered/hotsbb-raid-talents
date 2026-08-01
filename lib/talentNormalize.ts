// Pure, dependency-free — safe to import from both server code (lib/wow.ts re-exports
// it) and client components (which can't import lib/wow.ts directly, since it pulls in
// server-only next/cache).

// Most talent nodes report as a single WCL CombatantInfo row per node, with `rank`
// already reflecting total ranks invested — for those, Math.max (or just the one row's
// value) is correct. But some "apex"/capstone nodes (e.g. Warrior's Tigereye Brew,
// Priest's Benediction) report MULTIPLE rows under the same nodeID with DIFFERENT
// entry `id`s and rank values that don't form a clean 1/2/3 sequence (observed: rows
// like {rank:1},{rank:2},{rank:1} for a node with 3 real picks) — Math.max collapses
// these down to a smaller, wrong number regardless of whether 2 or 3 were actually
// taken, since the max individual rank value stays the same either way. Verified via
// direct in-game reconstruction test and cross-referencing dozens of real players:
// when a node has multiple distinct entry ids, the true amount invested is the COUNT
// of distinct entries, not the max of their individual rank fields.
export function normalizeTalentTree(
  raw: Array<{ nodeID: number; rank: number; id?: number }>
): Array<{ nodeID: number; rank: number }> {
  const byNode = new Map<number, Array<{ rank: number; id?: number }>>();
  for (const t of raw) {
    if (!byNode.has(t.nodeID)) byNode.set(t.nodeID, []);
    byNode.get(t.nodeID)!.push({ rank: t.rank, id: t.id });
  }
  const result: Array<{ nodeID: number; rank: number }> = [];
  for (const [nodeID, rows] of byNode) {
    if (rows.length === 1) {
      result.push({ nodeID, rank: rows[0].rank });
      continue;
    }
    const distinctIds = new Set(rows.map(r => r.id));
    const effectiveRank = distinctIds.size > 1 ? distinctIds.size : Math.max(...rows.map(r => r.rank));
    result.push({ nodeID, rank: effectiveRank });
  }
  return result;
}
