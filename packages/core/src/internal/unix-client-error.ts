/** Own `name` tag on `UnixClientTransportError` instances. */
export const UNIX_CLIENT_TRANSPORT_ERROR_NAME = 'UnixClientTransportError' as const;

/** Every failure code the explicit Unix client transport emits: the one list its readers share. */
export const UNIX_CLIENT_TRANSPORT_ERROR_CODES = [
  'UNIX_CLIENT_CLOSED',
  'UNIX_CONNECT_FAILED',
  'UNIX_DELIVERY_UNCERTAIN',
  'UNIX_HEADERS_TIMEOUT',
  'UNIX_HEADERS_TOO_LARGE',
  'UNIX_CONNECTION_LIMIT',
  'UNIX_REDIRECT_REFUSED',
  'UNIX_REQUEST_TOO_LARGE',
  'UNIX_RESPONSE_TOO_LARGE',
  'UNIX_RESPONSE_ABORTED',
  'UNIX_TARGET_REFUSED',
] as const;

/** Stable failure codes emitted by the explicit Unix client transport. */
export type UnixClientTransportErrorCode = (typeof UNIX_CLIENT_TRANSPORT_ERROR_CODES)[number];

/** Every delivery state a Unix transport failure carries: the one list its readers share. */
export const UNIX_CLIENT_DELIVERY_STATES = [
  'not-dispatched',
  'possibly-dispatched',
  'response-received',
] as const;

/** How far a failed request got before the Unix client transport failed. */
export type UnixClientDeliveryState = (typeof UNIX_CLIENT_DELIVERY_STATES)[number];

export class UnixClientTransportError extends Error {
  public readonly socketPath?: string;

  constructor(
    public readonly code: UnixClientTransportErrorCode,
    message: string,
    public readonly delivery: UnixClientDeliveryState = 'possibly-dispatched',
    options?: ErrorOptions & { readonly socketPath?: string },
  ) {
    super(message, options);
    this.name = UNIX_CLIENT_TRANSPORT_ERROR_NAME;
    if (options?.socketPath !== undefined) this.socketPath = options.socketPath;
  }
}

/** Construct a `UnixClientTransportError` with `socketPath` and optional `cause` attached. */
export function unixTransportError(
  socketPath: string,
  code: UnixClientTransportErrorCode,
  message: string,
  delivery: UnixClientDeliveryState = 'possibly-dispatched',
  cause?: unknown,
): UnixClientTransportError {
  return new UnixClientTransportError(code, message, delivery, {
    socketPath,
    ...(cause !== undefined && { cause }),
  });
}
