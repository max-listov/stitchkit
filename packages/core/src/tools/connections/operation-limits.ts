import { connectionMaxResponseBytes, connectionTimeoutMs } from './limits';
import type { ConnectionOperation, ConnectionPhase, McpConnectionLimits } from './types';

export interface ResolvedConnectionLimits {
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface ConnectionReadContext extends ResolvedConnectionLimits {
  operation: ConnectionOperation;
  phase: ConnectionPhase;
  observedReadBytes: number;
  signal?: AbortSignal;
}

export interface McpPhaseLimits {
  discovery: ResolvedConnectionLimits;
  call: ResolvedConnectionLimits;
}

/** Resolve and validate once at the connection boundary, including unused phases. */
export function resolveMcpLimits(config: {
  timeoutMs?: number;
  maxResponseBytes?: number;
  limits?: McpConnectionLimits;
}): McpPhaseLimits {
  const shared = {
    timeoutMs: connectionTimeoutMs(config.timeoutMs),
    maxResponseBytes: connectionMaxResponseBytes(config.maxResponseBytes),
  };
  const resolve = (phase: ConnectionPhase): ResolvedConnectionLimits => {
    const override = config.limits?.[phase];
    return {
      timeoutMs: connectionTimeoutMs(
        override?.timeoutMs === undefined ? shared.timeoutMs : override.timeoutMs,
      ),
      maxResponseBytes: connectionMaxResponseBytes(
        override?.maxResponseBytes === undefined
          ? shared.maxResponseBytes
          : override.maxResponseBytes,
      ),
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
