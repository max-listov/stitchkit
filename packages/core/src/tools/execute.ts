import type { RuntimeContext, TransportSource } from '../contract';
import { formatZodError, normalizeError, validateHandlerOutput } from '../internal/errors';
import { isUnsafeKey } from '../internal/safe-json';
import type { MethodDef } from '../server/types';
import { coerceJsonArgs } from './coerce';
import { objectShapeKeys } from './schema';

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; details?: unknown; hint?: string };

export interface ToolCallContext {
  source: TransportSource;
  [key: string]: unknown;
}

export interface ToolCallHooks {
  beforeToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ) => void | Promise<void>;
  afterToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    durationMs: number,
    context: ToolCallContext,
  ) => void | Promise<void>;
}

/**
 * The tool-side twin of the HTTP server's `beforeHandle` / `afterHandle`. A
 * tool call runs the same handler an HTTP request would — `ToolLifecycle` makes
 * it run the same gate. Pass a `createAuthHook` result as `beforeHandle` here
 * and tools are scope-guarded exactly as HTTP routes are; without it a tool
 * call bypasses the auth a `createServer` `beforeHandle` enforces.
 *
 * Structurally a subset of `LifecycleHooks` — the same hook object used for
 * `createServer({ hooks })` is assignable here.
 */
export interface ToolLifecycle {
  /** Auth / scope gate — throw to reject the call. */
  beforeHandle?: (ctx: RuntimeContext, endpoint: MethodDef) => void | Promise<void>;
  /** Transform the handler result before it is returned. */
  afterHandle?: (
    ctx: RuntimeContext,
    result: unknown,
    endpoint: MethodDef,
  ) => unknown | Promise<unknown>;
}

/**
 * Normalise any thrown value into a failed `ToolResult` — the one place an
 * `AppError` becomes a tool error. Shared by `executeToolMethod` and both
 * transport mounts so every tool error has one shape.
 */
export function toolResultFromError(err: unknown): Extract<ToolResult, { ok: false }> {
  const appErr = normalizeError(err);
  return {
    ok: false,
    code: appErr.code,
    details: appErr.details ?? { message: appErr.message },
    ...(appErr.hint && { hint: appErr.hint }),
  };
}

export async function executeToolMethod(
  method: MethodDef<unknown, unknown, unknown>,
  toolName: string,
  rawArgs: Record<string, unknown>,
  context: ToolCallContext,
  hooks?: ToolCallHooks,
  lifecycle?: ToolLifecycle,
  coerceJson = false,
): Promise<ToolResult> {
  const startedAt = Date.now();

  // Single exit — fire `afterToolCall` for every result (success and error).
  const finish = async (result: ToolResult): Promise<ToolResult> => {
    await hooks?.afterToolCall?.(toolName, rawArgs, result, Date.now() - startedAt, context);
    return result;
  };

  // `beforeToolCall` is guarded — a throw here must still fire `afterToolCall`,
  // otherwise an auth-rejected call would produce no audit record.
  if (hooks?.beforeToolCall) {
    try {
      await hooks.beforeToolCall(toolName, rawArgs, context);
    } catch (err) {
      return finish(toolResultFromError(err));
    }
  }

  // Slice the flat tool args the way the HTTP transport slices a request: path
  // params and body/query are disjoint sets of keys. Parsing each schema over
  // only its own slice keeps a `.strict()` schema working as a tool, exactly
  // as it works on HTTP — a single flat blob parsed against both would reject
  // every call once either schema is strict.
  const paramKeys = new Set(objectShapeKeys(method.paramsSchema));
  let paramArgs: Record<string, unknown> = {};
  let inputArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArgs)) {
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

  let params: unknown;
  if (method.paramsSchema) {
    const result = method.paramsSchema.safeParse(paramArgs);
    if (!result.success) {
      return finish({
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { message: `Invalid params: ${formatZodError(result.error)}` },
      });
    }
    params = result.data;
  }

  let input: unknown;
  if (method.inputSchema) {
    const result = method.inputSchema.safeParse(inputArgs);
    if (!result.success) {
      return finish({
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { message: `Invalid input: ${formatZodError(result.error)}` },
      });
    }
    input = result.data;
  }

  try {
    // Framework-owned fields are written last so neither the static context
    // nor a `ToolExtend.resolve` result can shadow `params` / `input` /
    // `source` — the same guard the HTTP context builder applies.
    const ctx: RuntimeContext = { ...context, params, input, source: context.source };

    if (lifecycle?.beforeHandle) {
      await lifecycle.beforeHandle(ctx, method);
    }

    let data: unknown = await method.handler(ctx);

    if (lifecycle?.afterHandle) {
      const transformed = await lifecycle.afterHandle(ctx, data, method);
      if (transformed !== undefined) data = transformed;
    }

    // Validate the handler's output against the contract, like the HTTP path.
    // A mismatch is a server fault — `INTERNAL_SERVER_ERROR`, not the client
    // `VALIDATION_ERROR` an invalid argument produces.
    if (method.outputSchema) {
      const checked = validateHandlerOutput(method.outputSchema, data);
      if (!checked.ok) {
        return finish({
          ok: false,
          code: 'INTERNAL_SERVER_ERROR',
          details: { message: checked.message },
        });
      }
      data = checked.data;
    }

    // A void handler reports `{ status: 'ok' }` — but only when the contract
    // declares no `output`. With an `outputSchema`, a validated `null` is the
    // contract's chosen result and must not be replaced.
    const output =
      (data === undefined || data === null) && !method.outputSchema ? { status: 'ok' } : data;
    return finish({ ok: true, data: output });
  } catch (err) {
    // The result carries the cause (message in `details` when there is nothing
    // structured) so a model sees why it failed. Result logging is the
    // consumer's job, via the `afterToolCall` hook.
    return finish(toolResultFromError(err));
  }
}
