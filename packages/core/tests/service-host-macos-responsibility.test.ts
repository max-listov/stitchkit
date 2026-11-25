import { describe, expect, test } from 'bun:test';
import {
  collectProcessSubtreePids,
  inspectResponsibleProcess,
  isExecutableInsideBundle,
  type MacosResponsibilityAdapter,
  type MacosResponsibilityReason,
  normalizeMacosSyntheticPath,
  parsePsPidPpidTable,
  verifyProcessSubtreeResponsibility,
} from '../src/entrypoints/service-host/macos';
import {
  type DarwinBinding,
  requireDarwinServiceHostMethod,
} from '../src/internal/darwin-binding';

function makeProcessInstance(startId: string) {
  return {
    platform: 'darwin' as const,
    bootId: '00000000-0000-4000-8000-000000000001',
    namespace: 'host',
    startId,
  };
}

describe('service-host/macos TCC responsibility inspection', () => {
  test('parsePsPidPpidTable and collectProcessSubtreePids traverse BFS safely against cycles and enforce maxProcesses', () => {
    const table = parsePsPidPpidTable(
      [
        '  100    1',
        '  101  100',
        '  102  100',
        '  103  101',
        '  999    1',
        '  bad line',
      ].join('\n'),
    );
    expect(collectProcessSubtreePids(100, table)).toEqual([100, 101, 102, 103]);

    // Cycle safety: 100 -> 101 -> 100 must terminate cleanly
    const cyclic = [
      { pid: 100, ppid: 101 },
      { pid: 101, ppid: 100 },
    ];
    expect(collectProcessSubtreePids(100, cyclic)).toEqual([100, 101]);

    // Limit enforcement
    expect(() => collectProcessSubtreePids(100, table, { maxProcesses: 2 })).toThrow(
      RangeError,
    );
  });

  test('isExecutableInsideBundle blocks .app2 prefix confusion attacks', () => {
    const expected = '/Users/example-user/Applications/Example.app';
    expect(
      isExecutableInsideBundle(
        '/Users/example-user/Applications/Example.app/Contents/MacOS/example-launcher',
        expected,
      ),
    ).toBe(true);
    expect(
      isExecutableInsideBundle(
        '/Users/example-user/Applications/Example.app2/Contents/MacOS/evil-launcher',
        expected,
      ),
    ).toBe(false);
    expect(
      isExecutableInsideBundle('/Users/example-user/Applications/Example.app', expected),
    ).toBe(false);
    expect(
      isExecutableInsideBundle(
        '/Users/example-user/Applications/Example.app/Contents/../../Evil.app/Contents/MacOS/x',
        expected,
      ),
    ).toBe(false);
    // APFS case-insensitivity matches differently cased bundle paths while still blocking .app2
    expect(
      isExecutableInsideBundle(
        '/users/example-user/applications/example.app/contents/MacOS/example-launcher',
        expected,
      ),
    ).toBe(true);
    expect(
      isExecutableInsideBundle(
        '/users/example-user/applications/example.app2/contents/MacOS/evil-launcher',
        expected,
      ),
    ).toBe(false);
  });

  test('inspectResponsibleProcess classifies attributed (/tmp <-> /private/tmp), observed, misattributed (.app2), and TOCTOU pid-reused', async () => {
    const makeAdapter = (
      overrides: Partial<MacosResponsibilityAdapter>,
    ): MacosResponsibilityAdapter => ({
      async responsiblePid() {
        return 200;
      },
      async processPath() {
        return '/private/tmp/work/Example.app/Contents/MacOS/example-launcher';
      },
      async observeProcessInstance() {
        return { state: 'observed', instance: makeProcessInstance('1000') };
      },
      async canonicalizePath(target) {
        return normalizeMacosSyntheticPath(target);
      },
      async listProcesses() {
        return [];
      },
      ...overrides,
    });

    // Attributed through /tmp <-> /private/tmp canonicalization
    const attributed = await inspectResponsibleProcess({
      pid: 201,
      expectedBundlePath: '/tmp/work/Example.app',
      adapter: makeAdapter({}),
    });
    expect(attributed.status).toBe('attributed');
    expect(attributed.responsiblePid).toBe(200);

    // Observed when expectedBundlePath is omitted
    const observed = await inspectResponsibleProcess({
      pid: 201,
      adapter: makeAdapter({}),
    });
    expect(observed.status).toBe('observed');
    expect(observed.expectedBundlePath).toBeNull();

    // Prefix attack (.app2) -> misattributed
    const prefixAttack = await inspectResponsibleProcess({
      pid: 201,
      expectedBundlePath: '/Users/example-user/Applications/Example.app',
      adapter: makeAdapter({
        async processPath() {
          return '/Users/example-user/Applications/Example.app2/Contents/MacOS/example-launcher';
        },
      }),
    });
    expect(prefixAttack.status).toBe('misattributed');
    const mismatchReason: MacosResponsibilityReason | undefined = prefixAttack.reason;
    expect(mismatchReason).toBe('bundle-mismatch');

    // TOCTOU PID reuse between before and after observeProcessInstance -> unavailable (pid-reused)
    let observeCall = 0;
    const toctou = await inspectResponsibleProcess({
      pid: 201,
      expectedBundlePath: '/tmp/work/Example.app',
      adapter: makeAdapter({
        async observeProcessInstance() {
          observeCall += 1;
          return {
            state: 'observed',
            instance: makeProcessInstance(observeCall === 1 ? '1000' : '2000'),
          };
        },
      }),
    });
    expect(toctou.status).toBe('unavailable');
    expect(toctou.reason).toBe('pid-reused');

    // EPERM on after-observation -> process-unobservable (not pid-reused)
    let epermCall = 0;
    const epermAfter = await inspectResponsibleProcess({
      pid: 201,
      expectedBundlePath: '/tmp/work/Example.app',
      adapter: makeAdapter({
        async observeProcessInstance() {
          epermCall += 1;
          if (epermCall === 1) {
            return { state: 'observed', instance: makeProcessInstance('1000') };
          }
          return {
            state: 'unavailable',
            cause: Object.assign(new Error('denied'), { code: 'EPERM' }),
          };
        },
      }),
    });
    expect(epermAfter.status).toBe('unavailable');
    expect(epermAfter.reason).toBe('process-unobservable');

    // Unsupported native symbol -> unavailable (responsibility-unsupported)
    const unsupported = await inspectResponsibleProcess({
      pid: 201,
      expectedBundlePath: '/tmp/work/Example.app',
      adapter: makeAdapter({
        async responsiblePid() {
          throw Object.assign(new Error('not supported'), { code: 'EOPNOTSUPP' });
        },
      }),
    });
    expect(unsupported.status).toBe('unavailable');
    expect(unsupported.reason).toBe('responsibility-unsupported');
  });

  test('a lookup that fails without an errno is process-gone only when the process is observed gone', async () => {
    const noErrno = () => new Error('returned no process and no errno');
    const observeThen = (afterFailure: 'observed' | 'gone') => {
      let calls = 0;
      return async () => {
        calls += 1;
        return calls === 1 || afterFailure === 'observed'
          ? { state: 'observed' as const, instance: makeProcessInstance('1000') }
          : {
              state: 'unavailable' as const,
              cause: Object.assign(new Error('no such process'), { code: 'ESRCH' }),
            };
      };
    };
    const adapter = (
      overrides: Partial<MacosResponsibilityAdapter>,
    ): MacosResponsibilityAdapter => ({
      async responsiblePid() {
        return 200;
      },
      async processPath() {
        return '/tmp/work/Example.app/Contents/MacOS/example-launcher';
      },
      async observeProcessInstance() {
        return { state: 'observed', instance: makeProcessInstance('1000') };
      },
      async canonicalizePath(target) {
        return normalizeMacosSyntheticPath(target);
      },
      async listProcesses() {
        return [];
      },
      ...overrides,
    });
    const inspect = (overrides: Partial<MacosResponsibilityAdapter>) =>
      inspectResponsibleProcess({
        pid: 201,
        expectedBundlePath: '/tmp/work/Example.app',
        adapter: adapter(overrides),
      });

    const responsibleGone = await inspect({
      async responsiblePid() {
        throw noErrno();
      },
      observeProcessInstance: observeThen('gone'),
    });
    expect(responsibleGone.reason).toBe('process-gone');
    const responsibleAlive = await inspect({
      async responsiblePid() {
        throw noErrno();
      },
      observeProcessInstance: observeThen('observed'),
    });
    expect(responsibleAlive.reason).toBe('responsibility-lookup-failed');

    const pathGone = await inspect({
      async processPath() {
        throw noErrno();
      },
      observeProcessInstance: observeThen('gone'),
    });
    expect(pathGone.reason).toBe('responsible-process-gone');
    const pathAlive = await inspect({
      async processPath() {
        throw noErrno();
      },
      observeProcessInstance: observeThen('observed'),
    });
    expect(pathAlive.reason).toBe('process-path-failed');
  });

  test('verifyProcessSubtreeResponsibility records ephemeral gone children in gonePids and flags any misattributed descendant', async () => {
    const expectedBundle = '/Users/example-user/Applications/Example.app';
    const goodPath = `${expectedBundle}/Contents/MacOS/example-launcher`;
    const badPath = '/Users/example-user/Applications/Example.app2/Contents/MacOS/evil';

    const makeSubtreeAdapter = (childBad: boolean): MacosResponsibilityAdapter => ({
      async listProcesses() {
        return [
          { pid: 300, ppid: 1 },
          { pid: 301, ppid: 300 },
          { pid: 302, ppid: 300 },
        ];
      },
      async observeProcessInstance(pid) {
        if (pid === 302) {
          return {
            state: 'unavailable',
            cause: Object.assign(new Error('gone'), { code: 'ESRCH' }),
          };
        }
        return { state: 'observed', instance: makeProcessInstance(String(pid * 10)) };
      },
      async responsiblePid() {
        return 300;
      },
      async processPath(_respPid) {
        return goodPath;
      },
      async canonicalizePath(p) {
        return normalizeMacosSyntheticPath(p);
      },
      ...(childBad
        ? {
            async responsiblePid(pid) {
              return pid === 301 ? 999 : 300;
            },
            async processPath(respPid) {
              return respPid === 999 ? badPath : goodPath;
            },
          }
        : {}),
    });

    const clean = await verifyProcessSubtreeResponsibility({
      rootPid: 300,
      expectedBundlePath: expectedBundle,
      adapter: makeSubtreeAdapter(false),
    });
    expect(clean.status).toBe('attributed');
    expect(clean.gonePids).toEqual([302]);
    expect(clean.checked.map((c) => c.pid)).toEqual([300, 301]);

    const tainted = await verifyProcessSubtreeResponsibility({
      rootPid: 300,
      expectedBundlePath: expectedBundle,
      adapter: makeSubtreeAdapter(true),
    });
    expect(tainted.status).toBe('misattributed');
    expect(tainted.misattributed.map((c) => c.pid)).toEqual([301]);

    // Root PID exiting (ESRCH) yields overall 'unavailable' (not swallowed into gonePids)
    const rootGone = await verifyProcessSubtreeResponsibility({
      rootPid: 300,
      expectedBundlePath: expectedBundle,
      adapter: {
        ...makeSubtreeAdapter(false),
        async observeProcessInstance() {
          return {
            state: 'unavailable',
            cause: Object.assign(new Error('gone'), { code: 'ESRCH' }),
          };
        },
      },
    });
    expect(rootGone.status).toBe('unavailable');
    expect(rootGone.unavailable.map((c) => c.pid)).toEqual([300]);
  });

  test('requireDarwinServiceHostMethod throws EOPNOTSUPP when packaged native addon lacks a new method', () => {
    const partialBinding: DarwinBinding = {
      processIdentity: () => ({}),
      openDirectoryAt: () => 0,
      reopenDirectory: () => 0,
      changeDirectory: () => undefined,
      openFileAt: () => 0,
      createFileAt: () => 0,
      createDirectoryAt: () => true,
      statAt: () => null,
      listAt: () => [],
      renameAt: () => undefined,
      unlinkAt: () => undefined,
    };
    expect(() => requireDarwinServiceHostMethod(partialBinding, 'renameSwapAt')).toThrow(
      /missing method: renameSwapAt/,
    );
    try {
      requireDarwinServiceHostMethod(partialBinding, 'responsiblePid');
    } catch (err) {
      expect(err).toMatchObject({ code: 'EOPNOTSUPP' });
    }
    const complete: DarwinBinding = {
      ...partialBinding,
      processPath: (pid) => `/proc/${pid}`,
    };
    expect(requireDarwinServiceHostMethod(complete, 'processPath')(42)).toBe('/proc/42');
  });
});
