import { ThemeProvider } from '@wrksz/themes/next';
import type { Metadata } from 'next';
import { Montserrat } from 'next/font/google';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';
import { env } from '@/env';
import { LocaleSchema } from '@/i18n/locales';
import { routing } from '@/i18n/routing';
import { createPageMetadata } from '@/lib/seo/metadata';
import { SITE_NAME } from '@/lib/seo/pages';
import { Providers } from '@/providers';
import { themeProviderConfig } from '@/theme/config';
import '../globals.css';

const montserrat = Montserrat({
  subsets: ['latin', 'cyrillic'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-montserrat',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_WEB_URL),
  ...createPageMetadata('home', 'en'),
  title: SITE_NAME,
  icons: { icon: [{ url: '/favicon/mascot-stitch.png', type: 'image/png' }] },
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!LocaleSchema.safeParse(locale).success) notFound();
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <body
        className={`${montserrat.variable} min-h-dvh bg-background font-sans text-foreground antialiased`}
      >
        <ThemeProvider {...themeProviderConfig}>
          <NextIntlClientProvider messages={messages}>
            <Providers>{children}</Providers>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
