import { z } from 'zod';
import { createBoundedChannel } from './channel';
import {
  type DiagnosticJournal,
  DiagnosticJournalCloseResultSchema,
  type DiagnosticJournalFailure,
  type DiagnosticJournalFailurePhase,
  DiagnosticJournalFrameSchema,
  type DiagnosticJournalLimits,
  DiagnosticJournalLimitsSchema,
  type DiagnosticJournalRefusalReason,
  type DiagnosticJournalState,
  type DiagnosticJournalStatus,
  DiagnosticJournalStatusSchema,
  DiagnosticJournalSubmitResultSchema,
  type DiagnosticJournalWaitOptions,
  DiagnosticJournalWaitResultSchema,
} from './diagnostic-journal-contract';
import {
  type DiagnosticJournalStorage,
  DiagnosticJournalStorageError,
} from './diagnostic-journal-storage';

interface DiagnosticJournalManagerConfig<SCHEMA extends z.ZodType> {
  readonly eventSchema: SCHEMA;
  readonly epoch: string;
  readonly limits: DiagnosticJournalLimits;
  readonly lock: DiagnosticJournalStatus['lock'];
  readonly onFailure?: (failure: DiagnosticJournalFailure) => void | Promise<void>;
}

interface PendingFrame {
  readonly sequence: number;
  readonly bytes: Uint8Array;
}

type WaitOutcome = 'settled' | 'timed-out' | 'cancelled';

function waitBudget(options: DiagnosticJournalWaitOptions): number | undefined {
  if (options.timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError('Diagnostic journal timeoutMs must be a positive safe integer');
  }
  return options.timeoutMs;
}

export function createDiagnosticJournalManager<SCHEMA extends z.ZodType>(
  config: DiagnosticJournalManagerConfig<SCHEMA>,
  storage: DiagnosticJournalStorage,
): DiagnosticJournal<z.input<SCHEMA>> {
  const limits = DiagnosticJournalLimitsSchema.parse(config.limits);
  const encoder = new TextEncoder();
  const channel = createBoundedChannel<PendingFrame>({
    policy: 'ordered',
    maxItems: limits.maxPendingItems,
    maxBytes: limits.maxPendingBytes,
    sizeOf: (frame) => frame.bytes.byteLength,
  });
  const refusals: Record<DiagnosticJournalRefusalReason, number> = {
    closed: 0,
    failed: 0,
    invalid: 0,
    oversized: 0,
    'item-capacity': 0,
    'byte-capacity': 0,
  };
  const progressWaiters = new Set<() => void>();
  let state: DiagnosticJournalState = 'open';
  let received = 0;
  let accepted = 0;
  let refused = 0;
  let written = 0;
  let failedRecords = 0;
  let pendingItems = 0;
  let pendingBytes = 0;
  let inFlight = false;
  let rotationFailures = 0;
  let lastAcceptedSequence = 0;
  let lastWrittenSequence = 0;
  let lastSettledSequence = 0;
  let lastFailure:
    | { readonly phase: DiagnosticJournalFailurePhase; readonly sequence?: number }
    | undefined;
  let physicalClosed = false;

  const isFailed = (): boolean => state === 'failed';

  const notifyProgress = (): void => {
    for (const waiter of progressWaiters) waiter();
  };

  const reportFailure = (failure: DiagnosticJournalFailure): void => {
    if (!config.onFailure) return;
    void Promise.resolve()
      .then(() => config.onFailure?.(failure))
      .catch(() => undefined);
  };

  const markFailure = (
    error: unknown,
    fallbackPhase: DiagnosticJournalFailurePhase,
    sequence?: number,
  ): void => {
    const phase = error instanceof DiagnosticJournalStorageError ? error.phase : fallbackPhase;
    if (phase === 'rotation') rotationFailures += 1;
    lastFailure = { phase, ...(sequence !== undefined && { sequence }) };
    state = 'failed';
    channel.close({ mode: 'drain' });
    reportFailure({ phase, error, ...(sequence !== undefined && { sequence }) });
  };

  const worker = (async (): Promise<void> => {
    for await (const frame of channel) {
      inFlight = true;
      if (isFailed()) {
        failedRecords += 1;
      } else {
        try {
          await storage.append(frame.bytes);
          written += 1;
          lastWrittenSequence = frame.sequence;
        } catch (error) {
          failedRecords += 1;
          markFailure(error, 'write', frame.sequence);
        }
      }
      pendingItems -= 1;
      pendingBytes -= frame.bytes.byteLength;
      lastSettledSequence = frame.sequence;
      inFlight = false;
      notifyProgress();
    }
    try {
      await storage.close();
    } catch (error) {
      markFailure(error, 'close');
    }
    physicalClosed = true;
    if (!isFailed()) state = 'closed';
    notifyProgress();
  })();
  void worker.catch((error) => {
    markFailure(error, 'close');
    physicalClosed = true;
    notifyProgress();
  });

  const refuse = (reason: DiagnosticJournalRefusalReason) => {
    refused += 1;
    refusals[reason] += 1;
    return DiagnosticJournalSubmitResultSchema.parse({ outcome: 'refused', reason });
  };

  const waitUntil = (
    predicate: () => boolean,
    options: DiagnosticJournalWaitOptions,
  ): Promise<WaitOutcome> => {
    const timeoutMs = waitBudget(options);
    if (predicate()) return Promise.resolve('settled');
    if (options.signal?.aborted) return Promise.resolve('cancelled');
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: WaitOutcome): void => {
        if (settled) return;
        settled = true;
        progressWaiters.delete(onProgress);
        options.signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        resolve(outcome);
      };
      const onProgress = (): void => {
        if (predicate()) finish('settled');
      };
      const onAbort = (): void => finish('cancelled');
      progressWaiters.add(onProgress);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => finish('timed-out'), timeoutMs);
      onProgress();
    });
  };

  const getStatus = () => {
    const file = storage.snapshot();
    return DiagnosticJournalStatusSchema.parse({
      state,
      epoch: config.epoch,
      limits,
      lock: config.lock,
      received,
      accepted,
      refused,
      refusals,
      written,
      failedRecords,
      pendingItems,
      pendingBytes,
      inFlight,
      rotations: file.rotations,
      rotationFailures,
      partialTails: file.partialTails,
      currentFileBytes: file.currentFileBytes,
      retainedFiles: file.retainedFiles,
      ...(lastAcceptedSequence > 0 && { lastAcceptedSequence }),
      ...(lastWrittenSequence > 0 && { lastWrittenSequence }),
      ...(lastSettledSequence > 0 && { lastSettledSequence }),
      ...(lastFailure && { lastFailure }),
    });
  };

  return {
    submit(event) {
      received += 1;
      if (state === 'failed') return refuse('failed');
      if (state !== 'open') return refuse('closed');
      const parsed = config.eventSchema.safeParse(event);
      if (!parsed.success) return refuse('invalid');
      const json = z.json().safeParse(parsed.data);
      if (!json.success) return refuse('invalid');
      const payload = encoder.encode(JSON.stringify(json.data));
      if (payload.byteLength > limits.maxEventBytes) return refuse('oversized');
      if (pendingItems >= limits.maxPendingItems) return refuse('item-capacity');

      const sequence = lastAcceptedSequence + 1;
      const frame = DiagnosticJournalFrameSchema.parse({
        schemaVersion: 1,
        epoch: config.epoch,
        sequence,
        event: json.data,
      });
      const bytes = encoder.encode(`${JSON.stringify(frame)}\n`);
      if (bytes.byteLength > limits.maxFileBytes) return refuse('oversized');
      if (pendingBytes + bytes.byteLength > limits.maxPendingBytes) {
        return refuse('byte-capacity');
      }
      const offered = channel.offer({ sequence, bytes });
      if (offered.outcome === 'refused') {
        return refuse(offered.reason === 'not-open' ? 'closed' : 'item-capacity');
      }
      accepted += 1;
      pendingItems += 1;
      pendingBytes += bytes.byteLength;
      lastAcceptedSequence = sequence;
      return DiagnosticJournalSubmitResultSchema.parse({
        outcome: 'accepted',
        epoch: config.epoch,
        sequence,
      });
    },
    async flush(options = {}) {
      const throughSequence = lastAcceptedSequence;
      const outcome = await waitUntil(() => lastSettledSequence >= throughSequence, options);
      return DiagnosticJournalWaitResultSchema.parse({
        outcome,
        state,
        throughSequence,
        settledSequence: lastSettledSequence,
      });
    },
    getStatus,
    async close(options = {}) {
      if (state === 'open') {
        state = 'draining';
        channel.close({ mode: 'drain' });
      }
      const wait = await waitUntil(() => physicalClosed, options);
      return DiagnosticJournalCloseResultSchema.parse({
        outcome: wait === 'settled' ? 'closed' : wait,
        state,
        pendingItems,
      });
    },
  };
}
