/**
 * Level-1 React Native 0.88 / Hermes execution realm in `node:vm`.
 *
 * Bundles Stitchkit entrypoints with `--target=browser --format=iife` and runs
 * them inside a fresh VM context populated ONLY with globals present in React
 * Native 0.88 (`whatwg-fetch@3.6.20`, RN's `URL`/`URLSearchParams`,
 * `AbortController`/`AbortSignal`, timers, `performance`, optional `process.env`
 * and optional `crypto.getRandomValues` polyfill). No `Buffer`, no `setImmediate`,
 * no `ReadableStream`, no `Response.json`, no `URL.canParse`, no `crypto.randomUUID`,
 * no `process.hrtime`, no `process.getBuiltinModule`, no global `DOMException`
 * (React Native takes `fetch`, `Headers`, `Request` and `Response` from `whatwg-fetch`
 * and nothing else). The engine is V8, not Hermes: this realm proves which globals the
 * code needs, not how Hermes runs it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const CORE_ROOT = resolve(import.meta.dir, '../..');
const WHATWG_FETCH_UMD = readFileSync(
  resolve(CORE_ROOT, 'node_modules/whatwg-fetch/dist/fetch.umd.js'),
  'utf8',
);

const RN_ABORT_POLYFILL_SOURCE = readFileSync(
  resolve(CORE_ROOT, 'scripts/consumer-lane/fixtures/minimal/src/handler-hermes-rn-abort.js'),
  'utf8',
);

const RN_URL_POLYFILL_SOURCE = readFileSync(
  resolve(CORE_ROOT, 'scripts/consumer-lane/fixtures/minimal/src/handler-hermes-rn-url.js'),
  'utf8',
);

export interface RnRealmOptions {
  /** Install `whatwg-fetch@3.6.20` globals (`fetch`, `Headers`, `Request`, `Response`, without `DOMException`). Default `true`. */
  withWhatwgFetch?: boolean;
  /** Install Web Crypto `getRandomValues` polyfill ONLY (no `randomUUID`). Default `true`. */
  withCryptoGetRandomValues?: boolean;
  /** Install RN-style `process = { env: {} }`, or a custom `process` value, or `false` to omit `process`. Default `true`. */
  process?: boolean | Record<string, unknown>;
  /** Install `TextEncoder` and `TextDecoder`. Default `false` to prove they are not required at load or for JSON requests. */
  withTextEncoding?: boolean;
  /** Install `ReadableStream`. Default `false`. */
  withReadableStream?: boolean;
}

export interface RnRealm {
  readonly context: vm.Context;
  readonly logs: string[];
  readonly warnings: string[];
  readonly errors: string[];
  evaluate<T = unknown>(code: string, filename?: string): T;
}

/** Create an isolated `node:vm` context exposing ONLY React Native 0.88 globals. */
export function createRnRealm(options: RnRealmOptions = {}): RnRealm {
  const {
    withWhatwgFetch = true,
    withCryptoGetRandomValues = true,
    process: processOpt = true,
    withTextEncoding = false,
    withReadableStream = false,
  } = options;

  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  const sandbox: Record<string, unknown> = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    performance: { now: () => performance.now() },
    console: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      info: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      debug: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
    },
  };

  if (processOpt === true) {
    sandbox.process = { env: {} };
  } else if (typeof processOpt === 'object' && processOpt !== null) {
    sandbox.process = processOpt;
  }

  if (withCryptoGetRandomValues) {
    // Deliberately expose ONLY `getRandomValues` — no `randomUUID`, matching `react-native-get-random-values`.
    sandbox.crypto = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        return crypto.getRandomValues(array);
      },
    };
  }

  if (withTextEncoding) {
    sandbox.TextEncoder = TextEncoder;
    sandbox.TextDecoder = TextDecoder;
  }

  if (withReadableStream) {
    sandbox.ReadableStream = ReadableStream;
  }

  const context = vm.createContext(sandbox);
  vm.runInContext(
    'globalThis.window = globalThis; globalThis.self = globalThis; globalThis.global = globalThis;',
    context,
    { filename: 'rn-setup-globals.js' },
  );
  vm.runInContext(RN_ABORT_POLYFILL_SOURCE, context, { filename: 'rn-abort-polyfill.js' });
  vm.runInContext(RN_URL_POLYFILL_SOURCE, context, { filename: 'rn-url-polyfill.js' });

  if (withWhatwgFetch) {
    vm.runInContext(WHATWG_FETCH_UMD, context, { filename: 'whatwg-fetch@3.6.20.js' });
    vm.runInContext(
      `
      globalThis.fetch = globalThis.WHATWGFetch.fetch;
      globalThis.Headers = globalThis.WHATWGFetch.Headers;
      globalThis.Request = globalThis.WHATWGFetch.Request;
      globalThis.Response = globalThis.WHATWGFetch.Response;
      `,
      context,
      { filename: 'rn-setup-fetch.js' },
    );
  }

  return {
    context,
    logs,
    warnings,
    errors,
    evaluate<T = unknown>(code: string, filename = 'rn-eval.js'): T {
      return vm.runInContext(code, context, { filename }) as T;
    },
  };
}

/**
 * Bundle an inline entry script (importing Stitchkit modules by absolute path)
 * with `--target=browser --format=iife` so no Node built-ins or Bun globals are
 * assumed, and return the standalone IIFE JS code.
 */
export async function bundleBrowserIife(entrySource: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'stitchkit-rn-realm-'));
  const entryPath = join(dir, 'entry.ts');
  try {
    writeFileSync(entryPath, entrySource, 'utf8');
    const result = await Bun.build({
      entrypoints: [entryPath],
      target: 'browser',
      format: 'iife',
      minify: false,
    });
    if (!result.success) {
      const details = result.logs.map((log) => log.message).join('\n');
      throw new Error(`Bun.build failed for RN realm bundle:\n${details}`);
    }
    const output = result.outputs[0];
    if (!output) throw new Error('Bun.build produced no output');
    return await output.text();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const CORE_SRC = resolve(CORE_ROOT, 'src');
export const ZOD_ENTRY = resolve(CORE_ROOT, 'node_modules/zod');
