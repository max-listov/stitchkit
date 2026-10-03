import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const GIB = 1024 ** 3;
// The 64-bit kernel's page-aligned LONG_MAX, compared before Number conversion.
const V1_UNLIMITED = 9223372036854771712n;
const unescapeMount = (value: string) =>
  value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

export type CgroupMemoryBudget =
  | { kind: 'bounded'; availableGib: number }
  | { kind: 'unlimited' | 'unsupported' | 'unavailable' };

interface MemoryMount {
  version: 1 | 2;
  membership: string;
  root: string;
  point: string;
}

function memoryMount(membership: string, mountinfo: string): MemoryMount | undefined {
  const entries = membership.split('\n').flatMap((line) => {
    const hierarchyEnd = line.indexOf(':');
    const controllersEnd = line.indexOf(':', hierarchyEnd + 1);
    if (hierarchyEnd <= 0 || controllersEnd < 0) return [];
    return [
      {
        hierarchy: line.slice(0, hierarchyEnd),
        controllers: line.slice(hierarchyEnd + 1, controllersEnd),
        membership: line.slice(controllersEnd + 1),
      },
    ];
  });
  const legacy = entries.find((entry) => entry.controllers.split(',').includes('memory'));
  const unified = entries.find((entry) => entry.hierarchy === '0' && entry.controllers === '');
  const member = legacy ?? unified;
  if (!member?.membership.startsWith('/')) return undefined;
  const version = legacy ? 1 : 2;
  const candidates = mountinfo.split('\n').flatMap((line) => {
    const [before, after] = line.split(' - ');
    const fields = before?.split(' ');
    const filesystem = after?.split(' ');
    if (!fields || !filesystem) return [];
    if (
      version === 2
        ? filesystem[0] !== 'cgroup2'
        : filesystem[0] !== 'cgroup' || !filesystem[2]?.split(',').includes('memory')
    )
      return [];
    const root = unescapeMount(fields[3] ?? '');
    const point = unescapeMount(fields[4] ?? '');
    if (!root.startsWith('/') || !point.startsWith('/')) return [];
    return [{ root, point }];
  });
  const exact = candidates.filter(
    (candidate) =>
      member.membership === candidate.root ||
      member.membership.startsWith(candidate.root === '/' ? '/' : `${candidate.root}/`),
  );
  const selected =
    exact.sort((a, b) => b.root.length - a.root.length)[0] ??
    (candidates.length === 1 ? candidates[0] : undefined);
  return selected && { ...selected, membership: member.membership, version };
}

function unsigned(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('Invalid memory controller value');
  return BigInt(value);
}

/** Only the selected memory controller and its applicable visible ancestors authorize headroom. */
export function cgroupMemoryBudget(
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  platform: string = process.platform,
): CgroupMemoryBudget {
  if (platform !== 'linux') return { kind: 'unsupported' };
  try {
    const mount = memoryMount(read('/proc/self/cgroup'), read('/proc/self/mountinfo'));
    if (!mount) return { kind: 'unavailable' };
    const base = resolve(mount.point);
    const absolute =
      mount.membership === mount.root ||
      mount.membership.startsWith(mount.root === '/' ? '/' : `${mount.root}/`);
    const path = absolute ? relative(mount.root, mount.membership) : mount.membership;
    let directory = resolve(join(base, path));
    if (directory !== base && !directory.startsWith(`${base}/`))
      return { kind: 'unavailable' };
    let available: bigint | undefined;
    let child = true;
    for (;;) {
      if (mount.version === 1 && !child) {
        const hierarchy = read(join(directory, 'memory.use_hierarchy')).trim();
        if (hierarchy === '0') break;
        if (hierarchy !== '1') return { kind: 'unavailable' };
      }
      let maximum: string;
      try {
        maximum = read(
          join(directory, mount.version === 1 ? 'memory.limit_in_bytes' : 'memory.max'),
        ).trim();
      } catch (error) {
        // memory.max is absent at the actual v2 root. Controller presence must
        // still be observed: a CPU-only unified mount proves no memory budget.
        if (
          mount.version !== 2 ||
          directory !== base ||
          mount.root !== '/' ||
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT' ||
          !read(join(base, 'cgroup.controllers')).trim().split(/\s+/).includes('memory')
        )
          return { kind: 'unavailable' };
        break;
      }
      const limit = maximum === 'max' && mount.version === 2 ? undefined : unsigned(maximum);
      if (limit !== undefined && !(mount.version === 1 && limit === V1_UNLIMITED)) {
        const current = unsigned(
          read(
            join(directory, mount.version === 1 ? 'memory.usage_in_bytes' : 'memory.current'),
          ).trim(),
        );
        const headroom = limit > current ? limit - current : 0n;
        available = available === undefined || headroom < available ? headroom : available;
      }
      if (directory === base) break;
      directory = dirname(directory);
      child = false;
    }
    if (available === undefined) return { kind: 'unlimited' };
    const availableGib = Number(available) / GIB;
    return Number.isFinite(availableGib)
      ? { kind: 'bounded', availableGib }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
