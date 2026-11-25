/**
 * Permutation matrix over CLI flag positions, profiles, argument atoms and slots.
 *
 * Uses an absolute semantic oracle (never comparing against the old code) and an
 * explicit `REFUSALS` table where both an unexpected refusal and a refusal row
 * turning green fail the run. Includes a `Bun.spawn` subprocess lane with real
 * `process.argv` per profile and slot class.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type CliProfileKind,
  createFixtureProfileStore,
  expectedProfileNotice,
  makeInspectPayload,
  type RunObservation,
  runFixtureProfile,
} from './cli-flag-positions.entry';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProfileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stitchkit-flag-pos-'));
  tempDirs.push(dir);
  const store = createFixtureProfileStore(dir);
  store.write('prod', { url: 'https://prod.example.test', token: 'fixture-key' });
  return dir;
}

const PROFILES: readonly CliProfileKind[] = [
  'static-native',
  'static-native-default',
  'managed-factory',
  'managed-profile',
];

const NATIVE_PROFILES = new Set<CliProfileKind>([
  'static-native',
  'static-native-default',
  'managed-factory',
]);

type Slot = 'before-cmd' | 'after-cmd' | 'after-pos' | 'no-cmd';

interface RefusalRule {
  readonly id: string;
  readonly code: number;
  readonly stderrSubstring: string;
}

const REFUSALS = {
  'invalid-bool-inline': {
    id: 'invalid-bool-inline',
    code: 2,
    stderrSubstring: 'expects a boolean (true/false), got "maybe"',
  },
  'broken-bool-boundary': {
    id: 'broken-bool-boundary',
    code: 2,
    stderrSubstring: 'cannot be separated from',
  },
  'missing-value': {
    id: 'missing-value',
    code: 2,
    stderrSubstring: 'requires a value',
  },
  'wait-timeout-without-wait': {
    id: 'wait-timeout-without-wait',
    code: 2,
    stderrSubstring: '--wait-timeout requires --wait',
  },
  'native-wait-unsupported': {
    id: 'native-wait-unsupported',
    code: 2,
    stderrSubstring: '--wait is not configured for native command "inspect"',
  },
  'native-output-dir-unsupported': {
    id: 'native-output-dir-unsupported',
    code: 2,
    stderrSubstring: '--output-dir is not configured for native commands',
  },
  'top-level-help-no-match': {
    id: 'top-level-help-no-match',
    code: 4,
    stderrSubstring: 'no command matches "',
  },
} as const satisfies Record<string, RefusalRule>;

type RefusalId = keyof typeof REFUSALS;

interface SemanticAtom {
  readonly id: string;
  readonly kind: 'fw-bool' | 'fw-value' | 'app-global' | 'cmd-bool';
  readonly tokens: readonly string[];
  /** True when the atom ends with a bare framework boolean (no inline `=`, no adjacent true/false). */
  readonly bareFrameworkBool?: boolean;
  readonly fwFlag?: string;
  readonly boolValue?: boolean;
  readonly invalidInline?: boolean;
  readonly missingValue?: boolean;
  readonly valuePayload?: string;
  readonly appProfile?: string;
  readonly appCompress?: boolean;
  readonly cmdVerbose?: boolean;
}

interface PositionalAtom {
  readonly id: string;
  readonly tokens: readonly string[];
  readonly text?: string;
  readonly isBareBoolWord?: boolean;
  readonly hasSeparator?: boolean;
}

const POS_EMPTY: PositionalAtom = { id: 'empty', tokens: [] };
const POS_HELLO: PositionalAtom = { id: 'hello', tokens: ['hello'], text: 'hello' };

const POSITIONAL_ATOMS: readonly PositionalAtom[] = [
  POS_EMPTY,
  POS_HELLO,
  { id: 'true', tokens: ['true'], text: 'true', isBareBoolWord: true },
  { id: 'false', tokens: ['false'], text: 'false', isBareBoolWord: true },
  { id: 'dash', tokens: ['-'], text: '-' },
  { id: 'sep-quiet', tokens: ['--', '--quiet'], text: '--quiet', hasSeparator: true },
];

const FRAMEWORK_BOOL_FLAGS = ['json', 'quiet', 'dry-run', 'schema', 'help', 'wait'] as const;

function buildFrameworkBoolAtoms(): SemanticAtom[] {
  const atoms: SemanticAtom[] = [];
  for (const name of FRAMEWORK_BOOL_FLAGS) {
    atoms.push(
      {
        id: `--${name}`,
        kind: 'fw-bool',
        tokens: [`--${name}`],
        bareFrameworkBool: true,
        fwFlag: name,
        boolValue: true,
      },
      {
        id: `--${name}=true`,
        kind: 'fw-bool',
        tokens: [`--${name}=true`],
        fwFlag: name,
        boolValue: true,
      },
      {
        id: `--${name}=false`,
        kind: 'fw-bool',
        tokens: [`--${name}=false`],
        fwFlag: name,
        boolValue: false,
      },
      {
        id: `--${name} true`,
        kind: 'fw-bool',
        tokens: [`--${name}`, 'true'],
        fwFlag: name,
        boolValue: true,
      },
      {
        id: `--${name} false`,
        kind: 'fw-bool',
        tokens: [`--${name}`, 'false'],
        fwFlag: name,
        boolValue: false,
      },
      {
        id: `--${name} TRUE`,
        kind: 'fw-bool',
        tokens: [`--${name}`, 'TRUE'],
        fwFlag: name,
        boolValue: true,
      },
      {
        id: `--${name}=maybe`,
        kind: 'fw-bool',
        tokens: [`--${name}=maybe`],
        fwFlag: name,
        invalidInline: true,
      },
    );
  }
  return atoms;
}

function buildFrameworkValueAtoms(outDir: string): SemanticAtom[] {
  return [
    {
      id: '--output-dir x',
      kind: 'fw-value',
      tokens: ['--output-dir', outDir],
      fwFlag: 'output-dir',
      valuePayload: outDir,
    },
    {
      id: '--output-dir=x',
      kind: 'fw-value',
      tokens: [`--output-dir=${outDir}`],
      fwFlag: 'output-dir',
      valuePayload: outDir,
    },
    {
      id: '--output-dir (missing)',
      kind: 'fw-value',
      tokens: ['--output-dir'],
      fwFlag: 'output-dir',
      missingValue: true,
    },
    {
      id: '--output-dir -x',
      kind: 'fw-value',
      tokens: ['--output-dir', '-x'],
      fwFlag: 'output-dir',
      missingValue: true,
    },
    {
      id: '--wait-timeout 5',
      kind: 'fw-value',
      tokens: ['--wait-timeout', '5'],
      fwFlag: 'wait-timeout',
      valuePayload: '5',
    },
    {
      id: '--wait-timeout=5',
      kind: 'fw-value',
      tokens: ['--wait-timeout=5'],
      fwFlag: 'wait-timeout',
      valuePayload: '5',
    },
    {
      id: '--wait-timeout (missing)',
      kind: 'fw-value',
      tokens: ['--wait-timeout'],
      fwFlag: 'wait-timeout',
      missingValue: true,
    },
    {
      id: '--wait-timeout -x',
      kind: 'fw-value',
      tokens: ['--wait-timeout', '-x'],
      fwFlag: 'wait-timeout',
      missingValue: true,
    },
    {
      id: '--sort score',
      kind: 'fw-value',
      tokens: ['--sort', 'score'],
      fwFlag: 'sort',
      valuePayload: 'score',
    },
    {
      id: '--sort=score',
      kind: 'fw-value',
      tokens: ['--sort=score'],
      fwFlag: 'sort',
      valuePayload: 'score',
    },
    {
      id: '--sort (missing)',
      kind: 'fw-value',
      tokens: ['--sort'],
      fwFlag: 'sort',
      missingValue: true,
    },
    {
      id: '--sort -x',
      kind: 'fw-value',
      tokens: ['--sort', '-x'],
      fwFlag: 'sort',
      missingValue: true,
    },
    {
      id: '--table id,score',
      kind: 'fw-value',
      tokens: ['--table', 'id,score'],
      fwFlag: 'table',
      valuePayload: 'id,score',
    },
    {
      id: '--table=id,score',
      kind: 'fw-value',
      tokens: ['--table=id,score'],
      fwFlag: 'table',
      valuePayload: 'id,score',
    },
    {
      id: '--table (missing)',
      kind: 'fw-value',
      tokens: ['--table'],
      fwFlag: 'table',
      missingValue: true,
    },
    {
      id: '--table -x',
      kind: 'fw-value',
      tokens: ['--table', '-x'],
      fwFlag: 'table',
      missingValue: true,
    },
  ];
}

const APP_GLOBAL_ATOMS: readonly SemanticAtom[] = [
  {
    id: '--profile prod',
    kind: 'app-global',
    tokens: ['--profile', 'prod'],
    appProfile: 'prod',
  },
  { id: '--profile=prod', kind: 'app-global', tokens: ['--profile=prod'], appProfile: 'prod' },
  { id: '--compress', kind: 'app-global', tokens: ['--compress'], appCompress: true },
  {
    id: '--compress false',
    kind: 'app-global',
    tokens: ['--compress', 'false'],
    appCompress: false,
  },
];

const CMD_BOOL_ATOMS: readonly SemanticAtom[] = [
  { id: '--verbose', kind: 'cmd-bool', tokens: ['--verbose'], cmdVerbose: true },
  {
    id: '--verbose false',
    kind: 'cmd-bool',
    tokens: ['--verbose', 'false'],
    cmdVerbose: false,
  },
  { id: '--verbose=false', kind: 'cmd-bool', tokens: ['--verbose=false'], cmdVerbose: false },
  { id: '-f false', kind: 'cmd-bool', tokens: ['-f', 'false'], cmdVerbose: false },
];

function buildArgv(slot: Slot, atom: SemanticAtom, pos: PositionalAtom): string[] {
  if (slot === 'no-cmd') {
    return [...atom.tokens, ...pos.tokens];
  }
  if (slot === 'before-cmd') {
    return [...atom.tokens, 'inspect', ...pos.tokens];
  }
  if (slot === 'after-cmd') {
    return ['inspect', ...atom.tokens, ...pos.tokens];
  }
  // after-pos: when positional includes `--`, options must precede `--` so they remain options.
  if (pos.hasSeparator) {
    return ['inspect', ...atom.tokens, ...pos.tokens];
  }
  return ['inspect', ...pos.tokens, ...atom.tokens];
}

interface OracleResult {
  refusal?: RefusalId;
  code: number;
  /** Exact expected stdout, or `'help'`/`'schema'` for deterministic structured assertions. */
  stdoutKind: 'exact' | 'command-help' | 'top-help' | 'schema';
  exactStdout?: string;
  exactStderr?: string;
  handlerCalls: number;
  resolveAuthCalls: number;
  factoryCalls: number;
  lastInput?: Record<string, unknown>;
}

/**
 * Pure absolute oracle derived solely from the declared semantics of each atom,
 * slot and CLI profile — never by running a reference implementation.
 */
function computeOracle(
  profile: CliProfileKind,
  slot: Slot,
  atom: SemanticAtom,
  pos: PositionalAtom,
  profileDir: string,
): OracleResult {
  const isNative = NATIVE_PROFILES.has(profile);
  const notice = profile === 'managed-profile' ? expectedProfileNotice(profileDir) : '';

  // 1. `--help=maybe` in top-level slot is a help filter ("maybe"), not an invalid boolean.
  if (
    atom.fwFlag === 'help' &&
    atom.invalidInline &&
    (slot === 'before-cmd' || slot === 'no-cmd')
  ) {
    return {
      refusal: 'top-level-help-no-match',
      code: 4,
      stdoutKind: 'exact',
      exactStdout: '',
      exactStderr: `${notice}no command matches "maybe" (${profile === 'managed-profile' || profile === 'managed-factory' ? 2 : 1} available)\n`,
      handlerCalls: 0,
      resolveAuthCalls: profile === 'managed-factory' ? 1 : 0,
      factoryCalls: profile === 'managed-factory' ? 1 : 0,
    };
  }

  // 2. Invalid inline boolean (`--b=maybe`) always refuses with code 2 before profile notice.
  if (atom.invalidInline) {
    return {
      refusal: 'invalid-bool-inline',
      code: 2,
      stdoutKind: 'exact',
      exactStdout: '',
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  // 3. Top-level help: `--help` (NOT inline `--help=true`) before command or in `no-cmd` triggers top-level help.
  if (
    atom.fwFlag === 'help' &&
    atom.tokens[0] === '--help' &&
    (slot === 'before-cmd' || slot === 'no-cmd')
  ) {
    if (slot === 'before-cmd') {
      if (atom.tokens.length === 1) {
        // `--help inspect`: top-level help filtered by "inspect" (matches inspect!)
        return {
          code: 0,
          stdoutKind: 'top-help',
          exactStderr: notice,
          handlerCalls: 0,
          resolveAuthCalls: profile === 'managed-factory' ? 1 : 0,
          factoryCalls: profile === 'managed-factory' ? 1 : 0,
        };
      }
      // `--help true|false|TRUE inspect`: top-level help with filter `true|false|TRUE` → no match!
      return {
        refusal: 'top-level-help-no-match',
        code: 4,
        stdoutKind: 'exact',
        exactStdout: '',
        exactStderr: `${notice}no command matches "${atom.tokens[1]}" (${profile === 'managed-profile' || profile === 'managed-factory' ? 2 : 1} available)\n`,
        handlerCalls: 0,
        resolveAuthCalls: profile === 'managed-factory' ? 1 : 0,
        factoryCalls: profile === 'managed-factory' ? 1 : 0,
      };
    }
    // `no-cmd` with defaultCommand: `--help` alone → unfiltered top-level help; `--help true|false|TRUE` → filtered top-level help (no match).
    if (atom.tokens.length === 1) {
      return {
        code: 0,
        stdoutKind: 'top-help',
        exactStderr: notice,
        handlerCalls: 0,
        resolveAuthCalls: 0,
        factoryCalls: 0,
      };
    }
    return {
      refusal: 'top-level-help-no-match',
      code: 4,
      stdoutKind: 'exact',
      exactStdout: '',
      exactStderr: `${notice}no command matches "${atom.tokens[1]}" (1 available)\n`,
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  // 4. Broken boolean boundary: bare framework boolean separated from `true`/`false` by removed command name (`before-cmd` + bare bool + bare `true`/`false` positional).
  if (slot === 'before-cmd' && atom.bareFrameworkBool && pos.isBareBoolWord) {
    return {
      refusal: 'broken-bool-boundary',
      code: 2,
      stdoutKind: 'exact',
      exactStdout: '',
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  // 4b. Adjacent bare framework boolean followed directly by `true`/`false` in `after-cmd`:
  //     `inspect --flag false` binds `false` as the boolean's value (no positional text!).
  const adjacentSwallowedBool =
    slot === 'after-cmd' && atom.bareFrameworkBool === true && pos.isBareBoolWord === true;
  const effectiveBoolValue = adjacentSwallowedBool ? pos.text === 'true' : atom.boolValue;
  const effectivePosText = adjacentSwallowedBool ? undefined : pos.text;

  // 5. Missing value on a framework value option:
  //    - `--v` at end of argv (`after-pos` with no tokens after, or `no-cmd` with empty pos)
  //    - `--v -x` in ANY slot (`-x` is a single-letter option token)
  //    - NOTE: `--v inspect` (`before-cmd` with `--v` alone) treats `inspect` as the value of `--v`!
  //      Wait — we test `--v` (missing) specifically at the trailing position and `--v -x` in every slot!
  if (atom.missingValue) {
    return {
      refusal: 'missing-value',
      code: 2,
      stdoutKind: 'exact',
      exactStdout: '',
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  // 6. Command help (`--help` / `--help=true` / `--help true` / `--help TRUE` after command, or `--help=true` before command)
  if (atom.fwFlag === 'help' && effectiveBoolValue === true) {
    return {
      code: 0,
      stdoutKind: 'command-help',
      exactStderr: notice,
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  // 7. `--schema` enabled
  if (atom.fwFlag === 'schema' && effectiveBoolValue === true) {
    return {
      code: 0,
      stdoutKind: 'schema',
      exactStderr: notice,
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  // 8. `--wait-timeout` without `--wait`
  if (atom.fwFlag === 'wait-timeout') {
    return {
      refusal: 'wait-timeout-without-wait',
      code: 2,
      stdoutKind: 'exact',
      exactStdout: '',
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  // 9. `--wait` on native profile
  if (atom.fwFlag === 'wait' && effectiveBoolValue === true && isNative) {
    return {
      refusal: 'native-wait-unsupported',
      code: 2,
      stdoutKind: 'exact',
      exactStdout: '',
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  // 10. `--output-dir` on native profile
  if (atom.fwFlag === 'output-dir' && isNative) {
    return {
      refusal: 'native-output-dir-unsupported',
      code: 2,
      stdoutKind: 'exact',
      exactStdout: '',
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  const expectedInput: Record<string, unknown> = {
    ...(effectivePosText !== undefined && { text: effectivePosText }),
    ...(atom.cmdVerbose !== undefined && { verbose: atom.cmdVerbose }),
  };

  // 11. `--dry-run` enabled
  if (atom.fwFlag === 'dry-run' && effectiveBoolValue === true) {
    return {
      code: 0,
      stdoutKind: 'exact',
      exactStdout: `${JSON.stringify({ command: 'inspect', args: expectedInput }, null, 2)}\n`,
      exactStderr: notice,
      handlerCalls: 0,
      resolveAuthCalls: 0,
      factoryCalls: 0,
    };
  }

  // 12. Normal execution!
  const quiet = atom.fwFlag === 'quiet' && effectiveBoolValue === true;
  const json = atom.fwFlag === 'json' && effectiveBoolValue === true;
  const globals = {
    ...(atom.appProfile !== undefined && { profile: atom.appProfile }),
    ...(profile === 'managed-profile' && atom.appProfile === undefined && { profile: 'prod' }),
    ...(atom.appCompress !== undefined && { compress: atom.appCompress }),
  };
  const payload = makeInspectPayload(expectedInput, globals);

  let exactStdout: string;
  if (atom.fwFlag === 'sort') {
    exactStdout = `${JSON.stringify(payload.items, null, json ? undefined : 2)}\n`;
  } else if (atom.fwFlag === 'table') {
    exactStdout = 'id     score\n-----  -----\nrow-1  7\n';
  } else {
    exactStdout = `${JSON.stringify(payload, null, json ? undefined : 2)}\n`;
  }

  let exactStderr = '';
  if (profile === 'managed-profile' && !quiet && atom.appProfile === undefined) {
    exactStderr += notice;
  }
  if (atom.fwFlag === 'output-dir' && !quiet) {
    exactStderr += '--output-dir: the result carries no files to save\n';
  }

  return {
    code: 0,
    stdoutKind: 'exact',
    exactStdout,
    exactStderr,
    handlerCalls: 1,
    resolveAuthCalls: 0,
    factoryCalls: 0,
    lastInput: expectedInput,
  };
}

function assertMatchesOracle(
  obs: RunObservation,
  oracle: OracleResult,
  hitRefusals: Set<string>,
  label: string,
): void {
  if (oracle.refusal !== undefined) {
    const rule = REFUSALS[oracle.refusal];
    hitRefusals.add(rule.id);
    if (obs.code === 0) {
      throw new Error(`Refusal row "${rule.id}" unexpectedly succeeded on ${label}`);
    }
    expect(obs.code).toBe(rule.code);
    expect(obs.stdout).toBe('');
    expect(obs.stderr).toContain(rule.stderrSubstring);
    expect(obs.handlerCalls).toBe(0);
    return;
  }

  // Not in REFUSALS → unexpected non-zero code (unless explicitly expected 4 for top-help filter miss).
  if (obs.code !== oracle.code) {
    throw new Error(
      `Unexpected exit code ${obs.code} (expected ${oracle.code}) on ${label}\nstderr: ${obs.stderr}\nstdout: ${obs.stdout}`,
    );
  }
  expect(obs.handlerCalls).toBe(oracle.handlerCalls);
  expect(obs.resolveAuthCalls).toBe(oracle.resolveAuthCalls);
  expect(obs.factoryCalls).toBe(oracle.factoryCalls);
  if (oracle.lastInput !== undefined) {
    expect(obs.lastInput).toEqual(oracle.lastInput);
  }
  if (oracle.exactStderr !== undefined) {
    expect(obs.stderr).toBe(oracle.exactStderr);
  }
  if (oracle.stdoutKind === 'exact') {
    expect(obs.stdout).toBe(oracle.exactStdout ?? '');
  } else if (oracle.stdoutKind === 'command-help') {
    expect(obs.stdout).toContain('Usage: fixture inspect');
    expect(obs.stdout).toContain('--verbose');
  } else if (oracle.stdoutKind === 'top-help') {
    expect(obs.stdout).toContain('fixture 1.0.0');
    expect(obs.stdout).toContain('inspect');
  } else if (oracle.stdoutKind === 'schema') {
    const doc = z
      .object({ command: z.string(), input: z.unknown(), output: z.unknown() })
      .parse(JSON.parse(obs.stdout));
    expect(doc.command).toBe('inspect');
    expect(doc.input).toBeDefined();
    expect(doc.output).toBeDefined();
  }
}

describe('CLI flag position permutation matrix (absolute oracle)', () => {
  test('all 4 profiles × all atom classes × all valid slots satisfy the absolute oracle and refusals table', async () => {
    const profileDir = makeProfileDir();
    const outDir = join(profileDir, 'out');
    const fwBoolAtoms = buildFrameworkBoolAtoms();
    const fwValueAtoms = buildFrameworkValueAtoms(outDir);
    const hitRefusals = new Set<string>();
    let checked = 0;

    for (const profile of PROFILES) {
      const slots: readonly Slot[] =
        profile === 'static-native-default'
          ? ['before-cmd', 'after-cmd', 'after-pos', 'no-cmd']
          : ['before-cmd', 'after-cmd', 'after-pos'];

      // 1. Framework booleans across all slots & representative positionals
      for (const atom of fwBoolAtoms) {
        const positionals =
          atom.bareFrameworkBool || atom.fwFlag === 'json' || atom.fwFlag === 'quiet'
            ? POSITIONAL_ATOMS
            : [POS_EMPTY, POS_HELLO];
        for (const slot of slots) {
          for (const pos of positionals) {
            // In `no-cmd` with defaultCommand, a bare non-flag positional like `hello` selects command `hello`.
            if (slot === 'no-cmd' && pos.tokens.length > 0) continue;
            // After-pos with bare boolean followed by nothing is adjacent-free; keep after-pos clean.
            const argv = buildArgv(slot, atom, pos);
            const oracle = computeOracle(profile, slot, atom, pos, profileDir);
            const obs = await runFixtureProfile(profile, argv, { profileDir });
            assertMatchesOracle(
              obs,
              oracle,
              hitRefusals,
              `${profile} ${slot} ${atom.id} pos=${pos.id} argv=${JSON.stringify(argv)}`,
            );
            checked++;
          }
        }
      }

      // 2. Framework value flags across all slots
      for (const atom of fwValueAtoms) {
        for (const slot of slots) {
          // A bare `--v` (no value) before `inspect` or before a positional takes that next token as its value;
          // test bare missing `--v` at the end of argv (`after-pos` / `no-cmd`) and `--v -x` in EVERY slot.
          if (
            atom.missingValue &&
            atom.tokens.length === 1 &&
            (slot === 'before-cmd' || slot === 'after-cmd')
          ) {
            continue;
          }
          const pos = slot === 'no-cmd' ? POS_EMPTY : POS_HELLO;
          const argv = buildArgv(slot, atom, pos);
          const oracle = computeOracle(profile, slot, atom, pos, profileDir);
          const obs = await runFixtureProfile(profile, argv, { profileDir });
          assertMatchesOracle(
            obs,
            oracle,
            hitRefusals,
            `${profile} ${slot} ${atom.id} argv=${JSON.stringify(argv)}`,
          );
          checked++;
        }
      }

      // 3. Application globals across all slots
      for (const atom of APP_GLOBAL_ATOMS) {
        for (const slot of slots) {
          const pos = slot === 'no-cmd' ? POS_EMPTY : POS_HELLO;
          const argv = buildArgv(slot, atom, pos);
          const oracle = computeOracle(profile, slot, atom, pos, profileDir);
          const obs = await runFixtureProfile(profile, argv, { profileDir });
          assertMatchesOracle(
            obs,
            oracle,
            hitRefusals,
            `${profile} ${slot} ${atom.id} argv=${JSON.stringify(argv)}`,
          );
          checked++;
        }
      }

      // 4. Command boolean fields + short alias across command slots
      const cmdSlots: readonly Slot[] =
        profile === 'static-native-default'
          ? ['after-cmd', 'after-pos', 'no-cmd']
          : ['after-cmd', 'after-pos'];
      for (const atom of CMD_BOOL_ATOMS) {
        for (const slot of cmdSlots) {
          const pos = slot === 'no-cmd' ? POS_EMPTY : POS_HELLO;
          const argv = buildArgv(slot, atom, pos);
          const oracle = computeOracle(profile, slot, atom, pos, profileDir);
          const obs = await runFixtureProfile(profile, argv, { profileDir });
          assertMatchesOracle(
            obs,
            oracle,
            hitRefusals,
            `${profile} ${slot} ${atom.id} argv=${JSON.stringify(argv)}`,
          );
          checked++;
        }
      }
    }

    // Also verify broken boolean boundary across an application global (`inspect --dry-run --profile prod false`).
    for (const profile of PROFILES) {
      const obs = await runFixtureProfile(
        profile,
        ['inspect', '--dry-run', '--profile', 'prod', 'false'],
        { profileDir },
      );
      assertMatchesOracle(
        obs,
        {
          refusal: 'broken-bool-boundary',
          code: 2,
          stdoutKind: 'exact',
          exactStdout: '',
          handlerCalls: 0,
          resolveAuthCalls: 0,
          factoryCalls: 0,
        },
        hitRefusals,
        `${profile} broken-boundary-app-global`,
      );
      checked++;
    }

    // Stripping a framework/app flag between a command flag and a subsequent token must never glue them together.
    for (const profile of PROFILES) {
      for (const argv of [
        ['inspect', '--verbose', '--json=true', 'false'],
        ['inspect', '-f', '--json=true', 'false'],
        ['inspect', '--verbose', '--profile', 'prod', 'false'],
      ]) {
        const obs = await runFixtureProfile(profile, argv, { profileDir });
        expect(obs.code).toBe(0);
        expect(obs.handlerCalls).toBe(1);
        expect(obs.lastInput).toEqual({ verbose: true, text: 'false' });
        checked++;
      }
      const missingVal = await runFixtureProfile(
        profile,
        ['inspect', '--text', '--json', 'hello'],
        { profileDir },
      );
      assertMatchesOracle(
        missingVal,
        {
          refusal: 'missing-value',
          code: 2,
          stdoutKind: 'exact',
          exactStdout: '',
          handlerCalls: 0,
          resolveAuthCalls: 0,
          factoryCalls: 0,
        },
        hitRefusals,
        `${profile} separated-value-flag`,
      );
      checked++;
    }

    // Verify value flag before command followed by another framework flag (`--sort --json inspect`) behaves identically with and without defaultCommand!
    for (const profile of PROFILES) {
      const obs = await runFixtureProfile(profile, ['--sort', '--json', 'inspect'], {
        profileDir,
      });
      assertMatchesOracle(
        obs,
        {
          refusal: 'missing-value',
          code: 2,
          stdoutKind: 'exact',
          exactStdout: '',
          handlerCalls: 0,
          resolveAuthCalls: 0,
          factoryCalls: 0,
        },
        hitRefusals,
        `${profile} --sort --json inspect`,
      );
      checked++;
    }

    expect(checked).toBeGreaterThan(350);
    // Every declared refusal row must have fired at least once (no dead/unexpectedly green refusal).
    expect([...hitRefusals].sort()).toEqual(Object.keys(REFUSALS).sort());
  }, 30_000);
});

async function spawnFixture(
  profile: CliProfileKind,
  argv: string[],
  profileDir: string,
  statsDir: string,
): Promise<RunObservation> {
  const statsFile = join(statsDir, `stats-${Math.random().toString(36).slice(2)}.json`);
  const entry = join(import.meta.dir, 'cli-flag-positions.entry.ts');
  const proc = Bun.spawn([process.execPath, '--no-env-file', entry, ...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      STITCHKIT_TEST_PROFILE: profile,
      STITCHKIT_TEST_PROFILE_DIR: profileDir,
      STITCHKIT_TEST_STATS_FILE: statsFile,
    },
  });
  trackProcess(proc.pid);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (!existsSync(statsFile)) {
    throw new Error(
      `Subprocess (${profile} ${JSON.stringify(argv)}) exited ${code} without writing stats.\nstderr: ${stderr}\nstdout: ${stdout}`,
    );
  }
  const stats = z
    .object({
      handlerCalls: z.number(),
      resolveAuthCalls: z.number(),
      factoryCalls: z.number(),
      lastInput: z.record(z.string(), z.unknown()).nullable(),
    })
    .parse(JSON.parse(readFileSync(statsFile, 'utf8')));
  return {
    code,
    stdout,
    stderr,
    handlerCalls: stats.handlerCalls,
    resolveAuthCalls: stats.resolveAuthCalls,
    factoryCalls: stats.factoryCalls,
    lastInput: stats.lastInput ?? undefined,
  };
}

describe('CLI flag positions subprocess lane (real process.argv via Bun.spawn)', () => {
  test('one point per profile and slot class matches the absolute oracle byte-for-byte', async () => {
    const profileDir = makeProfileDir();
    const statsDir = mkdtempSync(join(tmpdir(), 'stitchkit-flag-stats-'));
    tempDirs.push(statsDir);
    const notice = expectedProfileNotice(profileDir);

    const cases: Array<{
      label: string;
      profile: CliProfileKind;
      argv: string[];
      expectedCode: number;
      expectedStdout: string;
      expectedStderr: string;
      expectedCalls: number;
      expectedInput?: Record<string, unknown>;
    }> = [
      // static-native: before-cmd, after-cmd, after-pos
      {
        label: 'static-native before-cmd',
        profile: 'static-native',
        argv: ['--json', 'inspect', 'hello'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'static-native after-cmd',
        profile: 'static-native',
        argv: ['inspect', '--json', 'hello'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'static-native after-pos',
        profile: 'static-native',
        argv: ['inspect', 'hello', '--json'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      // static-native-default: no-cmd, before-cmd, after-cmd, after-pos
      {
        label: 'static-native-default no-cmd',
        profile: 'static-native-default',
        argv: ['--json', '--verbose'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ verbose: true }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { verbose: true },
      },
      {
        label: 'static-native-default before-cmd',
        profile: 'static-native-default',
        argv: ['--json', 'inspect', 'hello'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'static-native-default after-cmd',
        profile: 'static-native-default',
        argv: ['inspect', '--json', 'hello'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'static-native-default after-pos',
        profile: 'static-native-default',
        argv: ['inspect', 'hello', '--json'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      // managed-factory: before-cmd (former transitional refusal now succeeds!), after-cmd, after-pos
      {
        label: 'managed-factory before-cmd (leading flag before native)',
        profile: 'managed-factory',
        argv: ['--json', 'inspect', 'hello'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'managed-factory after-cmd',
        profile: 'managed-factory',
        argv: ['inspect', '--json', 'hello'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'managed-factory after-pos',
        profile: 'managed-factory',
        argv: ['inspect', 'hello', '--json'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, {}))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      // managed-profile: real process.argv quiet suppression across before-cmd/after-cmd/after-pos, loud notice & --quiet=maybe before notice
      {
        label: 'managed-profile before-cmd with --quiet suppresses early profile notice',
        profile: 'managed-profile',
        argv: ['--quiet', '--json', 'inspect', 'hello'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, { profile: 'prod' }))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'managed-profile after-cmd with --quiet suppresses early profile notice',
        profile: 'managed-profile',
        argv: ['inspect', '--quiet', '--json', 'hello'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, { profile: 'prod' }))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'managed-profile after-pos with --quiet suppresses early profile notice',
        profile: 'managed-profile',
        argv: ['inspect', 'hello', '--quiet', '--json'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, { profile: 'prod' }))}\n`,
        expectedStderr: '',
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'managed-profile without --quiet emits exact profile notice',
        profile: 'managed-profile',
        argv: ['inspect', 'hello', '--json'],
        expectedCode: 0,
        expectedStdout: `${JSON.stringify(makeInspectPayload({ text: 'hello' }, { profile: 'prod' }))}\n`,
        expectedStderr: notice,
        expectedCalls: 1,
        expectedInput: { text: 'hello' },
      },
      {
        label: 'managed-profile --quiet=maybe refuses before profile notice',
        profile: 'managed-profile',
        argv: ['--quiet=maybe', 'inspect'],
        expectedCode: 2,
        expectedStdout: '',
        expectedStderr: '--quiet expects a boolean (true/false), got "maybe"\n',
        expectedCalls: 0,
      },
    ];

    for (const c of cases) {
      const obs = await spawnFixture(c.profile, c.argv, profileDir, statsDir);
      expect(obs.code).toBe(c.expectedCode);
      expect(obs.stdout).toBe(c.expectedStdout);
      expect(obs.stderr).toBe(c.expectedStderr);
      expect(obs.handlerCalls).toBe(c.expectedCalls);
      expect(obs.resolveAuthCalls).toBe(0);
      expect(obs.factoryCalls).toBe(0);
      if (c.expectedInput !== undefined) expect(obs.lastInput).toEqual(c.expectedInput);
    }
  }, 30_000);
});
