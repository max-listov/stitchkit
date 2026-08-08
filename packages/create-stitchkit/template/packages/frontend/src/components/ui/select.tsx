'use client';

/**
 * Select - Dropdown компонент
 *
 * Составные части: Select, SelectTrigger, SelectContent, SelectItem, SelectGroup, SelectLabel, SelectSeparator
 * Варианты trigger: default, outline
 * Размеры: sm, md
 *
 * Powered by Radix UI Select & CVA
 */

import * as SelectPrimitive from '@radix-ui/react-select';
import { IconCheck, IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from 'react';
import { cn } from '@/lib/utils';

// ==========================================================================
// Root & Value
// ==========================================================================

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

// ==========================================================================
// Group & Label
// ==========================================================================

const SelectGroup = SelectPrimitive.Group;

const SelectLabel = forwardRef<
  ComponentRef<typeof SelectPrimitive.Label>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn('px-3 py-1.5 text-xs text-muted-foreground', className)}
    {...props}
  />
));
SelectLabel.displayName = 'SelectLabel';

// ==========================================================================
// Separator
// ==========================================================================

const SelectSeparator = forwardRef<
  ComponentRef<typeof SelectPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-border', className)}
    {...props}
  />
));
SelectSeparator.displayName = 'SelectSeparator';

// ==========================================================================
// Trigger Styles
// ==========================================================================

const selectTriggerVariants = cva(
  'flex items-center justify-between gap-2 text-foreground transition-colors cursor-pointer outline-hidden disabled:opacity-50 disabled:cursor-not-allowed data-[placeholder]:text-muted-foreground',
  {
    variants: {
      variant: {
        default: 'bg-muted hover:bg-muted/80',
        outline: 'border border-border bg-transparent hover:bg-muted',
        ghost: 'bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      },
      size: {
        sm: 'h-8 px-3 text-sm rounded-lg',
        md: 'h-10 px-4 text-sm rounded-xl',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  },
);

// ==========================================================================
// Trigger
// ==========================================================================

interface SelectTriggerProps
  extends ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>,
    VariantProps<typeof selectTriggerVariants> {}

const SelectTrigger = forwardRef<
  ComponentRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, variant, size, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(selectTriggerVariants({ variant, size, className }))}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <IconChevronDown className='h-3 w-3 text-muted-foreground' />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

// ==========================================================================
// Content Styles
// ==========================================================================

const selectContentVariants = cva(
  [
    'relative z-50 max-h-[var(--radix-select-content-available-height)] min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-xl shadow-lg',
    'data-[state=open]:animate-in data-[state=closed]:animate-out',
    'fade-in-0 fade-out-0 zoom-in-95 zoom-out-95',
    'duration-200',
  ],
  {
    variants: {
      variant: {
        default: 'border border-border bg-background text-foreground',
        glass: 'border border-border text-foreground bg-background/80 backdrop-blur-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

// ==========================================================================
// Content
// ==========================================================================

const SelectScrollUpButton = forwardRef<
  ComponentRef<typeof SelectPrimitive.ScrollUpButton>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <IconChevronUp className='h-4 w-4' stroke={2} />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = 'SelectScrollUpButton';

const SelectScrollDownButton = forwardRef<
  ComponentRef<typeof SelectPrimitive.ScrollDownButton>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <IconChevronDown className='h-4 w-4' stroke={2} />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = 'SelectScrollDownButton';

interface SelectContentProps
  extends ComponentPropsWithoutRef<typeof SelectPrimitive.Content>,
    VariantProps<typeof selectContentVariants> {}

const SelectContent = forwardRef<
  ComponentRef<typeof SelectPrimitive.Content>,
  SelectContentProps
>(({ className, children, position = 'popper', variant, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(selectContentVariants({ variant }), className)}
      position={position}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(
          'p-1',
          position === 'popper' &&
            'h-(--radix-select-trigger-height) w-full min-w-(--radix-select-trigger-width)',
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = 'SelectContent';

// ==========================================================================
// Item
// ==========================================================================

const SelectItem = forwardRef<
  ComponentRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-pointer select-none items-center rounded-lg py-2 pl-3 pr-8 text-sm outline-hidden',
      'focus:bg-muted',
      'data-disabled:pointer-events-none data-disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <span className='absolute right-2 flex h-4 w-4 items-center justify-center'>
      <SelectPrimitive.ItemIndicator>
        <IconCheck className='h-4 w-4' stroke={2} />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
));
SelectItem.displayName = 'SelectItem';

// ==========================================================================
// Exports
// ==========================================================================

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
