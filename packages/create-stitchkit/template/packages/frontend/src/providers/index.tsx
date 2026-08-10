'use client';

import { TooltipProvider } from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { ReactQueryProvider } from './react-query';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ReactQueryProvider>
      <TooltipProvider delayDuration={250}>{children}</TooltipProvider>
      <Toaster />
    </ReactQueryProvider>
  );
}
