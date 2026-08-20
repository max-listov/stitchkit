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
}

export interface CliCommandDefinitionWithoutOutput<TInput extends ZodObject>
  extends CliCommandDefinitionBase<TInput> {
  output?: never;
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
