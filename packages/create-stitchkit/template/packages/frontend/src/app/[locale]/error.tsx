'use client';

import { Button, Card, CardContent } from '@/components/ui';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className='grid min-h-dvh place-items-center p-6'>
      <Card className='max-w-lg'>
        <CardContent className='space-y-4 py-10 text-center'>
          <h1 className='text-2xl font-medium'>The project surface could not load</h1>
          <p className='text-sm text-muted-foreground'>
            The error boundary kept the shell alive.
          </p>
          <Button onClick={reset}>Try again</Button>
        </CardContent>
      </Card>
    </main>
  );
}
