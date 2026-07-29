import { NextRequest, NextResponse } from 'next/server';
import { getBlizzardToken, getTalentTreeId, getCachedTalentLayout, SPEC_IDS } from '../../../lib/wow';

// Allow up to 5 minutes — sequentially fetching 36 specs with rate-limited icon calls takes time
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const blizzardToken = await getBlizzardToken();
  const results: { class: string; spec: string; status: string; ms?: number; missingIcons?: string[] }[] = [];

  for (const [className, specs] of Object.entries(SPEC_IDS)) {
    for (const specName of Object.keys(specs)) {
      const t0 = Date.now();
      try {
        const treeInfo = await getTalentTreeId(specName, className, blizzardToken);
        if (!treeInfo) {
          results.push({ class: className, spec: specName, status: 'no-tree-id' });
          continue;
        }
        const { layout } = await getCachedTalentLayout(treeInfo.treeId, treeInfo.specId, blizzardToken);
        const missingIcons = layout
          .filter(n => (n.spellId && !n.iconUrl) || (n.choiceB?.spellId && !n.choiceB.iconUrl))
          .map(n => `${n.name || n.nodeID}`);
        results.push({
          class: className, spec: specName,
          status: missingIcons.length ? 'missing-icons' : 'ok',
          ms: Date.now() - t0,
          ...(missingIcons.length ? { missingIcons } : {}),
        });
      } catch (e: any) {
        results.push({ class: className, spec: specName, status: `error: ${e?.message ?? e}`, ms: Date.now() - t0 });
      }
    }
  }

  const ok = results.filter(r => r.status === 'ok').length;
  const failed = results.filter(r => r.status !== 'ok').length;
  return NextResponse.json({ ok, failed, results });
}
