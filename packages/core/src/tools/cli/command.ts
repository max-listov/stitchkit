import type { ZodObject, ZodType, z } from 'zod';
import { validateDeclaredOutput } from '../../contract/normalize';
import { formatZodError } from '../../internal/zod-issues';
import type { ErrorHintFn } from '../execute-hooks';
import {
  type ToolFailure,
  type ToolResult,
  toolErrorFromResult,
  toolResultFromError,
} from '../execute-result';
import { projectJsonSafe } from '../internal/json-projection';
import { coerceJsonArgs } from '../schema/coerce';
import { buildToolPresentationSchema } from '../schema/presentation';
import type { CliRunOptions } from './args';
import { CliArgumentError } from './argument-error';
import {
  type CliWriters,
  cliExitCode,
  type EmitOptions,
  type ExitCodeMap,
  emitPresentationFailure,
  emitResult,
} from './format';
import { renderCliView, stringifyGroups } from './view';
import { assertViewColumns } from './view-columns';

export interface CliCommandContext<TInput extends ZodObject> extends CliWriters {
  input: z.output<TInput>;
  options: Readonly<CliRunOptions>;
  /**
   * The application's own global options for this invocation, already validated
   * against `CliConfig.globalOptions`. Empty when the CLI declares none. Typed
   * loosely because a command is defined independently of the CLI it is mounted
   * on — read it through the same schema the application declared.
   */
  globals: Readonly<Record<string, unknown>>;
}

export interface CliCommandDefinitionBase<TInput extends ZodObject> {
  name: string;
  description: string;
  input: TInput;
}

/**
 * How a successfully validated result leaves the process: its stdout bytes and
 * its exit code. One shape for a native command (`defineCliCommand`) and for a
 * managed command (`CliConfig.commandSettings`), so a result is printed and exit-coded
 * by one rule whichever way the command was declared.
 */
export interface CliResultPolicy<TResult> {
  // Method signatures on purpose: a policy typed against its own schema is held
  // by a CLI that knows only "some validated result", and methods are what let
  // the precise declaration stand where the general one is expected.
  /** Pure post-validation stdout presentation; returned bytes are written verbatim once. */
  present?(context: { result: TResult; options: Readonly<CliRunOptions> }): string;
  /** Process exit code for a successfully validated result. */
  exitCode?(result: TResult): number;
  /** The schema the policy is typed against; a managed command checks it is its own. */
  output?: ZodType;
}

/**
 * Type a managed command's result policy against the schema its operation
 * returns. Pass the very schema the contract declares: the CLI refuses at
 * startup a policy whose schema is not the one its command answers with, so a
 * policy cannot be mounted on a command whose result it does not describe.
 */
export function defineCliResult<TOutput extends ZodType>(
  output: TOutput,
  policy: Pick<CliResultPolicy<z.output<TOutput>>, 'present' | 'exitCode'>,
): CliResultPolicy<z.output<TOutput>> {
  return { ...policy, output };
}

export interface CliCommandDefinitionWithOutput<
  TInput extends ZodObject,
  TOutput extends ZodType,
> extends CliCommandDefinitionBase<TInput>,
    CliResultPolicy<z.output<TOutput>> {
  output: TOutput;
  handler: (
    context: CliCommandContext<TInput>,
  ) => z.output<TOutput> | Promise<z.output<TOutput>>;
}

export interface CliCommandDefinitionWithoutOutput<TInput extends ZodObject>
  extends CliCommandDefinitionBase<TInput> {
  output?: never;
  present?: never;
  exitCode?: never;
  handler: (context: CliCommandContext<TInput>) => void | Promise<void>;
}

export type CliCommandDefinition =
  | CliCommandDefinitionWithOutput<ZodObject, ZodType>
  | CliCommandDefinitionWithoutOutput<ZodObject>;

/** Typed identity helper for one transport-local executable command. */
export function defineCliCommand<TInput extends ZodObject, TOutput extends ZodType>(
  definition: CliCommandDefinitionWithOutput<TInput, TOutput>,
): CliCommandDefinitionWithOutput<TInput, TOutput>;
export function defineCliCommand<TInput extends ZodObject>(
  definition: CliCommandDefinitionWithoutOutput<TInput>,
): CliCommandDefinitionWithoutOutput<TInput>;
export function defineCliCommand(definition: CliCommandDefinition): CliCommandDefinition {
  return definition;
}

interface PreparedCliCommandEmission {
  result: ToolResult;
  presentation?: string;
  presentationFailure?: ToolFailure;
  successExitCode: number;
}

/**
 * Whether a native command yields a value at all.
 *
 * The two halves of `CliCommandDefinition` are not the same kind of thing: one
 * returns a validated result and lets the frame print it, the other prints
 * itself and returns nothing. Only the first can be executed somewhere that has
 * no stdout to print to — an in-process invocation, a stream of JSON lines —
 * and this is the test that decides it.
 */
export function cliCommandReturnsResult(
  definition: CliCommandDefinition,
): definition is CliCommandDefinitionWithOutput<ZodObject, ZodType> {
  return definition.output !== undefined;
}

/**
 * The exit code a successful result earns, or a throw naming the offence.
 *
 * Shared, because a command run in process must exit-code identically to the
 * same command typed at a prompt; two copies of this rule would eventually
 * disagree and the divergence would show up as a script that branches wrong.
 */
export function cliCommandSuccessExitCode(
  policy: CliResultPolicy<unknown> | undefined,
  data: unknown,
): number {
  const successExitCode = policy?.exitCode?.(data) ?? 0;
  if (!Number.isSafeInteger(successExitCode) || successExitCode < 0 || successExitCode > 255) {
    throw new Error('CLI success exit code must be an integer from 0 to 255');
  }
  return successExitCode;
}

/** The result policy a native command declares; a printing command has none. */
export function cliCommandResultPolicy(
  definition: CliCommandDefinition,
): CliResultPolicy<unknown> | undefined {
  return cliCommandReturnsResult(definition) ? definition : undefined;
}

/** Apply a command's result policy after canonical output validation. */
function prepareCliCommandEmission(
  policy: CliResultPolicy<unknown> | undefined,
  result: ToolResult,
  options: Readonly<CliRunOptions>,
): PreparedCliCommandEmission {
  if (!result.ok || policy === undefined) {
    return { result, successExitCode: 0 };
  }
  let successExitCode: number;
  try {
    successExitCode = cliCommandSuccessExitCode(policy, result.data);
  } catch (error) {
    return {
      result: toolResultFromError(new Error('CLI result policy failed', { cause: error })),
      successExitCode: 0,
    };
  }
  try {
    if (policy.present === undefined) return { result, successExitCode };
    const presentation = policy.present({ result: result.data, options });
    if (typeof presentation !== 'string') {
      throw new Error('CLI result presenter must return a string');
    }
    return { result, presentation, successExitCode };
  } catch (error) {
    return {
      result,
      presentationFailure: toolResultFromError(
        new Error('CLI result presentation failed', { cause: error }),
      ),
      successExitCode,
    };
  }
}

/**
 * Print one result under its command's policy and return the process exit code.
 *
 * The single place a policy meets the terminal: a native command and a managed
 * one answer through it, so `present`, `exitCode` and a failed presentation
 * behave identically on both.
 *
 * The policy judges `result`, the operation's own answer. `shown` is what stdout
 * prints when the policy brings no presenter: the same answer, unless the caller
 * has already moved part of it elsewhere (a view, media saved to files).
 */
export function emitCliCommandResult(
  policy: CliResultPolicy<unknown> | undefined,
  result: ToolResult,
  options: Readonly<CliRunOptions>,
  writers: CliWriters,
  emit: EmitOptions & { repeatable: boolean },
  shown?: Extract<ToolResult, { ok: true }>,
): number {
  const emission = prepareCliCommandEmission(policy, result, options);
  if (!emission.result.ok) return emitResult(emission.result, writers, emit);
  if (emission.presentation !== undefined) {
    writers.stdout(emission.presentation);
    return emission.successExitCode;
  }
  const printed = shown ?? emission.result;
  if (emission.presentationFailure !== undefined) {
    return emitPresentationFailure(printed, emission.presentationFailure, writers, emit);
  }
  emitResult(printed, writers, emit);
  return emission.successExitCode;
}

export function cliCommandPresentationSchema(
  definition: CliCommandDefinition,
): Record<string, unknown> {
  return buildToolPresentationSchema({
    inputSchema: definition.input,
    unrepresentable: 'any',
  });
}

/** Execute a CLI-only definition without inventing a tool operation identity. */
export async function executeCliCommand(
  definition: CliCommandDefinition,
  rawArgs: Record<string, unknown>,
  options: CliRunOptions,
  writers: CliWriters,
  coerceJson: boolean,
  globals: Readonly<Record<string, unknown>> = {},
): Promise<ToolResult> {
  let parsed: ReturnType<typeof definition.input.safeParse>;
  try {
    parsed = definition.input.safeParse(
      coerceJson ? coerceJsonArgs(rawArgs, definition.input) : rawArgs,
    );
  } catch (error) {
    return toolResultFromError(error);
  }
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: `Invalid input: ${formatZodError(parsed.error)}` },
    };
  }

  try {
    const data: unknown = await definition.handler({
      input: parsed.data,
      options,
      globals,
      ...writers,
    });
    const checked = validateDeclaredOutput(definition.output, data);
    if (!checked.ok) {
      return {
        ok: false,
        code: 'INTERNAL_SERVER_ERROR',
        details: { message: checked.message },
      };
    }
    return { ok: true, data: checked.data };
  } catch (error) {
    return toolResultFromError(error);
  }
}

/**
 * Apply an optional aggregate/table/sort view to a successful result, then emit
 * under `policy` and return the process exit code. Shared by managed and native
 * terminal execution paths.
 */
export function emitCliViewOrResult(
  policy: CliResultPolicy<unknown> | undefined,
  result: ToolResult,
  options: Readonly<CliRunOptions>,
  writers: CliWriters,
  emit: EmitOptions & { repeatable: boolean },
  initialShown?: Extract<ToolResult, { ok: true }>,
  mediaExitCode = 0,
): number {
  if (!result.ok) return emitResult(result, writers, emit);
  let shown = initialShown ?? result;
  if (options.view) {
    let viewed: ReturnType<typeof renderCliView>;
    try {
      viewed = renderCliView(shown.data, options.view);
    } catch (error) {
      const failure: ToolFailure =
        error instanceof CliArgumentError
          ? { ok: false, code: 'BAD_REQUEST', details: { message: error.message } }
          : toolResultFromError(error);
      return emitPresentationFailure(shown, failure, writers, emit);
    }
    if (viewed.kind === 'text') {
      writers.stdout(viewed.text);
      return mediaExitCode;
    }
    if (viewed.order) {
      writers.stdout(`${stringifyGroups(viewed.data, viewed.order, options.json === true)}\n`);
      return mediaExitCode;
    }
    shown = { ...shown, data: viewed.data };
  }
  const activePolicy = options.view === undefined && !options.wait ? policy : undefined;
  const exitCode = emitCliCommandResult(activePolicy, result, options, writers, emit, shown);
  return mediaExitCode || exitCode;
}

const IN_PROCESS_RUN_OPTIONS: Readonly<CliRunOptions> = Object.freeze({
  json: false,
  wait: false,
  quiet: true,
  dryRun: false,
  help: false,
  schema: false,
});

export interface NativeTerminalExecution {
  mode: 'terminal';
  options: CliRunOptions;
  writers: CliWriters;
  emit: EmitOptions & { repeatable: boolean };
}

export interface NativeInProcessExecution {
  mode: 'in-process';
  errorHint?: ErrorHintFn;
  exitCodes?: ExitCodeMap;
}

export interface NativeInvocationOutcome {
  ok: boolean;
  exitCode: number;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    hint?: string;
    retryable?: boolean;
  };
  written?: { stdout?: string; stderr?: string };
}

/** Shape a `ToolResult` into an invocation result without writing to stdout/stderr. */
export function shapeCliInvocationResult(
  result: ToolResult,
  toolName: string,
  config: { errorHint?: ErrorHintFn; exitCodes?: ExitCodeMap },
  policy?: CliResultPolicy<unknown>,
): NativeInvocationOutcome {
  if (!result.ok) {
    const normalized = toolErrorFromResult(result);
    const hints: string[] = [];
    if (result.hint) hints.push(result.hint);
    const global = config.errorHint?.(toolName, result.code);
    if (global) hints.push(global);
    return {
      ok: false,
      exitCode: cliExitCode(result, config.exitCodes),
      error: {
        code: result.code,
        message: normalized.message,
        ...(result.details !== undefined && { details: result.details }),
        ...(hints.length > 0 && { hint: hints.join(' ') }),
        ...(result.retryable !== undefined && { retryable: result.retryable }),
      },
    };
  }
  const data = result.data === undefined ? undefined : projectJsonSafe(result.data).value;
  if (policy === undefined) return { ok: true, exitCode: 0, data };
  try {
    return {
      ok: true,
      exitCode: cliCommandSuccessExitCode(policy, result.data),
      data,
    };
  } catch (error) {
    return shapeCliInvocationResult(
      toolResultFromError(new Error('CLI result policy failed', { cause: error })),
      toolName,
      config,
    );
  }
}

/**
 * Single execution path for native CLI commands across terminal (`createCli`)
 * and in-process (`createCliInvoker`) callers.
 *
 * Terminal invocations validate view compatibility before running the handler:
 * a native command without `output` refuses view flags with exit code 2, and a
 * command with an unambiguous collection `output` checks requested columns first.
 */
export async function executeNativeCommand(
  definition: CliCommandDefinition,
  rawArgs: Record<string, unknown>,
  coerceJson: boolean,
  globals: Readonly<Record<string, unknown>>,
  target: NativeTerminalExecution,
): Promise<number>;
export async function executeNativeCommand(
  definition: CliCommandDefinition,
  rawArgs: Record<string, unknown>,
  coerceJson: boolean,
  globals: Readonly<Record<string, unknown>>,
  target: NativeInProcessExecution,
): Promise<NativeInvocationOutcome>;
export async function executeNativeCommand(
  definition: CliCommandDefinition,
  rawArgs: Record<string, unknown>,
  coerceJson: boolean,
  globals: Readonly<Record<string, unknown>>,
  target: NativeTerminalExecution | NativeInProcessExecution,
): Promise<number | NativeInvocationOutcome> {
  if (target.mode === 'terminal') {
    if (target.options.view !== undefined) {
      if (!cliCommandReturnsResult(definition)) {
        target.writers.stderr(
          `aggregate views do not apply to native command "${definition.name}" without an output schema\n`,
        );
        return 2;
      }
      try {
        assertViewColumns(target.options.view, definition.output);
      } catch (error) {
        if (!(error instanceof CliArgumentError)) throw error;
        target.writers.stderr(`${error.message}\n`);
        return 2;
      }
    }
    const result = await executeCliCommand(
      definition,
      rawArgs,
      target.options,
      target.writers,
      coerceJson,
      globals,
    );
    return emitCliViewOrResult(
      cliCommandResultPolicy(definition),
      result,
      target.options,
      target.writers,
      target.emit,
    );
  }

  let out = '';
  let err = '';
  const result = await executeCliCommand(
    definition,
    rawArgs,
    IN_PROCESS_RUN_OPTIONS,
    {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    coerceJson,
    globals,
  );
  const invocation = shapeCliInvocationResult(
    result,
    definition.name,
    target,
    cliCommandResultPolicy(definition),
  );
  if (out === '' && err === '') return invocation;
  return {
    ...invocation,
    written: { ...(out !== '' && { stdout: out }), ...(err !== '' && { stderr: err }) },
  };
}
