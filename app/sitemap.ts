import { MetadataRoute } from 'next';
import { POPULAR_SPECS, getSeasonState } from '../lib/wow';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://hotsbbtalents.io';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // The tier lists render the season's default difficulty at their bare URL, so the
  // explicit-difficulty variant listed here must be the OTHER one — hardcoding 4 made
  // `/tier-list` and `/tier-list?difficulty=4` duplicates before Mythic opened.
  const season = await getSeasonState();
  const altDiff = season.defaultRaidDifficulty === 5 ? 4 : 5;

  const entries: MetadataRoute.Sitemap = [
    { url: BASE_URL, changeFrequency: 'daily', priority: 1 },
    // Standalone sections — until 2026-10 nothing linked to these from the finder
    // and they weren't listed here either, so crawlers had no path to them at all.
    { url: `${BASE_URL}/dungeons`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${BASE_URL}/tier-list`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${BASE_URL}/tier-list/tanks`, changeFrequency: 'daily', priority: 0.7 },
    { url: `${BASE_URL}/tier-list/healers`, changeFrequency: 'daily', priority: 0.7 },
    { url: `${BASE_URL}/tier-list?difficulty=${altDiff}`, changeFrequency: 'daily', priority: 0.5 },
    { url: `${BASE_URL}/tier-list/tanks?difficulty=${altDiff}`, changeFrequency: 'daily', priority: 0.4 },
    { url: `${BASE_URL}/tier-list/healers?difficulty=${altDiff}`, changeFrequency: 'daily', priority: 0.4 },
  ];

  for (const cls of POPULAR_SPECS) {
    const c = encodeURIComponent(cls.class);
    entries.push({
      url: `${BASE_URL}/?class=${c}&difficulty=5`,
      changeFrequency: 'daily',
      priority: 0.7,
    });

    for (const spec of cls.specs) {
      const s = encodeURIComponent(spec);
      // Mythic (primary)
      entries.push({
        url: `${BASE_URL}/?class=${c}&spec=${s}&difficulty=5`,
        changeFrequency: 'daily',
        priority: 0.9,
      });
      // Heroic
      entries.push({
        url: `${BASE_URL}/?class=${c}&spec=${s}&difficulty=4`,
        changeFrequency: 'daily',
        priority: 0.6,
      });
      // Mythic+ (the standalone dungeons route is the canonical-looking URL for M+)
      entries.push({
        url: `${BASE_URL}/dungeons?class=${c}&spec=${s}`,
        changeFrequency: 'daily',
        priority: 0.8,
      });
    }
  }

  return entries;
}
