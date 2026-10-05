/**
 * Refuse a limit that is not a positive safe integer; `undefined` means "not set" and passes.
 *
 * The one place the rule and its message live. `name` is the full subject of the
 * message ("maxBytes", "Contract \"x\" maxJsonBodyBytes"); `errorType` is the error
 * class the owning API already throws.
 */
export function assertPositiveSafeInteger(
  name: string,
  value: number | undefined,
  errorType: new (message: string) => Error = TypeError,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new errorType(`${name} must be a positive safe integer, received ${value}`);
  }
}
