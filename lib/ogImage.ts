// Shared builder for per-page Open Graph images. Pages can't use Next's
// opengraph-image file convention here because our pages vary by SEARCH PARAMS
// (?class=&spec=&boss=) and the file convention only varies by route segment —
// so generateMetadata points og/twitter at /api/og with the text baked into the
// query string instead.

// Standard WoW class colors — used as the image's accent so a shared link reads
// as "a Mage thing" at a glance, same trick the site itself uses.
export const WOW_CLASS_HEX: Record<string, string> = {
  'Death Knight': '#C41E3A',
  'Demon Hunter': '#A330C9',
  'Druid': '#FF7C0A',
  'Evoker': '#33937F',
  'Hunter': '#AAD372',
  'Mage': '#3FC7EB',
  'Monk': '#00FF98',
  'Paladin': '#F48CBA',
  'Priest': '#FFFFFF',
  'Rogue': '#FFF468',
  'Shaman': '#0070DD',
  'Warlock': '#8788EE',
  'Warrior': '#C69B6D',
};

export function ogImageUrl(params: { title: string; subtitle?: string; kicker?: string; className?: string }): string {
  const q = new URLSearchParams();
  q.set('t', params.title.slice(0, 80));
  if (params.subtitle) q.set('s', params.subtitle.slice(0, 120));
  if (params.kicker) q.set('k', params.kicker.slice(0, 60));
  if (params.className && WOW_CLASS_HEX[params.className]) q.set('c', params.className);
  return `/api/og?${q.toString()}`;
}

// Drop-in openGraph/twitter metadata fragments. Spread into the object
// generateMetadata returns; resolves against metadataBase (set in app/layout.tsx).
export function ogImageMeta(params: { title: string; description: string; imageTitle: string; subtitle?: string; kicker?: string; className?: string }) {
  const url = ogImageUrl({ title: params.imageTitle, subtitle: params.subtitle, kicker: params.kicker, className: params.className });
  return {
    openGraph: {
      title: params.title,
      description: params.description,
      type: 'website' as const,
      images: [{ url, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image' as const,
      title: params.title,
      description: params.description,
      images: [url],
    },
  };
}
