import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const config: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  reactCompiler: true,
  transpilePackages: ['shiki'],
  turbopack: {
    root: path.resolve(import.meta.dirname, '../..'),
  },
  // Development only, and deliberately not derived from a public address:
  // reading one here would pull a value of the place into the build.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  images: { remotePatterns: [] },
};

export default createNextIntlPlugin()(config);
