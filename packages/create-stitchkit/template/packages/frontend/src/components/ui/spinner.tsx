import { cn } from '@/lib/utils';

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      aria-label='Loading'
      className={cn('size-4', className)}
      viewBox='0 0 24 24'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
    >
      <circle cx='12' cy='12' r='9' stroke='currentColor' strokeOpacity='0.2' strokeWidth='2' />
      <path
        d='M21 12a9 9 0 0 0-9-9'
        stroke='currentColor'
        strokeLinecap='round'
        strokeWidth='2'
      >
        <animateTransform
          attributeName='transform'
          type='rotate'
          from='0 12 12'
          to='360 12 12'
          dur='1s'
          repeatCount='indefinite'
        />
      </path>
    </svg>
  );
}
