import { IconArrowUpRight } from '@tabler/icons-react';
import Image from 'next/image';
import { BrandMark } from '@/components/brand-mark';
import { LanguageSwitcher, ThemeToggle } from '@/components/system-controls';
import { buttonVariants } from '@/components/ui';
import type { AppLocale } from '@/i18n/locales';
import { Link } from '@/i18n/navigation';
import { absoluteSiteUrl } from '@/lib/seo/metadata';
import { getSeoPage, SITE_NAME } from '@/lib/seo/pages';
import { cn } from '@/lib/utils/cn';

interface StarterPageProps {
  applicationName: string;
  applicationDescription: string;
  heroTitle: string;
  catalogueLabel: string;
  locale: AppLocale;
}

const architecture = [
  {
    name: 'Frontend',
    detail: 'Web',
    technologies: [
      { name: 'Next.js', icon: '/icons/next.svg' },
      { name: 'React', icon: '/icons/react.svg' },
      { name: 'Tailwind CSS', icon: '/icons/tailwind.svg' },
      { name: 'React Query', icon: '/icons/react-query.svg' },
    ],
  },
  {
    name: 'Backend',
    detail: 'API',
    technologies: [
      { name: 'Stitchkit', icon: '/mascot-stitch.png' },
      { name: 'Bun', icon: '/icons/bun.svg' },
      { name: 'Zod', icon: '/icons/zod.svg' },
    ],
  },
  {
    name: 'Data',
    detail: 'Storage',
    technologies: [
      { name: 'PostgreSQL', icon: '/icons/postgresql.svg' },
      { name: 'Prisma', icon: '/icons/prisma.svg', invertInDark: true },
    ],
  },
  {
    name: 'Tooling',
    detail: 'Quality',
    technologies: [
      { name: 'TypeScript', icon: '/icons/typescript.svg' },
      { name: 'TSConfig', icon: '/icons/tsconfig.svg' },
      { name: 'Biome', icon: '/icons/biome.svg' },
    ],
  },
];

export async function StarterPage({
  applicationName,
  applicationDescription,
  heroTitle,
  catalogueLabel,
  locale,
}: StarterPageProps) {
  const homeSeo = getSeoPage('home', locale);
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web',
    url: await absoluteSiteUrl(`/${locale}`),
    description: homeSeo.description,
  };

  return (
    <main className='h-svh overflow-y-auto bg-background lg:overflow-hidden'>
      <script type='application/ld+json'>{JSON.stringify(structuredData)}</script>
      <div className='mx-auto flex min-h-full w-full max-w-7xl flex-col px-5 lg:h-full lg:px-8'>
        <header className='flex h-16 shrink-0 items-center justify-between'>
          <div className='flex min-w-0 items-center gap-2 font-medium'>
            <BrandMark priority />
            <span className='truncate'>{applicationName}</span>
          </div>
          <div className='flex items-center gap-2'>
            <LanguageSwitcher />
            <ThemeToggle />
            <Link
              aria-label={catalogueLabel}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              href='/ui'
            >
              <span className='hidden sm:inline'>{catalogueLabel}</span>
              <IconArrowUpRight />
            </Link>
          </div>
        </header>

        <div className='flex flex-1 flex-col items-center justify-center py-8 text-center lg:min-h-0 lg:py-5'>
          <section className='flex w-full min-w-0 flex-col items-center'>
            <h1 className='max-w-4xl font-display text-5xl font-medium tracking-tight sm:text-6xl lg:text-7xl lg:leading-[0.96]'>
              {heroTitle}
            </h1>
            <p className='mt-5 max-w-3xl text-base leading-7 text-muted-foreground lg:text-lg'>
              {applicationDescription}
            </p>

            <div className='mt-8 w-full max-w-4xl'>
              <div className='grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card text-left sm:grid-cols-4'>
                {architecture.map((item) => (
                  <div
                    className='min-w-0 border-border px-3 py-3 odd:border-r first:border-b second:border-b sm:border-r sm:border-b-0 sm:last:border-r-0 sm:px-4'
                    key={item.name}
                  >
                    <div className='flex min-w-0 items-baseline gap-2'>
                      <p className='truncate text-sm font-medium'>{item.name}</p>
                      <p className='text-xs text-muted-foreground'>{item.detail}</p>
                    </div>
                    <div className='mt-2 flex min-h-6 items-center gap-2'>
                      {item.technologies.map((technology) => (
                        <Image
                          alt={technology.name}
                          className={
                            technology.invertInDark
                              ? 'technology-icon-invert-dark size-5 shrink-0 object-contain'
                              : 'size-5 shrink-0 object-contain'
                          }
                          height={20}
                          key={technology.icon}
                          src={technology.icon}
                          title={technology.name}
                          width={20}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <p className='mt-5 text-sm text-muted-foreground'>
              Add your first vertical feature from schema to transport and UI.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
