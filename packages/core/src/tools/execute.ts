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
    endpoint: MethodDef,
  ) => void | Promise<void>;
  /**
   * Every finished call, success and failure alike — the record of the call.
   *
   * `error` is the value **as thrown**, present only when the call failed by
   * throwing (never for an argument-validation failure, an output-schema
   * mismatch or a `beforeToolCall` rejection — those never had a raw value).
   * It is the same value `onToolError` receives, handed here too so a single
   * hook can build one row that names the cause: the `result` alone cannot,
   * because an unexpected throw is scrubbed to a bare `INTERNAL_SERVER_ERROR`.
   * A six-parameter hook is unaffected.
   */
  afterToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    durationMs: number,
    context: ToolCallContext,
    endpoint: MethodDef,
    error?: unknown,
  ) => void | Promise<void>;
  /**
   * The handler path threw — the value **as thrown**, before it is normalised
   * into a `ToolResult`. The tool-side answer to HTTP's `hooks.onError`, and the
   * only place the real cause of an unexpected failure is reachable: an error
   * that is not an `AppError` is scrubbed to a bare `INTERNAL_SERVER_ERROR` with
   * no details, so by the time `afterToolCall` sees the result, the stack, the
   * `cause` chain and the message are gone.
   *
   * Fires for a throw from `lifecycle.beforeHandle`, the handler, or
   * `lifecycle.afterHandle` — the span where information is destroyed. It does
   * **not** fire for a `beforeToolCall` rejection, an argument-validation
   * failure or an output-schema mismatch: each of those is already described in
   * full by the `ToolResult` that `afterToolCall` receives, and a second path to
   * the same information only invites double-logging.
   *
   * This is observation, not an error handler — the tool envelope is always
   * `toolResultFromError`, so the return value is ignored and a throw from the
   * hook itself is reported and swallowed rather than replacing the failure it
   * was called to observe. Awaited before `afterToolCall`, so anything the hook
   * records (a request-context error, say) is already in place when the audit
   * hook reads it.
   */
  onToolError?: (
    toolName: string,
    error: unknown,
    context: ToolCallContext,
    endpoint: MethodDef,
  ) => void | Promise<void>;
}

/**
 * A per-tool hint appended to a failed tool result — given the tool name and the
 * error code, return extra guidance for the model (or `null` for none). Shared
 * by every tool mount (`mountMcp` / `mountAgent` / `createCli`), so a project
 * writes one recovery-hint policy and it reaches all three transports.
 */
export type ErrorHintFn = (toolName: string, errorCode: string) => string | null;

/**
 * The tool-side twin of the HTTP server's `beforeHandle` / `afterHandle`. A
 * tool call runs the same handler an HTTP request would — `ToolLifecycle` makes
 * it run the same gate. Pass a `createAuthHook` result as `beforeHandle` here
 * and tools are scope-guarded exactly as HTTP routes are; without it a tool
 * call bypasses the auth a `createServer` `beforeHandle` enforces.
 *
 * Structurally a subset of `LifecycleHooks` — the same hook object used for
 * `createServer({ hooks })` is assignable here.
 *
 * There is deliberately no `onError` twin: `LifecycleHooks.onError` returns a
 * `Response`, which the tool path has no use for, and narrowing the return type
 * here would break the assignability above. Observing a thrown tool error is
 * `ToolCallHooks.onToolError`.
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
  onOutputStrip?: (paths: string[]) => void,
): Promise<ToolResult> {
  const startedAt = Date.now();

  // Single exit — fire `afterToolCall` for every result (success and error).
  // `method` (the resolved `MethodDef`) is passed so the hook reads identity
  // (`serviceName` / `key` / `meta`) directly — the tool-side twin of
  // `afterHandle(ctx, result, endpoint)`, no toolName→identity map. → ADR 0022.
  // `thrown` is passed only on the throw path, so a hook can tell "the handler
  // threw and this is why" from "the call failed a check" — the latter never had
  // a raw value to lose.
  const finish = async (result: ToolResult, thrown?: unknown): Promise<ToolResult> => {
    await hooks?.afterToolCall?.(
      toolName,
      rawArgs,
      result,
      Date.now() - startedAt,
      context,
      method,
      thrown,
    );
    return result;
  };

  // `beforeToolCall` is guarded — a throw here must still fire `afterToolCall`,
  // otherwise an auth-rejected call would produce no audit record.
  if (hooks?.beforeToolCall) {
    try {
      await hooks.beforeToolCall(toolName, rawArgs, context, method);
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
      const checked = validateHandlerOutput(method.outputSchema, data, onOutputStrip);
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
    // Report the value as thrown BEFORE normalising it: `normalizeError` scrubs
    // anything that is not an `AppError` down to a bare `INTERNAL_SERVER_ERROR`,
    // so this is the last point at which the real cause exists. Guarded — the
    // hook observes the failure, it must not become one.
    if (hooks?.onToolError) {
      try {
        await hooks.onToolError(toolName, err, context, method);
      } catch (hookErr) {
        console.error('[stitchkit] onToolError hook failed:', hookErr);
      }
    }
    // The result carries the cause (message in `details` when there is nothing
    // structured) so a model sees why it failed. Result logging is the
    // consumer's job, via the `afterToolCall` hook — which is handed the raw
    // value too, so one hook can build a record the scrubbed result cannot.
    return finish(toolResultFromError(err), err);
  }
}
