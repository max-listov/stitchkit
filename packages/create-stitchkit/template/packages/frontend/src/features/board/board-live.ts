'use client';

import { type Board, BoardSchema, boardContract, liveContract } from '@app/shared';
import { createClient, createRealtimeClient } from 'stitchkit';
import { createWatchClient, type WatchStateFrame, watchTransport } from 'stitchkit/live';

/**
 * One socket and one watch client for the life of the tab.
 *
 * Kept in a module local rather than in React state, and that is the whole
 * point: the server shares one read between everyone asking the same question,
 * and a client per component would defeat that from the other side. A component
 * that remounts joins the subscription that exists.
 */
let shared: ReturnType<typeof connect> | undefined;

/**
 * Where the socket dials.
 *
 * The page's own origin unless a deployment says otherwise, and "otherwise" is
 * handed down per request rather than compiled in — a `NEXT_PUBLIC_` value is
 * substituted at build time, which would freeze one deployment's address into
 * the artifact. `PUBLIC_REALTIME_ORIGIN` exists because a WebSocket upgrade does
 * not survive a proxying route handler, so the two roles can share an origin for
 * HTTP and still need to name the socket's.
 */
function connect(realtimeOrigin?: string) {
  const realtime = createRealtimeClient(liveContract, {
    url: realtimeOrigin ?? window.location.origin,
  });
  realtime.connect();
  return {
    realtime,
    // `watchTransport` is the conversion the framework owns: a bound realtime
    // client's `on` is generic over its contract, and TypeScript will not relate
    // that to a transport interface. One call, and no cast in this application.
    watch: createWatchClient(boardContract, {
      transport: watchTransport(realtime),
      // A tab that navigates away and back inside the window paints from memory
      // and costs no read.
      holdMs: 30_000,
    }),
  };
}

/** The typed HTTP client, for the one operation that writes. */
export const boardApi = createClient(boardContract, { baseUrl: '/api' });

export interface BoardWatch {
  close(): void;
}

/**
 * Watch the board.
 *
 * `onState` is the honest half and is not optional in practice: `opening` means
 * subscribed and nothing read yet, which is neither healthy nor broken, and
 * `unavailable` carries the read's own words rather than a flag. A socket that
 * drops says so here and resumes on its own when it comes back.
 */
export function watchBoard(
  onValue: (board: Board) => void,
  onState: (state: WatchStateFrame) => void,
  realtimeOrigin?: string,
): BoardWatch {
  shared ??= connect(realtimeOrigin);
  const handle = shared.watch.list({});
  const stop = handle.subscribe({
    value: (value) => {
      // Parsed at the boundary rather than asserted. A watched read carries the
      // operation's output, so a value that fails its own schema means this tab
      // and the server disagree about the contract — a half-finished deploy, or
      // a cached bundle from before one. That is worth showing; a cast would
      // render it as though it were fine and fail somewhere unrelated.
      const parsed = BoardSchema.safeParse(value);
      if (!parsed.success) {
        onState({
          key: { service: boardContract.meta.prefix, action: 'list', digest: '' },
          phase: 'unavailable',
          reason: 'source-error',
          message:
            'The board arrived in a shape this page does not know — reload to update it.',
        });
        return;
      }
      onValue(parsed.data);
    },
    state: onState,
  });
  return { close: stop };
}
