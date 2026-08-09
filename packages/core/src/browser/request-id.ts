const REQUEST_ID_HEADER = 'x-request-id';

/** Read the framework-owned request correlation id from an HTTP response. */
export function responseTraceId(response: Response | undefined): string | undefined {
  return response?.headers.get(REQUEST_ID_HEADER) ?? undefined;
}
