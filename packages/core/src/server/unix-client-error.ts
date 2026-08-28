/** Stable failure codes emitted by the explicit Unix client transport. */
export type UnixClientTransportErrorCode =
  | 'UNIX_CLIENT_CLOSED'
  | 'UNIX_CONNECT_FAILED'
  | 'UNIX_DELIVERY_UNCERTAIN'
  | 'UNIX_HEADERS_TIMEOUT'
  | 'UNIX_HEADERS_TOO_LARGE'
  | 'UNIX_CONNECTION_LIMIT'
  | 'UNIX_REDIRECT_REFUSED'
  | 'UNIX_REQUEST_TOO_LARGE'
  | 'UNIX_RESPONSE_TOO_LARGE'
  | 'UNIX_RESPONSE_ABORTED';

export type UnixClientDeliveryState =
  | 'not-dispatched'
  | 'possibly-dispatched'
  | 'response-received';

export class UnixClientTransportError extends Error {
  constructor(
    public readonly code: UnixClientTransportErrorCode,
    message: string,
    public readonly delivery: UnixClientDeliveryState = 'possibly-dispatched',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'UnixClientTransportError';
  }
}
