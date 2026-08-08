import { redirect } from '@/i18n/navigation';

export default async function UiCataloguePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: '/ui/components', locale });
}
