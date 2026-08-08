import type { Metadata } from 'next';
import { env } from '@/env';
import type { AppLocale } from '@/i18n/locales';
import { locales } from '@/i18n/locales';
import type { SeoPageId } from './pages';
import { getSeoPage, localizedPagePath, SITE_NAME } from './pages';

export const siteOrigin = new URL(env.NEXT_PUBLIC_WEB_URL).origin;

export function absoluteSiteUrl(path: string): string {
  return new URL(path, siteOrigin).toString();
}

export function createPageMetadata(pageId: SeoPageId, locale: AppLocale): Metadata {
  const page = getSeoPage(pageId, locale);
  const title = pageId === 'home' ? SITE_NAME : `${page.title} · ${SITE_NAME}`;
  const canonicalPath = localizedPagePath(pageId, locale);
  const image = absoluteSiteUrl(`/api/og/${locale}/${pageId}`);
  const languageAlternates = Object.fromEntries(
    locales.map((availableLocale) => [
      availableLocale,
      absoluteSiteUrl(localizedPagePath(pageId, availableLocale)),
    ]),
  );

  return {
    title,
    description: page.description,
    alternates: {
      canonical: absoluteSiteUrl(canonicalPath),
      languages: languageAlternates,
    },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description: page.description,
      url: absoluteSiteUrl(canonicalPath),
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
