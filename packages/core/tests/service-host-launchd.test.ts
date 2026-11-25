import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootoutLaunchdJob,
  createDefaultLaunchdHostAdapter,
  inspectLaunchdJob,
  type LaunchdCommandResult,
  type LaunchdHostAdapter,
  LaunchdJobError,
  type LaunchdPlistConfig,
  lintLaunchdPlist,
  PLUTIL_PATH,
  parseLaunchctlPrint,
  readLaunchdPlist,
  reloadLaunchdJob,
  renderLaunchdPlist,
} from '../src/entrypoints/service-host';
import { canonicalHostPath } from '../src/service-host/host-adapter';
import { LAUNCHCTL_PATH } from '../src/service-host/launchd-plist';

interface FakeLaunchdCommand {
  executable: string;
  args: readonly string[];
  stdin?: Uint8Array;
}

interface FakeLaunchdState {
  files: Map<string, string>;
  /** The mode each file was written with; a file set directly has `0o644`. */
  modes: Map<string, number>;
  /** A symbolic link standing at a path, with its target. */
  links: Map<string, string>;
  commands: FakeLaunchdCommand[];
  writes: string[];
  timeMs: number;
  handler: (
    executable: string,
    args: readonly string[],
    stdin?: Uint8Array,
  ) => LaunchdCommandResult;
}

function createFakeLaunchdAdapter(
  handler: (
    executable: string,
    args: readonly string[],
    state: FakeLaunchdState,
    stdin?: Uint8Array,
  ) => LaunchdCommandResult,
): { adapter: LaunchdHostAdapter; state: FakeLaunchdState } {
  const state: FakeLaunchdState = {
    files: new Map(),
    modes: new Map(),
    links: new Map(),
    commands: [],
    writes: [],
    timeMs: 1_000,
    handler: (executable, args, stdin) => handler(executable, args, state, stdin),
  };
  const adapter: LaunchdHostAdapter = {
    async runCommand(executable, args, options) {
      state.commands.push({ executable, args: [...args], stdin: options?.stdin });
      if (executable === PLUTIL_PATH && args[0] === '-lint') {
        const custom = state.handler(executable, args, options?.stdin);
        return custom;
      }
      return state.handler(executable, args, options?.stdin);
    },
    async readFile(path) {
      const value = state.files.get(path);
      return value === undefined ? null : new TextEncoder().encode(value);
    },
    async writeFileAtomic(path, content, options) {
      state.writes.push(path);
      state.modes.set(path, options?.mode ?? 0o644);
      state.files.set(
        path,
        typeof content === 'string' ? content : new TextDecoder().decode(content),
      );
    },
    async removeFile(path) {
      state.files.delete(path);
    },
    // Real resolution: a fake path whose directory does not exist is left as it is.
    canonicalPath: canonicalHostPath,
    async inspectPath(path) {
      const target = state.links.get(path);
      if (target !== undefined) return { kind: 'symlink', target };
      if (!state.files.has(path)) return { kind: 'missing' };
      return { kind: 'file', mode: state.modes.get(path) ?? 0o644 };
    },
    now() {
      return state.timeMs;
    },
    async sleep(ms) {
      state.timeMs += ms;
    },
  };
  return { adapter, state };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('service-host launchd plist rendering and print parsing', () => {
  test('renders XML-escaped LaunchAgent plist including &#13;, AssociatedBundleIdentifiers, LimitLoadToSessionType, and sorted EnvironmentVariables', () => {
    const plist = renderLaunchdPlist({
      label: 'com.example.daemon',
      associatedBundleIdentifiers: 'com.example.app',
      programArguments: [
        '/Users/example-user/.local/bin/daemon',
        '--tag',
        'a & b <c> "d" \'e\'\rline2',
      ],
      environmentVariables: {
        Z_KEY: 'last',
        A_KEY: '1 < 2 & 3 > 0\r',
      },
      workingDirectory: '/Users/example-user/work',
      keepAlive: { crashed: true, successfulExit: false },
      runAtLoad: true,
      standardOutPath: '/Users/example-user/Library/Logs/daemon.out.log',
      standardErrorPath: '/Users/example-user/Library/Logs/daemon.err.log',
      throttleInterval: 5,
      processType: 'Background',
      limitLoadToSessionType: 'Aqua',
    });

    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain('<key>Label</key>\n    <string>com.example.daemon</string>');
    expect(plist).toContain(
      '<key>AssociatedBundleIdentifiers</key>\n    <string>com.example.app</string>',
    );
    expect(plist).toContain(
      '<string>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;&#13;line2</string>',
    );
    expect(plist.indexOf('<key>A_KEY</key>')).toBeLessThan(plist.indexOf('<key>Z_KEY</key>'));
    expect(plist).toContain('<string>1 &lt; 2 &amp; 3 &gt; 0&#13;</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain('<key>Crashed</key>\n      <true/>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n      <false/>');
    expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>');
    expect(plist).toContain('<key>ThrottleInterval</key>\n    <integer>5</integer>');
    expect(plist).toContain('<key>ProcessType</key>\n    <string>Background</string>');
    expect(plist).toContain('<key>LimitLoadToSessionType</key>\n    <string>Aqua</string>');

    const multiAssoc = renderLaunchdPlist({
      label: 'com.example.daemon',
      associatedBundleIdentifiers: ['com.example.app', 'com.example.helper'],
      programArguments: ['/usr/bin/true'],
    });
    expect(multiAssoc).toContain(
      '<key>AssociatedBundleIdentifiers</key>\n    <array>\n      <string>com.example.app</string>\n      <string>com.example.helper</string>\n    </array>',
    );
  });

  test('refuses NUL, control characters, newline in programArguments[0], bad associatedBundleIdentifiers, and malformed env keys', () => {
    const invalidConfigs: LaunchdPlistConfig[] = [
      { label: 'com.example.bad\0label', programArguments: ['/usr/bin/true'] },
      { label: 'com.example.daemon', programArguments: ['/usr/bin/true', 'bad\x07bell'] },
      { label: 'com.example.daemon', programArguments: ['/usr/bin/true\nnewline'] },
      {
        label: 'com.example.daemon',
        programArguments: ['/usr/bin/true'],
        workingDirectory: '/tmp/dir\nnewline',
      },
      {
        label: 'com.example.daemon',
        programArguments: ['/usr/bin/true'],
        environmentVariables: { '': 'val' },
      },
      {
        label: 'com.example.daemon',
        programArguments: ['/usr/bin/true'],
        environmentVariables: { 'BAD=KEY': 'val' },
      },
      {
        label: 'com.example.daemon',
        associatedBundleIdentifiers: 'com.example/bad',
        programArguments: ['/usr/bin/true'],
      },
      {
        label: 'com.example.daemon',
        programArguments: ['/usr/bin/true', 'lone-high-\uD800-surrogate'],
      },
      {
        label: 'com.example.daemon',
        programArguments: ['/usr/bin/true', 'lone-low-\uDFFF-surrogate'],
      },
      {
        label: 'com.example.daemon',
        programArguments: ['/usr/bin/true', 'nonchar-\uFFFE'],
      },
      {
        label: 'com.example.daemon',
        programArguments: ['/usr/bin/true', 'nonchar-\uFFFF'],
      },
      {
        label: 'com.example.daemon',
        programArguments: ['/usr/bin/true'],
        environmentVariables: { BAD_SURROGATE: '\uD800' },
      },
      {
        label: 'com.example.daemon',
        programArguments: ['/usr/bin/true'],
        environmentVariables: { BAD_NONCHAR: '\uFFFF' },
      },
    ];
    for (const cfg of invalidConfigs) {
      expect(() => renderLaunchdPlist(cfg)).toThrow(LaunchdJobError);
    }

    // Valid supplementary Unicode surrogate pairs (e.g. U+1F680) remain accepted.
    const unicodePlist = renderLaunchdPlist({
      label: 'com.example.daemon',
      programArguments: ['/usr/bin/true', 'rocket-\u{1F680}'],
    });
    expect(unicodePlist).toContain('<string>rocket-\u{1F680}</string>');
  });

  test('parseLaunchctlPrint extracts top-level properties even when nested env values end with { or equal }', () => {
    const sample = [
      'gui/501/com.example.daemon = {',
      '\tactive count = 1',
      '\tpath = /Users/example-user/Library/LaunchAgents/com.example.daemon.plist',
      '\ttype = LaunchAgent',
      '\tstate = running',
      '',
      '\tprogram = /Users/example-user/.local/releases/v2/daemon',
      '\tenvironment = {',
      '\t\tOPEN_BRACE => value {',
      '\t\tCLOSE_BRACE => }',
      '\t\tprogram = /should/not/override',
      '\t\tpid = 99999',
      '\t}',
      '\tpid = 31415',
      '\tlast exit code = 0',
      '}',
    ].join('\n');

    expect(parseLaunchctlPrint(sample)).toEqual({
      loaded: true,
      state: 'running',
      program: '/Users/example-user/.local/releases/v2/daemon',
      pid: 31415,
      path: '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist',
      lastExitCode: 0,
    });
  });

  test('a line break in an argument or environment value is refused: launchctl print shows it unescaped', () => {
    for (const cfg of [
      {
        label: 'com.example.daemon',
        programArguments: ['/bin/sleep', '600'],
        environmentVariables: { FOO: 'a\n\t}\n\tprogram = /bin/evil' },
      },
      { label: 'com.example.daemon', programArguments: ['/bin/sleep', '600\r\n\tpid = 1'] },
    ] satisfies LaunchdPlistConfig[]) {
      expect(() => renderLaunchdPlist(cfg)).toThrow(/line break/);
    }
    expect(
      renderLaunchdPlist({
        label: 'com.example.daemon',
        programArguments: ['/bin/sleep', '600'],
        environmentVariables: { FOO: 'tab\tstays' },
      }),
    ).toContain('tab\tstays');
  });

  test('properties forged inside the environment block of a real launchctl print do not replace the job', () => {
    // Captured on macOS 27.2.1: an environment value closing its block with
    // `\t}` and naming another program, state and pid.
    const real = (name: string) =>
      readFileSync(
        join(import.meta.dir, 'fixtures/macos', `launchctl-print.${name}.txt`),
        'utf8',
      );
    expect(parseLaunchctlPrint(real('base'))).toMatchObject({
      state: 'running',
      program: '/bin/sleep',
      pid: 91595,
    });
    expect(parseLaunchctlPrint(real('v3-close-block'))).toMatchObject({
      state: 'running',
      program: '/bin/sleep',
      pid: 91763,
    });
    expect(parseLaunchctlPrint(real('v4-state-spoof'))).toMatchObject({
      state: 'running',
      program: '/bin/sleep',
      pid: 20468,
    });
  });

  test('inspectLaunchdJob returns loaded: false when launchctl print exits non-zero', async () => {
    const { adapter, state } = createFakeLaunchdAdapter(() => ({
      exitCode: 113,
      stdout: '',
      stderr: 'Could not find service',
    }));

    const inspection = await inspectLaunchdJob({
      label: 'com.example.missing',
      uid: 501,
      adapter,
    });
    expect(state.commands[0]?.executable).toBe(LAUNCHCTL_PATH);
    expect(state.commands[0]?.args).toEqual(['print', 'gui/501/com.example.missing']);
    expect(inspection.loaded).toBe(false);
    expect(inspection.pid).toBeNull();
    expect(inspection.program).toBeNull();
  });
});

describe('service-host launchd plutil validation, reading, and bootout', () => {
  test('lintLaunchdPlist runs /usr/bin/plutil -lint on stdin content or file path and throws INVALID_PLIST on failure', async () => {
    const { adapter, state } = createFakeLaunchdAdapter((exe, args, _st, stdin) => {
      if (exe === PLUTIL_PATH && args[0] === '-lint' && args[1] === '-') {
        const text = new TextDecoder().decode(stdin);
        return text.includes('<plist')
          ? { exitCode: 0, stdout: '<stdin>: OK\n', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: '<stdin>: Encountered unexpected EOF' };
      }
      if (exe === PLUTIL_PATH && args[0] === '-lint') {
        return { exitCode: 0, stdout: `${args[1]}: OK\n`, stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    });

    await lintLaunchdPlist({ content: '<plist version="1.0"><dict/></plist>', adapter });
    expect(state.commands[0]?.executable).toBe(PLUTIL_PATH);
    expect(state.commands[0]?.args).toEqual(['-lint', '-']);

    await lintLaunchdPlist({
      path: '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist',
      adapter,
    });
    expect(state.commands[1]?.args).toEqual([
      '-lint',
      '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist',
    ]);

    await expect(lintLaunchdPlist({ content: 'not-xml', adapter })).rejects.toMatchObject({
      code: 'INVALID_PLIST',
    });
    await expect(lintLaunchdPlist({ adapter })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    await expect(
      lintLaunchdPlist({ path: 'relative/file.plist', adapter }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  test('readLaunchdPlist returns null on ENOENT, parses JSON object, and throws INVALID_PLIST on malformed JSON or non-object', async () => {
    const existingPath = '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist';
    const badJsonPath = '/Users/example-user/Library/LaunchAgents/com.example.bad.plist';
    const arrayPath = '/Users/example-user/Library/LaunchAgents/com.example.array.plist';
    const eaccesPath = '/Users/example-user/Library/LaunchAgents/com.example.eacces.plist';

    const { adapter, state } = createFakeLaunchdAdapter((exe, args) => {
      if (exe !== PLUTIL_PATH) return { exitCode: 1, stdout: '', stderr: 'unexpected' };
      if (args[4] === existingPath) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ Label: 'com.example.daemon' }),
          stderr: '',
        };
      }
      if (args[4] === badJsonPath) {
        return { exitCode: 0, stdout: '{invalid-json', stderr: '' };
      }
      if (args[4] === arrayPath) {
        return { exitCode: 0, stdout: '["not","a","dict"]', stderr: '' };
      }
      if (args[4] === eaccesPath) {
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            'file does not exist or is not readable (Error Domain=NSCocoaErrorDomain Code=257 "You do not have permission")',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'No such file or directory' };
    });

    expect(
      await readLaunchdPlist({
        path: '/Users/example-user/Library/LaunchAgents/com.example.absent.plist',
        adapter,
      }),
    ).toBeNull();

    state.files.set(existingPath, '<plist/>');
    expect(await readLaunchdPlist({ path: existingPath, adapter })).toEqual({
      Label: 'com.example.daemon',
    });

    state.files.set(badJsonPath, '<plist/>');
    await expect(readLaunchdPlist({ path: badJsonPath, adapter })).rejects.toMatchObject({
      code: 'INVALID_PLIST',
    });

    state.files.set(eaccesPath, '<plist/>');
    await expect(readLaunchdPlist({ path: eaccesPath, adapter })).rejects.toMatchObject({
      code: 'INVALID_PLIST',
    });

    state.files.set(arrayPath, '<plist/>');
    await expect(readLaunchdPlist({ path: arrayPath, adapter })).rejects.toMatchObject({
      code: 'INVALID_PLIST',
    });
  });

  test('bootoutLaunchdJob unloads job and polls launchctl print until absent', async () => {
    let printsRemaining = 2;
    const { adapter, state } = createFakeLaunchdAdapter((_exe, args) => {
      if (args[0] === 'bootout') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'print') {
        printsRemaining -= 1;
        if (printsRemaining > 0) {
          return {
            exitCode: 0,
            stdout: 'gui/501/com.example.daemon = {\n\tpid = 42\n}',
            stderr: '',
          };
        }
        return { exitCode: 113, stdout: '', stderr: 'not found' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    });

    const startTime = state.timeMs;
    await bootoutLaunchdJob({
      label: 'com.example.daemon',
      uid: 501,
      settleTimeoutMs: 1_000,
      pollIntervalMs: 100,
      adapter,
    });
    expect(state.commands.map((c) => c.args)).toEqual([
      ['bootout', 'gui/501/com.example.daemon'],
      ['print', 'gui/501/com.example.daemon'],
      ['print', 'gui/501/com.example.daemon'],
    ]);
    expect(state.timeMs - startTime).toBe(100);

    // Timeout case: job remains loaded past settleTimeoutMs -> rejects with COMMAND_FAILED
    const stuck = createFakeLaunchdAdapter((_exe, args) => {
      if (args[0] === 'bootout') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'print') {
        return {
          exitCode: 0,
          stdout: 'gui/501/com.example.stuck = {\n\tpid = 99\n}',
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    });
    const stuckStart = stuck.state.timeMs;
    await expect(
      bootoutLaunchdJob({
        label: 'com.example.stuck',
        uid: 501,
        settleTimeoutMs: 250,
        pollIntervalMs: 100,
        adapter: stuck.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(stuck.state.timeMs - stuckStart).toBe(250);
    expect(stuck.state.commands.map((c) => c.args)).toEqual([
      ['bootout', 'gui/501/com.example.stuck'],
      ['print', 'gui/501/com.example.stuck'],
      ['print', 'gui/501/com.example.stuck'],
      ['print', 'gui/501/com.example.stuck'],
      ['print', 'gui/501/com.example.stuck'],
    ]);
  });
});

describe('service-host launchd reload with plutil pre-check, bootout + bootstrap, and rollback', () => {
  test('plutil -lint failure aborts BEFORE writeFileAtomic and BEFORE launchctl bootout', async () => {
    const plistPath = '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist';
    const existing = renderLaunchdPlist({
      label: 'com.example.daemon',
      programArguments: ['/Users/example-user/bin/old'],
    });
    const { adapter, state } = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH && args[0] === '-lint') {
        return { exitCode: 1, stdout: '', stderr: 'XML parse error on line 1' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    state.files.set(plistPath, existing);

    await expect(
      reloadLaunchdJob({
        label: 'com.example.daemon',
        uid: 501,
        plistPath,
        content: '<broken-xml',
        adapter,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PLIST', rolledBack: false });

    expect(state.writes).toEqual([]);
    expect(state.files.get(plistPath)).toBe(existing);
    expect(state.commands.map((c) => c.executable)).toEqual([PLUTIL_PATH]);
    expect(state.commands.some((c) => c.executable === LAUNCHCTL_PATH)).toBe(false);
  });

  test('uses plutil -lint + bootout + bootstrap (never kickstart -k) and supports validatePlist: none', async () => {
    const plistPath = '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist';
    const newProgram = '/Users/example-user/app/releases/v2/bin/daemon';
    const plist = renderLaunchdPlist({
      label: 'com.example.daemon',
      programArguments: [newProgram, '--serve'],
    });

    let loaded = true;
    let activeProgram = '/Users/example-user/app/releases/v1/bin/daemon';
    let activePid = 1001;

    const { adapter, state } = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH && args[0] === '-lint') {
        return { exitCode: 0, stdout: '<stdin>: OK\n', stderr: '' };
      }
      if (args[0] === 'bootout') {
        loaded = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootstrap') {
        loaded = true;
        activeProgram = newProgram;
        activePid = 2002;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'print') {
        if (!loaded) return { exitCode: 113, stdout: '', stderr: 'not found' };
        return {
          exitCode: 0,
          stdout: `gui/501/com.example.daemon = {\n\tpath = ${plistPath}\n\tstate = running\n\tprogram = ${activeProgram}\n\tpid = ${activePid}\n}`,
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    });

    const result = await reloadLaunchdJob({
      label: 'com.example.daemon',
      uid: 501,
      plistPath,
      content: plist,
      expectedProgram: newProgram,
      stabilityMs: 1_000,
      pollIntervalMs: 250,
      adapter,
    });

    expect(result.pid).toBe(2002);
    expect(result.program).toBe(newProgram);
    expect(result.digest).toBe(sha256(plist));
    expect(state.commands[0]?.executable).toBe(PLUTIL_PATH);
    const launchctlVerbs = state.commands
      .filter((c) => c.executable === LAUNCHCTL_PATH)
      .map((c) => c.args[0]);
    expect(launchctlVerbs).toContain('bootout');
    expect(launchctlVerbs).toContain('bootstrap');
    expect(launchctlVerbs).not.toContain('kickstart');
    expect(launchctlVerbs.indexOf('bootout')).toBeLessThan(
      launchctlVerbs.indexOf('bootstrap'),
    );

    // validatePlist: 'none' skips plutil completely
    state.commands.length = 0;
    await reloadLaunchdJob({
      label: 'com.example.daemon',
      uid: 501,
      plistPath,
      content: plist,
      expectedProgram: newProgram,
      validatePlist: 'none',
      stabilityMs: 0,
      pollIntervalMs: 100,
      adapter,
    });
    expect(state.commands.some((c) => c.executable === PLUTIL_PATH)).toBe(false);
  });

  test('rolls back on stability loss or program mismatch via bootout + bootstrap', async () => {
    const plistPath = '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist';
    const oldProgram = '/Users/example-user/app/releases/v1/bin/daemon';
    const newProgram = '/Users/example-user/app/releases/v2/bin/daemon';
    const oldPlist = renderLaunchdPlist({
      label: 'com.example.daemon',
      programArguments: [oldProgram],
    });
    const newPlist = renderLaunchdPlist({
      label: 'com.example.daemon',
      programArguments: [newProgram],
    });

    let loaded = true;
    let bootCount = 0;
    let printAfterV2 = 0;

    const unstable = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH) return { exitCode: 0, stdout: 'OK', stderr: '' };
      if (args[0] === 'bootout') {
        loaded = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootstrap') {
        loaded = true;
        bootCount += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'print') {
        if (!loaded) return { exitCode: 113, stdout: '', stderr: 'not found' };
        if (bootCount === 1) {
          printAfterV2 += 1;
          const pid = printAfterV2 <= 2 ? 4001 : 4099;
          return {
            exitCode: 0,
            stdout: `gui/501/com.example.daemon = {\n\tpath = ${plistPath}\n\tstate = running\n\tprogram = ${newProgram}\n\tpid = ${pid}\n}`,
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: `gui/501/com.example.daemon = {\n\tpath = ${plistPath}\n\tstate = running\n\tprogram = ${oldProgram}\n\tpid = 1001\n}`,
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    });
    unstable.state.files.set(plistPath, oldPlist);

    await expect(
      reloadLaunchdJob({
        label: 'com.example.daemon',
        uid: 501,
        plistPath,
        content: newPlist,
        expectedProgram: newProgram,
        stabilityMs: 1_000,
        pollIntervalMs: 250,
        adapter: unstable.adapter,
      }),
    ).rejects.toMatchObject({ code: 'UNSTABLE_CANDIDATE', rolledBack: true });
    expect(unstable.state.files.get(plistPath)).toBe(oldPlist);
    expect(bootCount).toBe(2);

    // Program mismatch rollback
    let mismatchLoaded = false;
    const mismatch = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH) return { exitCode: 0, stdout: 'OK', stderr: '' };
      if (args[0] === 'bootout') {
        mismatchLoaded = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootstrap') {
        mismatchLoaded = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (!mismatchLoaded) return { exitCode: 113, stdout: '', stderr: 'not found' };
      return {
        exitCode: 0,
        stdout: `gui/501/com.example.daemon = {\n\tpath = ${plistPath}\n\tstate = running\n\tprogram = ${oldProgram}\n\tpid = 5001\n}`,
        stderr: '',
      };
    });
    mismatch.state.files.set(plistPath, oldPlist);

    await expect(
      reloadLaunchdJob({
        label: 'com.example.daemon',
        uid: 501,
        plistPath,
        content: newPlist,
        expectedProgram: newProgram,
        stabilityMs: 500,
        pollIntervalMs: 100,
        adapter: mismatch.adapter,
      }),
    ).rejects.toMatchObject({ code: 'PROGRAM_MISMATCH', rolledBack: true });
    expect(mismatch.state.files.get(plistPath)).toBe(oldPlist);
  });

  test('a plist that names another label is refused before anything is written or unloaded', async () => {
    const plistPath = '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist';
    const { adapter, state } = createFakeLaunchdAdapter((exe) =>
      exe === PLUTIL_PATH
        ? { exitCode: 0, stdout: 'OK', stderr: '' }
        : { exitCode: 113, stdout: '', stderr: 'not found' },
    );
    // launchd would load `com.example.other` from this file, and every wait and rollback
    // below watches `com.example.daemon`: the other job would run with nobody looking.
    await expect(
      reloadLaunchdJob({
        label: 'com.example.daemon',
        uid: 501,
        plistPath,
        content: renderLaunchdPlist({
          label: 'com.example.other',
          programArguments: ['/Users/example-user/bin/daemon'],
        }),
        adapter,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PLIST', rolledBack: false });
    expect(state.writes).toEqual([]);
    expect(state.commands.some((c) => c.executable === LAUNCHCTL_PATH)).toBe(false);
  });

  test('rollback writes the bytes that were there and leaves a job that was not loaded unloaded', async () => {
    const plistPath = '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist';
    // A binary plist: not text, so a decode and re-encode would not give these bytes back.
    const binaryPlist = new Uint8Array([
      0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0xd1, 0xff, 0x80, 0x00,
    ]);
    let stored: Uint8Array | string | undefined = binaryPlist;
    const written: Array<string | Uint8Array> = [];
    let bootstraps = 0;
    const { adapter } = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH) return { exitCode: 0, stdout: 'OK', stderr: '' };
      if (args[0] === 'bootstrap') {
        bootstraps += 1;
        return { exitCode: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      }
      // Never loaded: not before the reload and not after the failed bootstrap.
      if (args[0] === 'print') return { exitCode: 113, stdout: '', stderr: 'not found' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    adapter.readFile = async () =>
      stored === undefined
        ? null
        : typeof stored === 'string'
          ? new TextEncoder().encode(stored)
          : stored;
    adapter.writeFileAtomic = async (_path, content) => {
      written.push(content);
      stored = content;
    };

    await expect(
      reloadLaunchdJob({
        label: 'com.example.daemon',
        uid: 501,
        plistPath,
        content: renderLaunchdPlist({
          label: 'com.example.daemon',
          programArguments: ['/Users/example-user/bin/daemon'],
        }),
        adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });

    expect(written).toHaveLength(2);
    expect(written[1]).toEqual(binaryPlist);
    expect(stored).toEqual(binaryPlist);
    // One bootstrap: the candidate's. The job was not loaded before, so rollback loads nothing.
    expect(bootstraps).toBe(1);
  });

  test('restores/removes plist even when bootoutSettleTimeoutMs fails, honours mode/startupTimeoutMs, and validates wait bounds', async () => {
    const plistPath = '/Users/example-user/Library/LaunchAgents/com.example.fresh.plist';
    const oldPlist = renderLaunchdPlist({
      label: 'com.example.fresh',
      programArguments: ['/opt/old/daemon'],
    });
    const newPlist = renderLaunchdPlist({
      label: 'com.example.fresh',
      programArguments: ['/opt/new/daemon'],
    });

    let writtenMode: number | undefined;
    let loaded = false;
    const timeoutCase = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH) return { exitCode: 0, stdout: 'OK', stderr: '' };
      if (args[0] === 'bootout') {
        loaded = false;
        return { exitCode: 3, stdout: '', stderr: 'not loaded' };
      }
      if (args[0] === 'bootstrap') {
        loaded = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (!loaded) return { exitCode: 113, stdout: '', stderr: 'not found' };
      return {
        exitCode: 0,
        stdout: `gui/501/com.example.fresh = {\n\tpath = ${plistPath}\n\tstate = waiting\n\tprogram = /opt/new/daemon\n}`,
        stderr: '',
      };
    });
    const wrapped: LaunchdHostAdapter = {
      ...timeoutCase.adapter,
      async writeFileAtomic(path, data, opts) {
        writtenMode = opts?.mode;
        return timeoutCase.adapter.writeFileAtomic(path, data, opts);
      },
    };

    await expect(
      reloadLaunchdJob({
        label: 'com.example.fresh',
        uid: 501,
        plistPath,
        content: newPlist,
        mode: 0o600,
        startupTimeoutMs: 400,
        bootoutSettleTimeoutMs: 500,
        pollIntervalMs: 100,
        adapter: wrapped,
      }),
    ).rejects.toMatchObject({ code: 'START_TIMEOUT', rolledBack: true });
    expect(writtenMode).toBe(0o600);
    expect(timeoutCase.state.files.has(plistPath)).toBe(false);

    const stuckBootout = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH) return { exitCode: 0, stdout: 'OK', stderr: '' };
      if (args[0] === 'bootout') return { exitCode: 0, stdout: '', stderr: '' };
      return {
        exitCode: 0,
        stdout: `gui/501/com.example.fresh = {\n\tpath = ${plistPath}\n\tstate = running\n\tpid = 123\n}`,
        stderr: '',
      };
    });
    stuckBootout.state.files.set(plistPath, oldPlist);

    await expect(
      reloadLaunchdJob({
        label: 'com.example.fresh',
        uid: 501,
        plistPath,
        content: newPlist,
        bootoutSettleTimeoutMs: 300,
        pollIntervalMs: 100,
        adapter: stuckBootout.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    expect(stuckBootout.state.files.get(plistPath)).toBe(oldPlist);

    await expect(
      reloadLaunchdJob({
        label: 'com.example.fresh',
        uid: 501,
        plistPath,
        content: newPlist,
        bootoutSettleTimeoutMs: 999_999,
        adapter: stuckBootout.adapter,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  test('reloadLaunchdJob ignores nested or commented Label keys and decodes numeric XML entities', async () => {
    const plistPath = '/Users/example-user/Library/LaunchAgents/com.example.real.plist';
    const spoofedNested = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '  <!-- <key>Label</key><string>com.example.real</string> -->',
      '  <key>EnvironmentVariables</key><dict><key>Label</key><string>com.example.real</string></dict>',
      '  <key>Label</key><string>com.example.other</string>',
      '</dict></plist>',
    ].join('\n');
    const numericEntities = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>com&#46;example&#x2e;real</string>',
      '  <key>ProgramArguments</key><array><string>/usr/bin/true</string></array>',
      '</dict></plist>',
    ].join('\n');
    let loaded = false;
    const fake = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH) return { exitCode: 0, stdout: 'OK', stderr: '' };
      if (args[0] === 'bootout') {
        loaded = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootstrap') {
        loaded = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'print') {
        return loaded
          ? {
              exitCode: 0,
              stdout: `gui/501/com.example.real = {\n\tpath = ${plistPath}\n\tstate = running\n\tpid = 42\n}`,
              stderr: '',
            }
          : { exitCode: 113, stdout: '', stderr: 'Could not find service' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(
      reloadLaunchdJob({
        label: 'com.example.real',
        uid: 501,
        plistPath,
        content: spoofedNested,
        adapter: fake.adapter,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PLIST',
      message:
        'Plist declares Label com.example.other, but the job being reloaded is com.example.real',
    });

    const reloaded = await reloadLaunchdJob({
      label: 'com.example.real',
      uid: 501,
      plistPath,
      content: numericEntities,
      adapter: fake.adapter,
    });
    expect(reloaded.label).toBe('com.example.real');
  });

  test('reloadLaunchdJob parses XML 1.0 CDATA labels before comments and rejects illegal XML 1.0 code points (NUL, control chars, surrogates, 0xFFFE/0xFFFF)', async () => {
    const plistPath = '/Users/example-user/Library/LaunchAgents/com.example.cdata.plist';
    let loaded = false;
    const fake = createFakeLaunchdAdapter((_exe, args) => {
      if (args[0] === 'bootout') {
        loaded = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootstrap') {
        loaded = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'print') {
        return loaded
          ? {
              exitCode: 0,
              stdout: `gui/501/com.example.cdata = {\n\tpath = ${plistPath}\n\tstate = running\n\tpid = 77\n}`,
              stderr: '',
            }
          : { exitCode: 113, stdout: '', stderr: 'Could not find service' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const cdataLabel = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string><![CDATA[com.example.cdata]]></string>',
      '  <key>ProgramArguments</key><array><string>/usr/bin/true</string></array>',
      '</dict></plist>',
    ].join('\n');
    const cdataRes = await reloadLaunchdJob({
      label: 'com.example.cdata',
      uid: 501,
      plistPath,
      content: cdataLabel,
      validatePlist: 'none',
      stabilityMs: 0,
      adapter: fake.adapter,
    });
    expect(cdataRes.label).toBe('com.example.cdata');

    // CDATA containing comment delimiters must be parsed BEFORE XML comments
    const cdataWithCommentMarkers = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '  <key>NoteA</key><string><![CDATA[<!--]]></string>',
      '  <key>Label</key><string>com.<![CDATA[example]]>&#46;cdata</string>',
      '  <key>NoteB</key><string><![CDATA[-->]]></string>',
      '</dict></plist>',
    ].join('\n');
    const cdataCommentRes = await reloadLaunchdJob({
      label: 'com.example.cdata',
      uid: 501,
      plistPath,
      content: cdataWithCommentMarkers,
      validatePlist: 'none',
      stabilityMs: 0,
      adapter: fake.adapter,
    });
    expect(cdataCommentRes.label).toBe('com.example.cdata');

    // Reject illegal XML 1.0 numeric references and raw characters even when Label text matches
    const invalidPlsts = [
      '<plist version="1.0"><dict><key>Label</key><string>com.example.cdata</string><key>X</key><string>&#0;</string></dict></plist>',
      '<plist version="1.0"><dict><key>Label</key><string>com.example.cdata</string><key>X</key><string>&#x08;</string></dict></plist>',
      '<plist version="1.0"><dict><key>Label</key><string>com.example.cdata</string><key>X</key><string>&#x0b;</string></dict></plist>',
      '<plist version="1.0"><dict><key>Label</key><string>com.example.cdata</string><key>X</key><string>&#x1f;</string></dict></plist>',
      '<plist version="1.0"><dict><key>Label</key><string>com.example.cdata</string><key>X</key><string>&#xD800;</string></dict></plist>',
      '<plist version="1.0"><dict><key>Label</key><string>com.example.cdata</string><key>X</key><string>&#xDFFF;</string></dict></plist>',
      '<plist version="1.0"><dict><key>Label</key><string>com.example.cdata</string><key>X</key><string>&#xFFFE;</string></dict></plist>',
      '<plist version="1.0"><dict><key>Label</key><string>com.example.cdata</string><key>X</key><string>&#xFFFF;</string></dict></plist>',
      '<plist version="1.0"><dict><key>Label</key><string>com.example.cdata</string><key>X</key><string>\uD800</string></dict></plist>',
      '<plist version="1.0"><dict><key>Label</key><string><![CDATA[com.example.cdata</string></dict></plist>',
    ];
    for (const badPlist of invalidPlsts) {
      await expect(
        reloadLaunchdJob({
          label: 'com.example.cdata',
          uid: 501,
          plistPath,
          content: badPlist,
          validatePlist: 'none',
          stabilityMs: 0,
          adapter: fake.adapter,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PLIST' });
    }

    // Preserve default launchd adapter distinction: ENOENT returns null, non-regular files (/dev/null) reject
    const defaultLaunchd = createDefaultLaunchdHostAdapter();
    expect(
      await defaultLaunchd.readFile('/nonexistent/stitchkit-launchd-missing-12345.plist'),
    ).toBeNull();
    await expect(defaultLaunchd.readFile('/dev/null')).rejects.toMatchObject({
      reason: 'not-regular',
    });
  });
});

describe('service-host launchd: a job of the same label from another plist', () => {
  const label = 'com.example.daemon';
  const ourPath = '/Users/example-user/Library/LaunchAgents/com.example.daemon.plist';
  const foreignPath = '/Library/LaunchAgents/com.example.daemon.plist';
  const content = renderLaunchdPlist({ label, programArguments: ['/opt/ours/daemon'] });

  /** A domain holding one job loaded from `loadedFrom` (`null`: print names no path). */
  function domainWith(loadedFrom: string | null, bootstrapExit = 5) {
    let loaded = true;
    const fake = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH) return { exitCode: 0, stdout: 'OK', stderr: '' };
      if (args[0] === 'print') {
        if (!loaded) return { exitCode: 113, stdout: '', stderr: 'Could not find service' };
        const pathLine = loadedFrom === null ? '' : `\tpath = ${loadedFrom}\n`;
        return {
          exitCode: 0,
          stdout: `gui/501/${label} = {\n${pathLine}\tstate = running\n\tprogram = /opt/foreign/daemon\n\tpid = 42\n}\n`,
          stderr: '',
        };
      }
      if (args[0] === 'bootout') {
        loaded = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootstrap') {
        return bootstrapExit === 0
          ? { exitCode: 0, stdout: '', stderr: '' }
          : {
              exitCode: bootstrapExit,
              stdout: '',
              stderr: 'Bootstrap failed: 5: Input/output error',
            };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    return { ...fake, isLoaded: () => loaded };
  }

  test('a job loaded from another plist is refused before bootout and stays loaded', async () => {
    for (const loadedFrom of [foreignPath, null]) {
      const domain = domainWith(loadedFrom);
      await expect(
        reloadLaunchdJob({
          label,
          uid: 501,
          plistPath: ourPath,
          content,
          validatePlist: 'none',
          adapter: domain.adapter,
        }),
      ).rejects.toMatchObject({ code: 'FOREIGN_FRAGMENT', rolledBack: false });
      expect(domain.isLoaded(), String(loadedFrom)).toBe(true);
      expect(domain.state.writes, String(loadedFrom)).toEqual([]);
      expect(
        domain.state.commands.map((c) => c.args[0]),
        String(loadedFrom),
      ).toEqual(['print']);
    }
  });

  test('a rollback puts the plist back with the mode it had, not the candidate mode', async () => {
    const domain = domainWith(ourPath);
    const previous = renderLaunchdPlist({ label, programArguments: ['/opt/ours/v1/daemon'] });
    domain.state.files.set(ourPath, previous);
    domain.state.modes.set(ourPath, 0o600);
    await expect(
      reloadLaunchdJob({
        label,
        uid: 501,
        plistPath: ourPath,
        content,
        validatePlist: 'none',
        adapter: domain.adapter,
      }),
      // This domain refuses every bootstrap, the rollback's too: what is checked is the file
      // the rollback wrote before it.
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(domain.state.writes).toEqual([ourPath, ourPath]);
    expect(domain.state.files.get(ourPath)).toBe(previous);
    expect(domain.state.modes.get(ourPath)).toBe(0o600);
  });

  test('a symbolic link at plistPath is refused before anything is written or unloaded', async () => {
    const domain = domainWith(ourPath);
    domain.state.links.set(ourPath, '/Users/example-user/dotfiles/com.example.daemon.plist');
    await expect(
      reloadLaunchdJob({
        label,
        uid: 501,
        plistPath: ourPath,
        content,
        validatePlist: 'none',
        adapter: domain.adapter,
      }),
    ).rejects.toMatchObject({
      code: 'FOREIGN_FRAGMENT',
      rolledBack: false,
      message: expect.stringContaining('a symbolic link to /Users/example-user/dotfiles/'),
    });
    expect(domain.isLoaded()).toBe(true);
    expect(domain.state.writes).toEqual([]);
    expect(domain.state.commands.map((command) => command.args[0])).toEqual(['print']);
  });

  test('a bootstrap that loads the job and answers an error is undone: the job ends as it was found', async () => {
    let loaded = false;
    let bootstraps = 0;
    const fake = createFakeLaunchdAdapter((exe, args) => {
      if (exe === PLUTIL_PATH) return { exitCode: 0, stdout: 'OK', stderr: '' };
      if (args[0] === 'print') {
        if (!loaded) return { exitCode: 113, stdout: '', stderr: 'Could not find service' };
        return {
          exitCode: 0,
          stdout: `gui/501/${label} = {\n\tpath = ${ourPath}\n\tstate = running\n\tprogram = /opt/ours/daemon\n\tpid = 42\n}\n`,
          stderr: '',
        };
      }
      if (args[0] === 'bootout') {
        loaded = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootstrap') {
        bootstraps += 1;
        // The candidate is loaded, then launchctl answers an error; a second one "succeeds"
        // without loading anything.
        if (bootstraps === 1) loaded = true;
        return bootstraps === 1
          ? { exitCode: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
          : { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    fake.state.files.set(ourPath, content);
    await expect(
      reloadLaunchdJob({
        label,
        uid: 501,
        plistPath: ourPath,
        content,
        validatePlist: 'none',
        adapter: fake.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: true });
    expect(loaded).toBe(false);

    // Loaded before: bootstraps that answer 0 and load nothing — the candidate never starts, and
    // the rollback's bootstrap leaves the job unloaded — are not rolledBack.
    loaded = true;
    bootstraps = 1;
    await expect(
      reloadLaunchdJob({
        label,
        uid: 501,
        plistPath: ourPath,
        content,
        validatePlist: 'none',
        adapter: fake.adapter,
      }),
    ).rejects.toMatchObject({
      rolledBack: false,
      message: expect.stringContaining('is not loaded after rollback; it was loaded'),
    });
  });

  test('a job loaded from our own plist is reloaded (positive control)', async () => {
    const domain = domainWith(ourPath, 0);
    domain.state.files.set(ourPath, content);
    const adapter = domain.adapter;
    // After bootstrap the job is ours again and stays up.
    const run = adapter.runCommand;
    let bootstrapped = false;
    adapter.runCommand = async (exe, args, options) => {
      if (args[0] === 'bootstrap') bootstrapped = true;
      if (args[0] === 'print' && bootstrapped) {
        return {
          exitCode: 0,
          stdout: `gui/501/${label} = {\n\tpath = ${ourPath}\n\tstate = running\n\tprogram = /opt/ours/daemon\n\tpid = 77\n}\n`,
          stderr: '',
        };
      }
      return run(exe, args, options);
    };
    const result = await reloadLaunchdJob({
      label,
      uid: 501,
      plistPath: ourPath,
      content,
      validatePlist: 'none',
      stabilityMs: 0,
      adapter,
    });
    expect(result.pid).toBe(77);
  });

  test('a launchctl print that fails for another reason than a missing service is an error, not "not loaded"', async () => {
    const { adapter } = createFakeLaunchdAdapter(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Operation not permitted',
    }));
    await expect(inspectLaunchdJob({ label, uid: 501, adapter })).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
    // The reload acts on nothing when it cannot tell whether a job is loaded.
    const refused = createFakeLaunchdAdapter(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Operation not permitted',
    }));
    await expect(
      reloadLaunchdJob({
        label,
        uid: 501,
        plistPath: ourPath,
        content,
        validatePlist: 'none',
        adapter: refused.adapter,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', rolledBack: false });
    expect(refused.state.writes).toEqual([]);
  });

  test('a job loaded from our path whose file is gone cannot be put back: not rolledBack', async () => {
    const domain = domainWith(ourPath);
    let caught: unknown;
    try {
      await reloadLaunchdJob({
        label,
        uid: 501,
        plistPath: ourPath,
        content,
        validatePlist: 'none',
        adapter: domain.adapter,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LaunchdJobError);
    if (caught instanceof LaunchdJobError) {
      expect(caught.code).toBe('COMMAND_FAILED');
      expect(caught.rolledBack).toBe(false);
      expect(caught.message).toContain('rollback also failed');
    }
    expect(domain.state.files.has(ourPath)).toBe(false);
  });
});
