import path from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
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

/**
 * A `page.dev.tsx` exists for the development server alone, so what it imports
 * is absent from a production build rather than guarded inside it.
 */
export default function nextConfig(phase: string): NextConfig {
  const pageExtensions =
    phase === PHASE_DEVELOPMENT_SERVER ? ['dev.tsx', 'tsx', 'ts'] : ['tsx', 'ts'];
  return createNextIntlPlugin()({ ...config, pageExtensions });
}
