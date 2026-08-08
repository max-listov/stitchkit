'use client';

import { IconX } from '@tabler/icons-react';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';

export interface FilterOption {
  value: string;
  label: string;
  color?: string;
}

export interface FilterConfig {
  key: string;
  placeholder: string;
  allLabel: string;
  options: FilterOption[];
}

interface TableFiltersProps {
  filters: FilterConfig[];
  values: Record<string, string | undefined>;
  onChange: (key: string, value: string | undefined) => void;
  onClear?: () => void;
}

export function TableFilters({ filters, values, onChange, onClear }: TableFiltersProps) {
  const activeCount = Object.values(values).filter(Boolean).length;

  return (
    <div className='flex items-center gap-2'>
      {filters.map((filter) => (
        <Select
          key={filter.key}
          value={values[filter.key] ?? 'all'}
          onValueChange={(v) => onChange(filter.key, v === 'all' ? undefined : v)}
        >
          <SelectTrigger
            aria-label={`Filter by ${filter.placeholder}`}
            variant='ghost'
            className='w-fit h-8 text-xs px-2 gap-1 rounded-lg'
          >
            <SelectValue placeholder={filter.placeholder} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>{filter.allLabel}</SelectItem>
            {filter.options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.color ? (
                  <span className='flex items-center gap-2'>
                    <span className={`h-2 w-2 rounded-full ${opt.color}`} />
                    {opt.label}
                  </span>
                ) : (
                  opt.label
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}

      {activeCount > 0 && onClear && (
        <Button
          variant='ghost'
          size='sm'
          onClick={onClear}
          className='h-8 px-2 text-xs text-muted-foreground hover:text-foreground'
        >
          <IconX size={14} />
          Clear
        </Button>
      )}
    </div>
  );
}
