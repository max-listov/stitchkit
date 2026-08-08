'use client';

import { IconChevronDown, IconChevronUp, IconSelector } from '@tabler/icons-react';
import type { ReactNode } from 'react';

interface SortableHeaderProps {
  column: {
    getIsSorted: () => false | 'asc' | 'desc';
    toggleSorting: (desc: boolean) => void;
  };
  children: ReactNode;
}

export function SortableHeader({ column, children }: SortableHeaderProps) {
  const sorted = column.getIsSorted();

  const Icon =
    sorted === 'asc' ? IconChevronUp : sorted === 'desc' ? IconChevronDown : IconSelector;

  return (
    <button
      type='button'
      className='flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer whitespace-nowrap'
      onClick={() => {
        const currentSorted = column.getIsSorted();
        column.toggleSorting(currentSorted === 'asc');
      }}
    >
      {children}
      <Icon size={14} className={sorted ? undefined : 'opacity-40'} />
    </button>
  );
}
