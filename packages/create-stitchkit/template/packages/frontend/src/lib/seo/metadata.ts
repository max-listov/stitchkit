import type { Metadata, MetadataRoute } from 'next';
import type { AppLocale } from '@/i18n/locales';
import { locales } from '@/i18n/locales';
import { cacheByOrigin } from './cache-by-origin';
import type { SeoPageId } from './pages';
import { getSeoPage, localizedPagePath, publicPageIds, SITE_NAME } from './pages';
import { requestOrigin } from './request-origin';

/** Absolute URL for `path` on the origin this response is being served from. */
export async function absoluteSiteUrl(path: string): Promise<string> {
  return siteUrl(await requestOrigin(), path);
}

function siteUrl(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

interface PageMetadataInput {
  origin: string;
  pageId: SeoPageId;
  locale: AppLocale;
}

/**
 * Page metadata for one origin. Pure in its inputs, so it is built once per
 * (origin, page, locale) instead of once per request — the cost of trading a
 * build-time constant for a request-time value, paid once per address.
 */
const metadataFor = cacheByOrigin(
  ({ origin, pageId, locale }: PageMetadataInput) => `${origin}|${pageId}|${locale}`,
  ({ origin, pageId, locale }: PageMetadataInput) => buildPageMetadata(origin, pageId, locale),
);

export async function createPageMetadata(
  pageId: SeoPageId,
  locale: AppLocale,
): Promise<Metadata> {
  return metadataFor({ origin: await requestOrigin(), pageId, locale });
}

/** `metadataBase` for the origin in hand — relative metadata resolves against it. */
export async function siteMetadataBase(): Promise<URL> {
  return new URL(await requestOrigin());
}

function buildPageMetadata(origin: string, pageId: SeoPageId, locale: AppLocale): Metadata {
  const page = getSeoPage(pageId, locale);
  const title = pageId === 'home' ? SITE_NAME : `${page.title} · ${SITE_NAME}`;
  const canonicalPath = localizedPagePath(pageId, locale);
  const image = siteUrl(origin, `/api/og/${locale}/${pageId}`);
  const languageAlternates = Object.fromEntries(
    locales.map((availableLocale) => [
      availableLocale,
      siteUrl(origin, localizedPagePath(pageId, availableLocale)),
    ]),
  );

  return {
    title,
    description: page.description,
    alternates: {
      canonical: siteUrl(origin, canonicalPath),
      languages: languageAlternates,
    },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description: page.description,
      url: siteUrl(origin, canonicalPath),
      locale: locale === 'ru' ? 'ru_RU' : 'en_US',
      alternateLocale: locale === 'ru' ? ['en_US'] : ['ru_RU'],
      images: [{ url: image, width: 1200, height: 630, alt: `${title} — ${page.eyebrow}` }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: page.description,
      images: [{ url: image, alt: `${title} — ${page.eyebrow}` }],
    },
  };
}

/**
 * Sitemap entries for one origin — the same value for every request that
 * arrives on that address, so it is built once per address.
 */
export const sitemapForOrigin = cacheByOrigin(
  (origin: string) => origin,
  (origin: string): MetadataRoute.Sitemap =>
    publicPageIds.flatMap(
      (pageId): MetadataRoute.Sitemap =>
        locales.map((locale) => ({
          url: siteUrl(origin, localizedPagePath(pageId, locale)),
          changeFrequency: pageId === 'home' ? 'weekly' : 'monthly',
          priority: pageId === 'home' ? 1 : 0.7,
          alternates: {
            languages: Object.fromEntries(
              locales.map((availableLocale) => [
                availableLocale,
                siteUrl(origin, localizedPagePath(pageId, availableLocale)),
              ]),
            ),
          },
        })),
    ),
);
