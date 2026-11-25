import {
  UNIX_CLIENT_DELIVERY_STATES,
  UNIX_CLIENT_TRANSPORT_ERROR_CODES,
  UNIX_CLIENT_TRANSPORT_ERROR_NAME,
  type UnixClientDeliveryState,
  type UnixClientTransportErrorCode,
} from '../../internal/unix-client-error';
import { type ToolFailure, toolCauseFromResult } from '../execute-result';

const MAX_CAUSE_DEPTH = 16;

const UNIX_ERROR_CODES: ReadonlySet<string> = new Set(UNIX_CLIENT_TRANSPORT_ERROR_CODES);
const UNIX_DELIVERY_STATES: ReadonlySet<string> = new Set(UNIX_CLIENT_DELIVERY_STATES);

interface FoundUnixError {
  readonly code: UnixClientTransportErrorCode;
  readonly delivery: UnixClientDeliveryState;
  readonly message: string;
  readonly causeCode?: string;
  readonly socketPath?: string;
}

function ownString(value: object, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function isUnixErrorCode(value: string | undefined): value is UnixClientTransportErrorCode {
  return value !== undefined && UNIX_ERROR_CODES.has(value);
}

function isUnixDeliveryState(value: string | undefined): value is UnixClientDeliveryState {
  return value !== undefined && UNIX_DELIVERY_STATES.has(value);
}

/** Walk an error's cause chain to find a `UnixClientTransportError` without invoking getters. */
function findUnixTransportError(root: unknown): FoundUnixError | undefined {
  const visited = new Set<unknown>();
  let current: unknown = root;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (typeof current !== 'object' || current === null || visited.has(current))
      return undefined;
    visited.add(current);
    if (
      current instanceof Error &&
      ownString(current, 'name') === UNIX_CLIENT_TRANSPORT_ERROR_NAME
    ) {
      const code = ownString(current, 'code');
      const delivery = ownString(current, 'delivery');
      if (isUnixErrorCode(code) && isUnixDeliveryState(delivery)) {
        const inner = current.cause;
        const causeCode =
          typeof inner === 'object' && inner !== null ? ownString(inner, 'code') : undefined;
        const causePath =
          typeof inner === 'object' && inner !== null ? ownString(inner, 'path') : undefined;
        const socketPath = ownString(current, 'socketPath') ?? causePath;
        return {
          code,
          delivery,
          message: current.message,
          ...(causeCode !== undefined && { causeCode }),
          ...(socketPath !== undefined && { socketPath }),
        };
      }
    }
    current = 'cause' in current ? Reflect.get(current, 'cause') : undefined;
  }
  return undefined;
}

function notDispatchedMessage(found: FoundUnixError): string {
  if (found.code === 'UNIX_CONNECT_FAILED') {
    const target = found.socketPath ? `"${found.socketPath}"` : 'the unix socket';
    const suffix = found.causeCode ? ` (${found.causeCode})` : '';
    return `Not executed: application is not listening on ${target}${suffix}`;
  }
  if (found.code === 'UNIX_TARGET_REFUSED') {
    return `Not executed: unix socket target refused — ${found.message}`;
  }
  return `Not executed: ${found.message}`;
}

function notDispatchedHint(code: UnixClientTransportErrorCode): string {
  if (code === 'UNIX_CONNECT_FAILED') {
    return 'The request was not executed because the application is not listening; start the application and retry.';
  }
  if (code === 'UNIX_TARGET_REFUSED') {
    return 'The request was not executed; check the unix socket path, owner and directory permissions.';
  }
  return 'The request was not dispatched to the application.';
}

/**
 * Reclassify a generic remote transport failure backed by `UnixClientTransportError`
 * into its explicit delivery outcome (`not-dispatched`, `possibly-dispatched`, or
 * `response-received`) so the CLI emits distinct exit codes and diagnostics.
 */
export function projectCliUnixFailure(result: ToolFailure): ToolFailure {
  const found = findUnixTransportError(toolCauseFromResult(result));
  if (!found) return result;
  if (found.delivery === 'not-dispatched') {
    return {
      ok: false,
      code: found.code,
      details: {
        message: notDispatchedMessage(found),
        delivery: 'not-dispatched',
        ...(found.socketPath !== undefined && { socketPath: found.socketPath }),
        ...(found.causeCode !== undefined && { errno: found.causeCode }),
      },
      hint: notDispatchedHint(found.code),
      retryable: found.code === 'UNIX_CONNECT_FAILED',
    };
  }
  if (found.delivery === 'possibly-dispatched') {
    const code =
      found.code === 'UNIX_HEADERS_TIMEOUT'
        ? 'UNIX_HEADERS_TIMEOUT'
        : 'UNIX_DELIVERY_UNCERTAIN';
    const message =
      found.code === 'UNIX_HEADERS_TIMEOUT'
        ? `Outcome unknown, not retried: ${found.message}`
        : `Outcome unknown, not retried: connection closed after the request was sent (${found.message})`;
    return {
      ok: false,
      code,
      details: {
        message,
        delivery: 'possibly-dispatched',
        ...(found.socketPath !== undefined && { socketPath: found.socketPath }),
      },
      hint: 'The request may have been executed by the application before the connection closed; inspect state before retrying.',
      retryable: false,
    };
  }
  return {
    ok: false,
    code: found.code,
    details: {
      message: found.message,
      delivery: 'response-received',
    },
    retryable: false,
  };
}
