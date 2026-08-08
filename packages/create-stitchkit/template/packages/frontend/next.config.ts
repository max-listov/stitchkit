import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { env } from './src/env';

const config: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  reactCompiler: true,
  transpilePackages: ['shiki'],
  turbopack: {
    root: path.resolve(import.meta.dirname, '../..'),
  },
  allowedDevOrigins: [new URL(env.NEXT_PUBLIC_WEB_URL).hostname],
  images: { remotePatterns: [] },
};

export default createNextIntlPlugin()(config);
