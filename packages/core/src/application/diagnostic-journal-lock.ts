import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { promisify } from 'node:util';
import { isRecord } from '../internal/typed';
import type {
  DiagnosticJournalLockDiagnosis,
  DiagnosticJournalLockPolicy,
} from './diagnostic-journal-contract';

type FileHandle = Awaited<ReturnType<typeof open>>;

export interface AcquiredDiagnosticJournalLock {
  readonly handle: FileHandle;
  readonly reclaimedStale: boolean;
}

interface JournalLockOwner {
  readonly pid: number;
  readonly host: string;
  readonly acquiredAt: string;
  /** Stable machine identity; absent in locks written before it existed. */
  readonly machine?: string;
}

function isExisting(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function readOwner(text: string): JournalLockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { pid, host, acquiredAt, machine } = parsed;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof host !== 'string' || host.length === 0) return undefined;
  if (typeof acquiredAt !== 'string') return undefined;
  const identified = typeof machine === 'string' && machine.length > 0 ? { machine } : {};
  return { pid, host, acquiredAt, ...identified };
}

/**
 * This machine's identity, or `null` when the platform offers none.
 *
 * A host name is **mutable state, not identity**: it changes on a VPN or Tailscale transition, on
 * DHCP handing out a different name, on a container or pod restart. A machine that renamed itself
 * was therefore classified as foreign to itself and could never reclaim its own abandoned lock —
 * observed as a supervisor restarting a service 127 times in 1h47m against a pid that had not
 * existed for hours, recovered only by a human deleting the file.
 *
 * The identity has to come from the operating system, not from a file this library writes: a UUID
 * stored beside the journal, or under a home directory, is copied or shared exactly where the
 * guard matters — a network filesystem — and would make two machines look like one, which is the
 * unsafe direction. So the sources are the platform's own, and where there is none the answer is
 * `null` rather than a guess.
 */
let detectedIdentity: string | null | undefined;

async function firstReadableLine(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      const text = (await readFile(path, 'utf8')).trim();
      if (text.length > 0) return text;
    } catch {
      // Absent or unreadable is not an error here: the next source answers, or nothing does.
    }
  }
  return null;
}

const run = promisify(execFile);

/**
 * `IOPlatformUUID` out of an `ioreg` dump, or `null` when the dump does not carry one.
 *
 * @internal Exported for the tests: the registry only exists on darwin, so a parser folded into the
 * spawn could never be exercised anywhere else — and this branch decides the identity of the very
 * machines the lock policy was fixed for.
 */
export function parsePlatformUuid(dump: string): string | null {
  return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(dump)?.[1] ?? null;
}

/**
 * @internal `command` is a seam for the tests. macOS keeps no machine-id file, so the I/O cannot be
 * removed — but which executable answers can be, and that makes the branch provable off darwin.
 */
export async function readDarwinPlatformUuid(command = 'ioreg'): Promise<string | null> {
  // Spawned at most once per process and only on darwin, and bounded: a lock acquisition must not
  // hang on a registry read. `node:child_process` rather than `Bun.spawn` — this layer is
  // fetch-clean and must not reach for a runtime global, and the lock is imported by applications
  // that do not run on Bun at all.
  try {
    const { stdout } = await run(command, ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      timeout: 2_000,
      maxBuffer: 1 << 20,
      encoding: 'utf8',
    });
    return parsePlatformUuid(stdout);
  } catch {
    // Absent, unreadable, over budget or past the deadline: all of them mean this machine did not
    // answer, which `attribute` already handles as `unattributable` rather than as a wrong answer.
    return null;
  }
}

async function machineIdentity(declared: string | undefined): Promise<string | null> {
  // A declared identity wins: an application on a platform that offers none, or one that knows its
  // own deployment better than the platform does, states it. Detection is memoized because it is a
  // read of an unchanging OS fact, not a policy the caller could want re-evaluated.
  if (declared !== undefined) return declared;
  if (detectedIdentity !== undefined) return detectedIdentity;
  detectedIdentity =
    platform() === 'darwin'
      ? await readDarwinPlatformUuid()
      : await firstReadableLine(['/etc/machine-id', '/var/lib/dbus/machine-id']);
  return detectedIdentity;
}

/**
 * Whether the recorded owner's pid is ours to probe.
 *
 * Identity decides it when both sides have one, and it survives a rename. Where either side has
 * none — an older lock, or a platform with no identity — the host name is all that is left, and a
 * mismatch there is reported as `unattributable` rather than as a foreign machine: those are
 * different states, and the earlier code collapsed them into a permanent silent refusal.
 */
function attribute(
  owner: JournalLockOwner,
  identity: string | null,
): DiagnosticJournalLockDiagnosis['attribution'] {
  if (identity !== null && owner.machine !== undefined) {
    return owner.machine === identity ? 'this-machine' : 'another-machine';
  }
  return owner.host === hostname() ? 'this-machine' : 'unattributable';
}

/**
 * Whether the recorded owner is provably gone.
 *
 * `kill(pid, 0)` delivers no signal and reports reachability: `ESRCH` is the only answer that
 * proves absence. `EPERM` means the process exists under another user, which is presence, and
 * every other outcome is unknown — both refuse. PID reuse can only turn a dead owner into a live
 * one, so the residual risk of this check is a refusal to reclaim, never a reclaim over a live
 * writer.
 *
 * Reachability is not liveness, though, and the gap is a zombie: an exited child its parent has not
 * reaped keeps its table entry, so the signal succeeds for a process that is provably finished. A
 * zombie is reported as `gone`, which is what it is — it holds no descriptor and no lock, because it
 * exited. And it is the SAFER half of `gone` rather than a weakening of it: a pid cannot be reused
 * until it is reaped, so a zombie entry is provably the owner the lock recorded, where an absent pid
 * carries the ordinary doubt about reuse. Found by a consuming application, which measured `Z` and a
 * successful signal on both platforms of its fleet. → ADR 0147.
 */
async function probeLiveness(owner: JournalLockOwner): Promise<'alive' | 'gone'> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return isRecord(error) && error.code === 'ESRCH' ? 'gone' : 'alive';
  }
  // The signal proves an ENTRY in the process table, not a running process. A child that has
  // exited and whose parent has not reaped it keeps its entry, and `kill(pid, 0)` succeeds for it —
  // so the probe that exists to prove absence reported the clearest possible absence as presence.
  // That needs no unusual deployment: a supervisor running as PID 1 in a container is a parent
  // that does not reap.
  return (await isZombieProcess(owner.pid)) ? 'gone' : 'alive';
}

/**
 * The state letter of a pid, or `null` where this platform will not say.
 *
 * `/proc/<pid>/stat` puts the command name in parentheses and the name may itself contain them, so
 * the state follows the LAST `)` — reading the third whitespace-separated field instead is wrong for
 * any process whose name has a space or a bracket in it.
 *
 * @internal `psCommand` is a seam for the tests: `/proc` is Linux-only, so the fallback branch is
 * unreachable here without one, and an untested branch in a liveness probe is how this defect got in.
 */
export async function isZombieProcess(
  pid: number,
  seam: { procRoot?: string; psCommand?: string } = {},
): Promise<boolean> {
  const { procRoot = '/proc', psCommand = 'ps' } = seam;
  try {
    const stat = await readFile(`${procRoot}/${pid}/stat`, 'utf8');
    return stat
      .slice(stat.lastIndexOf(')') + 1)
      .trimStart()
      .startsWith('Z');
  } catch {
    // No `/proc` — ask `ps`, which answers on darwin and the BSDs.
  }
  try {
    const { stdout } = await run(psCommand, ['-o', 'state=', '-p', String(pid)], {
      timeout: 2_000,
      maxBuffer: 1 << 16,
      encoding: 'utf8',
    });
    return stdout.trim().startsWith('Z');
  } catch {
    // Nothing answered. Treat the owner as present: a refusal to reclaim is the safe outcome, and
    // it is the same outcome this probe had before it could see a zombie at all.
    return false;
  }
}

async function diagnose(
  owner: JournalLockOwner | undefined,
  declaredIdentity: string | undefined,
): Promise<DiagnosticJournalLockDiagnosis> {
  if (!owner) return { attribution: 'unattributable', liveness: 'not-probed', owner: null };
  const attribution = attribute(owner, await machineIdentity(declaredIdentity));
  const record = {
    pid: owner.pid,
    host: owner.host,
    acquiredAt: owner.acquiredAt,
    ...(owner.machine !== undefined && { machine: owner.machine }),
  };
  if (attribution !== 'this-machine')
    return { attribution, liveness: 'not-probed', owner: record };
  return { attribution, liveness: await probeLiveness(owner), owner: record };
}

async function readLockOwner(lockPath: string): Promise<JournalLockOwner | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    return readOwner(await handle.readFile('utf8'));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createExclusive(
  lockPath: string,
  mode: number,
  declaredIdentity: string | undefined,
): Promise<FileHandle> {
  const handle = await open(lockPath, 'wx', mode);
  const identity = await machineIdentity(declaredIdentity);
  const owner: JournalLockOwner = {
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...(identity !== null && { machine: identity }),
  };
  await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
  return handle;
}

/**
 * Take the journal's exclusive lock under the configured policy.
 *
 * `refuse` is the default and rethrows the `EEXIST` a present lock produces. `reclaim-stale`
 * rethrows that same error unless the recorded owner is provably gone, so it is a strict superset
 * of `refuse`: every refusal a caller sees today it still sees, with the identical error.
 *
 * A refusal under `reclaim-stale` carries its reason on that error, readable through
 * `readDiagnosticJournalLockDiagnosis`. It is attached rather than thrown so the error a caller
 * already handles does not change shape; the point is that "the owner is alive" and "this lock
 * cannot be attributed to this host" stop being the same silent answer. The consumer that met this
 * printed "another process is running against this state" — a sentence it had no evidence for.
 */
export async function acquireDiagnosticJournalLock(
  lockPath: string,
  mode: number,
  policy: DiagnosticJournalLockPolicy,
  declaredIdentity?: string,
): Promise<AcquiredDiagnosticJournalLock> {
  try {
    return {
      handle: await createExclusive(lockPath, mode, declaredIdentity),
      reclaimedStale: false,
    };
  } catch (error) {
    if (policy !== 'reclaim-stale' || !isExisting(error)) throw error;

    const owner = await readLockOwner(lockPath);
    const diagnosis = await diagnose(owner, declaredIdentity);
    // An unreadable or ownerless lock proves nothing. It predates this policy, or a writer died
    // between creating the file and recording itself; either way absence is not established.
    if (!owner || diagnosis.liveness !== 'gone') {
      if (isRecord(error)) Object.assign(error, { journalLock: diagnosis });
      throw error;
    }

    await unlink(lockPath).catch(() => undefined);
    // If another reclaimer won the race between that unlink and this create, this one throws
    // `EEXIST` again and refuses exactly as it would have without the policy. One of us holds a
    // valid lock either way, which is the property that matters.
    return {
      handle: await createExclusive(lockPath, mode, declaredIdentity),
      reclaimedStale: true,
    };
  }
}
