import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          'h-10 w-full px-4 bg-background border border-border rounded-lg',
          'placeholder:text-muted-foreground',
          'focus:outline-none focus:border-primary',
          'transition-colors',
          className,
        )}
        {...props}
      />
    );
  },
);

Input.displayName = 'Input';
