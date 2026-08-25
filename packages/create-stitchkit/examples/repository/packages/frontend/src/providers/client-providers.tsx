'use client';

import { TooltipProvider } from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { type PublicOrigins, setPublicOrigins } from '@/lib/api/cross-origin';
import { ReactQueryProvider } from './react-query';
import { RealtimeProvider } from './realtime';

export function ClientProviders({
  origins,
  children,
}: {
  origins: PublicOrigins;
  children: ReactNode;
}) {
  // Recorded before any child renders, so the realtime socket can be built
  // lazily on first use. Idempotent: the same values every render. `undefined`
  // means this deployment serves both roles on one origin.
  setPublicOrigins(origins);

  return (
    <ReactQueryProvider>
      <RealtimeProvider>
        <TooltipProvider delayDuration={250}>{children}</TooltipProvider>
      </RealtimeProvider>
      <Toaster />
    </ReactQueryProvider>
  );
}
