/**
 * Drive a contract over a **bring-your-own transport**.
 *
 * The HTTP server, the MCP mount and the agent mount all run a contract method
 * the same way: slice the flat args, validate `params` / `input` against the Zod
 * schemas, run the handler, validate the output, and return a typed result
 * envelope. `createContractDispatcher` exposes exactly that core for a transport
 * stitchkit does not own — a raw WebSocket lane (webview ↔ a local sidecar), an
 * IPC channel, a queue worker. The transport owns the wire (framing, handshake,
 * reconnect); the dispatcher owns "given a method name and args, run it safely."
 *
 * This is the same execution path as `mountMcp` / `mountAgent` (it shares
 * `executeToolMethod`), so a bespoke transport gets identical validation and the
 * identical `{ ok, code, details, hint }` error envelope for free, instead of a
 * hand-rolled method registry. → ADR 0027. Upholds ADR 0008 (no competing
 * engine — the transport is the app's) and ADR 0002 (the core stays generic —
 * `source` is a free tag, `idempotent` carries no built-in behaviour).
 */
import { AppError, type TransportSource } from '../contract';
import type { MethodDef, ServiceDef } from '../server/types';
import {
  executeToolMethod,
  type ToolCallContext,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolResult,
  toolResultFromError,
} from './execute';

export interface ContractDispatcherConfig {
  /** Transport tag written to every call's `ctx.source` — e.g. `'local-ws'`. */
  source: TransportSource;
  /** Static context merged into every call (overridden by per-call context). */
  context?: Record<string, unknown>;
  /**
   * Observability hooks — the same `beforeToolCall` / `afterToolCall` the MCP and
   * agent mounts fire, so a bespoke transport audits calls the same way.
   */
  hooks?: ToolCallHooks;
  /**
   * Auth / scope gate and result transform run for every call — pass a
   * `createAuthHook` result as `beforeHandle` to scope-guard the transport like
   * an HTTP route.
   */
  lifecycle?: ToolLifecycle;
  /**
   * Coerce JSON-stringified array / object arguments before validation. Off by
   * default — a structured transport (WebSocket JSON) sends real types; only an
   * LLM-style flat-string transport needs it.
   */
  coerceJsonArgs?: boolean;
}

export interface ContractDispatcher {
  /**
   * Run one contract method by its endpoint key (e.g. `'transcriptions.list'`)
   * with a flat argument object. Returns the `{ ok: true, data } | { ok: false,
   * code, details?, hint? }` envelope the MCP / agent transports use — it does
   * not throw for a normal call; a handler error becomes a failed result, and an
   * unknown method is a `NOT_FOUND` result. Per-call `context` is merged after
   * the static `config.context` (neither can shadow `source`).
   */
  dispatch(
    method: string,
    args: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): Promise<ToolResult>;
  /** Every method key this dispatcher can run, across the given services. */
  readonly methods: readonly string[];
}

/**
 * Build a {@link ContractDispatcher} from one or more `implement()` services.
 * Every method of every service is dispatchable by its key — exposure is the
 * transport's choice (which services it dispatches), not the contract's `expose`
 * (that gates the built-in HTTP / MCP / agent / CLI transports).
 */
export function createContractDispatcher(
  services: ServiceDef | ServiceDef[],
  config: ContractDispatcherConfig,
): ContractDispatcher {
  const list = Array.isArray(services) ? services : [services];
  const index = new Map<string, MethodDef<unknown, unknown, unknown>>();
  for (const service of list) {
    for (const [name, method] of Object.entries(service.methods)) {
      if (index.has(name)) {
        throw new Error(
          `createContractDispatcher: duplicate method "${name}" across services`,
        );
      }
      index.set(name, method);
    }
  }

  return {
    methods: [...index.keys()],
    dispatch(method, args, context) {
      const target = index.get(method);
      if (!target) {
        return Promise.resolve(
          toolResultFromError(new AppError('NOT_FOUND', `Unknown method: ${method}`, 404)),
        );
      }
      // `source` is written last so neither static nor per-call context shadows
      // the real transport tag — the same guard the other transports apply.
      const ctx: ToolCallContext = { ...config.context, ...context, source: config.source };
      return executeToolMethod(
        target,
        method,
        args,
        ctx,
        config.hooks,
        config.lifecycle,
        config.coerceJsonArgs ?? false,
      );
    },
  };
}
