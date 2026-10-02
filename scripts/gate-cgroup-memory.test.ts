import { expect, test } from 'bun:test';
import { cgroupMemoryBudget } from './gate-cgroup-memory';
import { availableGateMemoryGib, chooseHeavyConcurrency } from './verify';

const GIB = 1024 ** 3;
function reader(membership: string, mountRoot = '/', mountPoint = '/sys/fs/cgroup') {
  const files: Record<string, string> = {
    '/proc/self/cgroup': `0::${membership}\n`,
    '/proc/self/mountinfo': `23 1 0:23 ${mountRoot} ${mountPoint} rw - cgroup2 cgroup rw\n`,
  };
  return {
    files,
    read(path: string) {
      const value = files[path];
      if (value === undefined)
        throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
      return value;
    },
  };
}

test('a parent cgroup budget constrains an unlimited child and prevents a false parallel admission', () => {
  const fixture = reader('/user.slice/session.scope');
  fixture.files['/sys/fs/cgroup/user.slice/session.scope/memory.max'] = 'max';
  fixture.files['/sys/fs/cgroup/user.slice/memory.max'] = String(8 * GIB);
  fixture.files['/sys/fs/cgroup/user.slice/memory.current'] = String(6 * GIB);
  const budget = cgroupMemoryBudget(fixture.read);
  const available = availableGateMemoryGib(20, budget);
  expect(available).toBe(2);
  expect(chooseHeavyConcurrency('', () => Math.min(20, available ?? 20)).concurrency).toBe(1);
  fixture.files['/sys/fs/cgroup/user.slice/memory.current'] = String(GIB);
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 7 });
  expect(chooseHeavyConcurrency('', () => 7).concurrency).toBe(2);
});

test('nested limits, namespace mounts, exhausted budgets and escaped mount points retain their meaning', () => {
  const fixture = reader('/tenant/child', '/tenant', '/cg\\040root');
  fixture.files['/cg root/child/memory.max'] = String(4 * GIB);
  fixture.files['/cg root/child/memory.current'] = String(3 * GIB);
  fixture.files['/cg root/memory.max'] = String(8 * GIB);
  fixture.files['/cg root/memory.current'] = String(2 * GIB);
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 1 });
  fixture.files['/cg root/memory.current'] = String(9 * GIB);
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 0 });
  fixture.files['/proc/self/cgroup'] = '0::/child\n';
  fixture.files['/cg root/memory.current'] = String(2 * GIB);
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 1 });
});

test('unlimited, unavailable and malformed controls are unknown, never a measured zero', () => {
  const fixture = reader('/');
  fixture.files['/sys/fs/cgroup/memory.max'] = 'max';
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'unlimited' });
  expect(availableGateMemoryGib(20, cgroupMemoryBudget(fixture.read))).toBe(20);
  fixture.files['/sys/fs/cgroup/memory.max'] = 'malformed';
  fixture.files['/sys/fs/cgroup/memory.current'] = '0';
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'unavailable' });
  delete fixture.files['/proc/self/cgroup'];
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'unavailable' });
});

test('an unreadable mount boundary cannot certify the visible child headroom', () => {
  const fixture = reader('/tenant/child', '/tenant', '/cg');
  fixture.files['/cg/child/memory.max'] = String(8 * GIB);
  fixture.files['/cg/child/memory.current'] = String(GIB);
  const denied = (path: string) => {
    if (path === '/cg/memory.max')
      throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return fixture.read(path);
  };
  expect(cgroupMemoryBudget(denied)).toEqual({ kind: 'unavailable' });
  const effective = availableGateMemoryGib(20, cgroupMemoryBudget(denied));
  expect(effective).toBeUndefined();
  expect(chooseHeavyConcurrency('', () => effective).concurrency).toBe(1);
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'unavailable' });
  fixture.files['/cg/memory.max'] = String(4 * GIB);
  fixture.files['/cg/memory.current'] = String(2 * GIB);
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 2 });
});
