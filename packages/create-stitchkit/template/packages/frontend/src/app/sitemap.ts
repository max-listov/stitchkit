import type { MetadataRoute } from 'next';
import { sitemapForOrigin } from '@/lib/seo/metadata';
import { requestOrigin } from '@/lib/seo/request-origin';

// Dynamic on purpose (see robots.ts): the URLs are a function of the origin
// this response is served on, and that is not known until the request arrives.
// The entries themselves are built once per origin, not once per request.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapForOrigin(await requestOrigin());
}
