import { isModuleNotFound } from '../internal/optional-peer';
import type { SocketIOClientPeerLoaders } from './socket-io-contract';

export type IoFn = typeof import('socket.io-client')['io'];

/**
 * The one boundary where the injected module regains its type.
 *
 * `io` is a callable with properties, so the check is "callable" — anything
 * stricter would refuse a legitimate module and anything looser would let a
 * namespace object through to fail later as `io is not a function`.
 */
function isIoModule(module: unknown): module is { io: IoFn } {
  if (typeof module !== 'object' || module === null) return false;
  return typeof Reflect.get(module, 'io') === 'function';
}

/**
 * One client's way of getting to `io`, memoised.
 *
 * An injected loader is never put in the module-level cache: two clients in one
 * process may legitimately be built by different bundles, and one of them
 * winning a shared slot would decide which module the other uses.
 */
export function createIoResolver(
  injected: SocketIOClientPeerLoaders['client'],
  defaultIo: () => Promise<IoFn>,
): () => Promise<IoFn> {
  if (!injected) return defaultIo;
  let pending: Promise<IoFn> | null = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(injected)
        .then(
          (module: unknown) => {
            // Refused by name rather than failing later as `io is not a function`
            // — the loader is consumer-written and the likely slip is returning
            // the default export or a namespace that has no `io`. This is also
            // the boundary where the module regains its type, since the loader
            // is declared `() => Promise<unknown>` to keep `socket.io-client`
            // out of the browser entry's declarations.
            const io = isIoModule(module) ? module.io : null;
            if (!io) {
              pending = null;
              throw new Error(
                'stitchkit: the loader passed in `peers.client` did not return the "socket.io-client" module — it must resolve to the module itself, as `() => import(\'socket.io-client\')`.',
              );
            }
            return io;
          },
          (cause: unknown) => {
            pending = null;
            // Only a MISSING MODULE is re-explained. A loader that throws for its
            // own reasons is not a packaging problem, and reporting it as one
            // sends the reader after the wrong thing.
            if (!isModuleNotFound(cause)) throw cause;
            // A different fix from the default path: an injected loader failing
            // means the BUNDLE does not contain the package, and installing
            // something on the machine is the wrong answer for an artifact meant
            // to be self-contained.
            throw new Error(
              'stitchkit: createSocketIOClient could not load "socket.io-client" through the loader passed in `peers` — the artifact does not contain it. Check that the loader is a literal `import(\'socket.io-client\')` your bundler can follow, and that "socket.io-client" is a dependency of the package being bundled.',
              { cause },
            );
          },
        );
    }
    return pending;
  };
}
