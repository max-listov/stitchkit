/**
 * A ready-made `afterToolCall` preset — tool-call observability in one line.
 *
 * Logging MCP / agent tool calls (which tool, ok or failed, how long, which
 * endpoint) is the same code in every project. `createToolLogger` returns a
 * `ToolCallHooks` that formats it, keyed by the endpoint's stable identity
 * (`serviceName` / `key`, ADR 0022):
 *
 * ```ts
 * mountMcp(server, services, { hooks: createToolLogger() });
 * // [tool] ok list_widgets (widgets.list) 12ms
 * // [tool] warn get_widget (widgets.get) NOT_FOUND 4ms
 * ```
 *
 * It only reads the hook the mounts already fire — a thin wrapper, no new
 * machinery (ADR 0008). Pass `onRecord` to feed a metrics backend the raw parts.
 */
import { getTraceId } from '../observability/context';
import type { ToolCallHooks } from './execute';

/** The structured record behind each logged line — for metrics via `onRecord`. */
export interface ToolCallRecord {
  /** The mounted tool name. */
  tool: string;
  /** Owning service (`endpoint.serviceName`). */
  service: string;
  /** Endpoint key / action (`endpoint.key`). */
  action: string;
  /** Whether the call succeeded. */
  ok: boolean;
  /** The error code, when the call failed. */
  code?: string;
  /** Wall-clock duration, milliseconds (rounded). */
  durationMs: number;
  /** Transport tag the call came in on (`ctx.source`). */
  source: string;
  /**
   * The active trace id, when an observability context is running — the key
   * that joins this line to the HTTP request that triggered the tool call.
   * Absent when nothing established a context (`wrapInRequestContext`, or a
   * server's `wrapFetch`).
   */
  traceId?: string;
}

/** Config for `createToolLogger`. */
export interface ToolLoggerConfig {
  /** Where a formatted line goes. Default `console.info`. */
  log?: (line: string) => void;
  /** Called with the structured record for every call — feed a metrics sink. */
  onRecord?: (record: ToolCallRecord) => void;
}

/**
 * Build a `ToolCallHooks` that logs every tool call. Merge it into a mount's
 * `hooks` (or spread alongside your own `beforeToolCall`).
 */
export function createToolLogger(config: ToolLoggerConfig = {}): ToolCallHooks {
  const log = config.log ?? ((line: string) => console.info(line));
  return {
    afterToolCall: ({ toolName, result, durationMs, context, endpoint }) => {
      const record: ToolCallRecord = {
        tool: toolName,
        service: endpoint.serviceName,
        action: endpoint.key,
        ok: result.ok,
        code: result.ok ? undefined : result.code,
        durationMs: Math.round(durationMs),
        source: String(context.source),
        traceId: getTraceId(),
      };
      const codePart = result.ok ? '' : ` ${result.code}`;
      log(
        `[tool] ${result.ok ? 'ok' : 'warn'} ${toolName} (${endpoint.serviceName}.${endpoint.key})${codePart} ${record.durationMs}ms`,
      );
      config.onRecord?.(record);
    },
  };
}
