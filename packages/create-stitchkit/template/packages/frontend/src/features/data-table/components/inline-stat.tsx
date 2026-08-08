'use client';

import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';

interface InlineStatProps {
  label: string;
  value: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  isLoading?: boolean;
  className?: string;
}

/**
 * Compact inline stat card with icon and single value
 */
export function InlineStat({
  label,
  value,
  icon: Icon,
  isLoading,
  className,
}: InlineStatProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 lg:gap-3 px-3 lg:px-4 py-2 lg:py-3 bg-muted/40 rounded-lg',
        className,
      )}
    >
      <div className='flex items-center justify-center w-7 h-7 lg:w-9 lg:h-9 bg-background rounded-md shrink-0'>
        <Icon className='w-4 h-4 lg:w-[18px] lg:h-[18px] text-muted-foreground' />
      </div>
      <div className='flex flex-col min-w-0'>
        <span className='text-[10px] lg:text-xs text-muted-foreground'>{label}</span>
        {isLoading ? (
          <div className='h-5 lg:h-7 w-16 bg-muted animate-pulse rounded' />
        ) : (
          <span className='text-base lg:text-lg font-semibold tracking-tight'>{value}</span>
        )}
      </div>
    </div>
  );
}

interface DualStatItem {
  value: string;
  suffix: string;
  /** Цвет точки (на мобильных показывается вместо suffix) */
  dotColor?: string;
}

interface DualInlineStatProps {
  label: string;
  items: DualStatItem[];
  icon: ComponentType<{ size?: number; className?: string }>;
  isLoading?: boolean;
  className?: string;
}

/**
 * Compact inline stat card with icon and two values side by side
 */
export function DualInlineStat({
  label,
  items,
  icon: Icon,
  isLoading,
  className,
}: DualInlineStatProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 lg:gap-3 px-3 lg:px-4 py-2 lg:py-3 bg-muted/40 rounded-lg',
        className,
      )}
    >
      <div className='flex items-center justify-center w-7 h-7 lg:w-9 lg:h-9 bg-background rounded-md shrink-0'>
        <Icon className='w-4 h-4 lg:w-[18px] lg:h-[18px] text-muted-foreground' />
      </div>
      <div className='flex flex-col min-w-0'>
        <span className='text-[10px] lg:text-xs text-muted-foreground'>{label}</span>
        {isLoading ? (
          <div className='h-5 lg:h-7 w-24 bg-muted animate-pulse rounded' />
        ) : (
          <div className='flex items-baseline gap-2 lg:gap-3 whitespace-nowrap'>
            {items.map((item, i) => (
              <span key={item.suffix} className='flex items-center gap-1.5 lg:gap-1.5'>
                <span className='text-base lg:text-lg font-semibold tracking-tight'>
                  {item.value}
                </span>
                {/* На мобильных — точка, на десктопе — текст */}
                {item.dotColor ? (
                  <>
                    <span className={cn('w-1.5 h-1.5 rounded-full lg:hidden', item.dotColor)} />
                    <span className='hidden lg:inline text-[10px] lg:text-xs text-muted-foreground'>
                      {item.suffix}
                    </span>
                  </>
                ) : (
                  <span className='text-[10px] lg:text-xs text-muted-foreground'>
                    {item.suffix}
                  </span>
                )}
                {i < items.length - 1 && <span className='w-px h-3 bg-border ml-1 lg:ml-1' />}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
