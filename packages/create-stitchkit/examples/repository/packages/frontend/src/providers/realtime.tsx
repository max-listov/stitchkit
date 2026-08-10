'use client';

import { type ReactNode, useEffect } from 'react';
import { repositoryBridge, repositorySocket } from '@/lib/realtime/repository';

export function RealtimeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    repositorySocket.connect();
    repositoryBridge.connect();
    return () => {
      repositoryBridge.disconnect();
      repositorySocket.disconnect();
    };
  }, []);
  return children;
}
