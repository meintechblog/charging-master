import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['echarts', 'zrender'],
  // Lint is a separate quality gate (`pnpm lint`); we do NOT want a noisy
  // pre-existing `unused-vars` to block a production build, especially the
  // Self-Update pipeline where a build failure auto-rolls back.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
