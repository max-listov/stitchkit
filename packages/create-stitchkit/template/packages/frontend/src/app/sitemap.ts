import type { MetadataRoute } from 'next';
import { locales } from '@/i18n/locales';
import { absoluteSiteUrl } from '@/lib/seo/metadata';
import { localizedPagePath, publicPageIds } from '@/lib/seo/pages';

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPageIds.flatMap((pageId) =>
    locales.map((locale) => ({
      url: absoluteSiteUrl(localizedPagePath(pageId, locale)),
      changeFrequency: pageId === 'home' ? 'weekly' : 'monthly',
      priority: pageId === 'home' ? 1 : 0.7,
      alternates: {
        languages: Object.fromEntries(
          locales.map((availableLocale) => [
            availableLocale,
            absoluteSiteUrl(localizedPagePath(pageId, availableLocale)),
          ]),
        ),
      },
    })),
  );
}
