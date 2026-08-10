'use client';

import { appIdentity } from '@app/config/identity';
import { IconArrowRight, IconBraces, IconDatabase, IconWorld } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDeck,
  CardHeader,
  CardTitle,
} from '@/components/ui';

const features = [
  {
    icon: IconBraces,
    title: 'Contract first',
    copy: 'Schemas, clients and transports stay aligned.',
  },
  {
    icon: IconDatabase,
    title: 'Production data',
    copy: 'Prisma and PostgreSQL are ready from day one.',
  },
  {
    icon: IconWorld,
    title: 'Every surface',
    copy: 'HTTP, realtime, MCP, agents and CLI share one service.',
  },
];

export function LandingHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className='flex items-center justify-between border-b border-border py-4'>
      <div className='flex items-center gap-2 font-medium'>
        <BrandMark priority />
        {appIdentity.name}
      </div>
      <div className='flex items-center gap-2'>{actions}</div>
    </header>
  );
}

export function HeroSection() {
  return (
    <section className='grid gap-8 py-20 lg:grid-cols-[1.2fr_0.8fr] lg:items-end'>
      <div className='space-y-6'>
        <Badge variant='primary'>Production starter</Badge>
        <h1 className='max-w-3xl font-display text-5xl font-medium tracking-tight sm:text-7xl'>
          Build the product, not its plumbing.
        </h1>
        <p className='max-w-2xl text-lg text-muted-foreground'>
          A precise fullstack base with a complete UI system and one contract across every
          interface.
        </p>
        <div className='flex flex-wrap gap-3'>
          <Button variant='primary'>
            Start building <IconArrowRight />
          </Button>
          <Button variant='outline'>Read the architecture</Button>
        </div>
      </div>
      <CardDeck
        items={features}
        overlap={-28}
        rotationStep={4}
        keyExtractor={(feature) => feature.title}
        renderCard={(feature) => (
          <Card className='w-48 bg-card/95 backdrop-blur'>
            <CardHeader>
              <feature.icon />
              <CardTitle>{feature.title}</CardTitle>
            </CardHeader>
            <CardContent className='text-sm text-muted-foreground'>{feature.copy}</CardContent>
          </Card>
        )}
      />
    </section>
  );
}

export function FeatureGrid() {
  return (
    <section className='grid gap-3 py-10 md:grid-cols-3'>
      {features.map((feature) => (
        <Card key={feature.title}>
          <CardHeader>
            <div className='mb-5 grid size-10 place-items-center rounded-xl bg-muted'>
              <feature.icon />
            </div>
            <CardTitle>{feature.title}</CardTitle>
          </CardHeader>
          <CardContent className='text-sm text-muted-foreground'>{feature.copy}</CardContent>
        </Card>
      ))}
    </section>
  );
}

export function PortfolioSection() {
  return (
    <section className='space-y-6 py-16'>
      <div>
        <p className='text-sm text-muted-foreground'>Composable sections</p>
        <h2 className='text-3xl font-medium'>From landing page to application shell</h2>
      </div>
      <div className='grid gap-4 md:grid-cols-2'>
        {[
          'Editorial landing',
          'Operational dashboard',
          'Account workspace',
          'Data-heavy admin',
        ].map((title, index) => (
          <div
            className='aspect-[16/9] rounded-2xl border border-border bg-gradient-to-br from-muted to-background p-5'
            key={title}
          >
            <Badge>{String(index + 1).padStart(2, '0')}</Badge>
            <p className='mt-auto pt-20 text-lg font-medium'>{title}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PricingSection() {
  return (
    <section className='grid gap-4 py-16 md:grid-cols-3'>
      {['Foundation', 'Product', 'Scale'].map((name, index) => (
        <Card className={index === 1 ? 'border-primary' : undefined} key={name}>
          <CardHeader>
            <Badge variant={index === 1 ? 'primary' : 'default'}>
              {index === 1 ? 'Recommended' : 'Flexible'}
            </Badge>
            <CardTitle className='pt-4 text-2xl'>{name}</CardTitle>
          </CardHeader>
          <CardContent className='space-y-5 text-sm text-muted-foreground'>
            <p>A reusable layout demonstrating pricing, comparison and conversion patterns.</p>
            <Button className='w-full' variant={index === 1 ? 'primary' : 'outline'}>
              Choose {name}
            </Button>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className='flex flex-col gap-3 border-t border-border py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between'>
      <span>{appIdentity.name} · Built with Stitchkit</span>
      <span>Contracts · UI · Realtime · Tools</span>
    </footer>
  );
}
