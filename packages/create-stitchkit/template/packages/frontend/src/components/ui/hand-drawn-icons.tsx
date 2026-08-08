import { cn } from '@/lib/utils';

interface HandDrawnIconProps {
  className?: string;
}

/** Рукописный крестик — для "плохо", "не нужно" */
export function HandDrawnX({ className }: HandDrawnIconProps) {
  return (
    <svg
      aria-hidden='true'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      className={cn('w-4 h-4', className)}
    >
      <path d='M5 5 C 8 9, 14 16, 19 19' />
      <path d='M19 5 C 15 8, 10 14, 5 19' />
    </svg>
  );
}

/** Рукописная галочка — для "хорошо", "нужно" */
export function HandDrawnCheck({ className }: HandDrawnIconProps) {
  return (
    <svg
      aria-hidden='true'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={cn('w-4 h-4', className)}
    >
      <path d='M4 12 C 6 14, 8 17, 10 19 C 12 15, 16 9, 20 5' />
    </svg>
  );
}
