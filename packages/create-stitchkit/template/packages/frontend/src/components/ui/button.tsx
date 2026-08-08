'use client';

/**
 * Button - Универсальный компонент кнопки
 *
 * Варианты: default, primary, ghost, outline, destructive
 * Размеры: sm, md, lg, icon
 * Поддержка: loading, disabled, asChild (для Link)
 *
 * Powered by Radix UI Slot & CVA for Polymorphism
 */

import { Slot } from '@radix-ui/react-slot';
import type { VariantProps } from 'class-variance-authority';
import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button-variants';
import { Spinner } from './spinner';

// ==========================================================================
// Styles with CVA
// ==========================================================================

// ==========================================================================
// Types
// ==========================================================================

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

// ==========================================================================
// Component
// ==========================================================================

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    const replacesChildrenWhileLoading = size === 'icon' || size === 'icon-md';

    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          replacesChildrenWhileLoading ? (
            <Spinner />
          ) : (
            <>
              <Spinner />
              {children}
            </>
          )
        ) : (
          children
        )}
      </Comp>
    );
  },
);

Button.displayName = 'Button';
