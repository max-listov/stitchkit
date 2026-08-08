import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// ==========================================================================
// Card Root
// ==========================================================================

const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-xl border bg-card text-card-foreground', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

// ==========================================================================
// Card Header
// ==========================================================================

const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-4', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

// ==========================================================================
// Card Title
// ==========================================================================

interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  level?: 2 | 3 | 4;
}

const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ className, level = 3, ...props }, ref) => {
    const titleClassName = cn('font-medium font-display tracking-tight', className);
    if (level === 2) return <h2 ref={ref} className={titleClassName} {...props} />;
    if (level === 4) return <h4 ref={ref} className={titleClassName} {...props} />;
    return <h3 ref={ref} className={titleClassName} {...props} />;
  },
);
CardTitle.displayName = 'CardTitle';

// ==========================================================================
// Card Description
// ==========================================================================

const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  ),
);
CardDescription.displayName = 'CardDescription';

// ==========================================================================
// Card Content
// ==========================================================================

const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-4 pt-0', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

// ==========================================================================
// Card Footer
// ==========================================================================

const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-4 pt-0', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
