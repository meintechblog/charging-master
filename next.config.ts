import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['echarts', 'zrender'],
};

export default nextConfig;
