import { NextRequest, NextResponse } from 'next/server';
import { getMetaBuild } from '../../../lib/metaBuild';
import { SPEC_IDS } from '../../../lib/wow';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const className = searchParams.get('class') ?? '';
  const spec = searchParams.get('spec') ?? '';
  const bossId = parseInt(searchParams.get('boss') ?? '');
  const difficulty = parseInt(searchParams.get('difficulty') ?? '5');
  const region = searchParams.get('region') === 'eu' ? 'eu' : 'us';
  const metric = searchParams.get('metric') ?? undefined;

  if (!className || !SPEC_IDS[className]) {
    return NextResponse.json({ status: 'error', message: `Unknown class '${className}'. Valid: ${Object.keys(SPEC_IDS).join(', ')}` }, { status: 400 });
  }
  if (!spec || !SPEC_IDS[className][spec]) {
    return NextResponse.json({ status: 'error', message: `Unknown spec '${spec}' for ${className}. Valid: ${Object.keys(SPEC_IDS[className]).join(', ')}` }, { status: 400 });
  }
  if (!Number.isFinite(bossId)) {
    return NextResponse.json({ status: 'error', message: 'Missing or invalid ?boss=<encounterId>' }, { status: 400 });
  }

  try {
    const result = await getMetaBuild({ bossId, className, spec, difficulty, region, metric });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400' },
    });
  } catch (e: any) {
    return NextResponse.json({ status: 'error', message: e?.message ?? String(e) }, { status: 500 });
  }
}
