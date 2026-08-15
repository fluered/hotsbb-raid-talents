import { NextRequest } from 'next/server';
import { revalidatePath } from 'next/cache';

const PAGES = [
  // Base shell routes with no params — cheap, and the point isn't fresh data here
  // (that's what the rest of this list + warm-talent-layouts handle), it's just
  // keeping each route's serverless function itself from going fully cold between
  // visits. Free-tier Vercel caps cron jobs at once/day, so this weekly run is the
  // only warming these routes get; it won't meaningfully prevent every cold start,
  // but it's the best available without paying for more frequent crons.
  '/',
  '/dungeons',
  // 'us-eu' is the only non-default region value the pages recognize — the old
  // 'region=eu' entries were parsed as Global and just re-warmed the default variant,
  // leaving the real us-eu variants cold.
  '/tier-list',
  '/tier-list?difficulty=4',
  '/tier-list?region=us-eu',
  '/tier-list?difficulty=4&region=us-eu',
  '/tier-list/tanks',
  '/tier-list/tanks?difficulty=4',
  '/tier-list/tanks?region=us-eu',
  '/tier-list/tanks?difficulty=4&region=us-eu',
  '/tier-list/healers',
  '/tier-list/healers?difficulty=4',
  '/tier-list/healers?region=us-eu',
  '/tier-list/healers?difficulty=4&region=us-eu',
];

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Bust the page cache so next render refetches fresh overall tier list data
  revalidatePath('/tier-list');
  revalidatePath('/tier-list/tanks');
  revalidatePath('/tier-list/healers');

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'http://localhost:3000';

  const results = await Promise.allSettled(
    PAGES.map(path => fetch(`${base}${path}`, { cache: 'no-store' }))
  );

  const counts = results.reduce(
    (acc, r) => { acc[r.status]++; return acc; },
    { fulfilled: 0, rejected: 0 }
  );

  return Response.json({ warmed: counts.fulfilled, failed: counts.rejected, ts: new Date().toISOString() });
}
