import { createHash } from 'node:crypto';
import type { Instructions, ModelMessage } from 'ai';
import type { AgentResolvedModel } from './models';
import type { RunExecutionState } from './run-execution-state';
import { providerResponseIdentity } from './runtime-internals';
import type { AgentRuntimeStore } from './store';
import { canonicalAgentJson } from './store-events';

/**
 * A model message with its binary parts replaced by references.
 *
 * `JSON.stringify` turns a `Uint8Array` into an object of numeric keys and a
 * `Buffer` into `{ type: 'Buffer', data: [...] }` — four to five times the
 * bytes, in the ledger, on every step that carried the attachment. The
 * record names the bytes by hash and size instead.
 */
function withoutBinaryParts(message: ModelMessage): unknown {
  const reference = (value: unknown): unknown => {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      return {
        binary: true,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
      };
    }
    if (value instanceof URL) return value.toString();
    if (Array.isArray(value)) return value.map(reference);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          reference(entry),
        ]),
      );
    }
    return value;
  };
  return reference(message);
}

/** The provider request and response records of one run, in ledger order. */
export interface RunProviderLedger {
  recordRequest(request: {
    stepNumber: number;
    attempt: number;
    instructions: Instructions;
    messages: readonly ModelMessage[];
  }): Promise<void>;
  recordResponse(response: {
    id: string;
    providerMetadata: unknown;
    stepNumber: number;
    attempt: number;
  }): Promise<ReturnType<typeof providerResponseIdentity>>;
}

export async function createRunProviderLedger(input: {
  store: AgentRuntimeStore;
  state: RunExecutionState;
  selectedModel: AgentResolvedModel;
}): Promise<RunProviderLedger> {
  const { store, state } = input;
  const requestModelId = input.selectedModel.descriptor.modelId;
  /**
   * Message bodies already in this conversation's ledger, by content hash.
   *
   * The request record used to carry every message of every step: O(N·K)
   * per run, O(N²) over a conversation's life, and one durable write of
   * the whole history on the hot path before every provider call. Now a
   * body is written once as `provider/message` and every request names
   * its messages by sha256. One paged read of the ledger per run seeds the
   * set — the same order of work as reading the history for the prompt,
   * which every run already does.
   */
  const knownMessageShas = new Set<string>();
  {
    let fromSeq: number | undefined;
    do {
      const page = await store.readEvents({
        conversationId: state.run.conversationId,
        ...(fromSeq && { fromSeq }),
        limit: 10_000,
      });
      for (const event of page.items) {
        if (event.kind !== 'provider/message') continue;
        const sha = (event.payload as { sha256?: unknown } | null)?.sha256;
        if (typeof sha === 'string') knownMessageShas.add(sha);
      }
      fromSeq = page.nextSeq;
    } while (fromSeq !== undefined);
  }
  return {
    async recordRequest(request) {
      const messageShas: string[] = [];
      for (const message of request.messages) {
        // Through JSON first: the SDK's messages carry `undefined` fields and
        // provider metadata that a canonical encoder must not see.
        const body = canonicalAgentJson(
          JSON.parse(JSON.stringify(withoutBinaryParts(message))),
        );
        const sha256 = createHash('sha256').update(body).digest('hex');
        messageShas.push(sha256);
        if (knownMessageShas.has(sha256)) continue;
        await store.appendEvent({
          conversationId: state.run.conversationId,
          kind: 'provider/message',
          payload: { sha256, message: JSON.parse(body) },
        });
        knownMessageShas.add(sha256);
      }
      const instructionsSha256 = createHash('sha256')
        .update(
          typeof request.instructions === 'string'
            ? request.instructions
            : canonicalAgentJson(
                JSON.parse(JSON.stringify(withoutBinaryParts(request.instructions as never))),
              ),
        )
        .digest('hex');
      const bodySha256 = createHash('sha256')
        .update(instructionsSha256)
        .update(messageShas.join(','))
        .digest('hex');
      await store.appendEvent({
        conversationId: state.run.conversationId,
        kind: 'provider/request',
        payload: {
          runId: state.run.id,
          attempt: request.attempt,
          stepNumber: request.stepNumber,
          modelId: requestModelId,
          instructionsSha256,
          messageShas,
          bodySha256,
        },
      });
    },
    async recordResponse(response) {
      const identity = providerResponseIdentity(
        response.id,
        state.selectedModel?.resolveResponseProvider?.({
          providerMetadata: response.providerMetadata,
        }),
      );
      await store.appendEvent({
        conversationId: state.run.conversationId,
        kind: 'provider/response',
        payload: {
          runId: state.run.id,
          attempt: response.attempt,
          stepNumber: response.stepNumber,
          response: identity,
        },
      });
      return identity;
    },
  };
}
