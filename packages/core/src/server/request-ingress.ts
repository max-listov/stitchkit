/** What a context hands back about its request: the `Request` the handler of the core received. */
export interface RequestIngressSource {
  readonly req?: Request | undefined;
}

/**
 * A typed channel for facts about a request that the request itself cannot carry: the code that
 * built the `Request` (a local socket ingress, a relay, a test harness) attaches a value, and the
 * endpoint reads it from its context.
 *
 * Nothing on the wire reaches it. A header, a body, `clone()` and `new Request(request)` are other
 * channels or other objects, so a request from another ingress simply has no value. Only the code
 * that holds the key can attach or read; two keys never meet, even with the same name.
 */
export interface RequestIngress<T> {
  /** For messages only; the key is its own identity. */
  readonly name: string;
  /**
   * Attach `value` to `request` before it is handed to the fetch handler of the core. A request
   * carries one value per key: a second `attach` is refused, never merged or replaced.
   */
  attach(request: Request, value: T): void;
  /**
   * The value attached to the request behind `source`, or `undefined` when there is none — in an
   * endpoint handler, `authorize`, `beforeHandle` and `onError` (`ctx` is the source). `ctx.req`
   * is the `Request` the handler of the core received, which is what makes this lookup sound.
   */
  from(source: RequestIngressSource): T | undefined;
}

/** Define a key for request attributes an ingress attaches and an endpoint reads. */
export function defineRequestIngress<T>(name: string): RequestIngress<T> {
  const values = new WeakMap<Request, T>();
  return {
    name,
    attach(request, value) {
      if (values.has(request)) {
        throw new TypeError(
          `[stitchkit] request ingress ${JSON.stringify(name)} is already attached to this request`,
        );
      }
      values.set(request, value);
    },
    from(source) {
      return source.req && values.get(source.req);
    },
  };
}
