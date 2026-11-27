import { describe, expect, test } from 'bun:test';
import {
  readWorkOrigin,
  WORK_ORIGIN_ENV,
  WorkLaunchError,
  WorkOriginSchema,
  WorkOwnerSchema,
  workUnitName,
} from '../src/entrypoints/service-host/work';
import { encodeWorkOrigin } from '../src/service-host/work/origin';
import { FAKE_INSTANCE } from './support/fake-work-host';

const owner = {
  launcher: 'agent-host',
  id: 'session-7',
  label: 'Session 7',
  project: 'example/app',
  agent: { harness: 'Example Harness', model: 'example-1', address: 'node:main' },
  parent: { launcher: 'release-runner', id: 'run-41' },
};

function refusal(read: () => unknown): WorkLaunchError {
  try {
    read();
  } catch (error) {
    if (error instanceof WorkLaunchError) return error;
    throw error;
  }
  throw new Error('Expected a WorkLaunchError');
}

describe('service-host/work owner record and origin variable', () => {
  test('an owner record answers every field and takes null only as a declared none', () => {
    expect(WorkOwnerSchema.parse(owner)).toEqual(owner);
    const none = { ...owner, project: null, agent: null, parent: null };
    expect(WorkOwnerSchema.parse(none)).toEqual(none);
    for (const field of ['launcher', 'id', 'label', 'project', 'agent', 'parent']) {
      const missing: Record<string, unknown> = { ...owner };
      delete missing[field];
      expect(WorkOwnerSchema.safeParse(missing).success).toBe(false);
    }
    for (const field of ['launcher', 'id', 'label'])
      expect(WorkOwnerSchema.safeParse({ ...owner, [field]: null }).success).toBe(false);
    expect(WorkOwnerSchema.safeParse({ ...owner, host: 'node-1' }).success).toBe(false);
  });

  test('launcher, id and label refuse what a unit name or a log line cannot carry', () => {
    const refused: Array<Record<string, unknown>> = [
      { launcher: 'Agent-Host' },
      { launcher: 'agent--host' },
      { launcher: 'a'.repeat(33) },
      { id: 'session@7' },
      { id: 'a/b' },
      { id: '-leading' },
      { id: 'x'.repeat(97) },
      { label: 'two\nlines' },
      { label: '   ' },
      { label: 'x'.repeat(121) },
      { project: 'two words' },
      { agent: { harness: 'h', model: 'm' } },
    ];
    for (const change of refused)
      expect(WorkOwnerSchema.safeParse({ ...owner, ...change }).success).toBe(false);
    expect(WorkOwnerSchema.safeParse({ ...owner, id: 'node:main_2.b-1' }).success).toBe(true);
  });

  test('a unit name is the launcher and the id, and two owners can spell one name', () => {
    expect(workUnitName({ launcher: 'agent-host', id: 'session-7' })).toBe(
      'agent-host-session-7.scope',
    );
    // Why the name is never parsed back into an owner.
    expect(workUnitName({ launcher: 'remote-login', id: '0-1' })).toBe(
      workUnitName({ launcher: 'remote', id: 'login-0-1' }),
    );
    expect(() => workUnitName({ launcher: 'agent-host', id: 'a b' })).toThrow();
    // A whole owner record names its unit too: that is how a reader matches records to scopes.
    expect(workUnitName(owner)).toBe('agent-host-session-7.scope');
  });

  test('the variable round-trips both boundary kinds and is absent as null', () => {
    const scope = {
      v: 1 as const,
      work: { launcher: 'agent-host', id: 'session-7' },
      boundary: {
        kind: 'transient-scope' as const,
        manager: 'system' as const,
        unit: 'agent-host-session-7.scope',
      },
    };
    const root = {
      v: 1 as const,
      work: scope.work,
      boundary: {
        kind: 'process-root' as const,
        root: { pid: 4242, instance: FAKE_INSTANCE },
      },
    };
    expect(readWorkOrigin({ [WORK_ORIGIN_ENV]: encodeWorkOrigin(scope) })).toEqual(scope);
    expect(readWorkOrigin({ [WORK_ORIGIN_ENV]: encodeWorkOrigin(root) })).toEqual(root);
    expect(readWorkOrigin({})).toBeNull();
    expect(WORK_ORIGIN_ENV).toBe('STITCHKIT_WORK_ORIGIN');
  });

  test('an unreadable variable is refused by name, never read as no origin', () => {
    const scope = {
      v: 1,
      work: { launcher: 'agent-host', id: 'session-7' },
      boundary: {
        kind: 'transient-scope',
        manager: 'system',
        unit: 'agent-host-session-7.scope',
      },
    };
    const unreadable = [
      'not json',
      '',
      JSON.stringify({ ...scope, v: 2 }),
      JSON.stringify({ ...scope, extra: true }),
      JSON.stringify({ ...scope, boundary: { kind: 'transient-scope', manager: 'system' } }),
      JSON.stringify({ ...scope, boundary: { ...scope.boundary, unit: 'other.service' } }),
      JSON.stringify({ v: 1, work: scope.work }),
      `${JSON.stringify(scope)}${' '.repeat(1024)}`,
    ];
    for (const text of unreadable) {
      const error = refusal(() => readWorkOrigin({ [WORK_ORIGIN_ENV]: text }));
      expect(error.reason).toBe('origin-unreadable');
      expect(error.cause).toBeDefined();
    }
    expect(WorkOriginSchema.safeParse({ ...scope, v: 2 }).success).toBe(false);
  });
});
