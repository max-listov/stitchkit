import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className='flex flex-col items-center justify-center py-16 px-6 text-center'>
      {icon && (
        <div className='w-12 h-12 rounded-xl bg-bg-elevated border border-border flex items-center justify-center text-text-muted mb-4'>
          {icon}
        </div>
      )}
      <h3 className='text-sm font-semibold text-text mb-1'>{title}</h3>
      {description && (
        <p className='text-xs text-text-muted max-w-xs leading-relaxed'>{description}</p>
      )}
      {action && <div className='mt-4'>{action}</div>}
    </div>
  );
}
