import type { ReactNode } from 'react';
import { CatalogueNavigation } from './catalogue-navigation';

export function CatalogueShell({ children }: { children: ReactNode }) {
  return (
    <div className='relative flex h-dvh flex-col overflow-hidden bg-background'>
      <CatalogueNavigation />
      <main
        className='min-h-0 flex-1 overflow-y-auto overscroll-contain'
        data-testid='catalogue-content'
      >
        <div className='mx-auto w-full max-w-[96rem] px-5 py-7 pt-16 lg:pl-[18rem] lg:pr-8 lg:pt-10'>
          {children}
        </div>
      </main>
    </div>
  );
}

export function StoryHeader({
  title,
  description,
  eyebrow,
}: {
  title: string;
  description: string;
  eyebrow: string;
}) {
  return (
    <div className='mb-7 max-w-3xl'>
      <p className='text-sm text-muted-foreground'>{eyebrow}</p>
      <h1 className='mt-2 font-display text-4xl font-medium tracking-tight sm:text-5xl'>
        {title}
      </h1>
      <p className='mt-3 text-muted-foreground'>{description}</p>
    </div>
  );
}

export function StorySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className='group mb-5 rounded-2xl border border-border bg-card/45' open>
      <summary className='flex list-none items-center justify-between px-5 py-4 text-lg font-medium marker:hidden'>
        {title}
        <span className='text-muted-foreground group-open:hidden'>+</span>
        <span className='hidden text-muted-foreground group-open:inline'>−</span>
      </summary>
      <section className='space-y-5 border-t border-border p-5'>{children}</section>
    </details>
  );
}
