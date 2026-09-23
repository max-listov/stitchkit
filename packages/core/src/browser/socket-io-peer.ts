import { isModuleNotFound } from '../internal/optional-peer';
import type { SocketIOClientPeerLoaders } from './socket-io';

export type IoFn = typeof import('socket.io-client')['io'];

// Held in a variable, not a string literal, on purpose: under `--target node`
// the bundler rewrites a *literal* external dynamic import into a `createRequire`
// shim, which drags `node:module` into the browser graph (caught by
// `check-browser-clean`). A non-literal specifier stays a native `import()`.
const SOCKET_IO_CLIENT = 'socket.io-client';

// The peer module, loaded once and shared by every client that does NOT inject
// a loader. Failure clears the cache so a later `connect()` can retry, and
// reports the missing peer clearly (the same courtesy `stitchkit/server` gives
// for its Socket.IO server peer).
let ioLoader: Promise<IoFn> | null = null;
function loadIo(): Promise<IoFn> {
  if (!ioLoader) {
    // Webpack must leave this runtime-selected optional peer alone. Without
    // the magic comment it reports an expression dependency even when a
    // consumer supplies the literal `peers.client` loader below.
    ioLoader = import(/* webpackIgnore: true */ SOCKET_IO_CLIENT).then(
      (mod: typeof import('socket.io-client')) => mod.io,
      (cause) => {
        ioLoader = null;
        throw new Error(
          'stitchkit: createSocketIOClient needs the "socket.io-client" peer — install it (e.g. `bun add socket.io-client`). Shipping one self-contained artifact instead? Pass `peers: { client: () => import(\'socket.io-client\') }` so your bundler puts it inside.',
          { cause },
        );
      },
    );
  }
  return ioLoader;
}

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
): () => Promise<IoFn> {
  if (!injected) return loadIo;
  let pending: Promise<IoFn> | null = null;
  return () => {
    if (!pending) {
      pending = injected().then(
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

/**
 * Adapt our friendly `auth` form to what `io()` expects. socket.io's function
 * form is callback-based (`(cb) => cb(payload)`) and called on every (re)connect;
 * we accept a plain sync/async producer and bridge it to that callback. If the
 * producer fails, send an empty auth object rather than leaving the handshake
 * waiting forever; a normal server-side auth gate will reject it. Object /
 * `undefined` pass straight through. No casts: socket.io types `auth` as
 * `{ [k]: any } | ((cb: (data: object) => void) => void)`.
 */
