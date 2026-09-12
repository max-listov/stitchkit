import { isRecord } from '../../internal/typed';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
}

export function unwrap(payload: unknown, id: number, connectionName: string): unknown {
  if (!isRecord(payload) || payload.id !== id)
    throw new Error(`MCP response id mismatch from "${connectionName}"`);
  if (isRecord(payload.error))
    throw new Error(
      `MCP error from "${connectionName}": ${typeof payload.error.message === 'string' ? payload.error.message : 'unknown'}`,
    );
  return payload.result;
}
