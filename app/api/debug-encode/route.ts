import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedInternalCaller } from '../../../lib/internalAuth';
import { getClassTreeForEncoding, harvestLoadoutStrings, generateTalentString, loadEntryTalentMap } from '../../../lib/wow';
import { decodeLoadoutString } from '../../../lib/loadoutCodec';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Validation harness for the loadout codec (internal-only): given a real profile
// loadout (its export string + its node selections), harvest format knowledge from
// the string, then re-encode the selections through the production pipeline and
// report whether the result is bit-exact. Used to prove the codec against a corpus;
// harmless to leave in place — it makes future format drift diagnosable in one call.
export async function POST(request: NextRequest) {
  if (!isAuthorizedInternalCaller(request)) {
    return NextResponse.json({ status: 'error', message: 'Not found' }, { status: 404 });
  }
  try {
    const body = await request.json();
    const { className, specId, code, nodes } = body as {
      className: string; specId: number; code: string;
      nodes: Array<{ id: number; rank: number; talentId: number | null }>;
    };
    const tree = await getClassTreeForEncoding(className);
    if (!tree) return NextResponse.json({ status: 'error', message: 'no class tree' }, { status: 500 });

    await harvestLoadoutStrings(className, [code]);

    // Selections exactly as production derives them from entries: summed ranks per
    // node minus granted, plus the chosen option's talent id for choice nodes.
    const byNode = new Map<number, { ranksPurchased: number; talentId: number | null }>();
    for (const n of nodes) {
      const meta = (tree as any)[n.id];
      if (!meta) continue; // profile pseudo-nodes aren't serialized
      const cur = byNode.get(n.id) ?? { ranksPurchased: 0, talentId: null };
      cur.ranksPurchased += n.rank;
      if (meta.choiceTalentIds && n.talentId != null) cur.talentId = n.talentId;
      byNode.set(n.id, cur);
    }
    for (const [id, sel] of byNode) {
      const g = (tree as any)[id].granted;
      if (g > 0) sel.ranksPurchased = Math.max(0, sel.ranksPurchased - g);
    }
    let built: string | null;
    if ((body as any).direct) {
      // Codec-only mode: feed Blizzard-space talent ids straight to the encoder,
      // isolating codec correctness from trait→talent bridge coverage.
      const { encodeLoadoutString } = await import('../../../lib/loadoutCodec');
      built = await encodeLoadoutString(specId, tree, [...byNode.entries()]
        .filter(([, sel]) => sel.ranksPurchased > 0)
        .map(([nodeId, sel]) => ({ nodeId, ranksPurchased: sel.ranksPurchased, choiceTalentId: sel.talentId })));
    } else {
      // Full production path: invert to trait-space ids first (production's real input),
      // exercising the bridge translation exactly as resolveMetaBuildPick does.
      const bridge = await loadEntryTalentMap();
      const talentToTrait = new Map<number, number>();
      for (const [trait, talent] of Object.entries(bridge)) talentToTrait.set(talent as number, Number(trait));
      const entries = [...byNode.entries()]
        .filter(([, sel]) => sel.ranksPurchased > 0)
        .map(([nodeId, sel]) => ({
          nodeID: nodeId,
          ranksGranted: 0,
          ranksPurchased: sel.ranksPurchased,
          selectionEntryID: (sel.talentId != null ? talentToTrait.get(sel.talentId) : undefined) ?? -1,
        }));
      built = await generateTalentString(className, specId, entries);
    }

    const decOriginal = decodeLoadoutString(code, tree);
    return NextResponse.json({
      status: 'ok',
      exact: built === code,
      built,
      originalDecodes: decOriginal != null,
      builtLength: built?.length ?? null,
      codeLength: code.length,
    });
  } catch (e: any) {
    return NextResponse.json({ status: 'error', message: e?.message ?? String(e) }, { status: 500 });
  }
}
