/**
 * A tool call's arguments, split and validated exactly as the call does it:
 * path params and body keys are disjoint slices, each parsed by its own schema.
 */
import { isUnsafeKey } from '../internal/safe-json';
import { formatZodError } from '../internal/zod-issues';
import type { ToolExecutionOptions, ToolOperation } from './execute';
import { applyToolViewDefaults } from './internal/tool-view';
import { coerceJsonArgs } from './schema/coerce';
import { objectShapeKeys } from './schema/schema';

/** What one tool call's arguments parse to — or why they did not. */
export type ParsedToolCallArguments =
  | { ok: true; params: unknown; input: unknown }
  | { ok: false; message: string; thrown?: unknown };

/**
 * Split and validate a flat tool-argument object exactly as a call does.
 *
 * Exported so the ONE thing that needs the parsed value without running the
 * call — an elicitation resolver choosing this call's questions — gets the same
 * value the handler will get, rather than a second parse written beside this
 * one that drifts on the next coercion change. It is pure: no lifecycle, no
 * hooks, no audit row, so asking what the arguments mean costs nothing that a
 * gate would charge for.
 */
export function parseToolCallArguments(
  method: ToolOperation,
  callArgs: Record<string, unknown>,
  {
    coerceJson = false,
    toolSurface = false,
  }: Pick<ToolExecutionOptions, 'coerceJson' | 'toolSurface'> = {},
): ParsedToolCallArguments {
  // Slice the flat tool args the way the HTTP transport slices a request: path
  // params and body/query are disjoint sets of keys. Parsing each schema over
  // only its own slice keeps a `.strict()` schema working as a tool, exactly
  // as it works on HTTP — a single flat blob parsed against both would reject
  // every call once either schema is strict.
  const paramKeys = new Set(objectShapeKeys(method.paramsSchema));
  let paramArgs: Record<string, unknown> = {};
  let inputArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(callArgs)) {
    // A tool arg named `__proto__` would pollute the prototype chain.
    if (isUnsafeKey(key)) continue;
    if (paramKeys.has(key)) paramArgs[key] = value;
    else inputArgs[key] = value;
  }

  // Coerce JSON-stringified array/object args (LLM double-serialization).
  if (coerceJson) {
    paramArgs = coerceJsonArgs(paramArgs, method.paramsSchema);
    inputArgs = coerceJsonArgs(inputArgs, method.inputSchema);
  }

  // The view's defaults join the arguments before the one parse, so the
  // handler receives an ordinary `input` value. → ADR 0196.
  if (toolSurface) inputArgs = applyToolViewDefaults(inputArgs, method.toolView?.defaults);

  let params: unknown;
  if (method.paramsSchema) {
    let result: ReturnType<typeof method.paramsSchema.safeParse>;
    try {
      result = method.paramsSchema.safeParse(paramArgs);
    } catch (err) {
      return { ok: false, message: 'Invalid params', thrown: err };
    }
    if (!result.success) {
      return { ok: false, message: `Invalid params: ${formatZodError(result.error)}` };
    }
    params = result.data;
  }

  let input: unknown;
  if (method.inputSchema) {
    let result: ReturnType<typeof method.inputSchema.safeParse>;
    try {
      result = method.inputSchema.safeParse(inputArgs);
    } catch (err) {
      return { ok: false, message: 'Invalid input', thrown: err };
    }
    if (!result.success) {
      return { ok: false, message: `Invalid input: ${formatZodError(result.error)}` };
    }
    input = result.data;
  }
  return { ok: true, params, input };
}
