/**
 * Faithful model of React Native 0.88.1 `Libraries/Core/setUpXHR.js` +
 * `src/private/webapis/dom/abort-api/{AbortController,AbortSignal}.js` +
 * `src/private/webapis/dom/events/EventTarget.js`:
 * - Exposes `AbortController` and `AbortSignal` (`AbortSignal.abort`,
 *   `AbortSignal.timeout`, `AbortSignal.any`, `{ once: true }`, `{ signal }`).
 * - Refuses direct `new AbortSignal()` construction with `TypeError`.
 * - Does NOT install global `DOMException` (RN 0.88.1 keeps `DOMException` internal
 *   to `src/private/webapis/errors/DOMException.js`, so default abort/timeout reasons
 *   are `Error` instances with `.name = 'AbortError' | 'TimeoutError'`).
 *
 * Shared by both the Level-1 `node:vm` RN realm tests (`tests/rn-realm/rn-realm.ts`)
 * and the real Hermes V1 VM consumer proof (`handler-hermes.mjs`).
 */
((g) => {
  const INTERNAL = Symbol('rnAbortSignal');

  const createAbortException = (message, name) => {
    const error = new Error(message);
    error.name = name;
    return error;
  };

  const invokeListener = (target, listener, event) => {
    if (typeof listener === 'function') listener.call(target, event);
    else if (listener && typeof listener.handleEvent === 'function')
      listener.handleEvent(event);
  };

  class RnAbortSignal {
    constructor(token) {
      if (token !== INTERNAL) {
        throw new TypeError("Failed to construct 'AbortSignal': Illegal constructor");
      }
      this._aborted = false;
      this._reason = undefined;
      this._onabort = null;
      this._listeners = new Map();
    }

    static abort(reason) {
      const signal = new RnAbortSignal(INTERNAL);
      signal._abort(reason);
      return signal;
    }

    static timeout(timeInMs) {
      if (!(timeInMs >= 0)) {
        throw new TypeError(
          "Failed to execute 'timeout' on 'AbortSignal': The provided value has to be a non-negative number.",
        );
      }
      const controller = new RnAbortController();
      g.setTimeout(
        () => controller.abort(createAbortException('signal timed out', 'TimeoutError')),
        timeInMs,
      );
      return controller.signal;
    }

    static any(signals) {
      if (!Array.isArray(signals)) {
        throw new TypeError('The signals value must be an instance of Array');
      }
      for (let i = 0; i < signals.length; i += 1) {
        if (!(signals[i] instanceof RnAbortSignal)) {
          throw new TypeError(
            `The "signals[${i}]" argument must be an instance of AbortSignal`,
          );
        }
      }
      for (let i = 0; i < signals.length; i += 1) {
        if (signals[i].aborted) return RnAbortSignal.abort(signals[i].reason);
      }
      const controller = new RnAbortController();
      const unsubscribes = [];
      const cleanup = () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
      for (let i = 0; i < signals.length; i += 1) {
        const source = signals[i];
        const onAbort = () => {
          controller.abort(source.reason);
          cleanup();
        };
        source.addEventListener('abort', onAbort, { once: true });
        unsubscribes.push(() => source.removeEventListener('abort', onAbort));
      }
      return controller.signal;
    }

    get aborted() {
      return this._aborted;
    }

    get reason() {
      return this._reason;
    }

    get onabort() {
      return this._onabort;
    }

    set onabort(listener) {
      this._onabort = typeof listener === 'function' ? listener : null;
    }

    throwIfAborted() {
      if (this._aborted) throw this._reason;
    }

    addEventListener(type, listener, options) {
      if (listener === null || listener === undefined) return;
      const opts = typeof options === 'object' && options !== null ? options : undefined;
      const listenerSignal = opts?.signal;
      if (listenerSignal?.aborted) return;

      let bucket = this._listeners.get(type);
      if (!bucket) {
        bucket = new Map();
        this._listeners.set(type, bucket);
      }
      if (bucket.has(listener)) return;

      const entry = {
        callback: listener,
        once: Boolean(opts?.once),
        removed: false,
      };
      bucket.set(listener, entry);

      if (listenerSignal) {
        listenerSignal.addEventListener(
          'abort',
          () => this.removeEventListener(type, listener),
          { once: true },
        );
      }
    }

    removeEventListener(type, listener) {
      const bucket = this._listeners.get(type);
      if (!bucket) return;
      const entry = bucket.get(listener);
      if (!entry) return;
      entry.removed = true;
      bucket.delete(listener);
    }

    _abort(reason) {
      if (this._aborted) return;
      this._aborted = true;
      this._reason =
        reason === undefined
          ? createAbortException('signal is aborted without reason', 'AbortError')
          : reason;
      const event = { type: 'abort', target: this, currentTarget: this };
      if (typeof this._onabort === 'function') this._onabort.call(this, event);
      const bucket = this._listeners.get('abort');
      if (!bucket) return;
      for (const entry of Array.from(bucket.values())) {
        if (entry.removed) continue;
        if (entry.once) {
          entry.removed = true;
          bucket.delete(entry.callback);
        }
        invokeListener(this, entry.callback, event);
      }
    }
  }

  Object.defineProperty(RnAbortSignal.prototype, Symbol.toStringTag, {
    configurable: true,
    value: 'AbortSignal',
  });

  class RnAbortController {
    constructor() {
      this._signal = new RnAbortSignal(INTERNAL);
    }

    get signal() {
      return this._signal;
    }

    abort(reason) {
      this._signal._abort(reason);
    }
  }

  Object.defineProperty(RnAbortController.prototype, Symbol.toStringTag, {
    configurable: true,
    value: 'AbortController',
  });

  g.AbortController = RnAbortController;
  g.AbortSignal = RnAbortSignal;
})(globalThis);
