/**
 * An `AbortError` or `TimeoutError` as the platform spells it.
 *
 * Browsers, Bun and Node raise a `DOMException` with that name. React Native has no global
 * `DOMException`, so the same refusal there is an `Error` carrying the name: everything that
 * reads these errors reads `name`, never the class.
 */
export function abortError(
  message: string,
  name: 'AbortError' | 'TimeoutError' = 'AbortError',
): Error {
  if (typeof DOMException === 'function') return new DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}
