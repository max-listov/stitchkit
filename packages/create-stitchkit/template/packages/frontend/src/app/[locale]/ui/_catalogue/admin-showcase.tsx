'use client';

import {
  IconActivity,
  IconChartBar,
  IconFileText,
  IconLayoutDashboard,
  IconUsers,
} from '@tabler/icons-react';
import { enUS } from 'date-fns/locale';
import {
  AreaChart,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Sidebar,
} from '@/components/ui';

const navigation = [
  { name: 'Overview', href: '/ui/blocks', icon: IconLayoutDashboard },
  { name: 'Content', href: '/ui/blocks', icon: IconFileText },
  { name: 'People', href: '/ui/blocks', icon: IconUsers },
];

const chartData = [
  { day: '2026-08-01', total: 12 },
  { day: '2026-08-02', total: 18 },
  { day: '2026-08-03', total: 15 },
  { day: '2026-08-04', total: 27 },
  { day: '2026-08-05', total: 32 },
];

const activity = [
  ['Deployment completed', '2 minutes ago'],
  ['Project contract updated', '18 minutes ago'],
  ['New collaborator joined', '1 hour ago'],
];

export function AdminShowcase() {
  return (
    <div className='relative flex min-h-[620px] overflow-hidden rounded-2xl border border-border bg-background'>
      <Sidebar navigation={navigation} logo='Workspace' mobileBreakpoint='md' />
      <div className='min-w-0 flex-1 p-5 md:p-8'>
        <div className='mb-8 flex items-center justify-between'>
          <div>
            <p className='text-sm text-muted-foreground'>Dashboard</p>
            <h2 className='text-2xl font-medium'>Overview</h2>
          </div>
          <Badge variant='success'>Live</Badge>
        </div>
        <div className='grid gap-3 sm:grid-cols-3'>
          {[
            { label: 'Requests', value: '12.8k', icon: IconActivity },
            { label: 'Users', value: '1,284', icon: IconUsers },
            { label: 'Conversion', value: '18.4%', icon: IconChartBar },
          ].map((stat) => (
            <Card key={stat.label}>
              <CardContent className='flex items-start justify-between pt-4'>
                <div>
                  <p className='text-sm text-muted-foreground'>{stat.label}</p>
                  <p className='mt-2 text-2xl font-medium'>{stat.value}</p>
                </div>
                <stat.icon className='text-muted-foreground' />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <AreaChart
              data={chartData}
              areas={[{ key: 'total', label: 'Requests', color: 'var(--chart-1)' }]}
              dateLocale={enUS}
            />
          </CardContent>
        </Card>
        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>Activity feed</CardTitle>
          </CardHeader>
          <CardContent className='divide-y divide-border'>
            {activity.map(([title, time]) => (
              <div
                className='flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0'
                key={title}
              >
                <span className='text-sm'>{title}</span>
                <span className='text-xs text-muted-foreground'>{time}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
