import { lstatSync, unlinkSync } from 'node:fs';

/** Where a unix socket is bound and the exact permission bits it is born with. */
export interface UnixSocketBinding {
  readonly path: string;
  /** Permission bits `0o000`–`0o777`; `0o600` when access to the socket is the credential. */
  readonly mode: number;
}

const PERMISSION_BITS = 0o777;

function octal(mode: number): string {
  return `0o${mode.toString(8).padStart(3, '0')}`;
}

/**
 * Bind a unix socket that exists only with `mode`, never with wider rights first.
 *
 * `bind(2)` takes a socket file's permissions from the process umask and accepts no mode, so a
 * `chmod` after the bind leaves the umask rights on disk until it runs, and a process watching the
 * path sees them even with `chmodSync` on the next line. The umask is narrowed to exactly
 * `~mode` for the one synchronous `bind(path)` call and restored in `finally`, before any other
 * JavaScript runs.
 *
 * The umask is process-wide. A file another thread creates during that call is born at most as
 * permissive as the socket — narrower, never wider — and work that must keep the normal umask (a
 * child process, a liveness probe) runs before the call, not inside `bind`.
 *
 * The path must be free before the call, so whatever stands there afterwards was created by it;
 * a stale socket is the caller's to remove first. After `bind` the path must be a socket with
 * exactly `mode`. A bind that failed — Node and Bun report a `listen` error asynchronously, on the
 * server's `error` event — or completes later than the call, and a directory whose default ACL
 * overrides the umask, all fail here; a socket that was born with other rights is unlinked first,
 * so no client reaches it by path. The listener `bind` started is the caller's to stop.
 */
export function bindUnixSocket<T>(socket: UnixSocketBinding, bind: (path: string) => T): T {
  const { path, mode } = socket;
  if (path.length === 0) {
    throw new Error('[stitchkit] bindUnixSocket: `path` must be a non-empty socket path');
  }
  if (!Number.isInteger(mode) || mode < 0 || mode > PERMISSION_BITS) {
    throw new Error(
      `[stitchkit] bindUnixSocket: \`mode\` must be permission bits 0o000–0o777, got ${String(mode)}`,
    );
  }
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(
      `[stitchkit] bindUnixSocket: "${path}" already exists — a socket is bound on a free path; remove a stale socket first`,
    );
  }
  const previous = process.umask(~mode & PERMISSION_BITS);
  let bound: T;
  try {
    bound = bind(path);
  } finally {
    process.umask(previous);
  }
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw new Error(
      `[stitchkit] bindUnixSocket: no socket at "${path}" when bind returned — the listen failed (its error arrives on the server's error event) or does not bind synchronously inside the call`,
    );
  }
  if (!stats.isSocket()) {
    throw new Error(
      `[stitchkit] bindUnixSocket: "${path}" is not a socket after bind — the bind must listen on this path`,
    );
  }
  const born = stats.mode & PERMISSION_BITS;
  if (born !== mode) {
    unlinkSync(path);
    throw new Error(
      `[stitchkit] bindUnixSocket: socket "${path}" was born ${octal(born)} instead of ${octal(mode)} — something other than the umask sets the rights in this directory (a default ACL?); the socket was removed`,
    );
  }
  return bound;
}
