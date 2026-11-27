import { lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { errnoOf } from '../../internal/errno';
import {
  assertExpectedOwnerUid,
  assertUnixSocketPathLength,
  unixSocketDirectoryViolation,
} from '../../internal/unix-socket';

const MAX_SYMLINK_HOPS = 40;

interface CodexUnixSocketTargetFsOps {
  readonly lstatSync?: typeof lstatSync;
  readonly readlinkSync?: typeof readlinkSync;
  readonly realpathSync?: typeof realpathSync;
}

/** Distinct failure categories for Codex WebSocket-over-Unix-socket connections. */
export type CodexUnixSocketErrorKind =
  | 'endpoint-absent'
  | 'endpoint-not-listening'
  | 'target-refused'
  | 'upgrade-refused'
  | 'connection-lost';

/** Typed transport error raised when dialing, upgrading, or reading a Codex Unix socket. */
export class CodexUnixSocketError extends Error {
  constructor(
    readonly kind: CodexUnixSocketErrorKind,
    readonly socketPath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CodexUnixSocketError';
  }
}

/** Validate a Codex Unix socket path eagerly before spawning or connecting. */
export function validateCodexUnixSocketPath(socketPath: string, caller: string): void {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new TypeError(`[stitchkit] ${caller}: unix socketPath must be a non-empty string`);
  }
  if (!socketPath.startsWith('/')) {
    throw new TypeError(
      `[stitchkit] ${caller}: unix socketPath must be an absolute path starting with "/", received ${JSON.stringify(socketPath)}`,
    );
  }
  if (socketPath.endsWith('/')) {
    throw new TypeError(
      `[stitchkit] ${caller}: unix socketPath must not end with "/", received ${JSON.stringify(socketPath)}`,
    );
  }
  if (/[\0\r\n\s?#]/.test(socketPath)) {
    throw new TypeError(
      `[stitchkit] ${caller}: unix socketPath contains forbidden characters (whitespace, NUL, ?, or #)`,
    );
  }
  assertUnixSocketPathLength(socketPath, caller);
}

function lstatTarget(
  targetPath: string,
  label: string,
  socketPath: string,
  caller: string,
  lstat: typeof lstatSync = lstatSync,
): Stats | undefined {
  try {
    return lstat(targetPath, { throwIfNoEntry: false });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined;
    throw new CodexUnixSocketError(
      'target-refused',
      socketPath,
      `[stitchkit] ${caller}: failed to inspect unix socket ${label} "${targetPath}"`,
      { cause: error },
    );
  }
}

function assertPrivateDirStats(
  dir: string,
  requiredUid: number | undefined,
  socketPath: string,
  caller: string,
  lstat: typeof lstatSync = lstatSync,
): 'present' | 'absent' {
  const stats = lstatTarget(dir, 'directory', socketPath, caller, lstat);
  if (stats === undefined) return 'absent';
  const violation = unixSocketDirectoryViolation(dir, stats, caller, requiredUid);
  if (violation !== undefined) {
    throw new CodexUnixSocketError('target-refused', socketPath, violation);
  }
  return 'present';
}

function canonicalizePrivateDir(
  dir: string,
  requiredUid: number | undefined,
  socketPath: string,
  caller: string,
  lstat: typeof lstatSync,
  realpath: typeof realpathSync,
): string | undefined {
  if (assertPrivateDirStats(dir, requiredUid, socketPath, caller, lstat) === 'absent') {
    return undefined;
  }
  let realDir: string;
  try {
    realDir = realpath(dir);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined;
    throw new CodexUnixSocketError(
      'target-refused',
      socketPath,
      `[stitchkit] ${caller}: failed to resolve unix socket directory "${dir}"`,
      { cause: error },
    );
  }
  if (
    realDir !== dir &&
    assertPrivateDirStats(realDir, requiredUid, socketPath, caller, lstat) === 'absent'
  ) {
    return undefined;
  }
  return realDir;
}

/**
 * Verify that `dirname(socketPath)` exists and is a private non-symlink directory, and that
 * `socketPath` itself does not already exist before spawning `codex app-server --listen`.
 * Throws {@link CodexUnixSocketError} (`'target-refused'`) on any violation.
 */
export function assertCodexUnixListenTargetAvailable(
  socketPath: string,
  caller: string,
): void {
  const dir = dirname(socketPath);
  const requiredUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (assertPrivateDirStats(dir, requiredUid, socketPath, caller) === 'absent') {
    throw new CodexUnixSocketError(
      'target-refused',
      socketPath,
      `[stitchkit] ${caller}: unix socket directory "${dir}" does not exist`,
    );
  }
  const existing = lstatTarget(socketPath, 'path', socketPath, caller);
  if (existing !== undefined) {
    throw new CodexUnixSocketError(
      'target-refused',
      socketPath,
      `[stitchkit] ${caller}: unix socket path "${socketPath}" already exists — choose a fresh socket path or remove the stale socket first`,
    );
  }
}

/**
 * Inspect the socket directory and target socket before dialing a Codex app-server Unix socket.
 *
 * Real `codex app-server --listen unix://<path>` publishes `<path>` as a user-owned symlink
 * pointing into a private `0o700` daemon directory (`/tmp/codex-daemon-<uid>/<hash>`). When
 * `<path>` is a symlink, each link hop is resolved iteratively with `readlinkSync` while
 * canonicalizing only parent directories via `realpathSync`, never calling `realpathSync` on the
 * socket inode itself (which fails with `EOPNOTSUPP` on Darwin/macOS). Every symlink hop, parent
 * directory, and the final socket inode must satisfy ownership and privacy checks.
 */
export function assertCodexUnixSocketClientTarget(
  socketPath: string,
  caller: string,
  expectedOwnerUid?: number,
  fsOps?: CodexUnixSocketTargetFsOps,
): 'present' | 'absent' {
  assertExpectedOwnerUid(expectedOwnerUid, caller);
  if (socketPath.length === 0 || socketPath.endsWith('/')) {
    throw new CodexUnixSocketError(
      'target-refused',
      socketPath,
      `[stitchkit] ${caller}: invalid unix socket target ${JSON.stringify(socketPath)}`,
    );
  }
  const requiredUid =
    expectedOwnerUid !== undefined
      ? expectedOwnerUid
      : typeof process.getuid === 'function'
        ? process.getuid()
        : undefined;
  const lstat = fsOps?.lstatSync ?? lstatSync;
  const readlink = fsOps?.readlinkSync ?? readlinkSync;
  const realpath = fsOps?.realpathSync ?? realpathSync;

  let currentPath = socketPath;
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
    const realDir = canonicalizePrivateDir(
      dirname(currentPath),
      requiredUid,
      socketPath,
      caller,
      lstat,
      realpath,
    );
    if (realDir === undefined) return 'absent';
    const candidate = join(realDir, basename(currentPath));
    const stats = lstatTarget(
      candidate,
      hop === 0 ? 'path' : 'resolved target',
      socketPath,
      caller,
      lstat,
    );
    if (stats === undefined) return 'absent';
    if (requiredUid !== undefined && stats.uid !== requiredUid) {
      throw new CodexUnixSocketError(
        'target-refused',
        socketPath,
        `[stitchkit] ${caller}: ${hop === 0 ? 'unix socket' : 'resolved unix socket target'} "${candidate}" is owned by uid ${stats.uid}, expected ${requiredUid}`,
      );
    }
    if (!stats.isSymbolicLink()) {
      if (!stats.isSocket()) {
        throw new CodexUnixSocketError(
          'target-refused',
          socketPath,
          `[stitchkit] ${caller}: ${hop === 0 ? `"${candidate}" is not a unix socket` : `resolved unix socket target "${candidate}" is not a socket`}`,
        );
      }
      return 'present';
    }
    if (hop === MAX_SYMLINK_HOPS) {
      throw new CodexUnixSocketError(
        'target-refused',
        socketPath,
        `[stitchkit] ${caller}: unix socket symlink "${socketPath}" exceeded ${MAX_SYMLINK_HOPS} hops`,
      );
    }
    let linkTarget: string;
    try {
      linkTarget = readlink(candidate);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return 'absent';
      throw new CodexUnixSocketError(
        'target-refused',
        socketPath,
        `[stitchkit] ${caller}: failed to read unix socket symlink "${candidate}"`,
        { cause: error },
      );
    }
    if (linkTarget.length === 0 || linkTarget.endsWith('/')) {
      throw new CodexUnixSocketError(
        'target-refused',
        socketPath,
        `[stitchkit] ${caller}: unix socket symlink "${candidate}" points to invalid target ${JSON.stringify(linkTarget)}`,
      );
    }
    currentPath = resolve(realDir, linkTarget);
  }
  throw new CodexUnixSocketError(
    'target-refused',
    socketPath,
    `[stitchkit] ${caller}: unix socket symlink "${socketPath}" exceeded ${MAX_SYMLINK_HOPS} hops`,
  );
}
