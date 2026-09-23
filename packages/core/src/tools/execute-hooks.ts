/**
 * The hook vocabulary of a tool call: the context every hook is handed, the
 * three per-call hooks (`beforeToolCall`, `afterToolCall`, `onToolError`), the
 * error-hint policy, and the lifecycle gate a tool shares with HTTP.
 */
import type { TransportSource } from '../contract/define';
import type { McpCallContext, RuntimeContext } from '../contract/runtime-context';
import type { OperationIdentity } from '../server/types';
import type { ToolResult } from './execute-result';

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
