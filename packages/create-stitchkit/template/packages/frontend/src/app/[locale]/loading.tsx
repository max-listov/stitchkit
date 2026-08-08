import { Skeleton } from '@/components/ui';

export default function Loading() {
  return (
    <main className='mx-auto min-h-dvh w-full max-w-7xl space-y-8 px-5 py-12 lg:px-8'>
      <Skeleton className='h-12 w-64' />
      <Skeleton className='h-72 w-full' />
      <div className='grid gap-3 md:grid-cols-2'>
        <Skeleton className='h-52' />
        <Skeleton className='h-52' />
      </div>
    </main>
  );
}
