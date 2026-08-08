import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'min-h-28 w-full resize-y rounded-lg border border-border bg-background px-4 py-3',
      'placeholder:text-muted-foreground focus:border-primary focus:outline-none',
      'transition-colors',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));

Textarea.displayName = 'Textarea';
