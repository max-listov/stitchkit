import { cva } from 'class-variance-authority';

export const buttonVariants = cva(
  'inline-flex items-center justify-center font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default: 'bg-muted text-foreground hover:bg-muted/80',
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        ghost: 'hover:bg-muted text-muted-foreground hover:text-foreground',
        outline: 'border border-border bg-transparent hover:bg-muted',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
      },
      size: {
        sm: 'h-8 px-3 text-sm rounded-lg gap-1.5',
        md: 'h-10 px-4 text-sm rounded-xl gap-2',
        lg: 'h-12 px-6 text-base rounded-xl gap-2',
        icon: 'h-8 w-8 rounded-lg',
        'icon-md': 'h-10 w-10 rounded-xl',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);
