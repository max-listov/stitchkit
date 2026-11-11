import type { ZodObject, ZodType, z } from 'zod';
import { validateDeclaredOutput } from '../../contract/normalize';
import { formatZodError } from '../../internal/zod-issues';
import { type ToolFailure, type ToolResult, toolResultFromError } from '../execute-result';
import { coerceJsonArgs } from '../schema/coerce';
import { buildToolPresentationSchema } from '../schema/presentation';
import type { CliRunOptions } from './args';
import {
  type CliWriters,
  type EmitOptions,
  emitPresentationFailure,
  emitResult,
} from './format';

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
 * managed command (`CliConfig.results`), so a result is printed and exit-coded
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
 */
export function emitCliCommandResult(
  policy: CliResultPolicy<unknown> | undefined,
  result: ToolResult,
  options: Readonly<CliRunOptions>,
  writers: CliWriters,
  emit: EmitOptions & { repeatable: boolean },
): number {
  const emission = prepareCliCommandEmission(policy, result, options);
  if (emission.result.ok && emission.presentationFailure !== undefined) {
    return emitPresentationFailure(
      emission.result,
      emission.presentationFailure,
      writers,
      emit,
    );
  }
  if (emission.result.ok && emission.presentation !== undefined) {
    writers.stdout(emission.presentation);
    return emission.successExitCode;
  }
  const emitted = emitResult(emission.result, writers, emit);
  return emission.result.ok ? emission.successExitCode : emitted;
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
