import type { ZodType, z } from 'zod';
import type { McpCallContext, RuntimeContext, TransportSource } from '../contract/define';
import {
  AppError,
  isRetryableStatus,
  isStitchErrorCode,
  STITCH_ERROR_STATUS,
} from '../contract/errors';
import { normalizeError, validateDeclaredOutput } from '../contract/normalize';
import type { EndpointToolView } from '../contract/tool-view';
import { isUnsafeKey } from '../internal/safe-json';
import { isRecord } from '../internal/typed';
import { formatZodError } from '../internal/zod-issues';
import { getRequestContext, runWithRequestContext } from '../observability/context';
import type { OperationIdentity } from '../server/types';
import { applyToolViewDefaults, projectToolView } from './internal/tool-view';
import { coerceJsonArgs } from './schema/coerce';
import { objectShapeKeys } from './schema/schema';

export type ToolResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      code: string;
      details?: unknown;
      hint?: string;
      /**
       * A declared retry class, carried so it survives a process hop.
       *
       * The normalized `AppError` lives in a `WeakMap` keyed by the result
       * object, which a serialized failure crossing MCP or the CLI cannot take
       * with it — `toolErrorFromResult` rebuilds from `{code, details, hint}`
       * and resolves the status from the code. A declaration that contradicts
       * its status class would be lost exactly there, which is the failure
       * already recorded for coding-tool refusals.
       */
      retryable?: boolean;
    };

type ToolFailure = Extract<ToolResult, { ok: false }>;

export type ToolExecutionControlReason = 'stale_run' | 'run_interrupted';

/** Internal control flow that must never be converted into a model-facing tool failure. */
export class ToolExecutionControlError extends Error {
  readonly reason: ToolExecutionControlReason;

  constructor(reason: ToolExecutionControlReason) {
    super(`Agent tool execution stopped: ${reason}`);
    this.name = 'ToolExecutionControlError';
    this.reason = reason;
  }
}

/**
 * A record with no prototype but `Object.prototype` or `null` — the shape an
 * object literal or `Object.fromEntries` produces, and nothing a class
 * instance, a `Map` or a `Promise` produces.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isToolExecutionControlError(
  value: unknown,
): value is ToolExecutionControlError {
  return value instanceof ToolExecutionControlError;
}

/**
 * The model-facing failure deliberately omits HTTP status and the raw cause.
 * In-process composition still needs the exact normalized AppError, so retain
 * it out-of-band for the lifetime of the result object. A WeakMap keeps the
 * public envelope and its JSON representation unchanged.
 */
const normalizedToolErrors = new WeakMap<
  ToolFailure,
  { normalized: AppError; cause: unknown }
>();

export interface ToolCallContext {
  source: TransportSource;
  /** Validated metadata for an MCP call; absent on every other transport. */
  mcp?: McpCallContext;
  /**
   * The provider's id for this tool call, on a surface that has one — today
   * `mountAgent`, where it is the AI SDK's `toolCallId`.
   *
   * Without it a consumer running its own agent loop could see the outcome of a
   * call through `afterToolCall` and had no way to say WHICH call it belonged
   * to, so it reconstructed the answer from the serialised error text instead.
   * That reconstruction is the defect: it is written once per consumer and
   * disagrees silently.
   */
  toolCallId?: string;
  [key: string]: unknown;
}

export interface BeforeToolCallOptions {
  toolName: string;
  args: Record<string, unknown>;
  context: ToolCallContext;
  endpoint: OperationIdentity;
}

export interface AfterToolCallOptions extends BeforeToolCallOptions {
  result: ToolResult;
  durationMs: number;
  /** The value as thrown; absent for failures that did not throw. */
  error?: unknown;
  /**
   * The arguments the call actually ran on, when `beforeToolCall` replaced
   * them. Absent when nothing rewrote them — so `args` alone stays the honest
   * record of what the caller sent, and a rewrite is visible as a rewrite
   * rather than by overwriting the evidence.
   */
  effectiveArgs?: Record<string, unknown>;
}

export interface ToolErrorOptions {
  toolName: string;
  error: unknown;
  context: ToolCallContext;
  endpoint: OperationIdentity;
}

export interface ToolCallHooks {
  /**
   * Before the arguments are validated — and the one place they can still be
   * changed.
   *
   * Returning a record replaces the arguments for this call; returning
   * `undefined`, `null` or nothing leaves them exactly as they arrived. The
   * replacement is validated by the contract schema like any other input, so
   * this is a way to shape a call, never a way around the schema: a hook that
   * returns something the schema refuses produces an ordinary
   * `VALIDATION_ERROR`.
   *
   * This exists because the pipeline was asymmetric. `lifecycle.afterHandle`
   * could already transform the OUTPUT, while the only way to affect the input
   * was to throw — so a caller wanting to expand a reference into a value
   * before validation had nowhere to stand: this hook sees the raw arguments
   * and could not change them, and `lifecycle.beforeHandle` runs after the
   * schemas have already refused.
   *
   * The audit trail is unaffected: `afterToolCall` still reports `args` as they
   * arrived from the caller, and reports the replacement separately as
   * `effectiveArgs`.
   *
   * Typed `unknown` for the same reason `lifecycle.afterHandle` is — the twin
   * this mirrors. Every hook written against the old `void` signature still
   * assigns, which is the whole compatibility claim, and a narrower union here
   * would break exactly the hooks that exist today. What the value must BE is
   * enforced where it is used, not where it is declared: anything that is not a
   * record, `null` or `undefined` is refused by name at the call.
   */
  beforeToolCall?: (options: BeforeToolCallOptions) => unknown | Promise<unknown>;
  /**
   * Every finished call, success and failure alike — the record of the call.
   *
   * `error` is the value **as thrown**, present only when the call failed by
   * throwing (never for an argument-validation failure, an output-schema
   * mismatch or a `beforeToolCall` rejection — those never had a raw value).
   * It is the same value `onToolError` receives, handed here too so a single
   * hook can build one row that names the cause: the `result` alone cannot,
   * because an unexpected throw is scrubbed to a bare `INTERNAL_SERVER_ERROR`.
   */
  afterToolCall?: (options: AfterToolCallOptions) => void | Promise<void>;
  /**
   * The tool execution path threw — the value **as thrown**, before it is normalised
   * into a `ToolResult`. The tool-side answer to HTTP's `hooks.onError`, and the
   * only place the real cause of an unexpected failure is reachable: an error
   * that is not an `AppError` is scrubbed to a bare `INTERNAL_SERVER_ERROR` with
   * no details, so by the time `afterToolCall` sees the result, the stack, the
   * `cause` chain and the message are gone.
   *
   * Fires for a throw from executable input parsing (`ToolExtend`, params or
   * input), extension resolution, `lifecycle.beforeHandle`, the handler, or
   * `lifecycle.afterHandle` — every span where the raw cause would otherwise be
   * destroyed. It does **not** fire for a normal validation result, a
   * `beforeToolCall` rejection or an output-schema mismatch: each is already
   * described in full by the `ToolResult` that `afterToolCall` receives.
   *
   * This is observation, not an error handler — the tool envelope is always
   * `toolResultFromError`, so the return value is ignored and a throw from the
   * hook itself is reported and swallowed rather than replacing the failure it
   * was called to observe. Awaited before `afterToolCall`, so anything the hook
   * records (a request-context error, say) is already in place when the audit
   * hook reads it.
   */
  onToolError?: (options: ToolErrorOptions) => void | Promise<void>;
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
  beforeHandle?: (ctx: RuntimeContext, endpoint: OperationIdentity) => void | Promise<void>;
  /** Transform the handler result before it is returned. */
  afterHandle?: (
    ctx: RuntimeContext,
    result: unknown,
    endpoint: OperationIdentity,
  ) => unknown | Promise<unknown>;
}

/** Executable tool operation; contract methods and native tools share this runner shape. */
export interface ToolOperation extends OperationIdentity {
  paramsSchema?: ZodType;
  inputSchema?: ZodType;
  outputSchema?: ZodType;
  /** Applied only by a runner built for the tool surface. → ADR 0196. */
  toolView?: EndpointToolView;
  handler(ctx: RuntimeContext): unknown | Promise<unknown>;
}

/** Executable extension parsed once inside the shared runner before resolution. */
export interface ToolArgumentExtension {
  schema: z.ZodObject;
  resolve: (
    args: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * Normalise any thrown value into a failed `ToolResult` — the one place an
 * `AppError` becomes a tool error. Shared by `executeToolMethod` and both
 * transport mounts so every tool error has one shape.
 */

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

/** Nobody is listening — the shape of that, so a handler need not check. */
const noProgress = async (): Promise<void> => undefined;

export function toolResultFromError(err: unknown): ToolFailure {
  const appErr = normalizeError(err);
  const result: ToolFailure = {
    ok: false,
    code: appErr.code,
    details: appErr.details ?? { message: appErr.message },
    ...(appErr.hint && { hint: appErr.hint }),
    // Resolved HERE, declared or derived, and carried on the failure — because
    // the only other place the status is known is the WeakMap this object
    // keys, and a failure that crosses a process boundary does not take it
    // along. Rebuilt from `{code, details, hint}` on the far side, an
    // application's `status: 429` would resolve to 500 and read as
    // unrecoverable. The failure is the one thing that crosses; the answer
    // rides on it.
    retryable: appErr.retryable ?? isRetryableStatus(appErr.status),
  };
  normalizedToolErrors.set(result, { normalized: appErr, cause: err });
  return result;
}

/** Recover the normalized AppError behind one canonical failed tool result. */
export function toolErrorFromResult(result: ToolFailure): AppError {
  const retained = normalizedToolErrors.get(result);
  if (retained) return retained.normalized;

  const details = isRecord(result.details) ? result.details : undefined;
  const message = typeof details?.message === 'string' ? details.message : result.code;
  const status = isStitchErrorCode(result.code) ? STITCH_ERROR_STATUS[result.code] : 500;
  return new AppError(
    result.code,
    message,
    status,
    details,
    result.hint,
    undefined,
    result.retryable,
  );
}

/** Original in-process failure; never part of the serialized tool envelope. */
export function toolCauseFromResult(result: ToolFailure): unknown {
  return normalizedToolErrors.get(result)?.cause;
}

/** What one tool call is: the name it was called by, its raw arguments, its context. */
export interface ToolCall {
  toolName: string;
  rawArgs: Record<string, unknown>;
  context: ToolCallContext;
}

/** How a call is run — every knob optional, named, and off unless set. */
export interface ToolExecutionOptions {
  /** Tool-call observability hooks. */
  hooks?: ToolCallHooks;
  /** Auth / scope gate and result transform. */
  lifecycle?: ToolLifecycle;
  /** Coerce JSON-stringified arrays/objects in the arguments (LLM double-serialization). */
  coerceJson?: boolean;
  /** Report handler-output keys the contract schema removed. → ADR 0037. */
  onOutputStrip?: (paths: string[]) => void;
  /** Extend arguments resolved, then stripped, before the parse. */
  extension?: ToolArgumentExtension;
  /** Last transformation of validated output — a runtime tool's presenter. */
  finalizeOutput?: (data: unknown) => unknown | Promise<unknown>;
  /** Answer as the tool surface: apply the endpoint's `toolView`. → ADR 0196. */
  toolSurface?: boolean;
}

export async function executeToolMethod(
  method: ToolOperation,
  call: ToolCall,
  options: ToolExecutionOptions = {},
): Promise<ToolResult> {
  const { toolName, context } = call;
  // Each call gets its own request context, forked from the ambient one.
  //
  // Without this every tool call in a request writes into **one** store, and the
  // AI SDK runs a step's calls with `Promise.all`: `beforeHandle(A)` stamps its
  // entity, `beforeHandle(B)` overwrites it, and both audit rows then name B.
  // Observed in production, on rows that looked perfectly ordinary. → ADR 0045.
  //
  // Forked only where a parent exists. With no ambient context there is no
  // shared store, so there is nothing to corrupt — and inventing a root here
  // would stamp every stdio / CLI row with a `parentSpanId` pointing at a span
  // no row ever carries (`audit.ts` treats any context's trace as the *parent*).
  return inToolCallContext({ source: context.source, toolName, method }, () =>
    runToolMethod(method, call, options),
  );
}

/**
 * Run `body` in a request context forked for one tool call — the shared rule,
 * so every entry point isolates the same way. A mount uses it around
 * `ToolExtend.resolve` as well, which runs before the executor and is a
 * documented per-call resolution point. → ADR 0045.
 *
 * No fork where there is no ambient context: nothing is shared there, and
 * inventing a root would stamp every stdio / CLI row with a `parentSpanId`
 * pointing at a span no row emits.
 */
export function inToolCallContext<T>(
  call: {
    source: TransportSource;
    toolName: string;
    method: OperationIdentity;
  },
  body: () => Promise<T>,
): Promise<T> {
  const parent = getRequestContext();
  if (!parent) return body();
  return runWithRequestContext(
    {
      ...parent,
      // Restated for emphasis (the spread already copies it): the audit hook
      // derives the tool's span as a **child** of this trace, so minting a child
      // here would point every tool row at a span nobody emits.
      trace: parent.trace,
      // Own copies of everything a call can write, or the fork changes nothing.
      dimensions: parent.dimensions ? { ...parent.dimensions } : undefined,
      error: undefined,
      // Self-describing: the enclosing request says `http` / `/mcp`, which is
      // true of the request and misleading about the call.
      source: call.source,
      method: 'TOOL',
      path: `/${call.source}/${call.toolName}`,
      serviceName: call.method.serviceName,
      action: call.method.key,
    },
    body,
  );
}

/** The call itself. Always runs inside the context `executeToolMethod` chose. */
async function runToolMethod(
  method: ToolOperation,
  { toolName, rawArgs, context }: ToolCall,
  {
    hooks,
    lifecycle,
    coerceJson = false,
    onOutputStrip,
    extension,
    finalizeOutput,
    toolSurface = false,
  }: ToolExecutionOptions,
): Promise<ToolResult> {
  const startedAt = Date.now();
  let hookContext = context;

  // Single exit — fire `afterToolCall` for every result (success and error).
  // The resolved operation is passed so the hook reads identity
  // (`serviceName` / `key` / `meta`) directly — the tool-side twin of
  // `afterHandle(ctx, result, endpoint)`, no toolName→identity map. → ADR 0022.
  // `thrown` is passed only on the throw path, so a hook can tell "the handler
  // threw and this is why" from "the call failed a check" — the latter never had
  // a raw value to lose.
  const finish = async (result: ToolResult, thrown?: unknown): Promise<ToolResult> => {
    try {
      await hooks?.afterToolCall?.({
        toolName,
        args: rawArgs,
        result,
        durationMs: Date.now() - startedAt,
        context: hookContext,
        endpoint: method,
        ...(thrown !== undefined && { error: thrown }),
        ...(rewrittenArgsApplied &&
          rewrittenArgs !== undefined && { effectiveArgs: rewrittenArgs }),
      });
    } catch (hookError) {
      try {
        console.error('[stitchkit] afterToolCall hook failed:', hookError);
      } catch {
        // Even a throwing console must not reach the observed call.
      }
    }
    return result;
  };

  let beforeRan = false;
  /**
   * The arguments `beforeToolCall` put in place of the caller's, if it did.
   * Read by `finish` for the audit record, so it is declared before either.
   */
  let rewrittenArgs: Record<string, unknown> | undefined;
  /**
   * Set only on the main path, at the point the replacement becomes the
   * arguments the call runs on. `runBefore` may also run on a path that has
   * already failed — there the replacement is recorded but never applied, and
   * reporting it as "what the call ran on" would be a fabricated audit row.
   */
  let rewrittenArgsApplied = false;

  /**
   * A refusal, a replacement set of arguments, or neither — discriminated on
   * purpose.
   *
   * Two of the three call sites below run on a path that has already failed and
   * deliberately ignore anything but a refusal. With a bare union they would
   * return a plain record where a `ToolResult` is expected, and the type system
   * would not notice — the failure would be a tool answering with the caller's
   * own arguments.
   */
  const runBefore = async (): Promise<
    { kind: 'failure'; result: ToolResult } | { kind: 'args' } | null
  > => {
    if (beforeRan || !hooks?.beforeToolCall) return null;
    beforeRan = true;
    let returned: unknown;
    try {
      returned = await hooks.beforeToolCall({
        toolName,
        args: rawArgs,
        context: hookContext,
        endpoint: method,
      });
    } catch (err) {
      return { kind: 'failure', result: await finish(toolResultFromError(err)) };
    }
    // Only a PLAIN object is a replacement. Everything else — `undefined`,
    // `null`, a `Map` from a one-line `audit.set(...)`, the number a `push`
    // returns — is what existing hooks already return today, and today it is
    // ignored. Reading any of those as arguments would turn a hook that has
    // worked for months into one that erases every call's input, silently,
    // because `Object.entries(new Map())` is `[]`. The compatibility claim is
    // "returning nothing changes nothing", and it has to hold for the values
    // real hooks actually return, not only for the two literal ones.
    if (!isPlainObject(returned)) return null;
    rewrittenArgs = returned;
    return { kind: 'args' };
  };

  const finishThrown = async (err: unknown): Promise<ToolResult> => {
    // The call has already failed, so replacement arguments have nowhere left
    // to be applied; only a refusal from the hook still changes the answer.
    const before = await runBefore();
    if (before?.kind === 'failure') return before.result;
    if (hooks?.onToolError) {
      try {
        await hooks.onToolError({
          toolName,
          error: err,
          context: hookContext,
          endpoint: method,
        });
      } catch (hookErr) {
        try {
          console.error('[stitchkit] onToolError hook failed:', hookErr);
        } catch {
          // Even a throwing console must not reach the observed call.
        }
      }
    }
    return finish(toolResultFromError(err), err);
  };

  let callArgs = rawArgs;
  let callContext = context;
  let extensionKeys: Set<string> | undefined;
  if (extension) {
    const keys = new Set(Object.keys(extension.schema.shape));
    extensionKeys = keys;
    const extensionArgs = Object.fromEntries(
      Object.entries(rawArgs).filter(([key]) => keys.has(key)),
    );
    let parsed: ReturnType<typeof extension.schema.safeParse>;
    try {
      parsed = extension.schema.safeParse(extensionArgs);
    } catch (err) {
      return finishThrown(err);
    }
    if (!parsed.success) {
      // Same reason as `finishThrown`: the extension arguments never parsed, so
      // there is no call left for a replacement to shape.
      const before = await runBefore();
      if (before?.kind === 'failure') return before.result;
      return finish({
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { message: `Invalid tool extension: ${formatZodError(parsed.error)}` },
      });
    }
    try {
      const resolved = await extension.resolve({ ...rawArgs, ...parsed.data });
      callContext = {
        ...context,
        ...resolved,
        // Transport-owned call identity always wins over a model-resolved
        // extension, just like source/params/input below. `toolCallId` is in
        // that set: an extension that resolved a key of that name would hand
        // every hook the wrong call to correlate — the exact defect the field
        // exists to close, reintroduced at the one seam that added it.
        source: context.source,
        ...(context.mcp !== undefined && { mcp: context.mcp }),
        ...(context.toolCallId !== undefined && { toolCallId: context.toolCallId }),
      };
      hookContext = callContext;
      callArgs = Object.fromEntries(Object.entries(rawArgs).filter(([key]) => !keys.has(key)));
    } catch (err) {
      return finishThrown(err);
    }
  }

  const before = await runBefore();
  if (before?.kind === 'failure') return before.result;
  if (before?.kind === 'args' && rewrittenArgs) {
    // The hook is handed the RAW arguments, which still carry the extension's
    // own keys; `callArgs` has had them removed. A hook that takes what it was
    // given, changes one field and returns it would therefore put the extension
    // keys back — and they are in neither schema, so a `.strict()` input schema
    // would refuse every rewritten call. Filter them out again rather than make
    // every hook know about the split. `extension.resolve` is deliberately NOT
    // replayed: the identity it resolved is the caller's, and a hook must not
    // be able to re-resolve who is calling.
    callArgs = extensionKeys
      ? Object.fromEntries(
          Object.entries(rewrittenArgs).filter(([key]) => !extensionKeys.has(key)),
        )
      : rewrittenArgs;
    rewrittenArgsApplied = true;
  }

  const parsed = parseToolCallArguments(method, callArgs, { coerceJson, toolSurface });
  if (!parsed.ok) {
    return parsed.thrown !== undefined
      ? finishThrown(parsed.thrown)
      : finish({ ok: false, code: 'VALIDATION_ERROR', details: { message: parsed.message } });
  }
  const { params, input } = parsed;

  try {
    // Framework-owned fields are written last so neither the static context
    // nor a `ToolExtend.resolve` result can shadow `params` / `input` /
    // `source` — the same guard the HTTP context builder applies.
    const ctx = {
      // A no-op reporter under the call context, so `ctx.reportProgress` is
      // present on EVERY tool call and a handler never branches on transport to
      // say what it is doing. The MCP path overwrites it with one that can
      // actually reach a listening host; on the others there is nobody to tell,
      // which is the same state as an MCP host that asked for no progress.
      reportProgress: noProgress,
      ...callContext,
      params,
      input,
      source: context.source,
    };

    if (lifecycle?.beforeHandle) {
      await lifecycle.beforeHandle(ctx, method);
    }

    let data: unknown = await method.handler(ctx);

    if (lifecycle?.afterHandle) {
      const transformed = await lifecycle.afterHandle(ctx, data, method);
      if (transformed !== undefined) data = transformed;
    }

    // Match the HTTP path: the contract decides whether an output exists.
    // A mismatch is a server fault — never argument VALIDATION_ERROR.
    const checked = validateDeclaredOutput(method.outputSchema, data, onOutputStrip);
    if (!checked.ok) {
      return finish({
        ok: false,
        code: 'INTERNAL_SERVER_ERROR',
        details: { message: checked.message },
      });
    }
    data = checked.data;

    // The tool-surface answer is derived from the validated full one, and only
    // where an output exists: a guard pass that runs no handler has nothing to
    // project. → ADR 0196.
    if (toolSurface && method.toolView && method.outputSchema) {
      const viewed = projectToolView({
        view: method.toolView,
        fullSchema: method.outputSchema,
        full: data,
        call: { input, source: context.source },
        operation: `${method.serviceName}.${method.key}`,
        onStripped: onOutputStrip,
      });
      if (!viewed.ok) {
        return finish({
          ok: false,
          code: 'INTERNAL_SERVER_ERROR',
          details: { message: viewed.message },
        });
      }
      data = viewed.data;
    }

    // Transport-specific presentation still belongs to the canonical attempt:
    // presenter throws and invalid results must reach onToolError/afterToolCall
    // before the executor records success.
    if (finalizeOutput) data = await finalizeOutput(data);

    // A void handler reports `{ status: 'ok' }` — but only when the contract
    // declares no `output`. With an `outputSchema`, a validated `null` is the
    // contract's chosen result and must not be replaced.
    const output =
      (data === undefined || data === null) && !method.outputSchema ? { status: 'ok' } : data;
    return finish({ ok: true, data: output });
  } catch (err) {
    if (isToolExecutionControlError(err)) throw err;
    // Report the value as thrown BEFORE normalising it: `normalizeError` scrubs
    // anything that is not an `AppError` down to a bare `INTERNAL_SERVER_ERROR`,
    // so this is the last point at which the real cause exists. Guarded — the
    // hook observes the failure, it must not become one.
    // The result carries the cause (message in `details` when there is nothing
    // structured) so a model sees why it failed. Result logging is the
    // consumer's job, via the `afterToolCall` hook — which is handed the raw
    // value too, so one hook can build a record the scrubbed result cannot.
    return finishThrown(err);
  }
}
