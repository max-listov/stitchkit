import { describe, expect, test } from 'bun:test';
import { LocaleSchema } from '@/i18n/locales';
import { getSeoPage, localizedPagePath, publicPageIds } from './pages';

describe('SEO page registry', () => {
  test('defines complete localized copy for every public page', () => {
    for (const locale of LocaleSchema.options) {
      const titles = new Set<string>();
      const descriptions = new Set<string>();

      for (const pageId of publicPageIds) {
        const page = getSeoPage(pageId, locale);
        expect(page.title.length).toBeGreaterThan(10);
        expect(page.description.length).toBeGreaterThan(60);
        expect(page.eyebrow.length).toBeGreaterThan(0);
        expect(localizedPagePath(pageId, locale)).toStartWith(`/${locale}`);
        titles.add(page.title);
        descriptions.add(page.description);
      }

      expect(titles.size).toBe(publicPageIds.length);
      expect(descriptions.size).toBe(publicPageIds.length);
    }
  });
});
