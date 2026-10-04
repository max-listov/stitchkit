import { createCliInvoker } from 'stitchkit/cli';
import type { StitchErrorCode } from 'stitchkit/contract';
import {
  type ConnectionFailureContext,
  type ConnectionOperation,
  type ConnectionOperationLimits,
  type ConnectionPhase,
  ConnectionResponseTooLargeError,
  ConnectionTimeoutError,
  defineMcpClientConnection,
  type McpClientConnectionConfig,
  type McpConnectionLimits,
  mountConnections,
} from 'stitchkit/tools/connections';

const bounds: ConnectionOperationLimits = { timeoutMs: 100, maxResponseBytes: 4096 };
const limits: McpConnectionLimits = { discovery: bounds, call: { timeoutMs: 200 } };
const config: McpClientConnectionConfig = {
  name: 'packed',
  transport: { url: 'http://127.0.0.1:1/mcp' },
  timeoutMs: 100,
  maxResponseBytes: 1024,
  limits,
  transports: ['CLI'],
};
const definition = defineMcpClientConnection(config);
const mounted = mountConnections([definition]);
const compiled = mounted.then((runtimeTools) =>
  createCliInvoker({ name: 'packed', runtimeTools }),
);
const phase: ConnectionPhase = 'discovery';
const operation: ConnectionOperation = 'initialize';
const failureContext: ConnectionFailureContext = {
  phase,
  operation,
  observedReadBytes: 0,
};
const timeout = new ConnectionTimeoutError('packed', 100, failureContext);
const size = new ConnectionResponseTooLargeError('packed', 4096, {
  phase: 'call',
  operation: 'tools/call',
  observedReadBytes: 4097,
});
const read: number = timeout.observedReadBytes + size.observedReadBytes;
const known: StitchErrorCode[] = [
  'CONNECTION_TIMEOUT',
  'CONNECTION_RESPONSE_TOO_LARGE',
  'CONNECTION_REQUEST_FAILED',
  'UPSTREAM_TOOL_ERROR',
];
void [compiled, read, known];

// @ts-expect-error Phase names form a closed policy vocabulary.
const wrongPhase: ConnectionPhase = 'stream-lifetime';
// @ts-expect-error Operation diagnostics cannot contain arbitrary URLs.
const wrongOperation: ConnectionOperation = 'https://example.invalid/private';
// @ts-expect-error Bytes are numeric bounds.
const wrongBytes: ConnectionOperationLimits = { maxResponseBytes: 'unbounded' };
// @ts-expect-error Phase overrides retain the same numeric timeout shape.
const wrongTimeout: McpConnectionLimits = { call: { timeoutMs: 'forever' } };
// @ts-expect-error Only discovery and call are policy phases.
const wrongPolicy: McpConnectionLimits = { lifetime: bounds };
// @ts-expect-error Observed byte counts are readonly diagnostics.
size.observedReadBytes = 0;
// @ts-expect-error Failure construction also uses the fixed operation vocabulary.
const wrongContext: ConnectionFailureContext = { operation: 'secret remote endpoint' };
void [wrongPhase, wrongOperation, wrongBytes, wrongTimeout, wrongPolicy, wrongContext];
