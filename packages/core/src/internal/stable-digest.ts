/**
 * A stable identity for a call's arguments — one implementation, two callers.
 *
 * Two callers need the same thing for different reasons. The MCP round keys a
 * tool invocation by `(operation, arguments)` so a retry is recognised as the
 * same round; a watched read keys its shared source by `(operation, arguments)`
 * so two browsers asking the same question are one read on the server. If those
 * two computed the key differently, the same arguments would be the same round
 * and two different watches — and nothing would say so.
 *
 * The stability that matters is key order: `{a:1,b:2}` and `{b:2,a:1}` are the
 * same arguments and `JSON.stringify` disagrees, so a naive key silently splits
 * one shared source into two whenever a caller builds its object in a different
 * order. That is not a hypothetical: object literal order follows the source
 * that wrote it, and two components asking the same question rarely share one.
 *
 * ## Why this is not SHA-256
 *
 * It was, and that made every watched read fail on an ordinary intranet. Web
 * Crypto — `crypto.subtle` — exists only in a **secure context**, so a page
 * served over plain HTTP from a LAN name has no `crypto.subtle` at all and the
 * first digest throws `Cannot read properties of undefined`. `localhost` is
 * secure by definition, which is exactly why nothing caught it until a browser
 * opened the app by its name.
 *
 * The fix is not a fallback, it is admitting what this is for: **identity, not
 * secrecy**. Nothing here resists an adversary — an attacker who can choose your
 * watch arguments can already ask the question directly. So the requirement is
 * distribution and determinism, both ends agreeing, and no ambient capability;
 * a cryptographic hash bought none of that and cost the entire non-secure web.
 *
 * Being synchronous is the second thing it buys. A promise for a key made the
 * first subscription of a question asynchronous, which meant a component could
 * not be handed a retained value in the same turn it subscribed.
 */

/**
 * The value with every object's keys sorted, recursively — arrays keep their
 * order, because in an array order *is* the value.
 *
 * `Object.keys` returns own enumerable keys only, so nothing from a prototype
 * reaches the digest.
 */
export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = stableValue(Reflect.get(value, key));
  }
  return result;
}

/**
 * 128 bits over a string, as four mixed 32-bit lanes.
 *
 * Four lanes rather than one because a collision here is not a slow path, it is
 * **two different questions sharing one answer** — at 32 bits a few thousand
 * live keys would collide about as often as a coin lands twice, and at 128 the
 * question stops being worth asking. Each lane starts from its own constant and
 * mixes with its own multiplier, so they do not move together.
 */
function mix128(input: string): [number, number, number, number] {
  let a = 0x9e3779b9;
  let b = 0x85ebca6b;
  let c = 0xc2b2ae35;
  let d = 0x27d4eb2f;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    a = Math.imul(a ^ code, 0x85ebca77);
    b = Math.imul(b ^ code, 0xc2b2ae3d);
    c = Math.imul(c ^ code, 0x27d4eb2f);
    d = Math.imul(d ^ code, 0x165667b1);
    a = (a << 13) | (a >>> 19);
    b = (b << 17) | (b >>> 15);
    c = (c << 7) | (c >>> 25);
    d = (d << 11) | (d >>> 21);
  }
  // A final avalanche per lane, then one cross-mix, so a change in the last
  // character reaches every lane rather than only the one it landed in.
  a ^= b >>> 15;
  b ^= c >>> 13;
  c ^= d >>> 11;
  d ^= a >>> 9;
  return [
    Math.imul(a ^ (a >>> 16), 0x2246f4b3) >>> 0,
    Math.imul(b ^ (b >>> 13), 0x9e3779b1) >>> 0,
    Math.imul(c ^ (c >>> 16), 0x85ebca6b) >>> 0,
    Math.imul(d ^ (d >>> 15), 0xc2b2ae35) >>> 0,
  ];
}

/**
 * A bounded, order-independent identity for a call's arguments.
 *
 * 128 bits as 32 lowercase hex characters. Deterministic across runtimes and
 * across both ends of a socket, synchronous, and dependent on no ambient
 * capability — see the module header for why that last one is the whole point.
 *
 * What it cannot do, stated because the limit is easy to walk into: values
 * `JSON.stringify` drops or transforms — `undefined` members, a `Date`, a `Map`,
 * a `BigInt` (which throws) — are not distinguished, or not survivable, here.
 * Contract arguments are parsed JSON, so this is the argument shape by
 * construction; a caller digesting something else has to say what it means.
 */
export function argumentsDigest(args: Record<string, unknown>): string {
  const lanes = mix128(JSON.stringify(stableValue(args)) ?? 'undefined');
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}
