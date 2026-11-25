import { PolledJsonFile } from '../files/polled-json';
import type { JsonValueSchema } from '../files/regular-file';
import { abortReason } from '../internal/abort-race';
import { messageOf } from '../internal/error-message';
import { canonicalDigest } from '../internal/stable-digest';

/** Outcome of one poll of a {@link ConfigSource}. */
export type ConfigSourceReading<TConfig> =
  | { readonly state: 'unchanged' }
  | { readonly state: 'missing' }
  | { readonly state: 'invalid'; readonly detail: string; readonly failureKey: string }
  | { readonly state: 'valid'; readonly config: TConfig; readonly digest: string };

/** Polled source of validated configuration snapshots with stable digests. */
export interface ConfigSource<TConfig> {
  read(): ConfigSourceReading<TConfig> | Promise<ConfigSourceReading<TConfig>>;
}

/** Options for {@link createPolledJsonConfigSource}. */
export interface PolledJsonConfigSourceOptions<TConfig> {
  readonly path: string;
  readonly schema: JsonValueSchema<TConfig>;
  readonly maxBytes?: number;
  readonly maxCacheBytes?: number;
  /** Optional custom digest function; defaults to `canonicalDigest(text)`. */
  readonly digest?: (config: TConfig, text: string) => string;
}

/** Clock abstraction for deterministic polling and timeout tests. */
export interface ConfigReloaderClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export const DEFAULT_CONFIG_RELOADER_CLOCK: ConfigReloaderClock = {
  now: () => Date.now(),
  schedule(cb, ms) {
    const timer = globalThis.setTimeout(cb, ms);
    return () => globalThis.clearTimeout(timer);
  },
};

export function safeCallObserver(fn: (() => unknown) | undefined): void {
  if (!fn) return;
  try {
    const result: unknown = fn();
    if (result !== undefined && result !== null) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Observer errors must never disrupt reloader transitions.
  }
}

export function runBoundedOperation<T>(
  label: string,
  op: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  clock: ConfigReloaderClock,
  parent?: AbortSignal,
  onLate?: (value: T) => void,
): Promise<T> {
  const ctrl = new AbortController();
  const raw = Promise.resolve().then(() => op(ctrl.signal));
  void raw.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancel: (() => void) | null = null;
    const onParent = () => fail(parent ? abortReason(parent) : undefined);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cancel?.();
      cancel = null;
      parent?.removeEventListener('abort', onParent);
      fn();
    };
    const fail = (err: unknown) =>
      settle(() => {
        ctrl.abort(err);
        reject(err);
      });
    if (parent?.aborted) fail(abortReason(parent));
    else {
      parent?.addEventListener('abort', onParent, { once: true });
      cancel = clock.schedule(
        () => fail(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }
    raw.then(
      (v) => (settled ? onLate?.(v) : settle(() => resolve(v))),
      (e: unknown) => settle(() => reject(e)),
    );
  });
}

export async function validateConfigValue<TConfig>(
  validate: ((config: TConfig) => void | Promise<void>) | undefined,
  config: TConfig,
  digest: string,
): Promise<{ ok: true } | { ok: false; error: unknown; detail: string; key: string }> {
  if (!validate) return { ok: true };
  try {
    await validate(config);
    return { ok: true };
  } catch (error) {
    const detail = messageOf(error) || String(error);
    return { ok: false, error, detail, key: `validate:${digest}:${canonicalDigest(detail)}` };
  }
}

/** Create a {@link ConfigSource} backed by {@link PolledJsonFile} and {@link canonicalDigest}. */
export function createPolledJsonConfigSource<TConfig>(
  options: PolledJsonConfigSourceOptions<TConfig>,
): ConfigSource<TConfig> {
  const polled = new PolledJsonFile(options.path, options.schema, {
    limit: options.maxBytes,
    maxCacheBytes: options.maxCacheBytes,
  });
  return {
    read(): ConfigSourceReading<TConfig> {
      const changed = polled.readChanged();
      if (changed === null) return { state: 'unchanged' };
      if (changed.state === 'missing') return { state: 'missing' };
      if (changed.state === 'unreadable' || changed.state === 'invalid') {
        const failureKey = `${changed.state}:${canonicalDigest(changed.detail)}`;
        return { state: 'invalid', detail: changed.detail, failureKey };
      }
      const digest = options.digest
        ? options.digest(changed.value, changed.text)
        : canonicalDigest(changed.text);
      return { state: 'valid', config: changed.value, digest };
    },
  };
}
