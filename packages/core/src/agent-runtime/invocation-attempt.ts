import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { serializeCanonicalJson } from '../internal/canonical-json';
import { invocationAudit } from './invocation-failure';
import {
  type createInvocationPayloads,
  type InvocationJsonValue,
  InvocationPayloadTooLargeError,
  invocationJson,
} from './invocation-payload';
import type {
  InvocationProcessSchema,
  ModelInvocationAttemptContext,
  ModelInvocationRecord,
} from './invocation-schema';
import type { AgentResolvedModel } from './models';
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentModelResponseMetadata,
  AgentModelStreamPart,
} from './models-driver';
import { markProviderOrigin } from './provider-origin';
import type { AgentUsage } from './schemas-usage';
import { statedUsage } from './schemas-usage-state';

const utf8Encoder = new TextEncoder();

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

/**
 * Decorate an `AgentModelDriver` with ADR 0206 request/response receipts and
 * `currentModelInvocationAttempt()` ALS context across `stream()` and every
 * streamed read/cancellation. → ADR 0336.
 */
export function wrapInvocationDriver(
  writer: InvocationAttemptWriter,
  selected: AgentResolvedModel,
  step: number,
  driver: AgentModelDriver = selected.driver,
): AgentModelDriver {
  const begin = async (
    context: ModelInvocationAttemptContext,
    correlatedRequest: AgentModelRequest,
  ) =>
    invocationAudit(async () => {
      let artifact: { artifactId: string; sha256: string } | undefined;
      let omittedSha256: string | undefined;
      try {
        artifact = await writer.payloads.write(writer.identity, correlatedRequest);
      } catch (error) {
        if (!(error instanceof InvocationPayloadTooLargeError)) throw error;
        writer.receiptErrors.push(error);
        omittedSha256 = error.sha256;
      }
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
          modelId: driver.modelId,
          provider: driver.provider,
          payloadSha256: artifact ? artifact.sha256 : (omittedSha256 ?? ''),
          ...(artifact
            ? { artifactId: artifact.artifactId }
            : { payloadOmitted: 'max-payload-bytes' as const }),
          tools: correlatedRequest.tools.length,
        },
      });
      try {
        await writer.onAttempt?.({ ...context });
      } catch (error) {
        await finish(context, 'failed', invocationJson({ phase: 'transport-audit', error }));
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
    normalizedPayload: InvocationJsonValue,
    usage?: AgentUsage,
    response?: AgentModelResponseMetadata,
    responseProvider?: string,
  ) =>
    invocationAudit(async () => {
      let artifact: { artifactId: string; sha256: string } | undefined;
      let omittedSha256: string | undefined;
      try {
        const bounded = boundedSerializedEvidence(
          normalizedPayload,
          Math.floor(writer.payloads.maxBytes / 2),
        );
        artifact = await writer.payloads.writeSerialized(
          writer.identity,
          bounded.data,
          bounded.sha256,
        );
      } catch (error) {
        if (!(error instanceof InvocationPayloadTooLargeError)) throw error;
        writer.receiptErrors.push(error);
        omittedSha256 = error.sha256;
      }
      await writer.append({
        ...writer.identity,
        type: 'provider/response',
        attemptId: context.attemptId,
        step,
        status,
        effective: {
          provider: responseProvider ?? null,
          modelId: response?.modelId ?? null,
          responseId: response?.id ?? null,
        },
        usage: statedUsage(usage),
        ...(artifact
          ? { artifactId: artifact.artifactId }
          : { payloadOmitted: 'max-payload-bytes' as const }),
        payloadSha256: artifact ? artifact.sha256 : (omittedSha256 ?? ''),
      });
    });

  return {
    provider: driver.provider,
    modelId: driver.modelId,
    async stream(request, signal) {
      const context: ModelInvocationAttemptContext = {
        ...writer.identity,
        step,
        attemptId: randomUUID(),
      };
      const correlatedRequest: AgentModelRequest = {
        ...request,
        correlation: {
          ...request.correlation,
          invocationId: context.invocationId,
          attemptId: context.attemptId,
        },
      };
      await begin(context, correlatedRequest);
      let inner: Awaited<ReturnType<AgentModelDriver['stream']>>;
      try {
        inner = await currentAttempt.run(context, () =>
          driver.stream(correlatedRequest, signal),
        );
      } catch (error) {
        await finish(
          context,
          signal.aborted ? 'cancelled' : 'failed',
          invocationJson({ error }),
        );
        throw markProviderOrigin(error);
      }
      return {
        ...(inner.response !== undefined && { response: inner.response }),
        parts: auditedParts(inner.parts, {
          context,
          initialResponse: inner.response,
          abortSignal: signal,
          maxEvidenceBytes: Math.floor(writer.payloads.maxBytes / 2),
          finish,
        }),
      };
    },
  };
}

function auditedParts(
  source: AsyncIterable<AgentModelStreamPart>,
  options: {
    context: ModelInvocationAttemptContext;
    initialResponse: AgentModelResponseMetadata | undefined;
    abortSignal: AbortSignal;
    maxEvidenceBytes: number;
    finish: (
      context: ModelInvocationAttemptContext,
      status: 'succeeded' | 'failed' | 'cancelled',
      payload: InvocationJsonValue,
      usage?: AgentUsage,
      response?: AgentModelResponseMetadata,
      responseProvider?: string,
    ) => Promise<void>;
  },
): AsyncIterable<AgentModelStreamPart> {
  const { context, abortSignal, maxEvidenceBytes, finish } = options;
  return {
    [Symbol.asyncIterator]() {
      let ended = false;
      let failed = false;
      let lastError: unknown;
      let response: AgentModelResponseMetadata | undefined = options.initialResponse;
      const evidence = streamEvidence(maxEvidenceBytes);
      const end = async (
        status: 'succeeded' | 'failed' | 'cancelled',
        value: unknown,
        usage?: AgentUsage,
        responseProvider?: string,
      ) => {
        if (ended) return;
        ended = true;
        await finish(
          context,
          status,
          evidence.payload(value),
          usage,
          response,
          responseProvider,
        );
      };
      let iterator: AsyncIterator<AgentModelStreamPart>;
      try {
        iterator = currentAttempt.run(context, () => source[Symbol.asyncIterator]());
      } catch (error) {
        void end(abortSignal.aborted ? 'cancelled' : 'failed', { error });
        throw markProviderOrigin(error);
      }
      return {
        async next() {
          let next: IteratorResult<AgentModelStreamPart>;
          try {
            next = await currentAttempt.run(context, () => iterator.next());
          } catch (error) {
            await end(abortSignal.aborted ? 'cancelled' : 'failed', { error });
            throw markProviderOrigin(error);
          }
          if (next.done) {
            if (failed) {
              await end('failed', { reason: 'stream-error', error: lastError });
            } else if (abortSignal.aborted) {
              await end('cancelled', { reason: 'aborted' });
            } else {
              await end('failed', { reason: 'stream-ended-without-finish' });
            }
            return next;
          }
          const part = next.value;
          if (part.type === 'response-metadata') {
            response = {
              ...(response ?? {}),
              ...(part.id !== undefined && { id: part.id }),
              ...(part.modelId !== undefined && { modelId: part.modelId }),
              ...(part.timestamp !== undefined && { timestamp: part.timestamp }),
            };
          } else if (part.type === 'finish') {
            if (part.response) {
              response = {
                ...(response ?? {}),
                ...(part.response.id !== undefined && { id: part.response.id }),
                ...(part.response.modelId !== undefined && { modelId: part.response.modelId }),
                ...(part.response.timestamp !== undefined && {
                  timestamp: part.response.timestamp,
                }),
              };
            }
            await end(
              failed || part.finishReason === 'error' ? 'failed' : 'succeeded',
              part,
              part.usage,
              part.responseProvider,
            );
          } else {
            if (part.type === 'error') {
              failed = true;
              lastError = part.error;
            }
            evidence.record(part);
          }
          return next;
        },
        async return(value?: unknown) {
          const iterReturn = iterator.return;
          try {
            if (iterReturn) {
              await currentAttempt.run(context, () => iterReturn.call(iterator, value));
            }
          } finally {
            if (failed) {
              await end('failed', { reason: 'stream-error', error: lastError });
            } else {
              await end('cancelled', { reason: 'consumer-cancelled' });
            }
          }
          return { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          const iterThrow = iterator.throw;
          try {
            if (iterThrow) {
              return await currentAttempt.run(context, () => iterThrow.call(iterator, error));
            }
            throw error;
          } finally {
            if (failed) {
              await end('failed', { reason: 'stream-error', error: lastError });
            } else if (abortSignal.aborted) {
              await end('cancelled', { reason: 'aborted' });
            } else {
              await end('failed', { reason: 'consumer-threw', error });
            }
          }
        },
      };
    },
  };
}

function boundedSerializedEvidence(
  normalized: InvocationJsonValue,
  limit: number,
): { data: Buffer; sha256: string } {
  const data = Buffer.from(serializeCanonicalJson(normalized));
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (data.byteLength <= limit) return { data, sha256 };
  const truncatedData = Buffer.from(
    serializeCanonicalJson({ truncated: { bytes: data.byteLength, sha256 } }),
  );
  return {
    data: truncatedData,
    sha256: createHash('sha256').update(truncatedData).digest('hex'),
  };
}

function streamEvidence(limit: number) {
  const output: InvocationJsonValue[] = [];
  const entrySizes: number[] = [];
  const whole = createHash('sha256');
  let outputBytes = 0;
  let parts = 0;
  let truncated = false;
  return {
    record(part: unknown) {
      const json = invocationJson(part);
      const serialized = serializeCanonicalJson(json);
      whole.update(serialized).update('\n');
      parts += 1;
      const size = utf8Encoder.encode(serialized).byteLength;
      const comma = output.length > 0 ? 1 : 0;
      if (!truncated && outputBytes + comma + size > limit) truncated = true;
      if (truncated) return;
      outputBytes += comma + size;
      output.push(json);
      entrySizes.push(size);
    },
    payload(terminal: unknown): InvocationJsonValue {
      const digest = whole.digest('hex');
      const terminalJson = invocationJson(terminal);
      const envelopeBytes = (isTruncated: boolean) =>
        utf8Encoder.encode(
          serializeCanonicalJson({
            output: [],
            terminal: terminalJson,
            ...(isTruncated && { truncated: { parts, sha256: digest } }),
          }),
        ).byteLength;
      let isTruncated = truncated;
      let overhead = envelopeBytes(isTruncated);
      if (output.length > 0 && overhead + outputBytes > limit) {
        if (!isTruncated) {
          isTruncated = true;
          overhead = envelopeBytes(true);
        }
        while (output.length > 0 && overhead + outputBytes > limit) {
          const removed = entrySizes.pop() ?? 0;
          output.pop();
          outputBytes -= removed + (output.length > 0 ? 1 : 0);
        }
      }
      return {
        output,
        terminal: terminalJson,
        ...(isTruncated && { truncated: { parts, sha256: digest } }),
      };
    },
  };
}
