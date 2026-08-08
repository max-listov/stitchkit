'use client';

import { TooltipProvider } from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { ReactQueryProvider } from './react-query';
import { RealtimeProvider } from './realtime';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ReactQueryProvider>
      <RealtimeProvider>
        <TooltipProvider delayDuration={250}>{children}</TooltipProvider>
      </RealtimeProvider>
      <Toaster />
    </ReactQueryProvider>
  );
}
