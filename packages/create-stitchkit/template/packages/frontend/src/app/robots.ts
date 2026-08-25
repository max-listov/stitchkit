import type { MetadataRoute } from 'next';
import { absoluteSiteUrl } from '@/lib/seo/metadata';

// Dynamic on purpose: a prerendered robots.txt freezes one external address
// into the artifact, and a single build then cannot serve a second one.
export default async function robots(): Promise<MetadataRoute.Robots> {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: await absoluteSiteUrl('/sitemap.xml'),
  };
}
