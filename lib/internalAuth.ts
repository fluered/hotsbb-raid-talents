import { NextRequest } from 'next/server';

// Shared by every route meant for internal callers only (the batch export script and
// the site's own client-side fetches) — never a public data API. See app/api/meta-build
// for the incident that made this necessary. No secret/env var needed: a real browser
// loading an actual page always sends a Referer for a same-origin fetch; our export
// script is the only other legitimate caller and identifies itself with a fixed header.
const INTERNAL_SCRIPT_HEADER = 'hotsbb-export-script';

export function isAuthorizedInternalCaller(request: NextRequest): boolean {
  if (request.headers.get('x-hbt-internal') === INTERNAL_SCRIPT_HEADER) return true;
  const referer = request.headers.get('referer') || request.headers.get('origin') || '';
  try {
    const host = new URL(referer).hostname;
    return host === 'hotsbbtalents.io' || host.endsWith('.vercel.app') || host === 'localhost';
  } catch {
    return false;
  }
}
