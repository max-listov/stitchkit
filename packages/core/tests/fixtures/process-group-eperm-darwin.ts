// Darwin reports EPERM for a reaped group member: only a real signal or absence settles the stop.
import type { ParsedNativeCommandStopPolicy } from '../../src/process/contract';

Object.defineProperty(process, 'platform', { value: 'darwin' });
const { stopCommandGroup } = await import('../../src/process/group');
const denied = Object.assign(new Error('permission denied'), { code: 'EPERM' });
const gone = Object.assign(new Error('group reaped'), { code: 'ESRCH' });
let probes = 0;
let kills = 0;
process.kill = (_pid: number, signal?: string | number) => {
  if (signal === 'SIGTERM') return true;
  if (signal === 0) {
    probes++;
    throw denied;
  }
  if (signal === 'SIGKILL') {
    if (++kills < 3) throw denied;
    throw gone;
  }
  throw new Error('unexpected signal');
};
const policy: ParsedNativeCommandStopPolicy = {
  target: 'group',
  signal: 'SIGTERM',
  graceMs: 20,
};
await stopCommandGroup({ pid: 4242, policy, cleanupTimeoutMs: 100, force: false });
if (!probes || kills !== 3) throw new Error('transient denial was suppressed');
process.kill = () => {
  throw denied;
};
const began = performance.now();
try {
  await stopCommandGroup({
    pid: 4242,
    policy: { ...policy, graceMs: 0 },
    cleanupTimeoutMs: 20,
    force: false,
  });
  throw new Error('must refuse');
} catch (error) {
  if (error !== denied) throw error;
}
if (performance.now() - began < 15)
  throw new Error('denial did not wait within declared budget');
console.log('bounded EPERM controls: ok');
