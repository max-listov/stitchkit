import type { ClientFetch } from './transport';

/** An operation's originating login has ended. Never an auth-refresh instruction. */
export class SessionExpiredError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The originating session is no longer active', options);
    this.name = 'SessionExpiredError';
  }
}

export interface SessionOperation<T> {
  readonly context: T;
  readonly id: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  current(): boolean;
  assertCurrent(): void;
  /** Check before and after an asynchronous boundary, including its rejection. No retry. */
  run<R>(operation: () => R | PromiseLike<R>): Promise<R>;
  /** Synchronous application/transport boundary. False means nothing was delivered. */
  deliver(delivery: () => void): boolean;
  /** Guards every fetch attempt; wrap the whole generated-client call in run() as well. */
  bindFetch(fetch: ClientFetch, headers?: () => HeadersInit): ClientFetch;
}

export interface SessionScope<T> {
  readonly generation: number;
  replace(context: T): SessionOperation<T>;
  clear(): void;
  stop(): void;
  capture(): SessionOperation<T>;
  /** Also verifies that the operation belongs to this scope. */
  owns(operation: SessionOperation<T>): boolean;
}

/** One host's login lifetime. Context must be treated as immutable by its owner. */
export function createSessionScope<T>(): SessionScope<T> {
  let generation = 0;
  let stopped = false;
  let active: SessionOperation<T> | undefined;
  let abort: AbortController | undefined;
  const invalidate = () => {
    const previous = abort;
    generation += 1;
    active = undefined;
    abort = undefined;
    previous?.abort(new SessionExpiredError());
  };
  return {
    get generation() {
      return generation;
    },
    replace(context) {
      if (stopped) throw new SessionExpiredError();
      const previous = abort;
      generation += 1;
      const controller = new AbortController();
      abort = controller;
      const id = generation;
      const current = () => !stopped && generation === id && !controller.signal.aborted;
      const assertCurrent = () => {
        if (!current()) throw new SessionExpiredError();
      };
      const operation: SessionOperation<T> = {
        context,
        id: crypto.randomUUID(),
        generation: id,
        signal: controller.signal,
        current,
        assertCurrent,
        async run(work) {
          assertCurrent();
          try {
            const result = await work();
            assertCurrent();
            return result;
          } catch (error) {
            // The session ended while the work failed: that is the answer, and
            // the failure stays attached as why the work itself stopped.
            if (!current()) throw new SessionExpiredError({ cause: error });
            throw error;
          }
        },
        deliver(delivery) {
          if (!current()) return false;
          delivery();
          return true;
        },
        bindFetch(fetch, headers) {
          return async (input, init) => {
            assertCurrent();
            const request = new Request(input, init);
            const extra = headers?.();
            assertCurrent();
            if (extra)
              new Headers(extra).forEach((value, key) => {
                request.headers.set(key, value);
              });
            const signal = AbortSignal.any([controller.signal, request.signal]);
            return operation.run(() => fetch(new Request(request, { signal })));
          };
        },
      };
      active = Object.freeze(operation);
      previous?.abort(new SessionExpiredError());
      return operation;
    },
    clear: invalidate,
    stop() {
      stopped = true;
      invalidate();
    },
    capture() {
      if (!active) throw new SessionExpiredError();
      return active;
    },
    owns(operation) {
      return active === operation && operation.current();
    },
  };
}
