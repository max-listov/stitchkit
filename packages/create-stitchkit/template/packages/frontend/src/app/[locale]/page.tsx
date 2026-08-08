import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LocaleSchema } from '@/i18n/locales';
import { createServerRepositoryApi } from '@/lib/api/client';
import { useRepository } from '@/lib/api/queries';
import { getQueryClient } from '@/lib/query-client';
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
  const queryClient = getQueryClient();
  const api = createServerRepositoryApi();
  const t = await getTranslations('App');
  await queryClient.prefetchQuery({
    queryKey: useRepository.getKey(),
    queryFn: () => api.read(),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <StarterPage
        applicationName={t('title')}
        applicationDescription={t('description')}
        heroTitle={t('heroTitle')}
        catalogueLabel={t('ui')}
        locale={appLocale}
      />
    </HydrationBoundary>
  );
}
