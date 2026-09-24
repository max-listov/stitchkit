import type { Bot, Context } from 'grammy';
import type { ApplicationOperationLease } from './kernel-contract';
import type { ManagedResourceAdmission } from './resource';

/**
 * Updates reach grammY only while the application admits them.
 *
 * grammY's built-in polling acknowledges a batch by asking for the next one
 * with a higher offset, and it asks as soon as the previous batch has been
 * through middleware — whatever the middleware did with it. So an update that
 * arrived while the application was starting, degraded or stopping was handed
 * to a handler that refused it, and the next `getUpdates` confirmed it to
 * Telegram as handled. Nothing retried it; it was simply gone.
 *
 * The gate sits on the one call that moves the offset. Before asking for a
 * batch it waits until the application admits; after Telegram answers with a
 * non-empty batch it takes one admission lease for the whole batch and only
 * then returns it to grammY. grammY handles a batch sequentially and asks for
 * the next one only when it is done, so the next `getUpdates` is also the
 * moment the batch is finished and its lease is released — no middleware, and
 * so no dependence on where in the chain it was registered.
 *
 * A batch that arrives when the application will not admit it is never
 * returned: the request fails with an abort, grammY's offset does not move, and
 * Telegram keeps the updates for the next process.
 */
export interface UpdateAdmissionGate {
  /** Admission for the current life of the polling resource; `undefined` passes calls through. */
  bind(admission: ManagedResourceAdmission | undefined): void;
  /** Resolves when no admitted batch is in progress, or when `signal` aborts. */
  whenIdle(signal: AbortSignal): Promise<void>;
  /** Release an admitted batch whose handling ended without a next request. */
  release(): void;
}

function batchSize(result: unknown): number {
  return Array.isArray(result) ? result.length : 0;
}

function abortError(): DOMException {
  return new DOMException('Telegram polling stopped', 'AbortError');
}

/**
 * The application will not admit again, so there is nothing to fetch for. Wait
 * for the stop that is coming instead of letting grammY retry every three
 * seconds against a gate that will not open.
 */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

async function admitted(
  admission: ManagedResourceAdmission,
  signal: AbortSignal,
): Promise<ApplicationOperationLease> {
  try {
    return await admission.acquireWhenAccepting(signal);
  } catch {
    if (signal.aborted) throw abortError();
    return untilAborted(signal);
  }
}

/** The part of grammY's declared signal the gate reads. */
interface PollingSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
}

/**
 * A platform signal that follows grammY's. Its Node declaration types the
 * signal as the `abort-controller` package's, which lacks `reason`; following
 * it through a listener keeps a cast out of the gate.
 */
function followed(signal: PollingSignal): AbortSignal {
  const controller = new AbortController();
  if (signal.aborted) controller.abort(abortError());
  else signal.addEventListener('abort', () => controller.abort(abortError()));
  return controller.signal;
}

const gates = new WeakMap<object, UpdateAdmissionGate>();

/** Install the gate once per bot; a restarted resource binds the same gate again. */
export function updateAdmissionGate<C extends Context>(bot: Bot<C>): UpdateAdmissionGate {
  const existing = gates.get(bot);
  if (existing) return existing;

  let admission: ManagedResourceAdmission | undefined;
  let batch: ApplicationOperationLease | undefined;
  const idle = new Set<() => void>();

  const release = (): void => {
    batch?.release();
    batch = undefined;
    for (const waiter of idle) waiter();
    idle.clear();
  };

  bot.api.config.use(async (previous, method, payload, signal) => {
    // `bot.stop()` sends one last `getUpdates` without a signal to confirm the
    // offset of what was handled; that call is exactly what should pass.
    if (method !== 'getUpdates' || !signal || !admission) {
      return previous(method, payload, signal);
    }
    release();
    const polling = admission;
    const stopped = followed(signal);
    // Only a check: an idle long poll holds no operation.
    (await admitted(polling, stopped)).release();
    const answer = await previous(method, payload, signal);
    if (answer.ok && batchSize(answer.result) > 0) batch = await admitted(polling, stopped);
    return answer;
  });

  const gate: UpdateAdmissionGate = {
    bind(next) {
      admission = next;
    },
    whenIdle(signal) {
      if (!batch || signal.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const done = (): void => {
          signal.removeEventListener('abort', done);
          idle.delete(done);
          resolve();
        };
        idle.add(done);
        signal.addEventListener('abort', done, { once: true });
      });
    },
    release,
  };
  gates.set(bot, gate);
  return gate;
}
