'use client';

import type { Icon } from '@tabler/icons-react';
import { IconDots } from '@tabler/icons-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  TriStateCheckbox,
} from '@/components/ui';
import { formatDateTime } from '@/lib/utils';
import type { dataTableFeatures } from '../table-features';
import { SortableHeader } from './sortable-header';

/**
 * Creates a select column with checkbox for row selection
 */
export function createSelectColumn<T extends object>(): ColumnDef<
  typeof dataTableFeatures,
  T,
  unknown
> {
  return {
    id: 'select',
    header: ({ table }) => (
      <TriStateCheckbox
        checked={
          table.getIsAllPageRowsSelected()
            ? true
            : table.getIsSomePageRowsSelected()
              ? 'indeterminate'
              : false
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(value === true)}
        aria-label='Select all'
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label='Select row'
      />
    ),
    enableSorting: false,
    enableHiding: false,
  };
}

/**
 * Creates a date/time column with sortable header
 */
export function createDateColumn<T extends object>(
  accessorKey: keyof T & string,
  headerLabel: string,
): ColumnDef<typeof dataTableFeatures, T, unknown> {
  return {
    accessorKey,
    header: ({ column }) => <SortableHeader column={column}>{headerLabel}</SortableHeader>,
    cell: ({ row }) => {
      const value = row.getValue(accessorKey);
      if (!value) return null;

      if (!(value instanceof Date) && typeof value !== 'string') return null;
      const { date, time } = formatDateTime(value);
      return (
        <div className='flex flex-col'>
          <span className='text-sm text-muted-foreground'>{date}</span>
          <span className='text-xs text-muted-foreground/70'>{time}</span>
        </div>
      );
    },
  };
}

export interface ActionItem<T extends object> {
  icon: Icon;
  label: string;
  onClick?: (row: T) => void;
  variant?: 'default' | 'destructive';
}

function ActionsCell<T extends object>({
  row,
  getActions,
}: {
  row: T;
  getActions: (row: T) => ActionItem<T>[];
}) {
  const actions = getActions(row);

  return (
    <div className='flex justify-end pr-2'>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' size='icon' className='h-7 w-7'>
            <IconDots size={14} />
            <span className='sr-only'>Открыть меню</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.label}
              onClick={() => action.onClick?.(row)}
              className={
                action.variant === 'destructive'
                  ? 'text-destructive focus:text-destructive'
                  : undefined
              }
            >
              <action.icon size={14} />
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Creates an actions column with dropdown menu
 */
export function createActionsColumn<T extends object>(
  getActions: (row: T) => ActionItem<T>[],
): ColumnDef<typeof dataTableFeatures, T, unknown> {
  return {
    id: 'actions',
    cell: ({ row }) => <ActionsCell row={row.original} getActions={getActions} />,
  };
}
