import type { ClientFetch } from './transport';

const NATIVE_FETCH_SOURCE = /^function fetch\(\)\s*\{\s*\[native code\]\s*\}$/;

/** Detect before binding: copied fetch properties do not make a patch native. */
function isNativeBunFetch(candidate: ClientFetch): boolean {
  const bun = Reflect.get(globalThis, 'Bun');
  return (
    typeof bun === 'object' &&
    bun !== null &&
    NATIVE_FETCH_SOURCE.test(Function.prototype.toString.call(candidate))
  );
}

/**
 * The client owns its whole-request/open deadline through AbortSignal. Bun's
 * independent idle timer must not end a native request before that deadline.
 * Explicit transports and patched global fetch keep their own delivery policy.
 */
export function resolveClientFetch(explicitFetch?: ClientFetch): ClientFetch {
  if (explicitFetch !== undefined) return explicitFetch;
  const defaultFetch = globalThis.fetch;
  const nativeBun = isNativeBunFetch(defaultFetch);
  const transport = defaultFetch.bind(globalThis);
  if (!nativeBun) return transport;
  return (input, init) => {
    const nativeInit: RequestInit & { timeout: number } = { ...init, timeout: 0 };
    return transport(input, nativeInit);
  };
}
