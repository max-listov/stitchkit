import { ImageResponse } from 'next/og';
import { LocaleSchema } from '@/i18n/locales';
import { getSeoPage, publicPageIds, SeoPageIdSchema, SITE_NAME } from '@/lib/seo/pages';

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };

export function generateStaticParams() {
  return LocaleSchema.options.flatMap((locale) =>
    publicPageIds.map((page) => ({ locale, page })),
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ locale: string; page: string }> },
) {
  const { locale, page } = await params;
  const parsedLocale = LocaleSchema.safeParse(locale);
  const parsedPage = SeoPageIdSchema.safeParse(page);
  if (!parsedLocale.success || !parsedPage.success) {
    return new Response('Unknown SEO page', { status: 404 });
  }

  const metadata = getSeoPage(parsedPage.data, parsedLocale.data);
  return new ImageResponse(
    <div
      style={{
        alignItems: 'center',
        background: '#111214',
        color: '#f7f7f8',
        display: 'flex',
        height: '100%',
        justifyContent: 'center',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26, maxWidth: 940 }}>
        <div style={{ color: '#a3a7b2', fontSize: 28 }}>{metadata.eyebrow}</div>
        <div style={{ fontSize: 74, fontWeight: 500, letterSpacing: -3, lineHeight: 1.05 }}>
          {metadata.title}
        </div>
        <div style={{ color: '#c7cad1', fontSize: 31, lineHeight: 1.35 }}>
          {metadata.description}
        </div>
        <div style={{ color: '#8d929e', display: 'flex', fontSize: 24, marginTop: 10 }}>
          {SITE_NAME}
        </div>
      </div>
    </div>,
    size,
  );
}
