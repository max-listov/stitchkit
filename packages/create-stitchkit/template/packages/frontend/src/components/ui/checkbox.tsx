'use client';

import type { CheckedState } from '@radix-ui/react-checkbox';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { IconCheck, IconMinus } from '@tabler/icons-react';
import { AnimatePresence, motion } from 'framer-motion';
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef, useId } from 'react';
import { cn } from '@/lib/utils';

// Базовые пропсы без checked/onCheckedChange
type BaseCheckboxProps = Omit<
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
  'checked' | 'onCheckedChange'
>;

/**
 * Внутренний компонент - вся UI логика в одном месте
 */
interface CheckboxBaseProps extends ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  label?: string;
}

const CheckboxBase = forwardRef<ComponentRef<typeof CheckboxPrimitive.Root>, CheckboxBaseProps>(
  ({ className, checked, label, id, ...props }, ref) => {
    const generatedId = useId();
    const checkboxId = id || generatedId;
    const isChecked = checked === true;
    const isIndeterminate = checked === 'indeterminate';

    return (
      <div className='flex items-center gap-2'>
        <CheckboxPrimitive.Root
          ref={ref}
          id={checkboxId}
          checked={checked}
          className={cn(
            'relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:pointer-events-none',
            'data-[state=checked]:border-primary data-[state=checked]:bg-primary',
            'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary',
            'data-[state=unchecked]:border-border data-[state=unchecked]:bg-background data-[state=unchecked]:hover:border-primary/50',
            className,
          )}
          {...props}
        >
          <AnimatePresence initial={false}>
            {(isChecked || isIndeterminate) && (
              <CheckboxPrimitive.Indicator forceMount>
                <motion.span
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                >
                  {isIndeterminate ? (
                    <IconMinus
                      size={14}
                      stroke={3}
                      className='text-primary-foreground transition-colors'
                    />
                  ) : (
                    <IconCheck
                      size={14}
                      stroke={3}
                      className='text-primary-foreground transition-colors'
                    />
                  )}
                </motion.span>
              </CheckboxPrimitive.Indicator>
            )}
          </AnimatePresence>
        </CheckboxPrimitive.Root>
        {label && (
          <label
            htmlFor={checkboxId}
            className={cn(
              'text-sm cursor-pointer select-none',
              props.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {label}
          </label>
        )}
      </div>
    );
  },
);

CheckboxBase.displayName = 'CheckboxBase';

/**
 * Обычный Checkbox - boolean API (90% случаев)
 */
interface CheckboxProps extends BaseCheckboxProps {
  label?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = forwardRef<ComponentRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(
  ({ onCheckedChange, ...props }, ref) => {
    // Адаптер: фильтруем indeterminate, возвращаем только boolean
    const handleChange = (state: CheckedState) => {
      if (state !== 'indeterminate' && onCheckedChange) {
        onCheckedChange(state);
      }
    };

    return <CheckboxBase ref={ref} onCheckedChange={handleChange} {...props} />;
  },
);

Checkbox.displayName = 'Checkbox';

/**
 * TriStateCheckbox - для редких случаев (таблицы, деревья)
 */
interface TriStateCheckboxProps extends BaseCheckboxProps {
  label?: string;
  checked?: CheckedState;
  onCheckedChange?: (checked: CheckedState) => void;
}

export const TriStateCheckbox = forwardRef<
  ComponentRef<typeof CheckboxPrimitive.Root>,
  TriStateCheckboxProps
>((props, ref) => {
  // Прямой проброс - без фильтрации
  return <CheckboxBase ref={ref} {...props} />;
});

TriStateCheckbox.displayName = 'TriStateCheckbox';
