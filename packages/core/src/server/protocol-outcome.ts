/**
 * A `4xx` that a protocol prescribes as an ordinary answer — not a refusal of a
 * malformed or unauthorised request. A Streamable HTTP MCP endpoint without an
 * event stream answers the stream-opening `GET` with `405`; the client reads it
 * as "no stream here" and carries on. The request line must not call that a
 * warning, and it must not learn which paths or methods are which: the code that
 * built the answer knows, so it marks the `Response`, and the line reads the mark.
 *
 * The mark lives beside the object, not in it — no header reaches the client and
 * a caller cannot forge one. A response rebuilt from a marked one is unmarked, so a
 * wrapper that copies the answer gets the ordinary level back, never a quieter one.
 */

const protocolOutcomes = new WeakSet<Response>();

/** Mark `response` as a protocol outcome. Only a `4xx` is lowered; anything else logs by status. */
export function markProtocolOutcome(response: Response): Response {
  protocolOutcomes.add(response);
  return response;
}

/** Whether the code that built `response` marked it as a protocol outcome. */
export function isProtocolOutcome(response: Response): boolean {
  return protocolOutcomes.has(response);
}
