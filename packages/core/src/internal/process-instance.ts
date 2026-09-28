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
  try {
    if (platform() === 'darwin') {
      const result = ProcessInstanceSchema.safeParse(loadDarwinBinding().processIdentity(pid));
      return result.success ? result.data : null;
    }
    if (platform() !== 'linux') return null;
    const [bootId, namespace, initNamespace, timeNamespace, ownStat, stat] = await Promise.all(
      [
        readFile(`${procRoot}/sys/kernel/random/boot_id`, 'utf8'),
        readlink(`${procRoot}/self/ns/pid`),
        readlink(`${procRoot}/1/ns/pid`),
        readlink(`${procRoot}/self/ns/time`),
        readFile(`${procRoot}/self/stat`, 'utf8'),
        readFile(`${procRoot}/${pid}/stat`, 'utf8'),
      ],
    );
    // A host-mounted /proc inside a child PID namespace is not this caller's PID table.
    if (namespace !== initNamespace || linuxProcessStart(ownStat, process.pid) === null)
      return null;
    const startId = linuxProcessStart(stat, pid);
    if (startId === null || !bootId.trim()) return null;
    return {
      platform: 'linux',
      bootId: bootId.trim(),
      namespace: `${namespace};${timeNamespace}`,
      startId,
    };
  } catch {
    // Missing native support, EPERM and unavailable proc evidence cannot authorize reclaim.
    return null;
  }
}

export interface ProcessOwnerEvidence {
  readonly liveness: 'alive' | 'gone' | 'not-probed';
  readonly identity:
    | 'matched'
    | 'different-boot'
    | 'reused-pid'
    | 'pid-gone'
    | 'legacy'
    | 'unavailable';
}

/** Compare identities only inside one machine (the caller establishes that boundary). */
export async function probeProcessOwner(
  pid: number,
  recorded: ProcessInstance | null | undefined,
  probes = { read: readProcessInstance, liveness: probeLiveness },
): Promise<ProcessOwnerEvidence> {
  if (recorded === undefined)
    return { liveness: await probes.liveness(pid), identity: 'legacy' };
  const unavailable: ProcessOwnerEvidence = {
    liveness: 'not-probed',
    identity: 'unavailable',
  };
  if (recorded === null) return unavailable;
  const current = await probes.read(process.pid);
  if (!current || recorded.platform !== current.platform) return unavailable;
  if (recorded.bootId !== current.bootId)
    return { liveness: 'gone', identity: 'different-boot' };
  if (recorded.namespace !== current.namespace) return unavailable;
  const liveness = await probes.liveness(pid);
  if (liveness === 'gone') return { liveness, identity: 'pid-gone' };
  const observed = await probes.read(pid);
  if (
    !observed ||
    observed.bootId !== current.bootId ||
    observed.namespace !== current.namespace
  )
    return unavailable;
  if (recorded.startId !== observed.startId)
    return { liveness: 'gone', identity: 'reused-pid' };
  return { liveness: 'alive', identity: 'matched' };
}
