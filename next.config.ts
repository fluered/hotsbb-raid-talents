// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // !! WARN !!
    // Danger: This allows production builds to complete even if 
    // your project has type errors.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;