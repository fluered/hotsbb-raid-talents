import { getBlizzardToken, getTalentTreeId, getTalentTreeLayout } from '../../../lib/wow';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const spec = searchParams.get('spec') ?? 'Devastation';
  const className = searchParams.get('class') ?? 'Evoker';

  const token = await getBlizzardToken();
  const treeInfo = await getTalentTreeId(spec, className, token);
  const { layout, heroTreeNames } = await getTalentTreeLayout(treeInfo.treeId, treeInfo.specId, token);

  const heroNodes = layout.filter(n => n.section === 'hero');
  const treeIdCounts: Record<string, number> = {};
  for (const n of heroNodes) {
    const key = String(n.heroTreeId);
    treeIdCounts[key] = (treeIdCounts[key] ?? 0) + 1;
  }

  const classNodes = layout.filter(n => n.section === 'class');
  const specNodes  = layout.filter(n => n.section === 'spec');

  // Class nodes with outlier columns (not in the main cluster)
  const classCols = [...new Set(classNodes.map(n => n.column))].sort((a, b) => a - b);
  const mainColMax = classCols.filter(c => c <= 10).at(-1) ?? 0;
  const outlierClassNodes = classNodes.filter(n => n.column > mainColMax);

  const specMaxRow = specNodes.length > 0 ? Math.max(...specNodes.map((n: any) => n.row)) : 0;
  const bottomSpecNodes = specNodes.filter((n: any) => n.row >= specMaxRow - 2);

  return Response.json({
    treeInfo,
    heroTreeNames,
    heroNodeCount: heroNodes.length,
    heroTreeIdCounts: treeIdCounts,
    classRows: [...new Set(classNodes.map(n => n.row))].sort((a, b) => a - b),
    classCols,
    specRows:  [...new Set(specNodes.map(n => n.row))].sort((a, b) => a - b),
    specCols:  [...new Set(specNodes.map(n => n.column))].sort((a, b) => a - b),
    specMaxRow,
    bottomSpecNodes: bottomSpecNodes.map((n: any) => ({ nodeID: n.nodeID, name: n.name, row: n.row, column: n.column, maxRanks: n.maxRanks }))
      .sort((a: any, b: any) => a.row - b.row || a.column - b.column),
    outlierClassNodes: outlierClassNodes.map(n => ({ nodeID: n.nodeID, name: n.name, row: n.row, column: n.column }))
      .sort((a, b) => a.column - b.column || a.row - b.row),
    heroNodesAll: heroNodes.map(n => ({ nodeID: n.nodeID, name: n.name, heroTreeId: n.heroTreeId, row: n.row, column: n.column }))
      .sort((a, b) => a.heroTreeId - b.heroTreeId || a.row - b.row || a.column - b.column),
  });
}
