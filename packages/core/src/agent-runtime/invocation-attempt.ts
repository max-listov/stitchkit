import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { LanguageModelUsage } from 'ai';
import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import type { z } from 'zod';
import { invocationAudit } from './invocation-failure';
import type { createInvocationPayloads } from './invocation-payload';
import { invocationJson } from './invocation-payload';
import type {
  InvocationProcessSchema,
  ModelInvocationAttemptContext,
  ModelInvocationRecord,
} from './invocation-schema';
import type { AgentResolvedModel } from './models';
import { markProviderOrigin } from './provider-origin';
import { normalizeSdkUsage } from './runtime-internals';

type ProviderResult = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware['wrapGenerate']>>
>;
type ProviderUsage = ProviderResult['usage'];
const currentAttempt = new AsyncLocalStorage<ModelInvocationAttemptContext>();
/** Available inside the provider's fetch/transport; no time/model-name correlation. */
export function currentModelInvocationAttempt(): ModelInvocationAttemptContext | undefined {
  const value = currentAttempt.getStore();
  return value && { ...value };
}

export interface InvocationAttemptWriter {
  identity: {
    conversationId: string;
    invocationId: string;
    operationId: string;
    runId?: string;
  };
  process: z.infer<typeof InvocationProcessSchema>;
  payloads: ReturnType<typeof createInvocationPayloads>;
  append(record: ModelInvocationRecord): Promise<void>;
  onAttempt?(context: ModelInvocationAttemptContext): void | Promise<void>;
  /**
   * Where a provider attempt's own record could not be written. The provider
   * has answered by then, so the failure is kept here instead of replacing
   * the answer — or the provider's own error — with a receipt error.
   */
  readonly receiptErrors: unknown[];
}

/** The single audited provider boundary, used by completion and the existing agent loop. */
export function wrapInvocationModel(
  writer: InvocationAttemptWriter,
  selected: AgentResolvedModel,
  step: number,
  model: LanguageModel = selected.model,
): LanguageModel {
  if (typeof model === 'string')
    throw new TypeError('Invocation receipts require a resolved model object');
  const begin = async (
    params: Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]['params'],
  ) =>
    invocationAudit(async () => {
      const context = { ...writer.identity, step, attemptId: randomUUID() };
      // Headers and AbortSignal are transport controls, never payload artifacts.
      const { headers: _headers, abortSignal: _signal, ...payload } = params;
      const artifact = await writer.payloads.write(writer.identity, payload);
      await writer.append({
        ...writer.identity,
        type: 'provider/request',
        attemptId: context.attemptId,
        step,
        executingProcess: writer.process,
        requested: {
          modelId: selected.descriptor.modelId,
          provider: selected.descriptor.provider,
        },
        sent: {
          modelId: model.modelId,
          provider: model.provider,
          payloadSha256: artifact.sha256,
          artifactId: artifact.artifactId,
          tools: params.tools?.length ?? 0,
        },
      });
      try {
        await writer.onAttempt?.({ ...context });
      } catch (error) {
        await finish(context, 'failed', { phase: 'transport-audit', error });
        throw error;
      }
      return context;
    });
  const finish = (...args: Parameters<typeof recordResponse>): Promise<void> =>
    recordResponse(...args).catch((error: unknown) => {
      writer.receiptErrors.push(error);
    });
  const recordResponse = async (
    context: ModelInvocationAttemptContext,
    status: 'succeeded' | 'failed' | 'cancelled',
    payload: unknown,
    usage?: ProviderUsage,
    response?: { id?: string; modelId?: string },
    providerMetadata?: unknown,
  ) =>
    invocationAudit(async () => {
      const artifact = await writer.payloads.write(
        writer.identity,
        boundedEvidence(payload, Math.floor(writer.payloads.maxBytes / 2)),
      );
      await writer.append({
        ...writer.identity,
        type: 'provider/response',
        attemptId: context.attemptId,
        step,
        status,
        effective: {
          provider: selected.resolveResponseProvider?.({ providerMetadata }) ?? null,
          modelId: response?.modelId ?? null,
          responseId: response?.id ?? null,
        },
        usage: reportedUsage(selected, usage, providerMetadata),
        artifactId: artifact.artifactId,
        payloadSha256: artifact.sha256,
      });
    });
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      async wrapGenerate({ doGenerate, params }) {
        const context = await begin(params);
        let result: ProviderResult;
        try {
          result = await currentAttempt.run(context, doGenerate);
        } catch (error) {
          await finish(context, params.abortSignal?.aborted ? 'cancelled' : 'failed', {
            error,
          });
          throw markProviderOrigin(error);
        }
        await finish(
          context,
          result.finishReason.unified === 'error' ? 'failed' : 'succeeded',
          {
            content: result.content,
            usage: result.usage,
            response: result.response,
            providerMetadata: result.providerMetadata,
          },
          result.usage,
          result.response,
          result.providerMetadata,
        );
        if (result.finishReason.unified === 'error') {
          throw markProviderOrigin(new Error('Provider returned an error finish reason'));
        }
        return result;
      },
      async wrapStream({ doStream, params }) {
        const context = await begin(params);
        let result: Awaited<ReturnType<typeof doStream>>;
        try {
          result = await currentAttempt.run(context, doStream);
        } catch (error) {
          await finish(context, params.abortSignal?.aborted ? 'cancelled' : 'failed', {
            error,
          });
          throw markProviderOrigin(error);
        }
        const reader = result.stream.getReader();
        let ended = false;
        let failed = false;
        let response: { id?: string; modelId?: string } | undefined;
        // Up to half the artifact limit, so the terminal part always fits beside it.
        const evidence = streamEvidence(Math.floor(writer.payloads.maxBytes / 2));
        const end = async (
          status: 'succeeded' | 'failed' | 'cancelled',
          value: unknown,
          usage?: ProviderUsage,
          metadata?: unknown,
        ) => {
          if (ended) return;
          ended = true;
          await finish(context, status, evidence.payload(value), usage, response, metadata);
        };
        return {
          ...result,
          stream: new ReadableStream({
            async pull(controller) {
              let next: Awaited<ReturnType<typeof reader.read>>;
              try {
                next = await currentAttempt.run(context, () => reader.read());
              } catch (error) {
                await end(params.abortSignal?.aborted ? 'cancelled' : 'failed', { error });
                controller.error(markProviderOrigin(error));
                return;
              }
              if (next.done) {
                await end('failed', { reason: 'stream-ended-without-finish' });
                controller.close();
                return;
              }
              const part = next.value;
              if (part.type === 'response-metadata') response = part;
              if (part.type === 'finish') {
                await end(
                  failed || part.finishReason.unified === 'error' ? 'failed' : 'succeeded',
                  part,
                  part.usage,
                  part.providerMetadata,
                );
              } else {
                if (part.type === 'error') failed = true;
                evidence.record(part);
              }
              controller.enqueue(part);
            },
            async cancel(reason) {
              try {
                await currentAttempt.run(context, () => reader.cancel(reason));
              } finally {
                await end('cancelled', { reason: 'consumer-cancelled' });
              }
            },
          }),
        };
      },
    },
  });
}

/**
 * A response payload as evidence: whole while it fits `limit` bytes, otherwise
 * its size and fingerprint. A long answer is the provider's to give; the
 * evidence of it is what is bounded.
 */
function boundedEvidence(payload: unknown, limit: number): unknown {
  const serialized = JSON.stringify(invocationJson(payload));
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= limit) return payload;
  return {
    truncated: { bytes, sha256: createHash('sha256').update(serialized).digest('hex') },
  };
}

/**
 * What a stream's evidence keeps: its parts up to `limit` bytes, then a count
 * and a fingerprint of the whole stream. The consumer's stream is never cut —
 * the evidence is truncated instead.
 */
function streamEvidence(limit: number) {
  // The evidence retains output through the encrypted artifact.
  const output: ReturnType<typeof invocationJson>[] = [];
  const whole = createHash('sha256');
  let bytes = 0;
  let parts = 0;
  let truncated = false;
  return {
    record(part: unknown) {
      const json = invocationJson(part);
      const serialized = JSON.stringify(json);
      whole.update(serialized).update('\n');
      parts += 1;
      const size = Buffer.byteLength(serialized);
      if (!truncated && bytes + size > limit) truncated = true;
      if (truncated) return;
      bytes += size;
      output.push(json);
    },
    payload(terminal: unknown) {
      return {
        output,
        terminal,
        ...(truncated && { truncated: { parts, sha256: whole.digest('hex') } }),
      };
    },
  };
}

function reportedUsage(
  selected: AgentResolvedModel,
  value: ProviderUsage | undefined,
  providerMetadata: unknown,
) {
  const usage: LanguageModelUsage = {
    inputTokens: value?.inputTokens.total,
    outputTokens: value?.outputTokens.total,
    totalTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: value?.inputTokens.noCache,
      cacheReadTokens: value?.inputTokens.cacheRead,
      cacheWriteTokens: value?.inputTokens.cacheWrite,
    },
    outputTokenDetails: {
      textTokens: value?.outputTokens.text,
      reasoningTokens: value?.outputTokens.reasoning,
    },
    ...(value?.raw && { raw: value.raw }),
  };
  return selected.normalizeUsage?.({ usage, providerMetadata }) ?? normalizeSdkUsage(usage);
}
