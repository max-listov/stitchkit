import { randomUUID } from 'node:crypto';
import { withoutUndefined } from '../internal/typed';
import { getSpendAttribution, mergeSpendAttribution } from './attribution';
import type { SpendFactsReader } from './facts';
import { type ObservedEnd, observeBody } from './gateway-stream';
import {
  type SpendAttempt,
  type SpendAttribution,
  SpendAttributionSchema,
  type SpendFacts,
  SpendFactsSchema,
  type SpendLedgerStore,
  type SpendOutcome,
} from './schemas';

/** One paid upstream the gateway may call, and how to authenticate to it. */
export interface SpendProvider {
  /** The gateway name receipts carry and reconcilers are keyed by (`openrouter`). */
  name: string;
  /** The only origin credentials are sent to (`https://openrouter.ai`). */
  origin: string;
  /** Credential headers; read per call, so a rotated key needs no restart. */
  headers(): Record<string, string> | Promise<Record<string, string>>;
  /** How to read usage from its responses; default: none, so cost stays `pending`. */
  facts?: SpendFactsReader;
}

/** The ledger, the providers and the hooks a spend gateway is built from. */
export interface SpendGatewayConfig {
  store: SpendLedgerStore;
  providers: readonly SpendProvider[];
  /**
   * Attribution fields not set by `runWithSpendAttribution` — typically the agent
   * runtime's attempt (`currentModelInvocationAttempt()`), so its run, invocation
   * and step land on the record. Merged under the explicit attribution.
   */
  context?: () => Partial<SpendAttribution> | undefined;
  /**
   * Decide before the call — a budget, a payer policy. Throwing refuses it: the
   * attempt is recorded and closed as `refused`, and nothing is sent.
   */
  admit?: (attempt: SpendAttempt) => void | Promise<void>;
  /** Observe a ledger write that failed after the call went out. The call is not failed for it. */
  onLedgerError?: (failure: { error: unknown; attemptId: string }) => void;
  /** Longest single response event parsed for usage, in characters. Default 256 KiB. */
  maxEventLength?: number;
  /** The network; default the global `fetch`. */
  fetch?: (request: Request) => Promise<Response>;
  now?: () => Date;
  newAttemptId?: () => string;
}

/** The SDK-facing door: `createOpenRouter({ fetch: gateway.fetchFor('openrouter') })`. */
export interface SpendGateway {
  fetchFor(provider: string): typeof fetch;
}

/**
 * A call the gateway refused before anything was sent: `unknown-provider`,
 * `origin-mismatch` (credentials never leave for another host), `no-attribution`
 * (no record could say what the call was for), `intent-unrecorded` (the ledger
 * refused the attempt, so the call would go unaccounted), `refused` (`admit`
 * said no; the attempt is recorded as `refused`).
 */
export class SpendGatewayError extends Error {
  constructor(
    readonly code:
      | 'unknown-provider'
      | 'origin-mismatch'
      | 'no-attribution'
      | 'intent-unrecorded'
      | 'refused',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SpendGatewayError';
  }
}

/** Every header a caller could smuggle credentials in; the provider's own replace them. */
const CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'cookie',
] as const;

const PartialFactsSchema = SpendFactsSchema.partial();

function outcomeOf(
  end: ObservedEnd,
  response: Response,
  signal: AbortSignal | null | undefined,
): SpendOutcome {
  if (end.kind === 'cancel') return 'aborted';
  if (end.kind === 'error') return signal?.aborted ? 'aborted' : 'failed';
  return response.ok ? 'succeeded' : 'failed';
}

/**
 * The one door to paid model APIs. Before the network sees a byte, the attempt is
 * recorded; whatever happens after — success, an HTTP error, a broken stream, a
 * cancelled read — the attempt is closed with what was observed. Credentials are
 * added here and only for the provider's origin, any the caller sent are dropped,
 * redirects are refused, and `x-request-id` carries the attempt id.
 */
export function createSpendGateway(config: SpendGatewayConfig): SpendGateway {
  const providers = new Map(config.providers.map((provider) => [provider.name, provider]));
  const send = config.fetch ?? ((request: Request) => fetch(request));
  const now = config.now ?? (() => new Date());
  const newAttemptId = config.newAttemptId ?? randomUUID;
  const maxEventLength = config.maxEventLength ?? 256 * 1024;

  const attributionNow = (): SpendAttribution => {
    const merged = mergeSpendAttribution(config.context?.(), getSpendAttribution());
    const parsed = SpendAttributionSchema.safeParse(merged);
    if (!parsed.success)
      throw new SpendGatewayError(
        'no-attribution',
        'A model call needs a valid spend attribution with a purpose: wrap it in runWithSpendAttribution',
        { cause: parsed.error },
      );
    return parsed.data;
  };

  /** A reader's facts, kept only when they are facts the schema accepts; a throwing reader adds none. */
  const readFacts = (read: () => Partial<SpendFacts> | undefined): Partial<SpendFacts> => {
    try {
      // Field by field: one fact out of bounds (an over-long id) drops that fact,
      // never the reported cost beside it.
      const kept: Partial<SpendFacts> = {};
      for (const [field, value] of Object.entries(withoutUndefined(read() ?? {}))) {
        const parsed = PartialFactsSchema.safeParse({ [field]: value });
        if (parsed.success) Object.assign(kept, withoutUndefined(parsed.data));
      }
      return kept;
    } catch {
      return {};
    }
  };

  return {
    fetchFor(name) {
      const provider = providers.get(name);
      if (!provider)
        throw new SpendGatewayError('unknown-provider', `No spend provider is named ${name}`);
      const handler = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== new URL(provider.origin).origin)
          throw new SpendGatewayError(
            'origin-mismatch',
            `${provider.name} credentials are only sent to ${provider.origin}, not ${url.origin}`,
          );
        const attribution = attributionNow();
        const attemptId = newAttemptId();
        // Everything that can fail before the network is done before the attempt is
        // recorded: a call that never left is not an attempt to close.
        const headers = new Headers(request.headers);
        for (const header of CREDENTIAL_HEADERS) headers.delete(header);
        for (const [header, value] of Object.entries(await provider.headers()))
          headers.set(header, value);
        headers.set('x-request-id', attemptId);
        const outgoing = new Request(request, {
          headers,
          redirect: 'error',
          signal: request.signal,
        });
        const startedAt = now();
        const attempt: SpendAttempt = {
          attemptId,
          gateway: provider.name,
          startedAt: startedAt.toISOString(),
          attribution,
          request: { method: request.method, origin: url.origin, path: url.pathname },
        };
        let refusal: unknown;
        try {
          await config.admit?.(attempt);
        } catch (error) {
          refusal = error ?? new Error('refused');
        }
        if (refusal !== undefined) {
          try {
            await config.store.begin(attempt);
            await config.store.settle({
              attemptId,
              rank: 1,
              at: now().toISOString(),
              outcome: 'refused',
              facts: { costStatus: 'free', costUsd: 0, failureCode: 'refused' },
            });
          } catch (error) {
            config.onLedgerError?.({ error, attemptId });
          }
          throw new SpendGatewayError('refused', 'The call was refused before it was sent', {
            cause: refusal,
          });
        }
        try {
          await config.store.begin(attempt);
        } catch (error) {
          throw new SpendGatewayError(
            'intent-unrecorded',
            'The spend ledger refused the attempt; the call was not sent',
            { cause: error },
          );
        }
        let facts: Partial<SpendFacts> = {};
        let firstAt: number | undefined;
        let settled = false;
        const settle = (outcome: SpendOutcome, extra: Partial<SpendFacts> = {}) => {
          if (settled) return;
          settled = true;
          const at = now();
          const { costUsd, costStatus: reportedStatus, ...observed } = { ...facts, ...extra };
          const httpOk =
            observed.httpStatus !== undefined &&
            observed.httpStatus >= 200 &&
            observed.httpStatus < 300;
          const costStatus =
            reportedStatus ??
            (outcome === 'succeeded' || (httpOk && observed.providerRequestId !== undefined)
              ? ('pending' as const)
              : ('unknown' as const));
          const receipt = {
            attemptId,
            rank: costStatus === 'reported' ? (2 as const) : (1 as const),
            at: at.toISOString(),
            outcome,
            facts: {
              ...observed,
              costStatus,
              ...(costUsd !== undefined &&
                (costStatus === 'reported' || costStatus === 'free') && { costUsd }),
              durationMs: Math.max(0, at.getTime() - startedAt.getTime()),
              ...(firstAt !== undefined && {
                ttftMs: Math.max(0, firstAt - startedAt.getTime()),
              }),
            },
          };
          // A ledger that throws, even synchronously, never reaches the caller.
          Promise.resolve()
            .then(() => config.store.settle(receipt))
            .catch((error: unknown) => config.onLedgerError?.({ error, attemptId }));
        };
        let response: Response;
        try {
          response = await send(outgoing);
        } catch (error) {
          settle(request.signal.aborted ? 'aborted' : 'failed', {
            failureCode: 'transport',
            failureMessage: error instanceof Error ? error.name : 'transport failure',
          });
          throw error;
        }
        facts = {
          provider: provider.name,
          httpStatus: response.status,
          ...readFacts(() => provider.facts?.headers?.(response.headers)),
          ...(!response.ok && { failureCode: `http-${response.status}` }),
        };
        if (response.body === null) {
          settle(response.ok ? 'succeeded' : 'failed');
          return response;
        }
        const observed = observeBody(response.body, {
          contentType: (response.headers.get('content-type') ?? '').toLowerCase(),
          maxEventLength,
          onFirstChunk: () => {
            firstAt = now().getTime();
          },
          onEvent: (value) => {
            facts = { ...facts, ...readFacts(() => provider.facts?.event?.(value)) };
          },
          onEnd: (end) => settle(outcomeOf(end, response, request.signal)),
        });
        return new Response(observed, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      // `typeof fetch` carries the runtime's extras (Bun's `preconnect`); keep the global one's.
      return Object.assign(handler, { preconnect: fetch.preconnect });
    },
  };
}
