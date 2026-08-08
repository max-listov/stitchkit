'use client';

import * as SliderPrimitive from '@radix-ui/react-slider';
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export const Slider = forwardRef<
  ComponentRef<typeof SliderPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, 'aria-label': ariaLabel, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className='relative h-2 w-full grow overflow-hidden rounded-full bg-muted'>
      <SliderPrimitive.Range className='absolute h-full bg-primary' />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      aria-label={ariaLabel}
      className={cn(
        'block h-5 w-5 rounded-full border-2 border-primary bg-background shadow-md',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        'disabled:pointer-events-none disabled:opacity-50',
        'cursor-grab active:cursor-grabbing',
      )}
    />
  </SliderPrimitive.Root>
));

Slider.displayName = 'Slider';
