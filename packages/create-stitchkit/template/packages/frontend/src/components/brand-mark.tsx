import Image from 'next/image';
import { cn } from '@/lib/utils/cn';

export function BrandMark({
  className,
  priority = false,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      alt=''
      aria-hidden='true'
      className={cn('size-8 shrink-0 object-contain', className)}
      height={32}
      priority={priority}
      src='/mascot-stitch.png'
      width={32}
    />
  );
}
