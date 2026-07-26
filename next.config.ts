// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // !! WARN !!
    // Danger: This allows production builds to complete even if
    // your project has type errors.
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.worldofwarcraft.com' },
      { protocol: 'https', hostname: 'wow.zamimg.com' },
      { protocol: 'https', hostname: 'assets.rpglogs.com' },
      { protocol: 'https', hostname: 'cdn.raiderio.net' },
      { protocol: 'https', hostname: 'warcraft.wiki.gg' },
    ],
  },
};

export default nextConfig;