import type { IoFn } from './socket-io-peer';

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
export function loadDefaultIo(): Promise<IoFn> {
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
