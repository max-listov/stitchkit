import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LocaleSchema } from '@/i18n/locales';
import { createPageMetadata } from '@/lib/seo/metadata';
import { getSeoPage } from '@/lib/seo/pages';
import { isStoryId, StoryHeader, StoryPage, storyIds } from '../_catalogue';

export function generateStaticParams() {
  return storyIds.map((story) => ({ story }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; story: string }>;
}): Promise<Metadata> {
  const { locale, story } = await params;
  if (!isStoryId(story)) notFound();
  return await createPageMetadata(story, LocaleSchema.parse(locale));
}

export default async function UiStoryPage({
  params,
}: {
  params: Promise<{ locale: string; story: string }>;
}) {
  const { locale, story } = await params;
  if (!isStoryId(story)) notFound();
  const metadata = getSeoPage(story, LocaleSchema.parse(locale));
  return (
    <>
      <StoryHeader
        title={metadata.title}
        description={metadata.description}
        eyebrow={metadata.eyebrow}
      />
      <StoryPage story={story} />
    </>
  );
}
