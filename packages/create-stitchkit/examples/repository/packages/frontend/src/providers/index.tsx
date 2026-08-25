import type { ReactNode } from 'react';
import { publicApiOrigin, publicRealtimeOrigin } from '@/lib/api/place';
import { ClientProviders } from './client-providers';

/**
 * A SERVER component on purpose.
 *
 * The browser's data calls are same-origin and need no address at all. What
 * still can is the realtime socket, which no route handler can proxy: when this
 * deployment runs the two roles on two origins, the socket's address is read
 * HERE, per request, and handed down. Reading it at request time rather than at
 * build time is what lets one artifact serve every address it is routed to; a
 * `NEXT_PUBLIC_` variable would have frozen one into the bundle.
 *
 * `undefined` for both is the normal answer for a single-origin deployment.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ClientProviders origins={{ api: publicApiOrigin(), realtime: publicRealtimeOrigin() }}>
      {children}
    </ClientProviders>
  );
}
