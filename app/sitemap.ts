import { MetadataRoute } from 'next';
import { POPULAR_SPECS } from '../lib/wow';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://hotsbb.gg';

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [
    { url: BASE_URL, changeFrequency: 'daily', priority: 1 },
  ];

  for (const cls of POPULAR_SPECS) {
    entries.push({
      url: `${BASE_URL}/?class=${encodeURIComponent(cls.class)}&difficulty=5`,
      changeFrequency: 'daily',
      priority: 0.7,
    });

    for (const spec of cls.specs) {
      // Mythic (primary)
      entries.push({
        url: `${BASE_URL}/?class=${encodeURIComponent(cls.class)}&spec=${encodeURIComponent(spec)}&difficulty=5`,
        changeFrequency: 'daily',
        priority: 0.9,
      });
      // Heroic
      entries.push({
        url: `${BASE_URL}/?class=${encodeURIComponent(cls.class)}&spec=${encodeURIComponent(spec)}&difficulty=4`,
        changeFrequency: 'daily',
        priority: 0.6,
      });
    }
  }

  return entries;
}
