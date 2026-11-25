/**
 * The integer rules of a limit, a count or a position: a positive safe integer, or a
 * non-negative one. The one place each rule and its message live. `name` is the full
 * subject of the message ("maxBytes", "Contract \"x\" maxJsonBodyBytes"); `errorType` is
 * the error class the owning API already throws; `undefined` means "not set" and passes,
 * unless the option says `absent: 'refused'` for a value the caller must give.
 */
type ErrorType = new (message: string) => Error;

interface IntegerOptions {
  readonly absent?: 'passes' | 'refused';
}

function assertSafeIntegerFrom(
  least: 0 | 1,
  rule: string,
  name: string,
  value: number | undefined,
  errorType: ErrorType,
  options: IntegerOptions,
): void {
  if (value === undefined && options.absent !== 'refused') return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < least)
    throw new errorType(`${name} ${rule}, received ${value}`);
}

/** Return whether `value` is a positive safe integer (`>= 1`). */
export function isPositiveSafeInteger(value: unknown): value is number {
  const least = 1;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= least;
}

/** Refuse a limit that is not a positive safe integer. */
export function assertPositiveSafeInteger(
  name: string,
  value: number | undefined,
  errorType: ErrorType = TypeError,
  options: IntegerOptions = {},
): void {
  assertSafeIntegerFrom(1, 'must be a positive safe integer', name, value, errorType, options);
}

/** Refuse a count or a position that is not a non-negative safe integer. */
export function assertNonNegativeSafeInteger(
  name: string,
  value: number | undefined,
  errorType: ErrorType = TypeError,
  options: IntegerOptions = {},
): void {
  assertSafeIntegerFrom(
    0,
    'must be a non-negative safe integer',
    name,
    value,
    errorType,
    options,
  );
}
