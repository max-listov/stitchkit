'use client';

import { type ReactNode, useEffect } from 'react';
import { repositoryBridge, repositorySocket } from '@/lib/realtime/repository';

export function RealtimeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const socket = repositorySocket();
    const bridge = repositoryBridge();
    socket.connect();
    bridge.connect();
    return () => {
      bridge.disconnect();
      socket.disconnect();
    };
  }, []);
  return children;
}
