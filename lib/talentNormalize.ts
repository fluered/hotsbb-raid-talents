// Pure, dependency-free — safe to import from both server code (lib/wow.ts re-exports
// it) and client components (which can't import lib/wow.ts directly, since it pulls in
// server-only next/cache).

// Most talent nodes report as a single WCL CombatantInfo row per node, with `rank`
// already reflecting total ranks invested — for those, Math.max (or just the one row's
// value) is correct. But some "apex"/capstone nodes (e.g. Warrior's Tigereye Brew,
// Priest's Benediction) are Tiered nodes: each rank is a SEPARATE sub-entry with its
// OWN independent rank counter (verified live against a real player's game client:
// C_Traits.GetEntryInfo confirms individual sub-entries can themselves hold more than
// 1 rank, e.g. Tigereye Brew's second entry maxRanks=2) — so WCL reports one row per
// sub-entry actually invested in, with that row's `rank` field being how many points
// went into THAT entry specifically, not a running cumulative. The true total is the
// SUM of each distinct entry's own rank, not just a count of how many entries appear
// (counting undercounts whenever an entry itself holds more than 1 point — e.g. rows
// {rank:1,id:A},{rank:2,id:B},{rank:1,id:C} is 4 total, not 3).
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
    // Group by entry id first (max rank seen per id, in case the same entry shows up
    // in more than one row) before deciding count vs. sum, so a node that legitimately
    // reports the same single entry multiple times doesn't get double-counted.
    const maxById = new Map<number | undefined, number>();
    for (const r of rows) maxById.set(r.id, Math.max(maxById.get(r.id) ?? 0, r.rank));
    const effectiveRank = maxById.size > 1
      ? Array.from(maxById.values()).reduce((sum, r) => sum + r, 0)
      : Math.max(...rows.map(r => r.rank));
    result.push({ nodeID, rank: effectiveRank });
  }
  return result;
}
