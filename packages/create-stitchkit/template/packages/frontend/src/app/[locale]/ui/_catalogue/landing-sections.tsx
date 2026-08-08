'use client';

import {
  IconArrowUpRight,
  IconBooks,
  IconBox,
  IconBrandReact,
  IconCode,
  IconDatabase,
  IconDeviceDesktop,
  IconRoute,
  IconServer,
  IconShieldCheck,
  IconUsers,
} from '@tabler/icons-react';
import { ThemedImage } from '@wrksz/themes/client/themed-image';
import { useState } from 'react';
import {
  AdaptiveModal,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';

const problems = [
  ['Schema drift', 'One named Zod schema drives server validation and every client.'],
  ['Transport duplication', 'HTTP, tools and CLI share the same implementation.'],
  ['Frontend plumbing', 'Queries, realtime cache updates and errors arrive composed.'],
];

export function ProblemsSection() {
  return (
    <section className='space-y-6 py-14'>
      <div className='max-w-2xl'>
        <p className='text-sm text-muted-foreground'>The repetitive work</p>
        <h2 className='text-3xl font-medium'>Keep infrastructure from becoming the product</h2>
      </div>
      <div className='grid gap-3 md:grid-cols-3'>
        {problems.map(([title, copy], index) => (
          <Card key={title}>
            <CardHeader>
              <Badge className='w-fit'>{String(index + 1).padStart(2, '0')}</Badge>
              <CardTitle className='pt-4'>{title}</CardTitle>
            </CardHeader>
            <CardContent className='text-sm text-muted-foreground'>{copy}</CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export function BuilderSection() {
  return (
    <section className='grid gap-8 border-y border-border py-14 md:grid-cols-[0.8fr_1.2fr] md:items-center'>
      <div className='grid aspect-square max-w-sm place-items-center rounded-3xl bg-muted'>
        <IconCode className='size-20 text-muted-foreground' stroke={1.25} />
      </div>
      <div className='space-y-4'>
        <Badge variant='secondary'>Built for product teams</Badge>
        <h2 className='text-3xl font-medium'>A neutral foundation, not a sample business</h2>
        <p className='text-muted-foreground'>
          Replace the example domain while retaining contracts, runtime boundaries, operational
          tooling and the complete component vocabulary.
        </p>
        <div className='flex items-center gap-2 text-sm'>
          <IconUsers /> Solo developers and teams
        </div>
      </div>
    </section>
  );
}

const foundations = [
  {
    icon: IconShieldCheck,
    title: 'Validated boundaries',
    copy: 'Fail-first environment and data parsing.',
  },
  {
    icon: IconDatabase,
    title: 'Persistent by default',
    copy: 'Prisma and PostgreSQL with a real migration.',
  },
  {
    icon: IconServer,
    title: 'Independent backend',
    copy: 'Long-running work, sockets and MCP stay outside Next.',
  },
  {
    icon: IconRoute,
    title: 'Typed navigation',
    copy: 'Contracts build calls and URLs without repeated strings.',
  },
];

export function WhySection() {
  return (
    <section className='space-y-6 py-14'>
      <div>
        <p className='text-sm text-muted-foreground'>Why this topology</p>
        <h2 className='text-3xl font-medium'>Clear ownership at every boundary</h2>
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        {foundations.map((item) => (
          <Card key={item.title}>
            <CardContent className='flex gap-4 pt-4'>
              <div className='grid size-10 shrink-0 place-items-center rounded-xl bg-muted'>
                <item.icon />
              </div>
              <div>
                <h3 className='font-medium'>{item.title}</h3>
                <p className='mt-1 text-sm text-muted-foreground'>{item.copy}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export function AudienceSection() {
  return (
    <section className='grid gap-3 py-14 md:grid-cols-3'>
      {[
        ['Start', 'Generate a complete system and learn it through one bounded domain.'],
        ['Adapt', 'Keep the boundaries and replace fixtures with your own product model.'],
        ['Scale', 'Split deployments without rewriting the contract or transport surface.'],
      ].map(([title, copy]) => (
        <div className='rounded-2xl border border-border p-5' key={title}>
          <h3 className='text-xl font-medium'>{title}</h3>
          <p className='mt-2 text-sm text-muted-foreground'>{copy}</p>
        </div>
      ))}
    </section>
  );
}

export function LearningSection() {
  return (
    <section className='grid gap-8 py-14 md:grid-cols-[0.8fr_1.2fr]'>
      <div>
        <IconBooks className='mb-4 size-10' />
        <h2 className='text-3xl font-medium'>Learn by tracing one operation</h2>
        <p className='mt-3 text-muted-foreground'>
          Follow a project mutation from schema to contract, service, HTTP client, query cache,
          Socket.IO event, MCP tool and CLI command.
        </p>
      </div>
      <ol className='space-y-3'>
        {[
          'Define a named schema',
          'Reference it from a thin contract',
          'Implement the domain once',
          'Consume the generated surfaces',
        ].map((step, index) => (
          <li
            className='flex items-center gap-4 rounded-xl border border-border p-4'
            key={step}
          >
            <Badge>{index + 1}</Badge>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function TemplatePreviewSection() {
  return (
    <section className='space-y-6 py-14'>
      <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
        <div>
          <p className='text-sm text-muted-foreground'>Theme-aware media</p>
          <h2 className='text-3xl font-medium'>A project shell ready to become yours</h2>
        </div>
        <Badge variant='success'>Light + dark</Badge>
      </div>
      <ThemedImage
        src={{ light: '/theme-light.svg', dark: '/theme-dark.svg' }}
        alt='Theme-aware generic application preview'
        width={1280}
        height={720}
        className='w-full rounded-2xl border border-border'
      />
    </section>
  );
}

export function FrontendSection() {
  return (
    <section className='space-y-6 py-14'>
      <h2 className='text-3xl font-medium'>Frontend foundations included</h2>
      <div className='grid gap-3 sm:grid-cols-3'>
        {[
          {
            icon: IconBrandReact,
            title: 'React 19',
            copy: 'Server-first composition and isolated client islands.',
          },
          {
            icon: IconDeviceDesktop,
            title: 'Responsive UI',
            copy: 'Touch, keyboard and desktop interaction patterns.',
          },
          {
            icon: IconBox,
            title: 'Source components',
            copy: 'Own and adapt every primitive without a black box.',
          },
        ].map((item) => (
          <Card key={item.title}>
            <CardContent className='pt-4'>
              <item.icon className='mb-5 size-8' />
              <h3 className='font-medium'>{item.title}</h3>
              <p className='mt-2 text-sm text-muted-foreground'>{item.copy}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export function DemoModal() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant='outline' onClick={() => setOpen(true)}>
        Explore starter <IconArrowUpRight />
      </Button>
      <AdaptiveModal
        isOpen={open}
        onClose={() => setOpen(false)}
        title='Choose a surface'
        desktopWidth='2xl'
        mobileVariant='sheet'
      >
        <div className='p-4 pt-1'>
          <Tabs defaultValue='http'>
            <TabsList>
              <TabsTrigger value='http'>HTTP</TabsTrigger>
              <TabsTrigger value='tools'>Tools</TabsTrigger>
              <TabsTrigger value='realtime'>Realtime</TabsTrigger>
            </TabsList>
            <TabsContent className='pt-5 text-sm text-muted-foreground' value='http'>
              Typed browser and server clients consume the same contract.
            </TabsContent>
            <TabsContent className='pt-5 text-sm text-muted-foreground' value='tools'>
              MCP, Agent and CLI surfaces reuse the service runner and validation.
            </TabsContent>
            <TabsContent className='pt-5 text-sm text-muted-foreground' value='realtime'>
              Socket.IO events update the TanStack Query cache through Stitchkit.
            </TabsContent>
          </Tabs>
        </div>
      </AdaptiveModal>
    </>
  );
}
