import type { ZodType, z } from 'zod';
import type { TransportSource } from '../contract/define';
import { validateDeclaredOutput } from '../contract/normalize';
import type { RuntimeContext } from '../contract/runtime-context';
import type { EndpointToolView } from '../contract/tool-view';
import { isRecord } from '../internal/typed';
import { formatZodError } from '../internal/zod-issues';
import { getRequestContext, runWithRequestContext } from '../observability/context';
import type { OperationIdentity } from '../server/types';
import { parseToolCallArguments } from './execute-args';
import type { ToolCallContext, ToolCallHooks, ToolLifecycle } from './execute-hooks';
import { type ToolResult, toolResultFromError } from './execute-result';
import { projectToolView } from './internal/tool-view';

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

/** Nobody is listening — the shape of that, so a handler need not check. */
const noProgress = async (): Promise<void> => undefined;

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

/**
 * The handler and everything that shapes its answer: the lifecycle gate, the
 * declared-output check, the tool view, the transport's presenter. A throw is
 * left to the caller, which owns the hooks that observe it.
 */
async function invokeToolHandler(
  method: ToolOperation,
  ctx: RuntimeContext,
  input: unknown,
  source: TransportSource,
  {
    lifecycle,
    onOutputStrip,
    finalizeOutput,
    toolSurface,
  }: Pick<
    ToolExecutionOptions,
    'lifecycle' | 'onOutputStrip' | 'finalizeOutput' | 'toolSurface'
  >,
): Promise<ToolResult> {
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
    return {
      ok: false,
      code: 'INTERNAL_SERVER_ERROR',
      details: { message: checked.message },
    };
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
      call: { input, source },
      operation: `${method.serviceName}.${method.key}`,
      onStripped: onOutputStrip,
    });
    if (!viewed.ok) {
      return {
        ok: false,
        code: 'INTERNAL_SERVER_ERROR',
        details: { message: viewed.message },
      };
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
  return { ok: true, data: output };
}

/**
 * Parse the extension's own arguments and resolve them into call context.
 * The extension keys leave the arguments; transport-owned identity stays.
 */
async function resolveToolExtension(
  extension: ToolArgumentExtension,
  keys: ReadonlySet<string>,
  rawArgs: Record<string, unknown>,
  context: ToolCallContext,
): Promise<
  | { args: Record<string, unknown>; context: ToolCallContext }
  | { invalid: string }
  | { thrown: unknown }
> {
  const extensionArgs = Object.fromEntries(
    Object.entries(rawArgs).filter(([key]) => keys.has(key)),
  );
  let parsed: ReturnType<typeof extension.schema.safeParse>;
  try {
    parsed = extension.schema.safeParse(extensionArgs);
  } catch (err) {
    return { thrown: err };
  }
  if (!parsed.success) return { invalid: formatZodError(parsed.error) };
  try {
    const resolved = await extension.resolve({ ...rawArgs, ...parsed.data });
    return {
      context: {
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
      },
      args: Object.fromEntries(Object.entries(rawArgs).filter(([key]) => !keys.has(key))),
    };
  } catch (err) {
    return { thrown: err };
  }
}

/** Run an observing hook: a throwing hook, or a throwing console, never reaches the call. */
async function observed(hook: string, call: () => unknown): Promise<void> {
  try {
    await call();
  } catch (hookError) {
    try {
      console.error(`[stitchkit] ${hook} hook failed:`, hookError);
    } catch {
      // Even a throwing console must not reach the observed call.
    }
  }
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
    await observed('afterToolCall', () =>
      hooks?.afterToolCall?.({
        toolName,
        args: rawArgs,
        result,
        durationMs: Date.now() - startedAt,
        context: hookContext,
        endpoint: method,
        ...(thrown !== undefined && { error: thrown }),
        ...(rewrittenArgsApplied &&
          rewrittenArgs !== undefined && { effectiveArgs: rewrittenArgs }),
      }),
    );
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
    await observed('onToolError', () =>
      hooks?.onToolError?.({ toolName, error: err, context: hookContext, endpoint: method }),
    );
    return finish(toolResultFromError(err), err);
  };

  let callArgs = rawArgs;
  let callContext = context;
  let extensionKeys: Set<string> | undefined;
  if (extension) {
    extensionKeys = new Set(Object.keys(extension.schema.shape));
    const resolved = await resolveToolExtension(extension, extensionKeys, rawArgs, context);
    if ('thrown' in resolved) return finishThrown(resolved.thrown);
    if ('invalid' in resolved) {
      // Same reason as `finishThrown`: the extension arguments never parsed, so
      // there is no call left for a replacement to shape.
      const before = await runBefore();
      if (before?.kind === 'failure') return before.result;
      return finish({
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { message: `Invalid tool extension: ${resolved.invalid}` },
      });
    }
    callContext = resolved.context;
    hookContext = callContext;
    callArgs = resolved.args;
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

    return finish(
      await invokeToolHandler(method, ctx, input, context.source, {
        lifecycle,
        onOutputStrip,
        finalizeOutput,
        toolSurface,
      }),
    );
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
