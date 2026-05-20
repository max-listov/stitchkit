import type { ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}

const tones: Record<Tone, string> = {
  neutral: 'bg-bg-elevated text-text-muted border-border',
  success: 'bg-success/10 text-success border-success/20',
  warning: 'bg-warning/10 text-warning border-warning/20',
  danger: 'bg-danger/10 text-danger border-danger/20',
  accent: 'bg-accent/10 text-accent border-accent/20',
};

export function Badge({ tone = 'neutral', children, className = '', dot }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-5 px-2 text-[11px] font-medium tracking-wide border rounded-md ${tones[tone]} ${className}`}
    >
      {dot && (
        <span
          className={`w-1.5 h-1.5 rounded-full ${tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : tone === 'danger' ? 'bg-danger' : tone === 'accent' ? 'bg-accent' : 'bg-text-muted'}`}
        />
      )}
      {children}
    </span>
  );
}
