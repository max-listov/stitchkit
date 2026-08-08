'use client';

import { IconArrowLeft, IconBox, IconLayoutDashboard, IconPalette } from '@tabler/icons-react';
import { useLocale } from 'next-intl';
import { LanguageSwitcher, ThemeToggle } from '@/components/system-controls';
import { buttonVariants, Sidebar } from '@/components/ui';
import { LocaleSchema } from '@/i18n/locales';
import { Link } from '@/i18n/navigation';
import { getSeoPage } from '@/lib/seo/pages';

export function CatalogueNavigation() {
  const locale = LocaleSchema.parse(useLocale());
  const navigation = [
    {
      name: getSeoPage('components', locale).title,
      href: '/ui/components',
      icon: IconBox,
    },
    {
      name: getSeoPage('themes', locale).title,
      href: '/ui/themes',
      icon: IconPalette,
    },
    {
      name: getSeoPage('blocks', locale).title,
      href: '/ui/blocks',
      icon: IconLayoutDashboard,
    },
  ];
  return (
    <Sidebar
      collapsible={false}
      className='top-5 max-h-[calc(100dvh-2.5rem)]'
      footer={
        <div className='flex items-center justify-between gap-2 border-t border-border px-1 pt-3'>
          <Link
            aria-label='Back to starter home'
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
            href='/'
            title='Back to starter home'
          >
            <IconArrowLeft />
          </Link>
          <div className='flex items-center gap-2'>
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      }
      navigation={navigation}
      logo='UI system'
      logoHref='/ui/components'
      variant='floating'
    />
  );
}
