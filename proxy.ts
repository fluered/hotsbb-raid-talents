import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getRaidBosses } from './lib/bossPage';

// A real 404 for boss pages that do not exist. Every page streams (app/loading.tsx),
// and once a response is streaming its status is already 200, so notFound() inside
// the page can only swap the content. Checking the slug here, before the page starts,
// lets an unknown one fall through to the ordinary not-found route and its 404 status.
// The roster is held in process memory (lib/wow.ts), so this costs nothing when warm;
// if it cannot be read, the request goes through and the page decides.
export async function proxy(request: NextRequest) {
  const slug = request.nextUrl.pathname.split('/')[2] ?? '';
  try {
    const bosses = await getRaidBosses();
    if (bosses.length && !bosses.some(b => b.slug === slug)) {
      return NextResponse.rewrite(new URL('/boss-not-found', request.url));
    }
  } catch {
    // WCL unavailable: let the page render what it can.
  }
  return NextResponse.next();
}

export const config = { matcher: '/boss/:slug' };
