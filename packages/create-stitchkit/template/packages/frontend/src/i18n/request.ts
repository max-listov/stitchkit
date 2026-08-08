import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, LocaleSchema } from './locales';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const parsedLocale = LocaleSchema.safeParse(requested);
  const locale = parsedLocale.success ? parsedLocale.data : defaultLocale;
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
