import { NextRequest } from 'next/server';

// Distinct from warm-tier-cache/warm-talent-layouts (weekly, deliberately bust + refresh
// data). This one runs frequently and does the opposite: no revalidatePath, no forced
// cache-store bypass — just enough real traffic to keep each route's serverless function
// warm so an infrequent visitor (or a browser silently reloading a discarded background
// tab) doesn't hit a cold start on top of a cold data cache.
const PAGES = ['/', '/dungeons', '/tier-list', '/tier-list/tanks', '/tier-list/healers'];

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'http://localhost:3000';

  const results = await Promise.allSettled(
    PAGES.map(path => fetch(`${base}${path}`))
  );

  const counts = results.reduce(
    (acc, r) => { acc[r.status]++; return acc; },
    { fulfilled: 0, rejected: 0 }
  );

  return Response.json({ warmed: counts.fulfilled, failed: counts.rejected, ts: new Date().toISOString() });
}
