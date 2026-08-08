'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from 'react';
import { cn } from '@/lib/utils';

const Tooltip = TooltipPrimitive.Root;
const TooltipProvider = TooltipPrimitive.Provider;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = forwardRef<
  ComponentRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={12}
      className={cn(
        'z-50 max-w-xs overflow-hidden rounded-md border border-border bg-card px-3 py-2 text-sm text-card-foreground shadow-md',
        'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
