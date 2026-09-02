import { NextRequest, NextResponse } from 'next/server';
import { getMetaBuild } from '../../../lib/metaBuild';
import { SPEC_IDS } from '../../../lib/wow';
import { isAuthorizedInternalCaller } from '../../../lib/internalAuth';
import { logServerError } from '../../../lib/persistentCache';

export const dynamic = 'force-dynamic';

// Discovered live (2026-08-03) that something was hitting this route directly and
// repeatedly with varying params, burning through WCL's entire hourly quota (28k live
// calls in 12h against only 835 cache hits) and breaking real pages that share the same
// budget. isAuthorizedInternalCaller rejects anything else before it costs anything.
export async function GET(request: NextRequest) {
  if (!isAuthorizedInternalCaller(request)) {
    return NextResponse.json({ status: 'error', message: 'Not found' }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const className = searchParams.get('class') ?? '';
  const spec = searchParams.get('spec') ?? '';
  const bossId = parseInt(searchParams.get('boss') ?? '');
  const difficulty = parseInt(searchParams.get('difficulty') ?? '5');
  const region = searchParams.get('region') === 'us-eu' ? 'us-eu' : 'global';
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
    // Surfaced distinctly from a generic error so batch callers (the export script) can
    // detect "we're rate-limited, stop entirely" rather than "this one combo failed."
    if (e?.isRateLimit) {
      return NextResponse.json(
        { status: 'rate_limited', message: e.message, retryAfter: e.retryAfter ?? null },
        { status: 429 }
      );
    }
    await logServerError(`meta-build ${className}/${spec} boss=${bossId} diff=${difficulty}`, e);
    return NextResponse.json({ status: 'error', message: e?.message ?? String(e) }, { status: 500 });
  }
}
