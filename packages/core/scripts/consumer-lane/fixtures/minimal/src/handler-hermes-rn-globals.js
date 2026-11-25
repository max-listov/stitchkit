/**
 * Minimal React Native 0.88 host globals prelude for the standalone Hermes V1 CLI.
 *
 * Exposes ONLY globals present in React Native 0.88 (plus `react-native-get-random-values`):
 * - `window` / `self` / `global` aliases
 * - `process = { env: {} }` (no `hrtime`, no `versions`, no `getBuiltinModule`)
 * - `console` levels backed by Hermes `print`
 * - due-ordered timers on a virtual clock (Hermes CLI fires timers ignoring delay)
 * - `performance.now` and `queueMicrotask`
 * - `crypto.getRandomValues` only (no `randomUUID`)
 *
 * `AbortController`/`AbortSignal` (`handler-hermes-rn-abort.js`) and `URL`/`URLSearchParams`
 * (`handler-hermes-rn-url.js`) live in their own shared RN 0.88.1 prelude modules.
 *
 * Deliberately omits `Buffer`, `DOMException`, `MessageChannel`, `ReadableStream`,
 * `setImmediate`, and all `node:*` APIs. Hermes V1's built-in `TextEncoder`/`TextDecoder`
 * remain available because `stitchkit/http` (`ky`) constructs `TextEncoder` at load time
 * (bare `stitchkit/handler` without `TextEncoder`/`TextDecoder` is proven separately by
 * `tests/rn-realm/rn-realm.test.ts`).
 */
((g) => {
  g.window = g;
  g.self = g;
  g.global = g;
  g.process = { env: {} };
  // Standalone Hermes CLI pre-populates `setImmediate`; React Native 0.88 does not.
  delete g.setImmediate;

  if (typeof g.console !== 'object' || g.console === null) g.console = {};
  ['log', 'info', 'debug', 'warn', 'error'].forEach((level) => {
    if (typeof g.console[level] !== 'function') {
      g.console[level] = (...args) => {
        const parts = args.map((arg) => (arg?.stack ? arg.stack : String(arg)));
        print(`[${level}] ${parts.join(' ')}`);
      };
    }
  });

  // The Hermes CLI fires every timer immediately regardless of delay. Order timers
  // by virtual due time so request timeouts cannot overtake the bridge reply.
  const hostSetTimeout = g.setTimeout;
  let timers = [];
  let clock = 0;
  let nextId = 0;
  let pumping = false;

  const schedule = () => {
    if (!pumping && timers.length > 0) {
      pumping = true;
      hostSetTimeout(pump, 0);
    }
  };

  const pump = () => {
    pumping = false;
    if (timers.length === 0) return;
    timers.sort((a, b) => a.due - b.due || a.id - b.id);
    const timer = timers.shift();
    if (timer.due > clock) clock = timer.due;
    if (timer.every !== undefined) {
      timer.due = clock + timer.every;
      timers.push(timer);
    }
    timer.callback.apply(undefined, timer.args);
    schedule();
  };

  const add = (callback, ms, args, every) => {
    const id = ++nextId;
    const delay = Math.max(0, Number(ms) || 0);
    timers.push({
      id,
      due: clock + delay,
      callback,
      args,
      every: every === undefined ? undefined : Math.max(1, delay),
    });
    schedule();
    return id;
  };

  const clear = (id) => {
    timers = timers.filter((timer) => timer.id !== id);
  };

  g.setTimeout = (callback, ms, ...args) => add(callback, ms, args);
  g.setInterval = (callback, ms, ...args) => add(callback, ms, args, ms);
  g.clearTimeout = clear;
  g.clearInterval = clear;
  g.performance = { now: () => clock };
  if (typeof g.queueMicrotask !== 'function') {
    g.queueMicrotask = (callback) => {
      Promise.resolve().then(callback);
    };
  }

  // react-native-get-random-values: `getRandomValues` only, no `randomUUID`.
  g.crypto = {
    getRandomValues: (array) => {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
      return array;
    },
  };
})(globalThis);
