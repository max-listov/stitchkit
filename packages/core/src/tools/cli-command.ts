import type { ZodObject, ZodType, z } from 'zod';
import { formatZodError, validateDeclaredOutput } from '../internal/errors';
import type { CliRunOptions } from './cli-args';
import type { CliWriters } from './cli-format';
import { coerceJsonArgs } from './coerce';
import { type ToolResult, toolResultFromError } from './execute';
import { buildToolPresentationSchema } from './presentation';

export interface CliCommandContext<TInput extends ZodObject> extends CliWriters {
  input: z.output<TInput>;
  options: Readonly<CliRunOptions>;
}

export interface CliCommandDefinitionBase<TInput extends ZodObject> {
  name: string;
  description: string;
  input: TInput;
}

export interface CliCommandDefinitionWithOutput<
  TInput extends ZodObject,
  TOutput extends ZodType,
> extends CliCommandDefinitionBase<TInput> {
  output: TOutput;
  handler: (
    context: CliCommandContext<TInput>,
  ) => z.output<TOutput> | Promise<z.output<TOutput>>;
  /** Pure post-validation stdout presentation; returned bytes are written verbatim once. */
  present?: (context: {
    result: z.output<TOutput>;
    options: Readonly<CliRunOptions>;
  }) => string;
  /** Process exit code for a successfully validated result. */
  exitCode?: (result: z.output<TOutput>) => number;
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

export interface PreparedCliCommandEmission {
  result: ToolResult;
  presentation?: string;
  successExitCode: number;
}

/** Apply native-only presentation policy after canonical output validation. */
export function prepareCliCommandEmission(
  definition: CliCommandDefinition,
  result: ToolResult,
  options: Readonly<CliRunOptions>,
): PreparedCliCommandEmission {
  if (!result.ok || definition.output === undefined) {
    return { result, successExitCode: 0 };
  }
  try {
    const successExitCode = definition.exitCode?.(result.data) ?? 0;
    if (
      !Number.isSafeInteger(successExitCode) ||
      successExitCode < 0 ||
      successExitCode > 255
    ) {
      throw new Error('CLI success exit code must be an integer from 0 to 255');
    }
    const presentation = definition.present?.({ result: result.data, options });
    if (presentation !== undefined && typeof presentation !== 'string') {
      throw new Error('CLI result presenter must return a string');
    }
    return { result, presentation, successExitCode };
  } catch (error) {
    return {
      result: toolResultFromError(new Error('CLI result policy failed', { cause: error })),
      successExitCode: 0,
    };
  }
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
