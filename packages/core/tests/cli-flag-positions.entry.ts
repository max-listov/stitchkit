/**
 * Shared CLI profiles fixture used both in-process and via `Bun.spawn` with
 * real `process.argv` by `cli-flag-positions.test.ts`.
 */
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  CliArgumentError,
  createCli,
  createCliProfileStore,
  defineCliCommand,
  extractCliGlobalOptions,
  scanCliInvocation,
} from '../src/entrypoints/cli';
import { withCliNotices } from '../src/tools/cli/notices';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

export type CliProfileKind =
  | 'static-native'
  | 'static-native-default'
  | 'managed-factory'
  | 'managed-profile';

export const APP_GLOBALS = z.object({
  profile: z.string().optional(),
  compress: z.boolean().optional(),
});

export const INSPECT_INPUT = z.object({
  text: z.string().optional(),
  verbose: z.boolean().optional(),
});

export const INSPECT_OUTPUT = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      score: z.number(),
      text: z.string().optional(),
      verbose: z.boolean().optional(),
      profile: z.string().optional(),
      compress: z.boolean().optional(),
    }),
  ),
});

export interface RunObservation {
  code: number;
  stdout: string;
  stderr: string;
  handlerCalls: number;
  resolveAuthCalls: number;
  factoryCalls: number;
  lastInput: Record<string, unknown> | undefined;
}

export function createFixtureProfileStore(directory: string) {
  return createCliProfileStore({
    directory,
    schema: z.object({ url: z.url(), token: z.string().min(1) }),
  });
}

export function expectedProfileNotice(directory: string): string {
  const file = `${directory}/prod.json`;
  return `[prod] using the only configured profile (${file})\n`;
}

export function makeInspectPayload(
  input: z.output<typeof INSPECT_INPUT>,
  globals: { profile?: string; compress?: boolean },
) {
  return {
    items: [
      {
        id: 'row-1',
        score: 7,
        ...(input.text !== undefined && { text: input.text }),
        ...(input.verbose !== undefined && { verbose: input.verbose }),
        ...(globals.profile !== undefined && { profile: globals.profile }),
        ...(globals.compress !== undefined && { compress: globals.compress }),
      },
    ],
  };
}

export async function runFixtureProfile(
  profile: CliProfileKind,
  argv: string[] | undefined,
  options: {
    profileDir?: string;
    capture?: boolean;
  } = {},
): Promise<RunObservation> {
  let code = -1;
  let stdout = '';
  let stderr = '';
  let handlerCalls = 0;
  let resolveAuthCalls = 0;
  let factoryCalls = 0;
  let lastInput: Record<string, unknown> | undefined;

  const writeOut = (text: string): void => {
    if (options.capture === false) process.stdout.write(text);
    else stdout += text;
  };
  const writeErr = (text: string): void => {
    if (options.capture === false) process.stderr.write(text);
    else stderr += text;
  };
  const setExit = (value: number): void => {
    code = value;
  };

  const inspectNative = defineCliCommand({
    name: 'inspect',
    description: 'Inspect arguments and flags',
    input: INSPECT_INPUT,
    output: INSPECT_OUTPUT,
    handler: ({ input, globals }) => {
      handlerCalls++;
      lastInput = { ...input };
      const parsed = APP_GLOBALS.parse(globals);
      return makeInspectPayload(input, parsed);
    },
  });

  const makeManagedInspect = (resolvedProfile?: string) =>
    defineRuntimeTool({
      name: 'inspect',
      description: 'Inspect arguments and flags',
      identity: { serviceName: 'fixture', action: 'inspect', method: 'GET' },
      expose: ['CLI'],
      input: INSPECT_INPUT,
      output: INSPECT_OUTPUT,
      handler: ({ input, ...rest }) => {
        handlerCalls++;
        lastInput = { ...input };
        const ctxGlobals =
          'globals' in rest && typeof rest.globals === 'object' && rest.globals !== null
            ? APP_GLOBALS.parse(rest.globals)
            : {};
        return makeInspectPayload(input, {
          ...ctxGlobals,
          ...(resolvedProfile !== undefined &&
            ctxGlobals.profile === undefined && { profile: resolvedProfile }),
        });
      },
    });

  const pollStatus = defineRuntimeTool({
    name: 'inspect_status',
    description: 'Poll status',
    identity: { serviceName: 'fixture', action: 'status', method: 'GET' },
    expose: ['CLI'],
    input: z.object({}),
    output: INSPECT_OUTPUT,
    handler: () => makeInspectPayload({}, {}),
  });

  const common = {
    name: 'fixture',
    version: '1.0.0',
    globalOptions: APP_GLOBALS,
    commandSettings: { inspect: { aliases: { f: 'verbose' } } },
    ...(argv !== undefined && { argv }),
    stdin: async () => null,
    stdout: writeOut,
    stderr: writeErr,
    exit: setExit,
  };

  if (profile === 'static-native') {
    await createCli({ ...common, commands: [inspectNative] });
  } else if (profile === 'static-native-default') {
    await createCli({ ...common, defaultCommand: 'inspect', commands: [inspectNative] });
  } else if (profile === 'managed-factory') {
    await createCli({
      ...common,
      access: { open: 'local-operator' },
      commands: [inspectNative],
      resolveAuth: (globals) => {
        resolveAuthCalls++;
        return globals.profile ?? 'default';
      },
      runtimeTools: () => {
        factoryCalls++;
        return [pollStatus];
      },
    });
  } else {
    // Managed array with profile resolution BEFORE createCli (uses real process.argv when argv is omitted).
    const rawArgv = argv ?? process.argv.slice(2);
    let selectedProfile: string | undefined;
    try {
      const lifted = extractCliGlobalOptions(rawArgv, APP_GLOBALS);
      const requested =
        typeof lifted.globals.profile === 'string' ? lifted.globals.profile : undefined;
      if (options.profileDir !== undefined) {
        const store = createFixtureProfileStore(options.profileDir);
        if (options.capture === false) {
          // Subprocess path: exercises notices.ts reading real process.argv via scanCliInvocation.
          selectedProfile = store.resolve(requested).name;
        } else {
          // In-process path: mirrors notices.ts (suppresses notice on invalid framework flags).
          let suppress = false;
          try {
            suppress = scanCliInvocation(rawArgv, { appGlobals: APP_GLOBALS }).framework.quiet;
          } catch (error) {
            if (error instanceof CliArgumentError) suppress = true;
            else throw error;
          }
          selectedProfile = withCliNotices(
            suppress,
            writeErr,
            () => store.resolve(requested).name,
          );
        }
      }
    } catch (error) {
      if (error instanceof CliArgumentError) {
        writeErr(`${error.message}\n`);
        setExit(2);
        return {
          code,
          stdout,
          stderr,
          handlerCalls,
          resolveAuthCalls,
          factoryCalls,
          lastInput,
        };
      }
      throw error;
    }
    await createCli({
      ...common,
      access: { open: 'local-operator' },
      context: (_auth, globals) => ({ globals }),
      runtimeTools: [makeManagedInspect(selectedProfile), pollStatus],
      commandSettings: {
        inspect: {
          aliases: { f: 'verbose' },
          wait: {
            tool: 'inspect_status',
            poll: () => ({}),
            done: () => true,
          },
        },
      },
    });
  }

  return { code, stdout, stderr, handlerCalls, resolveAuthCalls, factoryCalls, lastInput };
}

if (import.meta.main) {
  const profileEnv = process.env.STITCHKIT_TEST_PROFILE;
  const profileDir = process.env.STITCHKIT_TEST_PROFILE_DIR;
  const statsFile = process.env.STITCHKIT_TEST_STATS_FILE;
  if (
    profileEnv !== 'static-native' &&
    profileEnv !== 'static-native-default' &&
    profileEnv !== 'managed-factory' &&
    profileEnv !== 'managed-profile'
  ) {
    throw new Error(`Invalid STITCHKIT_TEST_PROFILE: ${String(profileEnv)}`);
  }
  const observation = await runFixtureProfile(profileEnv, undefined, {
    profileDir,
    capture: false,
  });
  if (statsFile !== undefined) {
    writeFileSync(
      statsFile,
      JSON.stringify({
        handlerCalls: observation.handlerCalls,
        resolveAuthCalls: observation.resolveAuthCalls,
        factoryCalls: observation.factoryCalls,
        lastInput: observation.lastInput ?? null,
      }),
    );
  }
  process.exit(observation.code >= 0 ? observation.code : 1);
}
