import { NextRequest, NextResponse } from 'next/server';
import { getServerErrorLog } from '../../../lib/persistentCache';
import { isAuthorizedInternalCaller } from '../../../lib/internalAuth';

export const dynamic = 'force-dynamic';

// Reads the capped server error log (see logServerError) — the substitute for
// production log access. Internal-only like the other debug routes: same 404-not-403
// shape so the route doesn't advertise its existence.
export async function GET(request: NextRequest) {
  if (!isAuthorizedInternalCaller(request)) {
    return NextResponse.json({ status: 'error', message: 'Not found' }, { status: 404 });
  }
  const limit = Math.min(300, parseInt(new URL(request.url).searchParams.get('limit') ?? '50'));
  try {
    const errors = await getServerErrorLog(limit);
    return NextResponse.json({ status: 'ok', count: errors.length, errors });
  } catch (e: any) {
    return NextResponse.json({ status: 'error', message: e?.message ?? String(e) }, { status: 500 });
  }
}
