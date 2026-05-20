interface SkeletonProps {
  className?: string;
  lines?: number;
  circle?: boolean;
}

export function Skeleton({ className = '', lines, circle }: SkeletonProps) {
  if (circle) {
    return <div className={`rounded-full bg-bg-elevated animate-pulse ${className}`} />;
  }

  if (lines) {
    return (
      <div className='space-y-2'>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={`h-3 rounded bg-bg-elevated animate-pulse ${i === lines - 1 ? 'w-3/4' : 'w-full'}`}
            style={{ animationDelay: `${i * 100}ms` }}
          />
        ))}
      </div>
    );
  }

  return <div className={`rounded-lg bg-bg-elevated animate-pulse ${className}`} />;
}

export function SkeletonCard() {
  return (
    <div className='bg-bg-card border border-border rounded-xl p-6 space-y-4'>
      <Skeleton className='h-4 w-1/3' />
      <Skeleton lines={3} />
      <div className='flex gap-2 pt-2'>
        <Skeleton className='h-6 w-16 rounded-full' />
        <Skeleton className='h-6 w-20 rounded-full' />
      </div>
    </div>
  );
}
