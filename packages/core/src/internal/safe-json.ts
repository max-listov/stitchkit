/**
 * Prototype-pollution defence for untrusted input. Assigning a `__proto__` key
 * onto a plain object (`obj[key] = value`, a JSON reviver, a merge) invokes the
 * `__proto__` setter and rewires the prototype chain — the single real
 * pollution vector at an assignment boundary. `constructor` / `prototype` as
 * plain own keys are inert (they shadow, they do not poison), so they are NOT
 * stripped — dropping them would silently corrupt legitimate data fields.
 *
 * Every boundary that ingests client-controlled keys (JSON bodies, query
 * strings, cookies, multipart fields, tool arguments) routes through here.
 */

/** True for a key that must never be copied onto a plain object from untrusted input. */
export function isUnsafeKey(key: string): boolean {
  return key === '__proto__';
}

/**
 * `JSON.parse` that strips the `__proto__` key from the result. Throws on
 * invalid JSON, exactly like `JSON.parse` — callers handle that as a 400.
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, value) => (isUnsafeKey(key) ? undefined : value));
}
