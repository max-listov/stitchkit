import { expect, test } from 'bun:test';
import { cgroupMemoryBudget } from './gate-cgroup-memory';
import { availableGateMemoryGib, chooseHeavyConcurrency } from './verify';

const GIB = 1024 ** 3;
function reader(membership: string, mountRoot = '/', mountPoint = '/sys/fs/cgroup') {
  const files: Record<string, string> = {
    '/proc/self/cgroup': `0::${membership}\n`,
    '/proc/self/mountinfo': `23 1 0:23 ${mountRoot} ${mountPoint} rw - cgroup2 cgroup rw\n`,
    [`${mountPoint}/cgroup.controllers`]: 'memory cpu',
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

test('hybrid selects its v1 memory controller rather than an unrelated unified mount', () => {
  const fixture = reader('/');
  fixture.files['/proc/self/cgroup'] = '0::/\n5:cpu,memory:/tenant/child\n';
  fixture.files['/proc/self/mountinfo'] +=
    '24 1 0:24 /tenant /v1\\040memory rw - cgroup cgroup rw,cpu,memory\n';
  fixture.files['/v1 memory/child/memory.limit_in_bytes'] = String(8 * GIB);
  fixture.files['/v1 memory/child/memory.usage_in_bytes'] = String(GIB);
  fixture.files['/v1 memory/memory.limit_in_bytes'] = String(4 * GIB);
  fixture.files['/v1 memory/memory.usage_in_bytes'] = String(3 * GIB);
  fixture.files['/v1 memory/memory.use_hierarchy'] = '1';
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 1 });
  fixture.files['/v1 memory/memory.use_hierarchy'] = '0';
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 7 });
});

test('missing memory controller is unknown even at the unified root', () => {
  const fixture = reader('/');
  fixture.files['/sys/fs/cgroup/cgroup.controllers'] = 'cpu io';
  const budget = cgroupMemoryBudget(fixture.read);
  expect(budget).toEqual({ kind: 'unavailable' });
  expect(availableGateMemoryGib(64, budget)).toBeUndefined();
});

test('pure v1 sentinel, exact bigint headroom, exhaustion and unreadable controls are distinguished', () => {
  const fixture = reader('/');
  fixture.files['/proc/self/cgroup'] = '5:memory:/\n';
  fixture.files['/proc/self/mountinfo'] = '24 1 0:24 / /v1 rw - cgroup cgroup rw,memory\n';
  fixture.files['/v1/memory.limit_in_bytes'] = '9223372036854771712';
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'unlimited' });
  fixture.files['/v1/memory.limit_in_bytes'] = '9007199254740993';
  fixture.files['/v1/memory.usage_in_bytes'] = '9007199254740992';
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 1 / GIB });
  fixture.files['/v1/memory.usage_in_bytes'] = '9007199254740994';
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 0 });
  fixture.files['/v1/memory.limit_in_bytes'] = 'garbage';
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'unavailable' });
  expect(
    cgroupMemoryBudget(() => {
      throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    }),
  ).toEqual({ kind: 'unavailable' });
  expect(
    cgroupMemoryBudget(() => {
      throw new Error('Must not read proc');
    }, 'darwin'),
  ).toEqual({ kind: 'unsupported' });
});

test('an unrelated mount does not hide the most specific visible memory mount', () => {
  const fixture = reader('/tenant/child');
  fixture.files['/proc/self/mountinfo'] +=
    '24 1 0:24 /tenant /specific rw - cgroup2 cgroup rw\n';
  fixture.files['/specific/child/memory.max'] = 'max';
  fixture.files['/specific/memory.max'] = String(3 * GIB);
  fixture.files['/specific/memory.current'] = String(GIB);
  expect(cgroupMemoryBudget(fixture.read)).toEqual({ kind: 'bounded', availableGib: 2 });
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

test('v2, v1 and hybrid controllers retain colons and trailing spaces in the exact membership', () => {
  for (const mode of ['v2', 'v1', 'hybrid']) {
    for (const membership of ['/job', '/job:isolated', '/job  ']) {
      const fixture = reader(membership);
      const legacy = mode !== 'v2';
      const mount = legacy ? '/legacy' : '/sys/fs/cgroup';
      if (legacy) {
        fixture.files['/proc/self/cgroup'] =
          `${mode === 'hybrid' ? '0::/unrelated\n' : ''}5:cpu,memory:${membership}\n`;
        fixture.files['/proc/self/mountinfo'] +=
          '24 1 0:24 / /legacy rw - cgroup cgroup rw,cpu,memory\n';
        fixture.files['/legacy/memory.limit_in_bytes'] = '9223372036854771712';
        fixture.files['/legacy/memory.use_hierarchy'] = '1';
      } else fixture.files['/sys/fs/cgroup/memory.max'] = 'max';
      const maximum = legacy ? 'memory.limit_in_bytes' : 'memory.max';
      const current = legacy ? 'memory.usage_in_bytes' : 'memory.current';
      fixture.files[`${mount}/job/${maximum}`] = String(10 * GIB);
      fixture.files[`${mount}/job/${current}`] = String(GIB);
      if (membership !== '/job') {
        fixture.files[`${mount}${membership}/${maximum}`] = String(2 * GIB);
        fixture.files[`${mount}${membership}/${current}`] = String(GIB);
      }
      const budget = cgroupMemoryBudget(fixture.read);
      expect(budget).toEqual({
        kind: 'bounded',
        availableGib: membership === '/job' ? 9 : 1,
      });
      const available = availableGateMemoryGib(20, budget);
      expect(chooseHeavyConcurrency('', () => available).concurrency).toBe(
        membership === '/job' ? 2 : 1,
      );
    }
  }
});
