import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { errnoOf } from '../../internal/errno';
import {
  assertExpectedOwnerUid,
  assertUnixSocketPathLength,
  unixSocketDirectoryViolation,
} from '../../internal/unix-socket';

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
): Stats | undefined {
  try {
    return lstatSync(targetPath, { throwIfNoEntry: false });
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
): 'present' | 'absent' {
  const stats = lstatTarget(dir, 'directory', socketPath, caller);
  if (stats === undefined) return 'absent';
  const violation = unixSocketDirectoryViolation(dir, stats, caller, requiredUid);
  if (violation !== undefined) {
    throw new CodexUnixSocketError('target-refused', socketPath, violation);
  }
  return 'present';
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
 * `<path>` is a symlink, both the symlink itself and its resolved target directory + socket inode
 * must satisfy ownership and privacy checks.
 */
export function assertCodexUnixSocketClientTarget(
  socketPath: string,
  caller: string,
  expectedOwnerUid?: number,
): 'present' | 'absent' {
  assertExpectedOwnerUid(expectedOwnerUid, caller);
  const requiredUid =
    expectedOwnerUid !== undefined
      ? expectedOwnerUid
      : typeof process.getuid === 'function'
        ? process.getuid()
        : undefined;
  if (
    assertPrivateDirStats(dirname(socketPath), requiredUid, socketPath, caller) === 'absent'
  ) {
    return 'absent';
  }
  const stats = lstatTarget(socketPath, 'path', socketPath, caller);
  if (stats === undefined) return 'absent';
  if (requiredUid !== undefined && stats.uid !== requiredUid) {
    throw new CodexUnixSocketError(
      'target-refused',
      socketPath,
      `[stitchkit] ${caller}: unix socket "${socketPath}" is owned by uid ${stats.uid}, expected ${requiredUid}`,
    );
  }
  if (stats.isSymbolicLink()) {
    let resolved: string;
    try {
      resolved = realpathSync(socketPath);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return 'absent';
      throw new CodexUnixSocketError(
        'target-refused',
        socketPath,
        `[stitchkit] ${caller}: failed to resolve unix socket symlink "${socketPath}"`,
        { cause: error },
      );
    }
    if (
      assertPrivateDirStats(dirname(resolved), requiredUid, socketPath, caller) === 'absent'
    ) {
      return 'absent';
    }
    const targetStats = lstatTarget(resolved, 'resolved target', socketPath, caller);
    if (targetStats === undefined) return 'absent';
    if (!targetStats.isSocket()) {
      throw new CodexUnixSocketError(
        'target-refused',
        socketPath,
        `[stitchkit] ${caller}: resolved unix socket target "${resolved}" is not a socket`,
      );
    }
    if (requiredUid !== undefined && targetStats.uid !== requiredUid) {
      throw new CodexUnixSocketError(
        'target-refused',
        socketPath,
        `[stitchkit] ${caller}: resolved unix socket target "${resolved}" is owned by uid ${targetStats.uid}, expected ${requiredUid}`,
      );
    }
    return 'present';
  }
  if (!stats.isSocket()) {
    throw new CodexUnixSocketError(
      'target-refused',
      socketPath,
      `[stitchkit] ${caller}: "${socketPath}" is not a unix socket`,
    );
  }
  return 'present';
}
