import type { ProcessInstance, ProcessOwnerEvidence } from '../internal/process-instance';
import { classifyOwnerEvidence, isProcessGoneError } from './process-evidence';

const SO_ACCEPTCON_FLAG = 0x10000;
// `/proc/net/unix`: `<Num>: <RefCount> <Protocol> <Flags> <Type> <St> <Inode>[ <Path>]`. The path
// is everything after the one space the kernel prints: a name may hold any byte but `\n` — a
// `\r`, U+2028 or a trailing space is the name (`s` flag, nothing trimmed).
const PROC_NET_UNIX_LINE =
  /^[0-9a-fA-F]+:\s+[0-9a-fA-F]+\s+[0-9a-fA-F]+\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+(\d+)(?: (.*))?$/s;
// `ss -H -x -l -e`: `<netid> <state> <recv-q> <send-q> <name> <inode> * 0[ <-> ino:<node inode>
// dev:<major>/<minor> peers:]`. The name is the one field a socket's owner writes, printed raw:
// it is taken greedily, so every field after it is read from the right, where only the kernel writes.
const SS_UNIX_LINE =
  /^u_(?:str|dgr|seq)\s+\S+\s+\d+\s+\d+\s+(.*)\s(\d+)\s+\*\s+0(?:\s(.*))?$/s;
const SS_NODE = /(?:^|\s)ino:(\d+)\s+dev:(\d+)\/(\d+)(?:\s|$)/;

/**
 * The lines of a kernel socket table, refusing the table when one is not a record of it.
 *
 * Both tables print a socket's name raw, so a name holding a line break writes whole records
 * of its own. Such a name always starts a line in both tables, and no line is a record of
 * both formats: a strict parse of every line of the two finds the forgery wherever it stands.
 * It does not find two forging sockets, each bound only while one of the two tables is read.
 */
function recordLines(
  output: string,
  table: string,
  format: RegExp,
  header?: string,
): RegExpExecArray[] {
  const lines = output.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const records: RegExpExecArray[] = [];
  for (const [index, line] of lines.entries()) {
    if (index === 0 && header !== undefined && line.startsWith(header)) continue;
    const match = format.exec(line);
    if (match === null) {
      throw new Error(
        `${table} line ${index + 1} is not a socket record: a socket name holds a line break, so no line of it can be trusted`,
      );
    }
    records.push(match);
  }
  return records;
}

/** Arguments that make `ss` list every listening Unix socket with the node it is bound to. */
export const SS_UNIX_LISTENER_ARGS: readonly string[] = ['-H', '-x', '-l', '-e'];

/** A listening Unix socket as `ss` lists it, with the filesystem node the kernel bound it to. */
export interface UnixSocketListener {
  /** The socket's own inode, as `/proc/net/unix` and `/proc/<pid>/fd` name it. */
  inode: string;
  /** The name it was bound to: a path, `@abstract`, or `*` for none. */
  name: string;
  /**
   * The bound filesystem node, for a socket bound to a path: `dev` in the encoding `stat`
   * returns, `ino` shared by every hard link of a published socket.
   */
  node?: { dev: bigint; ino: bigint };
}

/**
 * Parse `ss -H -x -l -e` into every listening Unix socket. Throws when a line is not a
 * record, which a socket name holding a line break makes: the table is not readable then.
 */
export function parseUnixSocketListeners(output: string): UnixSocketListener[] {
  const listeners: UnixSocketListener[] = [];
  for (const [, name = '', inode = '', tail = ''] of recordLines(output, 'ss', SS_UNIX_LINE)) {
    const node = SS_NODE.exec(tail);
    const [, ino, major, minor] = node ?? [];
    listeners.push({
      inode,
      name,
      ...(ino !== undefined &&
        major !== undefined &&
        minor !== undefined && {
          // `ss` prints the kernel's device number split at bit 20; `stat` returns it whole.
          node: { ino: BigInt(ino), dev: (BigInt(major) << 20n) | BigInt(minor) },
        }),
    });
  }
  return listeners;
}

/** A listening Unix domain socket parsed from Linux `/proc/net/unix`. */
export interface ProcNetUnixSocket {
  flagsHex: string;
  typeHex: string;
  stateHex: string;
  listening: boolean;
  inode: string;
  path: string;
}

/** Minimal socket inspection subset of `ProcessIdentityAdapter`. */
export interface UnixSocketInspectionAdapter {
  readProcNetUnix(): Promise<string>;
  readProcessSocketInodes(pid: number): Promise<ReadonlySet<string>>;
  probeProcessOwner(
    pid: number,
    recorded: ProcessInstance | null | undefined,
  ): Promise<ProcessOwnerEvidence>;
  /**
   * Inodes of the listening sockets bound to the filesystem node `socketPath` resolves to,
   * or, for an `@abstract` name, listed under exactly that name — by a table other than
   * `/proc/net/unix`, so that a socket counts only where both agree.
   *
   * A path names a socket only through its node. A server may bind one name and publish
   * another by hard link, and a name unlinked long ago still stands beside its listener in
   * `/proc/net/unix`: comparing path strings misses the first and trusts the second.
   */
  readSocketInodesAtPath(socketPath: string): Promise<ReadonlySet<string>>;
}

/** Failure subset returned by socket ownership checks. */
export type UnixSocketVerificationFailure =
  | {
      status: 'runtime-unavailable';
      reason:
        | 'process-unobservable'
        | 'process-gone'
        | 'socket-not-listening'
        | 'socket-unverifiable';
      pid: number;
      socketPath?: string;
      cause?: unknown;
    }
  | {
      status: 'runtime-conflict';
      reason: 'pid-reused' | 'socket-owned-by-other-process';
      pid: number;
      socketPath?: string;
      listeningInodes?: string[];
    };

/**
 * Parse `/proc/net/unix` content and return every listening Unix socket
 * (`St === 1` with `SO_ACCEPTCON` flag `0x10000` set, non-zero inode) that has a
 * bound path. Throws when a line is not a record, which a socket name holding a line
 * break makes: the table is not readable then.
 */
export function parseProcNetUnixListeningSockets(content: string): ProcNetUnixSocket[] {
  const sockets: ProcNetUnixSocket[] = [];
  for (const match of recordLines(content, '/proc/net/unix', PROC_NET_UNIX_LINE, 'Num')) {
    const flagsHex = match[1] ?? '';
    const typeHex = match[2] ?? '';
    const stateHex = match[3] ?? '';
    const inode = match[4] ?? '';
    const path = match[5] ?? '';
    const flags = Number.parseInt(flagsHex, 16);
    const state = Number.parseInt(stateHex, 16);
    const listening = state === 1 && (flags & SO_ACCEPTCON_FLAG) !== 0;
    if (!listening || path.length === 0 || inode === '0') continue;
    sockets.push({ flagsHex, typeHex, stateHex, listening: true, inode, path });
  }
  return sockets;
}

/**
 * The listening sockets `socketPath` reaches, as `/proc/net/unix` lists them and the second
 * table confirms (`boundInodes`): by literal name for an `@abstract` socket, by the inodes
 * bound to the path's filesystem node otherwise.
 */
export function matchListeningSockets(
  sockets: readonly ProcNetUnixSocket[],
  socketPath: string,
  boundInodes: ReadonlySet<string>,
): ProcNetUnixSocket[] {
  if (socketPath.startsWith('@')) {
    return sockets.filter(
      (entry) => entry.path === socketPath && boundInodes.has(entry.inode),
    );
  }
  return sockets.filter(
    (entry) => !entry.path.startsWith('@') && boundInodes.has(entry.inode),
  );
}

function sameSocketInodeSet(
  left: readonly ProcNetUnixSocket[],
  right: readonly ProcNetUnixSocket[],
): boolean {
  const leftSet = new Set(left.map((entry) => entry.inode));
  const rightSet = new Set(right.map((entry) => entry.inode));
  if (leftSet.size !== rightSet.size) return false;
  for (const inode of leftSet) {
    if (!rightSet.has(inode)) return false;
  }
  return true;
}

async function snapshotListeningSockets(
  pid: number,
  socketPath: string,
  adapter: UnixSocketInspectionAdapter,
): Promise<
  | { readonly ok: true; readonly sockets: ProcNetUnixSocket[] }
  | { readonly ok: false; readonly failure: UnixSocketVerificationFailure }
> {
  let listening: ProcNetUnixSocket[];
  let boundInodes: ReadonlySet<string>;
  try {
    listening = parseProcNetUnixListeningSockets(await adapter.readProcNetUnix());
    boundInodes = await adapter.readSocketInodesAtPath(socketPath);
  } catch (cause) {
    return {
      ok: false,
      // The table of listening sockets is what failed, not the process: ownership is unknown.
      failure: {
        status: 'runtime-unavailable',
        reason: 'socket-unverifiable',
        pid,
        socketPath,
        cause,
      },
    };
  }
  return { ok: true, sockets: matchListeningSockets(listening, socketPath, boundInodes) };
}

async function readSocketInodesOrFail(
  pid: number,
  socketPath: string,
  adapter: UnixSocketInspectionAdapter,
): Promise<
  | { readonly ok: true; readonly inodes: ReadonlySet<string> }
  | { readonly ok: false; readonly failure: UnixSocketVerificationFailure }
> {
  try {
    return { ok: true, inodes: await adapter.readProcessSocketInodes(pid) };
  } catch (cause) {
    return {
      ok: false,
      failure: {
        status: 'runtime-unavailable',
        reason: isProcessGoneError(cause) ? 'process-gone' : 'process-unobservable',
        pid,
        socketPath,
        cause,
      },
    };
  }
}

/**
 * Verify that `pid` owns the listening Unix socket at `socketPath`, handling
 * in-process socket reloads via a second `/proc/net/unix` snapshot (and one
 * bounded `/proc/<pid>/fd` re-read if the listening inode changed).
 */
export async function verifyUnixSocketOwnership(
  pid: number,
  socketPath: string,
  targetInstance: ProcessInstance,
  adapter: UnixSocketInspectionAdapter,
): Promise<
  | { readonly ok: true; readonly inode: string; readonly processInodes: ReadonlySet<string> }
  | { readonly ok: false; readonly failure: UnixSocketVerificationFailure }
> {
  const snap1 = await snapshotListeningSockets(pid, socketPath, adapter);
  if (!snap1.ok) return snap1;
  if (snap1.sockets.length === 0) {
    return {
      ok: false,
      failure: {
        status: 'runtime-unavailable',
        reason: 'socket-not-listening',
        pid,
        socketPath,
      },
    };
  }

  const fdRead1 = await readSocketInodesOrFail(pid, socketPath, adapter);
  if (!fdRead1.ok) return fdRead1;
  let processInodes = fdRead1.inodes;
  let owned = snap1.sockets.find((entry) => processInodes.has(entry.inode));

  if (owned === undefined) {
    const snap2 = await snapshotListeningSockets(pid, socketPath, adapter);
    if (!snap2.ok) return snap2;
    if (snap2.sockets.length === 0) {
      return {
        ok: false,
        failure: {
          status: 'runtime-unavailable',
          reason: 'socket-not-listening',
          pid,
          socketPath,
        },
      };
    }
    owned = snap2.sockets.find((entry) => processInodes.has(entry.inode));
    if (owned === undefined && !sameSocketInodeSet(snap1.sockets, snap2.sockets)) {
      const fdRead2 = await readSocketInodesOrFail(pid, socketPath, adapter);
      if (!fdRead2.ok) return fdRead2;
      processInodes = fdRead2.inodes;
      owned = snap2.sockets.find((entry) => processInodes.has(entry.inode));
    }
    if (owned === undefined) {
      const ownerNow = await adapter.probeProcessOwner(pid, targetInstance);
      const ownerFailure = classifyOwnerEvidence(pid, ownerNow);
      if (ownerFailure !== null) return { ok: false, failure: ownerFailure };
      return {
        ok: false,
        failure: {
          status: 'runtime-conflict',
          reason: 'socket-owned-by-other-process',
          pid,
          socketPath,
          listeningInodes: snap2.sockets.map((entry) => entry.inode),
        },
      };
    }
  }

  return { ok: true, inode: owned.inode, processInodes };
}

/**
 * Re-read `/proc/net/unix` after `probeProcessOwner` succeeds to confirm the
 * socket is still listening and owned by `pid` (tolerating an in-process reload
 * with one fd refresh).
 */
export async function confirmUnixSocketAfterProbe(
  pid: number,
  socketPath: string,
  previousInode: string,
  processInodes: ReadonlySet<string>,
  targetInstance: ProcessInstance,
  adapter: UnixSocketInspectionAdapter,
): Promise<
  | { readonly ok: true; readonly inode: string }
  | { readonly ok: false; readonly failure: UnixSocketVerificationFailure }
> {
  const snapAfter = await snapshotListeningSockets(pid, socketPath, adapter);
  if (!snapAfter.ok) return snapAfter;
  if (snapAfter.sockets.length === 0) {
    return {
      ok: false,
      failure: {
        status: 'runtime-unavailable',
        reason: 'socket-not-listening',
        pid,
        socketPath,
      },
    };
  }
  let confirmed = snapAfter.sockets.find((entry) => processInodes.has(entry.inode));
  if (confirmed === undefined) {
    if (!snapAfter.sockets.some((entry) => entry.inode === previousInode)) {
      const fdRefresh = await readSocketInodesOrFail(pid, socketPath, adapter);
      if (!fdRefresh.ok) return fdRefresh;
      confirmed = snapAfter.sockets.find((entry) => fdRefresh.inodes.has(entry.inode));
    }
    const ownerAfter = await adapter.probeProcessOwner(pid, targetInstance);
    const ownerFailure = classifyOwnerEvidence(pid, ownerAfter);
    if (ownerFailure !== null) return { ok: false, failure: ownerFailure };
    if (confirmed === undefined) {
      return {
        ok: false,
        failure: {
          status: 'runtime-conflict',
          reason: 'socket-owned-by-other-process',
          pid,
          socketPath,
          listeningInodes: snapAfter.sockets.map((entry) => entry.inode),
        },
      };
    }
  }
  return { ok: true, inode: confirmed.inode };
}
