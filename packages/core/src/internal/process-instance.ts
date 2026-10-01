/** OS process lifetime evidence; timestamps and PID presence alone never establish ownership. */
import { readFile, readlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { z } from 'zod';
import { loadDarwinBinding } from './darwin-binding';
import { probeLiveness } from './process-identity';

export const ProcessInstanceSchema = z
  .object({
    platform: z.enum(['linux', 'darwin']),
    bootId: z.string().min(1),
    namespace: z.string().min(1),
    startId: z.string().regex(/^\d+$/),
  })
  .strict();
export type ProcessInstance = z.infer<typeof ProcessInstanceSchema>;

/** An unavailable observation preserves its native or validation cause; it never proves death. */
const ProcessInstanceObservationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('observed'), instance: ProcessInstanceSchema }),
  z.object({ state: z.literal('unavailable'), cause: z.unknown() }),
]);
export type ProcessInstanceObservation = z.infer<typeof ProcessInstanceObservationSchema>;

export async function observeProcessInstance(
  pid: number,
): Promise<ProcessInstanceObservation> {
  z.number().int().positive().max(2_147_483_647).parse(pid);
  return observeProcessInstanceAt(pid, '/proc');
}

/** /proc stat field 22 follows a command name that may itself contain spaces and parentheses. */
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

/** @internal procRoot permits kernel-format fixtures without changing a real process or boot. */
export async function readProcessInstance(
  pid: number,
  procRoot = '/proc',
): Promise<ProcessInstance | null> {
  const result = await observeProcessInstanceAt(pid, procRoot);
  return result.state === 'observed' ? result.instance : null;
}

/** @internal The fixture root is never a public owner option. */
export async function observeProcessInstanceAt(
  pid: number,
  procRoot: string,
): Promise<ProcessInstanceObservation> {
  try {
    if (platform() === 'darwin') {
      return {
        state: 'observed',
        instance: ProcessInstanceSchema.parse(loadDarwinBinding().processIdentity(pid)),
      };
    }
    if (platform() !== 'linux')
      throw new Error('Process lifetime observation requires Linux or Darwin');
    const [bootId, namespace, ownStatus, timeNamespace, ownStat, stat] = await Promise.all([
      readFile(`${procRoot}/sys/kernel/random/boot_id`, 'utf8'),
      readlink(`${procRoot}/self/ns/pid`),
      readFile(`${procRoot}/self/status`, 'utf8'),
      // Time namespaces arrived in Linux 5.6; an older kernel has one clock
      // for everyone, so its absence is part of the identity, not a gap in it.
      readlink(`${procRoot}/self/ns/time`).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
        throw error;
      }),
      readFile(`${procRoot}/self/stat`, 'utf8'),
      readFile(`${procRoot}/${pid}/stat`, 'utf8'),
    ]);
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
export type ProcessOwnerEvidence = z.infer<typeof ProcessOwnerEvidenceSchema>;

/** Compare identities only inside one machine (the caller establishes that boundary). */
export async function probeProcessOwner(
  pid: number,
  recorded: ProcessInstance | null | undefined,
): Promise<ProcessOwnerEvidence> {
  z.number().int().positive().max(2_147_483_647).parse(pid);
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

/** @internal Injection is for kernel-format controls, not a public ownership assertion. */
export async function probeProcessOwnerWith(
  pid: number,
  recorded: ProcessInstance | null | undefined,
  probes: ProcessOwnerProbes = { read: readProcessInstance, liveness: probeLiveness },
): Promise<ProcessOwnerEvidence> {
  if (recorded === undefined)
    return { liveness: await probes.liveness(pid), identity: 'legacy' };
  const unavailable = (cause: unknown): ProcessOwnerEvidence => ({
    liveness: 'not-probed',
    identity: 'unavailable',
    cause,
  });
  if (recorded === null)
    return unavailable(new Error('Recorded process lifetime is unavailable'));
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
  const own = await observe(process.pid);
  if (own.state === 'unavailable') return unavailable(own.cause);
  const current = own.instance;
  if (recorded.platform !== current.platform)
    return unavailable(new Error('Process platforms differ'));
  if (recorded.bootId !== current.bootId)
    return { liveness: 'gone', identity: 'different-boot' };
  if (recorded.namespace !== current.namespace)
    return unavailable(new Error('Process namespaces differ'));
  const liveness = await probes.liveness(pid);
  if (liveness === 'gone') return { liveness, identity: 'pid-gone' };
  const observation = await observe(pid);
  if (observation.state === 'unavailable') return unavailable(observation.cause);
  const observed = observation.instance;
  if (
    !observed ||
    observed.bootId !== current.bootId ||
    observed.namespace !== current.namespace
  )
    return unavailable(new Error('Observed boot or namespace changed during probe'));
  if (recorded.startId !== observed.startId)
    return { liveness: 'gone', identity: 'reused-pid' };
  return { liveness: 'alive', identity: 'matched' };
}
