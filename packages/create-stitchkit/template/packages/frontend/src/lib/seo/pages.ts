import { appIdentity } from '@app/config/app-identity';
import { z } from 'zod';
import type { AppLocale } from '@/i18n/locales';

export const SITE_NAME = appIdentity.name;
export const StoryIdSchema = z.enum(['components', 'themes', 'blocks']);
export type StoryId = z.infer<typeof StoryIdSchema>;

export const SeoPageIdSchema = z.enum(['home', ...StoryIdSchema.options]);
export type SeoPageId = z.infer<typeof SeoPageIdSchema>;

interface SeoCopy {
  title: string;
  description: string;
  eyebrow: string;
}

interface SeoPageDefinition {
  path: string;
  copy: Record<AppLocale, SeoCopy>;
}

const seoPages: Record<SeoPageId, SeoPageDefinition> = {
  home: {
    path: '',
    copy: {
      en: {
        title: 'Production-ready full-stack starter',
        description:
          'Build typed production applications with Stitchkit, Next.js, Bun, PostgreSQL, realtime cache updates and contract-driven tools.',
        eyebrow: 'One contract. Every surface.',
      },
      ru: {
        title: 'Production-ready full-stack стартер',
        description:
          'Создавайте типизированные production-приложения на Stitchkit, Next.js, Bun и PostgreSQL с realtime-кешем и contract-driven tools.',
        eyebrow: 'Один контракт. Все поверхности.',
      },
    },
  },
  components: {
    path: '/ui/components',
    copy: {
      en: {
        title: 'UI components',
        description: `Explore accessible actions, forms, feedback, overlays, data displays and motion components included in ${SITE_NAME}.`,
        eyebrow: 'UI system',
      },
      ru: {
        title: 'UI-компоненты',
        description: `Изучите доступные действия, формы, обратную связь, оверлеи, представление данных и анимации в ${SITE_NAME}.`,
        eyebrow: 'UI-система',
      },
    },
  },
  themes: {
    path: '/ui/themes',
    copy: {
      en: {
        title: 'Theme system',
        description:
          'Global, system, server-readable, forced and scoped themes with configurable View Transition effects.',
        eyebrow: 'UI system',
      },
      ru: {
        title: 'Система тем',
        description:
          'Глобальные, системные, server-readable, forced и scoped темы с настраиваемыми View Transition эффектами.',
        eyebrow: 'UI-система',
      },
    },
  },
  blocks: {
    path: '/ui/blocks',
    copy: {
      en: {
        title: 'Reusable UI blocks',
        description:
          'Production-shaped landing, application shell, account and checkout blocks composed from the starter components.',
        eyebrow: 'UI system',
      },
      ru: {
        title: 'Готовые UI-блоки',
        description:
          'Production-shaped лендинг, каркас приложения, аккаунт и checkout-блоки, собранные из компонентов стартера.',
        eyebrow: 'UI-система',
      },
    },
  },
};

export const publicPageIds = SeoPageIdSchema.options;
export const storyIds = StoryIdSchema.options;

export function isStoryId(value: string): value is StoryId {
  return StoryIdSchema.safeParse(value).success;
}

export function getSeoPage(pageId: SeoPageId, locale: AppLocale) {
  const page = seoPages[pageId];
  return { ...page, ...page.copy[locale] };
}

export function localizedPagePath(pageId: SeoPageId, locale: AppLocale): string {
  return `/${locale}${seoPages[pageId].path}`;
}
