/**
 * OS process lifetime evidence; timestamps and PID presence alone never establish ownership.
 */
import { readFileSync, readlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { z } from 'zod';
import { loadDarwinBinding } from './darwin-binding';
import { errnoOf } from './errno';
import { probeLiveness, probeLivenessSync } from './process-identity';

/**
 * Identity of one running process (boot id, PID namespace, start tick); a bare PID can be
 * reused, this triple cannot.
 */
export const ProcessInstanceSchema = z
  .object({
    platform: z.enum(['linux', 'darwin']),
    bootId: z.string().min(1),
    namespace: z.string().min(1),
    startId: z.string().regex(/^\d+$/),
  })
  .strict();
/**
 * A process identity to store next to its PID, so a later check can tell the same process from
 * a reused PID.
 */
export type ProcessInstance = z.infer<typeof ProcessInstanceSchema>;

/** Return `true` when two observed process instances represent the exact same OS process. */
export function sameProcessInstance(left: ProcessInstance, right: ProcessInstance): boolean {
  return (
    left.platform === right.platform &&
    left.bootId === right.bootId &&
    left.namespace === right.namespace &&
    left.startId === right.startId
  );
}

/**
 * An unavailable observation preserves its native or validation cause; it never proves death.
 */
const ProcessInstanceObservationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('observed'), instance: ProcessInstanceSchema }),
  z.object({ state: z.literal('unavailable'), cause: z.unknown() }),
]);
/** Process ids are signed 32-bit integers. */
const MAX_PID = 2 ** 31 - 1;

/**
 * Result of `observeProcessInstance`: `observed` with the identity, or `unavailable` with the
 * cause; unavailable never proves the process is dead.
 */
export type ProcessInstanceObservation = z.infer<typeof ProcessInstanceObservationSchema>;

/**
 * Reads the identity of a running process on Linux or macOS; resolves `unavailable` instead of
 * throwing when the platform cannot say, and rejects an invalid PID.
 */
export async function observeProcessInstance(
  pid: number,
): Promise<ProcessInstanceObservation> {
  z.number().int().positive().max(MAX_PID).parse(pid);
  return observeProcessInstanceAt(pid, '/proc');
}

/**
 * /proc stat field 22 follows a command name that may itself contain spaces and parentheses.
 */
export function linuxProcessStart(stat: string, pid: number): string | null {
  if (!stat.startsWith(`${pid} (`)) return null;
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const start = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/)[19];
  return start !== undefined && /^\d+$/.test(start) ? start : null;
}

/**
 * @internal procRoot permits kernel-format fixtures without changing a real process or boot.
 */
export async function readProcessInstance(
  pid: number,
  procRoot = '/proc',
): Promise<ProcessInstance | null> {
  return readProcessInstanceSync(pid, procRoot);
}

/** {@link readProcessInstance} for a caller that cannot wait. */
export function readProcessInstanceSync(
  pid: number,
  procRoot = '/proc',
): ProcessInstance | null {
  const result = observeProcessInstanceAtSync(pid, procRoot);
  return result.state === 'observed' ? result.instance : null;
}

/** @internal The fixture root is never a public owner option. */
export async function observeProcessInstanceAt(
  pid: number,
  procRoot: string,
): Promise<ProcessInstanceObservation> {
  return observeProcessInstanceAtSync(pid, procRoot);
}

/**
 * The observation itself. Every source is a kernel answer — procfs files and links, or one Darwin
 * system call — that never waits on a device, so the asynchronous readers share this one.
 */
function observeProcessInstanceAtSync(
  pid: number,
  procRoot: string,
): ProcessInstanceObservation {
  try {
    if (platform() === 'darwin') {
      return {
        state: 'observed',
        instance: ProcessInstanceSchema.parse(loadDarwinBinding().processIdentity(pid)),
      };
    }
    if (platform() !== 'linux')
      throw new Error('Process lifetime observation requires Linux or Darwin');
    const bootId = readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8');
    const namespace = readlinkSync(`${procRoot}/self/ns/pid`);
    const ownStatus = readFileSync(`${procRoot}/self/status`, 'utf8');
    const timeNamespace = readTimeNamespace(procRoot);
    const ownStat = readFileSync(`${procRoot}/self/stat`, 'utf8');
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    // NStgid starts at the procfs mount's namespace. Multiple IDs mean a
    // host-mounted /proc inside a child namespace, even if the numeric IDs coincide.
    // Read our own status, not PID 1's namespace (ptrace-restricted for ordinary users).
    const namespacePids = ownStatus
      .match(/^NStgid:[ \t]*(.*)$/m)?.[1]
      ?.trim()
      .split(/\s+/);
    if (
      namespacePids?.length !== 1 ||
      namespacePids[0] !== String(process.pid) ||
      linuxProcessStart(ownStat, process.pid) === null
    )
      throw new Error(
        'Process namespace evidence is partial or belongs to a foreign proc mount',
      );
    const startId = linuxProcessStart(stat, pid);
    if (startId === null || !bootId.trim())
      throw new Error('Process boot/start evidence is incomplete');
    return {
      state: 'observed',
      instance: {
        platform: 'linux',
        bootId: bootId.trim(),
        namespace: `${namespace};${timeNamespace}`,
        startId,
      },
    };
  } catch (cause) {
    // Missing native support, EPERM and unavailable proc evidence cannot authorize reclaim.
    return { state: 'unavailable', cause };
  }
}

/**
 * Time namespaces arrived in Linux 5.6; an older kernel has one clock for everyone, so its absence
 * is part of the identity, not a gap in it.
 */
function readTimeNamespace(procRoot: string): string {
  try {
    return readlinkSync(`${procRoot}/self/ns/time`);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return '';
    throw error;
  }
}

const ProcessOwnerEvidenceSchema = z.object({
  liveness: z.enum(['alive', 'gone', 'not-probed']),
  identity: z.enum([
    'matched',
    'different-boot',
    'reused-pid',
    'pid-gone',
    'legacy',
    'unavailable',
  ]),
  cause: z.unknown().optional(),
});
/**
 * What `probeProcessOwner` found: whether the PID is alive and whether it is still the
 * recorded process; only `identity: 'matched'` means the same process.
 */
export type ProcessOwnerEvidence = z.infer<typeof ProcessOwnerEvidenceSchema>;

/**
 * Compare identities only inside one machine (the caller establishes that boundary).
 */
export async function probeProcessOwner(
  pid: number,
  recorded: ProcessInstance | null | undefined,
): Promise<ProcessOwnerEvidence> {
  z.number().int().positive().max(MAX_PID).parse(pid);
  if (recorded != null) ProcessInstanceSchema.parse(recorded);
  return probeProcessOwnerWith(pid, recorded, {
    read: readProcessInstance,
    observe: observeProcessInstance,
    liveness: probeLiveness,
  });
}

interface ProcessOwnerProbes {
  read(pid: number): Promise<ProcessInstance | null>;
  liveness(pid: number): Promise<'alive' | 'gone'>;
  observe?(pid: number): Promise<ProcessInstanceObservation>;
}

const unavailable = (cause: unknown): ProcessOwnerEvidence => ({
  liveness: 'not-probed',
  identity: 'unavailable',
  cause,
});

/**
 * The rule, in the order its evidence is gathered. Each step either decides or hands the next one
 * what it needs; the asynchronous and the synchronous probe run the same steps, so a lock judged on
 * either path is judged alike.
 *
 * First the record against this process's own observation: only a record of this boot and of this
 * PID namespace can be compared PID for PID.
 */
function judgeAgainstSelf(
  recorded: ProcessInstance,
  own: ProcessInstanceObservation,
): ProcessOwnerEvidence | { readonly current: ProcessInstance } {
  if (own.state === 'unavailable') return unavailable(own.cause);
  const current = own.instance;
  if (recorded.platform !== current.platform)
    return unavailable(new Error('Process platforms differ'));
  if (recorded.bootId !== current.bootId)
    return { liveness: 'gone', identity: 'different-boot' };
  if (recorded.namespace !== current.namespace)
    return unavailable(new Error('Process namespaces differ'));
  return { current };
}

/** Then the PID's own lifetime, observed after it was found reachable. */
function judgeObserved(
  recorded: ProcessInstance,
  current: ProcessInstance,
  observation: ProcessInstanceObservation,
): ProcessOwnerEvidence {
  if (observation.state === 'unavailable') return unavailable(observation.cause);
  const observed = observation.instance;
  if (observed.bootId !== current.bootId || observed.namespace !== current.namespace)
    return unavailable(new Error('Observed boot or namespace changed during probe'));
  if (recorded.startId !== observed.startId)
    return { liveness: 'gone', identity: 'reused-pid' };
  return { liveness: 'alive', identity: 'matched' };
}

const unrecordedLifetime = (): ProcessOwnerEvidence =>
  unavailable(new Error('Recorded process lifetime is unavailable'));

/**
 * @internal Injection is for kernel-format controls, not a public ownership assertion.
 */
export async function probeProcessOwnerWith(
  pid: number,
  recorded: ProcessInstance | null | undefined,
  probes: ProcessOwnerProbes = { read: readProcessInstance, liveness: probeLiveness },
): Promise<ProcessOwnerEvidence> {
  if (recorded === undefined)
    return { liveness: await probes.liveness(pid), identity: 'legacy' };
  if (recorded === null) return unrecordedLifetime();
  const observe = async (target: number): Promise<ProcessInstanceObservation> => {
    if (probes.observe) return probes.observe(target);
    const instance = await probes.read(target);
    return instance
      ? { state: 'observed', instance }
      : {
          state: 'unavailable',
          cause: new Error('Process lifetime reader returned no evidence'),
        };
  };
  const self = judgeAgainstSelf(recorded, await observe(process.pid));
  if (!('current' in self)) return self;
  const liveness = await probes.liveness(pid);
  if (liveness === 'gone') return { liveness, identity: 'pid-gone' };
  const observation = await observe(pid);
  if (observation.state === 'unavailable' && (await probes.liveness(pid)) === 'gone') {
    return { liveness: 'gone', identity: 'pid-gone' };
  }
  return judgeObserved(recorded, self.current, observation);
}

interface ProcessOwnerSyncProbes {
  liveness(pid: number): 'alive' | 'gone';
  observe(pid: number): ProcessInstanceObservation;
}

/**
 * @internal Injection is for synchronous kernel-format controls, not a public ownership assertion.
 */
export function probeProcessOwnerSyncWith(
  pid: number,
  recorded: ProcessInstance | null | undefined,
  probes: ProcessOwnerSyncProbes = {
    liveness: probeLivenessSync,
    observe: (target) => observeProcessInstanceAtSync(target, '/proc'),
  },
): ProcessOwnerEvidence {
  if (recorded === undefined) return { liveness: probes.liveness(pid), identity: 'legacy' };
  if (recorded === null) return unrecordedLifetime();
  const self = judgeAgainstSelf(recorded, probes.observe(process.pid));
  if (!('current' in self)) return self;
  const liveness = probes.liveness(pid);
  if (liveness === 'gone') return { liveness, identity: 'pid-gone' };
  const observation = probes.observe(pid);
  if (observation.state === 'unavailable' && probes.liveness(pid) === 'gone') {
    return { liveness: 'gone', identity: 'pid-gone' };
  }
  return judgeObserved(recorded, self.current, observation);
}

/** {@link probeProcessOwner} for a caller that cannot wait: the same steps on synchronous probes. */
export function probeProcessOwnerSync(
  pid: number,
  recorded: ProcessInstance | null | undefined,
): ProcessOwnerEvidence {
  z.number().int().positive().max(MAX_PID).parse(pid);
  if (recorded != null) ProcessInstanceSchema.parse(recorded);
  return probeProcessOwnerSyncWith(pid, recorded);
}
