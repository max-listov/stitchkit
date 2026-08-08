import type { LabelHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  htmlFor: string;
}

export function Label({ children, className, htmlFor, ...props }: LabelProps) {
  return (
    <label
      className={cn('text-sm font-medium text-foreground', className)}
      htmlFor={htmlFor}
      {...props}
    >
      {children}
    </label>
  );
}
