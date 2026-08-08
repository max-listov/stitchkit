'use client';

import * as SwitchPrimitive from '@radix-ui/react-switch';
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export const Switch = forwardRef<
  ComponentRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
        'data-[state=checked]:translate-x-[22px] data-[state=unchecked]:translate-x-[2px]',
      )}
    />
  </SwitchPrimitive.Root>
));

Switch.displayName = 'Switch';
