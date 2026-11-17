import {
  connectionIdleTimeoutMs,
  connectionMaxResponseBytes,
  connectionTimeoutMs,
  DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
} from './limits';
import type { ConnectionOperation, ConnectionPhase, McpConnectionLimits } from './types';

export interface ResolvedConnectionLimits {
  timeoutMs: number;
  maxResponseBytes: number;
  /** Absent: no idle deadline, only `timeoutMs` ends the operation. */
  idleTimeoutMs?: number;
}

export interface ConnectionReadContext extends ResolvedConnectionLimits {
  operation: ConnectionOperation;
  phase: ConnectionPhase;
  observedReadBytes: number;
  signal?: AbortSignal;
  /** Progress for the idle deadline; set by `withConnectionDeadline`. */
  touch?: () => void;
}

export interface McpPhaseLimits {
  discovery: ResolvedConnectionLimits;
  call: ResolvedConnectionLimits;
}

/**
 * Resolve and validate once at the connection boundary, including unused phases.
 *
 * A phase field wins, then the connection's shared field, then the phase default. Discovery
 * with no declared `timeoutMs` defaults to a long total deadline and a 30-second idle one — a
 * large catalog on a slow link keeps arriving — while a call keeps the shared 30 seconds and no
 * idle deadline, because a tool may legitimately compute in silence before it answers.
 */
export function resolveMcpLimits(config: {
  timeoutMs?: number;
  maxResponseBytes?: number;
  limits?: McpConnectionLimits;
}): McpPhaseLimits {
  const sharedTimeoutMs =
    config.timeoutMs === undefined ? undefined : connectionTimeoutMs(config.timeoutMs);
  const sharedMaxResponseBytes = connectionMaxResponseBytes(config.maxResponseBytes);
  const resolve = (phase: ConnectionPhase): ResolvedConnectionLimits => {
    const override = config.limits?.[phase];
    const discovery = phase === 'discovery';
    // Discovery's defaults replace an undeclared deadline as a pair; a declared `timeoutMs`
    // keeps meaning exactly what it did, with an idle deadline only when one is declared too.
    const declaredTimeout = override?.timeoutMs !== undefined || sharedTimeoutMs !== undefined;
    const idleTimeoutMs = connectionIdleTimeoutMs(
      override?.idleTimeoutMs ??
        (discovery && !declaredTimeout ? DEFAULT_DISCOVERY_IDLE_TIMEOUT_MS : undefined),
    );
    return {
      timeoutMs: connectionTimeoutMs(
        override?.timeoutMs ??
          sharedTimeoutMs ??
          (discovery ? DEFAULT_DISCOVERY_TIMEOUT_MS : undefined),
      ),
      maxResponseBytes: connectionMaxResponseBytes(
        override?.maxResponseBytes === undefined
          ? sharedMaxResponseBytes
          : override.maxResponseBytes,
      ),
      ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
    };
  };
  return { discovery: resolve('discovery'), call: resolve('call') };
}

/** Arbitrary request names cannot become diagnostic strings carrying secrets. */
export function mcpOperation(method: string): ConnectionOperation {
  switch (method) {
    case 'initialize':
    case 'notifications/initialized':
    case 'tools/list':
    case 'tools/call':
      return method;
    default:
      return 'request';
  }
}

export function connectionReadContext(
  operation: ConnectionOperation,
  limits: McpPhaseLimits,
): ConnectionReadContext {
  const phase: ConnectionPhase =
    operation === 'initialize' ||
    operation === 'notifications/initialized' ||
    operation === 'tools/list' ||
    operation === 'endpoint' ||
    operation === 'openapi/spec'
      ? 'discovery'
      : 'call';
  return { ...limits[phase], phase, operation, observedReadBytes: 0 };
}
