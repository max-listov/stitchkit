import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  type OpenRouterRequestPolicy,
  OpenRouterRequestPolicySchema,
} from './openrouter-options';

/**
 * How a thread stays on one upstream. `session-sticky` — OpenRouter keeps a
 * `session_id` on the upstream it chose first; `provider-order` — the upstream
 * that answered first is named outright on every later request.
 */
export const OpenRouterRoutePinSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session-sticky'), sessionId: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal('provider-order'), provider: z.string().min(1).max(128) }),
]);
/** Persisted upstream route pin inferred from `OpenRouterRoutePinSchema`. */
export type OpenRouterRoutePin = z.infer<typeof OpenRouterRoutePinSchema>;

/** Where pins live: the application's own store, or the bounded memory one. */
export interface OpenRouterRouteStore {
  get(key: string): Promise<OpenRouterRoutePin | undefined>;
  set(key: string, pin: OpenRouterRoutePin): Promise<void>;
}

/** Pins held in memory, at most `maxEntries` (least recently used go first), each for `ttlMs`. */
export function createMemoryOpenRouterRouteStore(
  options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
): OpenRouterRouteStore {
  const maxEntries = options.maxEntries ?? 10_000;
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
  assertPositiveSafeInteger('maxEntries', maxEntries);
  assertPositiveSafeInteger('ttlMs', ttlMs);
  const now = options.now ?? Date.now;
  const pins = new Map<string, { pin: OpenRouterRoutePin; expiresAt: number }>();
  return {
    async get(key) {
      const entry = pins.get(key);
      if (!entry) return undefined;
      pins.delete(key);
      if (entry.expiresAt <= now()) return undefined;
      pins.set(key, entry);
      return entry.pin;
    },
    async set(key, pin) {
      pins.delete(key);
      while (pins.size >= maxEntries) {
        const oldest = pins.keys().next().value;
        if (oldest === undefined) break;
        pins.delete(oldest);
      }
      pins.set(key, { pin: OpenRouterRoutePinSchema.parse(pin), expiresAt: now() + ttlMs });
    },
  };
}

/** A key OpenRouter accepts as `session_id`: the key itself, or its digest when longer than 256. */
export function openRouterSessionKey(key: string): string {
  return key.length <= 256 ? key : createHash('sha256').update(key).digest('hex');
}

/** Resolver that pins thread requests to a consistent OpenRouter upstream provider. */
export interface OpenRouterRouteResolver {
  /** The policy for the next request of `key` (a thread, a session), with its route pinned. */
  policyFor(key: string, base?: OpenRouterRequestPolicy): Promise<OpenRouterRequestPolicy>;
  /**
   * After a response: which upstream answered, as OpenRouter's provider slug (the
   * `provider.order` vocabulary, not a display name). Pins `provider-order` on the
   * first answer.
   */
  record(key: string, upstream: string | undefined): Promise<void>;
}

/**
 * Keep each thread on one upstream. A pinned route replaces whatever route the base
 * policy named, so a later request never carries both `session_id` and
 * `provider.order`.
 */
export function createOpenRouterRouteResolver(options: {
  store: OpenRouterRouteStore;
  strategy: OpenRouterRoutePin['kind'];
}): OpenRouterRouteResolver {
  const { store, strategy } = options;
  return {
    async policyFor(key, rawBase = {}) {
      const base = OpenRouterRequestPolicySchema.parse(rawBase);
      const { sessionId: _session, provider, ...rest } = base;
      const { order: _order, ...routing } = provider ?? {};
      const unrouted: OpenRouterRequestPolicy = {
        ...rest,
        ...(provider && Object.keys(routing).length > 0 && { provider: routing }),
      };
      const pin = await store.get(key);
      if (strategy === 'session-sticky') {
        const sessionId =
          pin?.kind === 'session-sticky' ? pin.sessionId : openRouterSessionKey(key);
        if (!pin) await store.set(key, { kind: 'session-sticky', sessionId });
        return OpenRouterRequestPolicySchema.parse({ ...unrouted, sessionId });
      }
      if (pin?.kind !== 'provider-order') return base;
      // A pin that falls back to another upstream is not a pin: unless the base
      // policy decided otherwise, the request stays with the pinned one.
      return OpenRouterRequestPolicySchema.parse({
        ...unrouted,
        provider: { allowFallbacks: false, ...routing, order: [pin.provider] },
      });
    },
    async record(key, upstream) {
      if (strategy !== 'provider-order' || upstream === undefined || upstream.length === 0)
        return;
      if ((await store.get(key))?.kind === 'provider-order') return;
      await store.set(key, { kind: 'provider-order', provider: upstream });
    },
  };
}
