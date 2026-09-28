import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { type InvocationAttemptWriter, wrapInvocationModel } from './invocation-attempt';
import { createInvocationPayloads, invocationHash } from './invocation-payload';
import {
  InvocationReadInputSchema,
  readInvocationPayload,
  readInvocationRecords,
} from './invocation-read';
import {
  type CompletionInvocationInput,
  CompletionInvocationInputSchema,
  InvocationCallerSchema,
  InvocationStartedSchema,
  ModelInvocationRecordSchema,
  type ModelInvocationTrace,
  ModelInvocationTraceSchema,
} from './invocation-schema';
import type { AgentModelRegistry, AgentResolvedModel } from './models';
import { hasProviderOrigin } from './provider-origin';
import type { AgentRun } from './schemas';
import type { AgentRuntimeStore } from './store';

const executingProcess = { instanceId: randomUUID(), pid: process.pid, hostname: hostname() };

export interface ModelInvocationConfig {
  store: AgentRuntimeStore;
  models: AgentModelRegistry<string>;
  /** Keep outside the event database and its archives. AES-256-GCM, exactly 32 bytes. */
  payloadKey: Uint8Array;
  maxPayloadBytes?: number;
  /** Host authentication/authorization; never return identity copied from untrusted request fields. */
  authorize(input: {
    context: unknown;
    conversationId: string;
    action: 'complete' | 'agent' | 'read' | 'read-payload';
    trace?: ModelInvocationTrace;
  }): z.infer<typeof InvocationCallerSchema> | Promise<z.infer<typeof InvocationCallerSchema>>;
  onAttempt?: InvocationAttemptWriter['onAttempt'];
}

export interface AgentInvocationScope {
  wrap(model: AgentResolvedModel, step: number, override?: LanguageModel): LanguageModel;
  finish(status: 'succeeded' | 'failed' | 'cancelled'): Promise<void>;
}

export interface ModelInvocationLedger {
  complete(
    input: CompletionInvocationInput,
    context: unknown,
    signal?: AbortSignal,
  ): Promise<{
    invocationId: string;
    outcome: 'succeeded' | 'failed' | 'cancelled' | 'duplicate';
    text?: string;
    /**
     * The outcome stands, but its `invocation/finished` record (or failure
     * artifact) could not be written: why. The provider's own attempt records
     * were written before it.
     */
    receiptError?: unknown;
  }>;
  read(
    input: z.infer<typeof InvocationReadInputSchema>,
    context: unknown,
  ): ReturnType<typeof readInvocationRecords>;
  readPayload(
    input: { conversationId: string; artifactId: string },
    context: unknown,
  ): ReturnType<typeof readInvocationPayload>;
}

interface AgentBinding {
  store: AgentRuntimeStore;
  start(
    input: { run: AgentRun; trace: ModelInvocationTrace },
    context: unknown,
  ): Promise<AgentInvocationScope>;
}
const agentBindings = new WeakMap<ModelInvocationLedger, AgentBinding>();
export function beginAgentInvocation(
  ledger: ModelInvocationLedger,
  store: AgentRuntimeStore,
  input: { run: AgentRun; trace: ModelInvocationTrace },
  context: unknown,
) {
  const binding = agentBindings.get(ledger);
  if (!binding || binding.store !== store)
    throw new TypeError('Agent and invocations must share the same store');
  return binding.start(input, context);
}

/** The outcome, with the first receipt that could not be written beside it. */
function withReceipt<T extends object>(
  result: T,
  writer: InvocationAttemptWriter,
): T & { receiptError?: unknown } {
  const [receiptError] = writer.receiptErrors;
  return receiptError === undefined ? result : { ...result, receiptError };
}

/** Each model in order until one answers; only a provider failure moves on. */
async function generateWithFallback(
  models: ModelInvocationConfig['models'],
  writer: InvocationAttemptWriter,
  input: CompletionInvocationInput,
  abortSignal: AbortSignal,
): Promise<string> {
  for (const [step, key] of input.models.entries()) {
    abortSignal.throwIfAborted();
    const selected = models.resolve(key);
    try {
      const result = await generateText({
        model: wrapInvocationModel(writer, selected, step),
        prompt: input.prompt,
        ...input.settings,
        maxRetries: 0,
        abortSignal,
      });
      return result.text;
    } catch (error) {
      if (!hasProviderOrigin(error) || abortSignal.aborted || step === input.models.length - 1)
        throw error;
    }
  }
  throw new Error('No completion model attempt available');
}

/** One canonical provider ledger for plain completions and agent tool loops. */
export function createModelInvocationLedger(
  config: ModelInvocationConfig,
): ModelInvocationLedger {
  const { store } = config;
  const appendOnce = store.appendEventOnce?.bind(store);
  if (!appendOnce)
    throw new TypeError('Model invocations require atomic store.appendEventOnce');
  const maxPayloadBytes = z
    .int()
    .min(1_024)
    .max(64 * 1024 * 1024)
    .parse(config.maxPayloadBytes ?? 4 * 1024 * 1024);
  const payloads = createInvocationPayloads(store, config.payloadKey, maxPayloadBytes);
  const authorize = async (input: Parameters<ModelInvocationConfig['authorize']>[0]) =>
    InvocationCallerSchema.parse(await config.authorize(input));

  const start = async (input: {
    conversationId: string;
    key: string;
    trace: ModelInvocationTrace;
    mode: 'completion' | 'agent';
    context: unknown;
    requested: unknown;
    models: string[];
    runId?: string;
  }) => {
    const trace = ModelInvocationTraceSchema.parse(input.trace);
    const caller = await authorize({
      context: input.context,
      conversationId: input.conversationId,
      action: input.mode === 'completion' ? 'complete' : 'agent',
      trace,
    });
    const fingerprint = invocationHash({
      mode: input.mode,
      caller,
      trace,
      requested: input.requested,
    });
    const identity = {
      conversationId: input.conversationId,
      invocationId: randomUUID(),
      operationId: trace.operationId,
      ...(input.runId && { runId: input.runId }),
    };
    const started = InvocationStartedSchema.parse({
      ...identity,
      type: 'invocation/started',
      mode: input.mode,
      trace,
      caller,
      executingProcess,
      fingerprint,
      requested: { models: input.models, payloadSha256: invocationHash(input.requested) },
    });
    const admission = await appendOnce(
      { conversationId: input.conversationId, kind: 'invocation/started', payload: started },
      input.key,
    );
    const previous = InvocationStartedSchema.parse(admission.event.payload);
    if (previous.fingerprint !== fingerprint)
      throw new Error('Invocation idempotency key conflicts with an existing request');
    const writer: InvocationAttemptWriter = {
      identity: { ...identity, invocationId: previous.invocationId },
      process: executingProcess,
      payloads,
      onAttempt: config.onAttempt,
      receiptErrors: [],
      async append(record) {
        const parsed = ModelInvocationRecordSchema.parse(record);
        await store.appendEvent({
          conversationId: input.conversationId,
          kind: parsed.type,
          payload: parsed,
        });
      },
    };
    return { writer, duplicate: admission.outcome === 'duplicate' };
  };

  const finish = (
    writer: InvocationAttemptWriter,
    status: 'succeeded' | 'failed' | 'cancelled',
    failure?: { artifactId: string; payloadSha256: string },
  ) =>
    writer.append({
      ...writer.identity,
      type: 'invocation/finished',
      status,
      ...(failure && { failure }),
    });

  const ledger: ModelInvocationLedger = {
    async complete(rawInput, context, signal) {
      const input = CompletionInvocationInputSchema.parse(rawInput);
      const { writer, duplicate } = await start({
        conversationId: input.conversationId,
        key: `completion:${input.idempotencyKey}`,
        trace: input.trace,
        mode: 'completion',
        context,
        requested: input,
        models: input.models,
      });
      const invocationId = writer.identity.invocationId;
      if (duplicate) return { invocationId, outcome: 'duplicate' };
      const deadline = AbortSignal.timeout(input.timeoutMs);
      const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let text: string;
      try {
        text = await generateWithFallback(config.models, writer, input, abortSignal);
      } catch (error) {
        const status = abortSignal.aborted ? 'cancelled' : 'failed';
        // Recording the failure must not replace it: a failure payload that
        // cannot be written is recorded without its artifact, and a record
        // that cannot be written is returned beside the outcome.
        try {
          const artifact = await payloads.write(writer.identity, { error });
          await finish(writer, status, {
            artifactId: artifact.artifactId,
            payloadSha256: artifact.sha256,
          });
        } catch (receiptError) {
          writer.receiptErrors.push(receiptError);
          await finish(writer, status).catch((error: unknown) => {
            writer.receiptErrors.push(error);
          });
        }
        return withReceipt({ invocationId, outcome: status }, writer);
      }
      // The provider answered and was paid; a receipt that cannot be written
      // does not turn that into a failure or lose the text.
      try {
        await finish(writer, 'succeeded');
      } catch (receiptError) {
        writer.receiptErrors.push(receiptError);
      }
      return withReceipt({ invocationId, outcome: 'succeeded', text }, writer);
    },
    async read(rawInput, context) {
      const input = InvocationReadInputSchema.parse(rawInput);
      await authorize({ context, conversationId: input.conversationId, action: 'read' });
      return readInvocationRecords(store, input);
    },
    async readPayload(input, context) {
      await authorize({
        context,
        conversationId: input.conversationId,
        action: 'read-payload',
      });
      return readInvocationPayload(store, payloads, input);
    },
  };
  agentBindings.set(ledger, {
    store,
    async start(input, context) {
      const { conversationId, id: runId } = input.run;
      const view = await store.loadRun({ conversationId, runId });
      if (
        view?.run.state !== 'running' ||
        view.run.ownerId !== input.run.ownerId ||
        view.run.fencingToken !== input.run.fencingToken
      ) {
        throw new Error('Invocation requires an owned running agent run');
      }
      const { writer } = await start({
        conversationId,
        runId,
        trace: input.trace,
        key: `agent:${runId}`,
        context,
        mode: 'agent',
        models: [],
        requested: { runId },
      });
      return {
        wrap: (selected, step, override) =>
          wrapInvocationModel(writer, selected, step, override),
        finish: (status) => finish(writer, status),
      };
    },
  });
  return ledger;
}
