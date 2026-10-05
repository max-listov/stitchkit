import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import {
  type AgentProcessSandbox,
  type AgentSandboxGrade,
  probeAgentProcessSandbox,
} from '../src/entrypoints/agent-runtime';

const SECRET_PATH = '/opt/private/launcher-bin';
const FULL: AgentSandboxGrade = { grade: 'full', restrictions: ['network-denied'] };

function sandboxWith(
  probe: AgentProcessSandbox['probe'],
): AgentProcessSandbox & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    probe() {
      calls += 1;
      return probe();
    },
    prepare: () => ({ executable: '/bin/true', args: [] }),
  };
}

/** Probe, and return the grade with the process warning that carried the cause. */
async function probeWithWarning(sandbox: AgentProcessSandbox) {
  const warned = once(process, 'warning');
  const grade = await probeAgentProcessSandbox(sandbox);
  const [warning] = await warned;
  return { grade, warning };
}

describe('probeAgentProcessSandbox on a failing adapter', () => {
  test('a synchronous throw resolves to unavailable instead of escaping', async () => {
    const failure = new Error(`ENOENT: posix_spawn '${SECRET_PATH}'`);
    const sandbox = sandboxWith(() => {
      throw failure;
    });
    const { grade, warning } = await probeWithWarning(sandbox);
    expect(grade).toEqual({ grade: 'unavailable', reason: 'sandbox probe failed' });
    expect(JSON.stringify(grade)).not.toContain(SECRET_PATH);
    expect(warning).toBeInstanceOf(Error);
    expect(warning.cause).toBe(failure);
  });

  test('an asynchronous rejection resolves to the same grade', async () => {
    const failure = new SyntaxError('JSON Parse error: Unexpected EOF');
    const sandbox = sandboxWith(() => Promise.reject(failure));
    const { grade, warning } = await probeWithWarning(sandbox);
    expect(grade).toEqual({ grade: 'unavailable', reason: 'sandbox probe failed' });
    expect(warning.cause).toBe(failure);
  });

  // An adapter is untyped at runtime (a parsed tool output, a plain JS module): JSON text stands
  // for whatever it may return.
  test.each([
    ['nothing', 'null'],
    ['a string', JSON.stringify(SECRET_PATH)],
    ['a grade with a missing field', '{"grade":"full"}'],
    ['an unknown grade', JSON.stringify({ grade: 'maybe', reason: SECRET_PATH })],
  ])('returning %s resolves to unavailable with its own reason', async (_label, text) => {
    const { grade, warning } = await probeWithWarning(sandboxWith(() => JSON.parse(text)));
    expect(grade).toEqual({
      grade: 'unavailable',
      reason: 'sandbox probe returned no valid grade',
    });
    expect(JSON.stringify(grade)).not.toContain(SECRET_PATH);
    expect(warning.cause).toBeDefined();
  });

  test('a failed probe is cached like a success, and refresh probes again', async () => {
    let healthy = false;
    const sandbox = sandboxWith(() => {
      if (!healthy) throw new Error('not yet');
      return FULL;
    });
    const { grade } = await probeWithWarning(sandbox);
    expect(grade.grade).toBe('unavailable');
    healthy = true;
    expect((await probeAgentProcessSandbox(sandbox)).grade).toBe('unavailable');
    expect(sandbox.calls()).toBe(1);
    expect(await probeAgentProcessSandbox(sandbox, { refresh: true })).toEqual(FULL);
    expect(sandbox.calls()).toBe(2);
    expect(await probeAgentProcessSandbox(sandbox)).toEqual(FULL);
    expect(sandbox.calls()).toBe(2);
  });
});
