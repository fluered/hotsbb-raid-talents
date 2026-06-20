import { NextRequest } from 'next/server';

const PAGES = [
  '/tier-list',
  '/tier-list?difficulty=4',
  '/tier-list?region=eu',
  '/tier-list?difficulty=4&region=eu',
  '/tier-list/tanks',
  '/tier-list/tanks?difficulty=4',
  '/tier-list/tanks?region=eu',
  '/tier-list/tanks?difficulty=4&region=eu',
  '/tier-list/healers',
  '/tier-list/healers?difficulty=4',
  '/tier-list/healers?region=eu',
  '/tier-list/healers?difficulty=4&region=eu',
];

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'http://localhost:3000';

  const results = await Promise.allSettled(
    PAGES.map(path => fetch(`${base}${path}`, { next: { revalidate: 0 } }))
  );

  const counts = results.reduce(
    (acc, r) => { acc[r.status]++; return acc; },
    { fulfilled: 0, rejected: 0 }
  );

  return Response.json({ warmed: counts.fulfilled, failed: counts.rejected, ts: new Date().toISOString() });
}
