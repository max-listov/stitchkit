'use client';

import { IconFileText, IconUsers } from '@tabler/icons-react';
import { useState } from 'react';
import {
  AdaptiveModal,
  Badge,
  Button,
  Field,
  Input,
  Sidebar,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import type { AdminData, AdminRow } from './admin-data';
import {
  type AdminRole,
  type AdminSection,
  adminPermissions,
  canOpen,
  sectionsFor,
} from './admin-sections';

const ICONS: Record<string, typeof IconFileText> = { records: IconFileText, people: IconUsers };

/** One section's table and its edit dialog. A role without `write` sees no action. */
export function AdminSectionView({
  section,
  rows,
  role,
}: {
  section: AdminSection;
  rows: readonly AdminRow[];
  role: AdminRole;
}) {
  const [editing, setEditing] = useState<AdminRow | undefined>();
  const canWrite = adminPermissions.allows(role, section.write);
  return (
    <section className='min-w-0'>
      <div className='mb-6 flex items-center justify-between gap-4'>
        <h1 className='text-2xl font-medium'>{section.label}</h1>
        {section.status === 'mock' ? <Badge variant='warning'>Fixture</Badge> : null}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>State</TableHead>
            {canWrite ? <TableHead /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.title}</TableCell>
              <TableCell>{row.owner}</TableCell>
              <TableCell>{row.state}</TableCell>
              {canWrite ? (
                <TableCell className='text-right'>
                  <Button size='sm' variant='outline' onClick={() => setEditing(row)}>
                    Edit
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AdaptiveModal
        isOpen={editing !== undefined}
        onClose={() => setEditing(undefined)}
        title={editing?.title ?? ''}
        footer={<Button onClick={() => setEditing(undefined)}>Close</Button>}
      >
        <div className='px-4 pb-2'>
          <Field label='Title' htmlFor='admin-row-title'>
            <Input id='admin-row-title' defaultValue={editing?.title} key={editing?.id} />
          </Field>
        </div>
      </AdaptiveModal>
    </section>
  );
}

export function AdminWorkspace({ section, data }: { section: AdminSection; data: AdminData }) {
  const [role, setRole] = useState<AdminRole>('owner');
  const visible = sectionsFor(role);
  return (
    <div className='relative flex min-h-dvh bg-background'>
      <Sidebar
        logo='Admin'
        mobileBreakpoint='md'
        navigation={visible.map(({ id, label, path }) => ({
          name: label,
          href: path,
          icon: ICONS[id] ?? IconFileText,
        }))}
        footer={
          <div className='flex flex-wrap gap-1 p-2'>
            {adminPermissions.definition.roles.map((name) => (
              <Button
                key={name}
                size='sm'
                variant={name === role ? 'primary' : 'ghost'}
                onClick={() => setRole(name)}
              >
                {name}
              </Button>
            ))}
          </div>
        }
      />
      <main className='min-w-0 flex-1 p-5 md:p-8'>
        {canOpen(role, section) ? (
          <AdminSectionView section={section} rows={data[section.id] ?? []} role={role} />
        ) : (
          <p className='text-muted-foreground'>This role cannot open {section.label}.</p>
        )}
      </main>
    </div>
  );
}
