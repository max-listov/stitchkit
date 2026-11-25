/**
 * Compare two secrets without saying where, or whether in length, they differ.
 *
 * A plain `===` returns at the first byte that disagrees, so the time it took
 * measures how much of the guess was right. This walks the longer of the two
 * every time and folds a length mismatch into the same result, so a caller
 * learns only "equal" or "not". Pure JavaScript: it runs in a browser, Hermes,
 * Bun and Node alike.
 */
export function secretsEqual(given: string, expected: string): boolean {
  const length = Math.max(given.length, expected.length);
  let difference = given.length ^ expected.length;
  for (let index = 0; index < length; index += 1) {
    const a = index < given.length ? given.charCodeAt(index) : 0;
    const b = index < expected.length ? expected.charCodeAt(index) : 0;
    difference |= a ^ b;
  }
  return difference === 0;
}
