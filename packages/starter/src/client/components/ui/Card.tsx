import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  hover?: boolean;
  padding?: 'sm' | 'md' | 'lg';
}

const paddings = { sm: 'p-3', md: 'p-4', lg: 'p-5' };

export function Card({
  children,
  hover = false,
  padding = 'md',
  className = '',
  ...props
}: CardProps) {
  return (
    <div
      className={`bg-bg-card border border-border rounded-lg ${paddings[padding]} transition-colors duration-100 ${hover ? 'hover:border-border-hover' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <h3 className={`text-[13px] font-medium text-text ${className}`}>{children}</h3>;
}

export function CardDescription({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={`text-xs text-text-muted leading-relaxed ${className}`}>{children}</p>;
}
