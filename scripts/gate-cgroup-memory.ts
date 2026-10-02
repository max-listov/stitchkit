import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const GIB = 1024 ** 3;
const unescapeMount = (value: string) =>
  value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

/** Every visible ancestor can impose the actual memory ceiling, independently of host RAM. */
export type CgroupMemoryBudget =
  | { kind: 'bounded'; availableGib: number }
  | { kind: 'unlimited' | 'unsupported' | 'unavailable' };

export function cgroupMemoryBudget(
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): CgroupMemoryBudget {
  try {
    const membership = /^0::(.+)$/m.exec(read('/proc/self/cgroup'))?.[1];
    const mount = read('/proc/self/mountinfo')
      .split('\n')
      .find((line) => line.includes(' - cgroup2 '));
    if (!membership || !mount) return { kind: 'unsupported' };
    const fields = mount.split(' ');
    const mountRoot = unescapeMount(fields[3] ?? '');
    const mountPoint = unescapeMount(fields[4] ?? '');
    if (!mountRoot.startsWith('/') || !mountPoint.startsWith('/'))
      return { kind: 'unavailable' };
    const path =
      membership === mountRoot || membership.startsWith(`${mountRoot}/`)
        ? relative(mountRoot, membership)
        : membership;
    const base = resolve(mountPoint);
    let directory = resolve(join(base, path));
    if (directory !== base && !directory.startsWith(`${base}/`))
      return { kind: 'unavailable' };
    let available: number | undefined;
    for (;;) {
      let maximum: string;
      try {
        maximum = read(join(directory, 'memory.max')).trim();
      } catch (error) {
        // Only the actual hierarchy root omits memory.max; permission refusal is unknown.
        if (
          directory === base &&
          mountRoot === '/' &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return available === undefined
            ? { kind: 'unlimited' }
            : { kind: 'bounded', availableGib: available };
        return { kind: 'unavailable' };
      }
      if (maximum !== 'max') {
        const current = read(join(directory, 'memory.current')).trim();
        if (!/^\d+$/.test(maximum) || !/^\d+$/.test(current)) return { kind: 'unavailable' };
        const headroom = Math.max(0, Number(maximum) - Number(current)) / GIB;
        available = available === undefined ? headroom : Math.min(available, headroom);
      }
      if (directory === base)
        return available === undefined
          ? { kind: 'unlimited' }
          : { kind: 'bounded', availableGib: available };
      directory = dirname(directory);
    }
  } catch {
    return { kind: 'unavailable' };
  }
}
