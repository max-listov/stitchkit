'use client';

/**
 * Badge - Компонент бейджа/тега
 *
 * Варианты: default, primary, secondary, outline, success, warning, destructive
 * Размеры: sm, md
 * Опционально: иконка слева
 */

import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// ==========================================================================
// Styles with CVA
// ==========================================================================

const badgeVariants = cva(
  'inline-flex items-center font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'bg-muted text-muted-foreground hover:bg-muted/80',
        primary: 'bg-primary/10 text-primary hover:bg-primary/20',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-border text-muted-foreground',
        success: 'bg-green-500/10 text-green-800 dark:text-green-300',
        warning: 'bg-warning/15 text-warning-foreground',
        destructive: 'bg-destructive/10 text-destructive',
      },
      size: {
        sm: 'px-2 py-0.5 text-xs gap-1',
        md: 'px-3 py-1 text-sm gap-1.5',
      },
      rounded: {
        full: 'rounded-full',
        lg: 'rounded-lg',
        md: 'rounded-md',
        sm: 'rounded-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
      rounded: 'full',
    },
  },
);

const iconSizes: Record<NonNullable<VariantProps<typeof badgeVariants>['size']>, string> = {
  sm: 'w-3 h-3',
  md: 'w-4 h-4',
};

// ==========================================================================
// Types
// ==========================================================================

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  icon?: ReactNode;
}

// ==========================================================================
// Component
// ==========================================================================

export function Badge({
  children,
  variant,
  size = 'md', // Default value needs to be explicit for iconSizes lookup
  rounded,
  icon,
  className,
  ...props
}: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size, rounded }), className)} {...props}>
      {icon && (
        <span
          className={cn(
            iconSizes[size || 'md'],
            'shrink-0 [&>svg]:w-full [&>svg]:h-full [&>img]:w-full [&>img]:h-full',
          )}
        >
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}
