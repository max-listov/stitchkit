import { linkSync, lstatSync, type Stats, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { errnoOf } from './errno';
import { randomHex } from './random-hex';
import { UnixClientTransportError } from './unix-client-error';
import { withUnixSocketLockSync } from './unix-socket-lock';

/** Where a unix socket is bound and the exact permission bits it is born with. */
export interface UnixSocketBinding {
  readonly path: string;
  /** Permission bits `0o000`–`0o777`; `0o600` when access to the socket is the credential. */
  readonly mode: number;
}

/** Filesystem identity of a socket or lock file, used to unlink only our own inode. */
export interface UnixSocketInode {
  readonly dev: number;
  readonly ino: number;
}

/** A bound unix socket path paired with the inode created by this listener. */
export interface OwnedUnixSocket extends UnixSocketInode {
  readonly path: string;
}

/**
 * Portable maximum UTF-8 byte length for a Unix domain socket path.
 * macOS `sockaddr_un.sun_path` is 104 bytes including the trailing NUL (103 usable bytes);
 * Linux is 108 bytes. Enforcing 103 bytes on every platform keeps paths dialable by every
 * local client (`curl`, Python, Node, Bun) without relying on Linux `/proc/self/fd` workarounds.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

const PERMISSION_BITS = 0o777;
const GROUP_OR_OTHER_WRITE_BITS = 0o022;
const MAX_STAGING_ATTEMPTS = 8;
const MIN_STAGING_NAME_BYTES = 3;

function sunPathLimitFor(platform: string): number {
  return platform === 'darwin' ? 104 : 108;
}

function octal(mode: number): string {
  return `0o${mode.toString(8).padStart(3, '0')}`;
}

/** Validate unix socket permission bits (`0o000`–`0o777`) before touching the filesystem. */
export function assertUnixSocketMode(mode: number, caller: string): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > PERMISSION_BITS) {
    throw new Error(
      `[stitchkit] ${caller}: \`mode\` must be permission bits 0o000–0o777, got ${String(mode)}`,
    );
  }
}

/** Remove `path` only when it is still a socket with the exact `(dev, ino)` recorded earlier. */
export function unlinkUnixSocketIfMatching(path: string, expected: UnixSocketInode): boolean {
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (
    current === undefined ||
    !current.isSocket() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Remove our bound socket on shutdown only if the path still points to our own `(dev, ino)`.
 * Acquires the per-socket lock so unlink cannot race a concurrent startup probe/bind.
 */
export function unlinkUnixSocketIfOwned(owned: OwnedUnixSocket): boolean {
  const pre = lstatSync(owned.path, { throwIfNoEntry: false });
  if (pre === undefined || !pre.isSocket() || pre.dev !== owned.dev || pre.ino !== owned.ino) {
    return false;
  }
  try {
    return withUnixSocketLockSync(owned.path, () =>
      unlinkUnixSocketIfMatching(owned.path, owned),
    );
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Refuse a unix socket path longer than the portable 103-byte `sun_path` ceiling. */
export function assertUnixSocketPathLength(socketPath: string, caller: string): void {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `[stitchkit] ${caller}: unix socket path "${socketPath}" is ${bytes} bytes, exceeding the ${MAX_UNIX_SOCKET_PATH_BYTES}-byte portable sun_path limit (ENAMETOOLONG) — choose a shorter path`,
    );
  }
}

function directoryPrivacyViolation(
  dir: string,
  stats: Stats,
  caller: string,
): string | undefined {
  if (stats.isSymbolicLink()) {
    return `[stitchkit] ${caller}: unix socket directory "${dir}" must not be a symlink`;
  }
  if (!stats.isDirectory()) {
    return `[stitchkit] ${caller}: unix socket parent "${dir}" is not a directory`;
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    return `[stitchkit] ${caller}: unix socket directory "${dir}" is owned by uid ${stats.uid}, expected ${process.getuid()}`;
  }
  const mode = stats.mode & PERMISSION_BITS;
  if ((mode & GROUP_OR_OTHER_WRITE_BITS) !== 0) {
    return `[stitchkit] ${caller}: unix socket directory "${dir}" must not be writable by group or others (mode ${octal(mode)}) — use a private 0o700 directory`;
  }
  return undefined;
}

/**
 * Verify that `dirname(socketPath)` exists, is a real directory (not a symlink), is owned by
 * the current user, and is not writable by group or others.
 */
export function assertPrivateUnixSocketDirectory(socketPath: string, caller: string): void {
  const dir = dirname(socketPath);
  const stats = lstatSync(dir, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw new Error(`[stitchkit] ${caller}: unix socket directory "${dir}" does not exist`);
  }
  const violation = directoryPrivacyViolation(dir, stats, caller);
  if (violation !== undefined) throw new Error(violation);
}

function statForClientTarget(
  targetPath: string,
  label: string,
  caller: string,
  socketPath: string,
): Stats | undefined {
  try {
    return lstatSync(targetPath, { throwIfNoEntry: false });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined;
    const code = errnoOf(error) ?? 'UNKNOWN';
    throw new UnixClientTransportError(
      'UNIX_TARGET_REFUSED',
      `[stitchkit] ${caller}: failed to inspect unix socket ${label} "${targetPath}" (${code})`,
      'not-dispatched',
      { cause: error, socketPath },
    );
  }
}

/**
 * Verify the socket directory and socket inode before dialing a unix socket.
 *
 * Missing directories or sockets (`ENOENT`) return without throwing so the caller's connect
 * path still classifies them as `UNIX_CONNECT_FAILED` (`not-dispatched`). Policy violations
 * and other `lstat` failures (`ENOTDIR`, `EACCES`, `ELOOP`) fail immediately with a
 * non-retryable `UNIX_TARGET_REFUSED` (`not-dispatched`) error.
 */
export function assertUnixSocketClientTarget(
  socketPath: string,
  caller = 'createUnixClientTransport',
): void {
  const dir = dirname(socketPath);
  const refuse = (message: string): never => {
    throw new UnixClientTransportError('UNIX_TARGET_REFUSED', message, 'not-dispatched', {
      socketPath,
    });
  };
  const dirStats = statForClientTarget(dir, 'directory', caller, socketPath);
  if (dirStats === undefined) return;
  const dirViolation = directoryPrivacyViolation(dir, dirStats, caller);
  if (dirViolation !== undefined) refuse(dirViolation);
  const socketStats = statForClientTarget(socketPath, 'path', caller, socketPath);
  if (socketStats === undefined) return;
  if (socketStats.isSymbolicLink()) {
    refuse(`[stitchkit] ${caller}: unix socket "${socketPath}" must not be a symlink`);
  }
  if (!socketStats.isSocket()) {
    refuse(`[stitchkit] ${caller}: "${socketPath}" is not a unix socket`);
  }
  if (typeof process.getuid === 'function' && socketStats.uid !== process.getuid()) {
    refuse(
      `[stitchkit] ${caller}: unix socket "${socketPath}" is owned by uid ${socketStats.uid}, expected ${process.getuid()}`,
    );
  }
}

/**
 * Choose a hidden staging filename in `dir` that fits within the platform's `sun_path` budget.
 * Shortens from `.sk-<6 hex>` down to `.s<hex>` or `.<hex>` when the directory is near the limit,
 * and fails loudly with `ENAMETOOLONG` if fewer than 3 bytes remain.
 */
export function chooseStagingSocketName(
  dir: string,
  targetPath: string,
  platform: string = process.platform,
): string {
  const limit = sunPathLimitFor(platform);
  const prefixBytes = Buffer.byteLength(join(dir, 'x')) - 1;
  const maxNameBytes = limit - 1 - prefixBytes;
  if (maxNameBytes >= 10) return `.sk-${randomHex(3)}`;
  if (maxNameBytes >= 4) {
    const suffixLen = maxNameBytes - 2;
    return `.s${randomHex(Math.ceil(suffixLen / 2)).slice(0, suffixLen)}`;
  }
  if (maxNameBytes === MIN_STAGING_NAME_BYTES) return `.${randomHex(1)}`;
  throw new Error(
    `[stitchkit] createServer: unix socket directory for "${targetPath}" leaves too little room in sun_path for a staging name (ENAMETOOLONG)`,
  );
}

/**
 * Bind a unix socket on a private staging name, atomically publish it to `targetPath` via `link`,
 * then unlink the staging name.
 *
 * Publishing through a staging name gives two guarantees simultaneously:
 * 1. `link(staging, targetPath)` atomically fails with `EEXIST` if anything exists at `targetPath`.
 * 2. When Bun's `server.stop()` later unlinks the path it was given (`staging`), `targetPath` is
 *    untouched, so our own shutdown path can check `(dev, ino)` before removing `targetPath`.
 */
export function publishStagedUnixSocket<T>(
  targetPath: string,
  bind: (stagingPath: string) => T,
  stop: (server: T) => void,
): { readonly server: T; readonly owned: OwnedUnixSocket } {
  const dir = dirname(targetPath);
  let stagingPath = '';
  let server: T | undefined;
  for (let attempt = 0; attempt < MAX_STAGING_ATTEMPTS; attempt += 1) {
    stagingPath = join(dir, chooseStagingSocketName(dir, targetPath));
    try {
      server = bind(stagingPath);
      break;
    } catch (error) {
      if (errnoOf(error) === 'EADDRINUSE' && attempt + 1 < MAX_STAGING_ATTEMPTS) continue;
      throw error;
    }
  }
  if (server === undefined) {
    throw new Error(
      `[stitchkit] createServer: failed to allocate a staging socket name for "${targetPath}"`,
    );
  }
  let linked: OwnedUnixSocket | undefined;
  try {
    // Capture our exact (dev, ino) from our private staging path before targetPath exists.
    const stats = lstatSync(stagingPath);
    linkSync(stagingPath, targetPath);
    linked = { path: targetPath, dev: stats.dev, ino: stats.ino };
    try {
      unlinkSync(stagingPath);
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error;
    }
    return { server, owned: linked };
  } catch (error) {
    stop(server);
    if (linked) unlinkUnixSocketIfMatching(linked.path, linked);
    try {
      unlinkSync(stagingPath);
    } catch {
      // Best-effort cleanup of our private staging name.
    }
    throw error;
  }
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
  assertUnixSocketMode(mode, 'bindUnixSocket');
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
    unlinkUnixSocketIfMatching(path, { dev: stats.dev, ino: stats.ino });
    throw new Error(
      `[stitchkit] bindUnixSocket: socket "${path}" was born ${octal(born)} instead of ${octal(mode)} — something other than the umask sets the rights in this directory (a default ACL?); the socket was removed`,
    );
  }
  return bound;
}
