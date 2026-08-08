'use client';

interface TableErrorProps {
  error: unknown;
  entity?: string;
}

/**
 * Error state component for table pages
 * Extracts error code from ApiError for display
 */
export function TableError({ error, entity = 'data' }: TableErrorProps) {
  const message = error instanceof Error ? error.message : 'Unknown error';

  return (
    <div className='flex-1 flex items-center justify-center'>
      <p className='text-sm text-destructive text-center'>
        Could not load {entity}
        <br />
        <span className='text-xs font-medium'>{message}</span>
      </p>
    </div>
  );
}
