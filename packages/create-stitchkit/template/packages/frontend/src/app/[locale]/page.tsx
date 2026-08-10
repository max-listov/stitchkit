import { appIdentity } from '@app/config/identity';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LocaleSchema } from '@/i18n/locales';
import { createPageMetadata } from '@/lib/seo/metadata';
import { StarterPage } from './starter-page';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return createPageMetadata('home', LocaleSchema.parse(locale));
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const appLocale = LocaleSchema.parse(locale);
  const t = await getTranslations('App');

  return (
    <StarterPage
      applicationName={appIdentity.name}
      applicationDescription={appIdentity.description[appLocale]}
      heroTitle={t('heroTitle')}
      catalogueLabel={t('ui')}
      locale={appLocale}
    />
  );
}
