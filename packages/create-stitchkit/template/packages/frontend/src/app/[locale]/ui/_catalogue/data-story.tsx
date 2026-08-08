'use client';

import { IconActivity, IconArchive, IconFolders } from '@tabler/icons-react';
import { createColumnHelper } from '@tanstack/react-table';
import { useState } from 'react';
import { Badge, Button } from '@/components/ui';
import {
  DataTable,
  DualInlineStat,
  InlineStat,
  SortableHeader,
  TableError,
  TableFilters,
} from '@/features/data-table';
import type { dataTableFeatures } from '@/features/data-table/table-features';
import { StorySection } from './catalogue-shell';

interface CatalogueProject {
  name: string;
  stage: string;
  owner: string;
  updatedAt: string;
}

const rows: CatalogueProject[] = [
  { name: 'Stitchkit', stage: 'Shipping', owner: 'Framework', updatedAt: '2026-08-08' },
  { name: 'Agent workspace', stage: 'Building', owner: 'Product', updatedAt: '2026-08-07' },
  { name: 'Device control', stage: 'Idea', owner: 'Research', updatedAt: '2026-08-02' },
  {
    name: 'Release observatory',
    stage: 'Shipping',
    owner: 'Platform',
    updatedAt: '2026-08-01',
  },
  { name: 'Contract explorer', stage: 'Building', owner: 'Framework', updatedAt: '2026-07-31' },
  { name: 'Runtime bench', stage: 'Idea', owner: 'Research', updatedAt: '2026-07-30' },
];

const columnHelper = createColumnHelper<typeof dataTableFeatures, CatalogueProject>();
const columns = columnHelper.columns([
  columnHelper.accessor('name', {
    header: ({ column }) => <SortableHeader column={column}>Project</SortableHeader>,
  }),
  columnHelper.accessor('stage', {
    header: 'Stage',
    cell: ({ row }) => <Badge size='sm'>{row.original.stage}</Badge>,
  }),
  columnHelper.accessor('owner', { header: 'Owner' }),
  columnHelper.accessor('updatedAt', { header: 'Updated' }),
]);

const filters = [
  {
    key: 'stage',
    placeholder: 'Stage',
    allLabel: 'All stages',
    options: [
      { value: 'Building', label: 'Building' },
      { value: 'Shipping', label: 'Shipping' },
    ],
  },
];

const displayStates: Array<'ready' | 'loading' | 'empty'> = ['ready', 'loading', 'empty'];

export function DataStory() {
  const [values, setValues] = useState<Record<string, string | undefined>>({});
  const [state, setState] = useState<'ready' | 'loading' | 'empty'>('ready');
  const filteredRows = rows.filter((row) => !values.stage || row.stage === values.stage);
  return (
    <div>
      <StorySection title='Operational statistics'>
        <div className='grid gap-3 sm:grid-cols-3'>
          <InlineStat icon={IconFolders} label='Projects' value='24' />
          <InlineStat icon={IconActivity} label='Active' value='18' />
          <DualInlineStat
            icon={IconArchive}
            label='Delivery'
            items={[
              { value: '12', suffix: 'shipped', dotColor: 'bg-success' },
              { value: '3', suffix: 'paused', dotColor: 'bg-warning' },
            ]}
          />
        </div>
      </StorySection>
      <StorySection title='Data table'>
        <div className='overflow-hidden rounded-xl border border-border'>
          <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border p-3'>
            <TableFilters
              filters={filters}
              values={values}
              onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
              onClear={() => setValues({})}
            />
            <div className='flex gap-1'>
              {displayStates.map((value) => (
                <Button
                  key={value}
                  size='sm'
                  variant={state === value ? 'default' : 'ghost'}
                  onClick={() => setState(value)}
                >
                  {value}
                </Button>
              ))}
            </div>
          </div>
          <div className='h-[420px]'>
            <DataTable<CatalogueProject>
              columns={columns}
              data={state === 'empty' ? [] : filteredRows}
              isLoading={state === 'loading'}
              searchKey='name'
              searchPlaceholder='Search projects'
            />
          </div>
        </div>
      </StorySection>
      <StorySection title='Failure state'>
        <div className='h-28 rounded-xl border border-border'>
          <TableError error={new Error('Example typed transport error')} entity='projects' />
        </div>
      </StorySection>
    </div>
  );
}
