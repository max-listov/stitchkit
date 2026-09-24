import { type Bot, Context, type PollingOptions, type WebhookReplyEnvelope } from 'grammy';
import { AppError } from '../contract/errors';
import { updateAdmissionGate } from './grammy-update-admission';
import {
  defineManagedResource,
  type ManagedResource,
  type ManagedResourceDependency,
} from './resource';

if (typeof Context !== 'function') {
  throw new TypeError('[stitchkit] stitchkit/application/grammy requires the grammY peer');
}

export interface GrammyPollingResourceConfig<C extends Context> {
  readonly id: string;
  readonly bot: Bot<C>;
  readonly dependsOn?: readonly ManagedResourceDependency[];
  readonly required?: boolean;
  readonly polling?: Omit<PollingOptions, 'onStart'>;
  readonly onStart?: PollingOptions['onStart'];
  readonly onError?: (error: unknown) => void | Promise<void>;
  /**
   * Polling ended on its own after it was ready — Telegram refused the token,
   * another process took the same bot (409), or the error handler rethrew.
   * Called once, never for a stop the application asked for. grammY's poller
   * does not recover in-process, and the framework does not exit processes
   * (ADR 0074): this is where an application turns the end into its shutdown.
   */
  readonly onEnded?: (end: GrammyPollingEnd) => void | Promise<void>;
}

/** How a poller that was ready came to an end; `error` is absent when it simply returned. */
export interface GrammyPollingEnd {
  readonly error?: unknown;
}

function reportIsolated(
  callback: ((error: unknown) => void | Promise<void>) | undefined,
  error: unknown,
): void {
  if (!callback) return;
  void Promise.resolve()
    .then(() => callback(error))
    .catch(() => {
      // A diagnostic callback cannot corrupt provider lifecycle accounting.
    });
}

function reportEnd(
  callback: ((end: GrammyPollingEnd) => void | Promise<void>) | undefined,
  end: GrammyPollingEnd,
): void {
  if (!callback) return;
  // A macrotask later: the kernel records the ended completion as this
  // resource's failure first. Called in the same turn, an observer that shuts
  // down marks the shutdown requested before that, and the one failure that
  // happened is never recorded.
  setTimeout(() => {
    void Promise.resolve()
      .then(() => callback(end))
      .catch(() => {
        // The observer of an ended poller cannot fail the poller a second time.
      });
  }, 0);
}

/**
 * Lifecycle adapter for grammY's built-in long polling.
 *
 * Updates are admitted by batch (see `grammy-update-admission`): no batch is
 * fetched while the application is not accepting, and the batch in hand is
 * finished before `bot.stop()` confirms the offset, so a stop neither loses an
 * update nor hands the next process one this process already handled.
 */
export function grammyPollingResource<C extends Context>(
  config: GrammyPollingResourceConfig<C>,
): ManagedResource {
  const gate = updateAdmissionGate(config.bot);
  let completion: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = Promise.resolve().then(() => config.bot.stop());
      void stopPromise.catch((error: unknown) => reportIsolated(config.onError, error));
    }
    return stopPromise;
  };

  return defineManagedResource({
    id: config.id,
    ...(config.dependsOn && { dependsOn: config.dependsOn }),
    ...(config.required !== undefined && { required: config.required }),
    start(context) {
      stopPromise = undefined;
      gate.bind(context.admission);
      let resolveReady: () => void = () => undefined;
      let rejectReady: (error: unknown) => void = () => undefined;
      let becameReady = false;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const polling = config.bot.start({
        ...config.polling,
        onStart: async (botInfo) => {
          await config.onStart?.(botInfo);
          becameReady = true;
          resolveReady();
        },
      });
      completion = polling.then(
        () => {
          gate.release();
          if (!becameReady) {
            rejectReady(
              new Error('[stitchkit] grammY polling stopped before reaching readiness'),
            );
          } else if (!stopPromise) reportEnd(config.onEnded, {});
        },
        (error: unknown) => {
          gate.release();
          if (!becameReady) rejectReady(error);
          reportIsolated(config.onError, error);
          if (becameReady && !stopPromise) reportEnd(config.onEnded, { error });
          throw error;
        },
      );
      // Observe immediately; the kernel also consumes this promise as resource completion.
      void completion.catch(() => undefined);
      return { ready, completion };
    },
    // The batch in hand finishes first, so the offset `stop()` confirms covers
    // all of it. The graceful deadline aborts the wait, never the handlers.
    async stopAdmission(context) {
      await gate.whenIdle(context.signal);
      await stop();
    },
    // Polling that already ended was recorded as this resource's `completion`
    // failure; draining it is done, not a second failure of the same end.
    async drain() {
      await completion?.catch(() => undefined);
    },
    async close() {
      await stop();
      if (completion) await completion.catch(() => undefined);
    },
    async force() {
      await stop();
      if (completion) await completion.catch(() => undefined);
    },
  });
}

export type GrammyUpdate<C extends Context = Context> = Parameters<Bot<C>['handleUpdate']>[0];

export interface GrammyWebhookResourceConfig<C extends Context> {
  readonly id: string;
  readonly bot: Bot<C>;
  readonly dependsOn?: readonly ManagedResourceDependency[];
  readonly required?: boolean;
  readonly onError?: (error: unknown) => void | Promise<void>;
}

export interface GrammyWebhookResource<C extends Context> {
  readonly resource: ManagedResource;
  handleUpdate(
    update: GrammyUpdate<C>,
    webhookReplyEnvelope?: WebhookReplyEnvelope,
  ): Promise<void>;
}

type GrammyNodeAbortSignal = Parameters<Bot<Context>['init']>[0];

/**
 * grammY's Node declaration replaces the platform signal with the
 * `abort-controller` declaration, even though its implementation and
 * `node-fetch` consume the same abort-event protocol as a native signal.
 */
function grammyNodeSignal(signal: AbortSignal): GrammyNodeAbortSignal {
  return signal as unknown as GrammyNodeAbortSignal;
}

/**
 * In `STITCH_ERROR_STATUS`, like every other code the framework throws
 * (→ ADR 0105), and branded for the same reason as `ApplicationAdmissionError`.
 *
 * The registry is not a domain vocabulary, so ADR 0002 does not exempt this: it
 * is the list of codes stitchkit itself authors, and the only thing a consumer
 * does with it is decide what each one looks like on their wire. Leaving an
 * adapter's code out does not keep a provider name out of a consumer's
 * concern — it means `isStitchErrorCode` answers `false`, `createErrorHook`
 * skips both `codeMap` and `unmappedCode`, and the code reaches the wire in
 * stitchkit's spelling. The name is more visible left out than in.
 */
export class GrammyWebhookUnavailableError extends AppError<'GRAMMY_WEBHOOK_NOT_ACCEPTING'> {
  constructor() {
    super(
      'GRAMMY_WEBHOOK_NOT_ACCEPTING',
      'grammY webhook resource is not accepting updates',
      503,
    );
    this.name = 'GrammyWebhookUnavailableError';
  }
}

/**
 * Create a managed admission gate around an injected grammY webhook bot.
 * HTTP parsing, webhook hosting and Telegram payload persistence remain outside Stitchkit.
 */
export function createGrammyWebhookResource<C extends Context>(
  config: GrammyWebhookResourceConfig<C>,
): GrammyWebhookResource<C> {
  let accepting = false;
  let pending = 0;
  const waiters = new Set<() => void>();
  const waitForIdle = (signal: AbortSignal): Promise<void> => {
    if (pending === 0 || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish);
        waiters.delete(finish);
        resolve();
      };
      waiters.add(finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  };
  const resource = defineManagedResource({
    id: config.id,
    ...(config.dependsOn && { dependsOn: config.dependsOn }),
    ...(config.required !== undefined && { required: config.required }),
    async start(context) {
      await config.bot.init(grammyNodeSignal(context.signal));
    },
    activate() {
      accepting = true;
    },
    stopAdmission() {
      accepting = false;
    },
    drain(context) {
      return waitForIdle(context.signal);
    },
    close() {
      accepting = false;
    },
    async force(context) {
      accepting = false;
      await waitForIdle(context.signal);
      if (pending > 0) {
        throw new Error(
          '[stitchkit] grammY webhook middleware remained active at force deadline',
        );
      }
    },
  });

  return {
    resource,
    async handleUpdate(update, webhookReplyEnvelope) {
      if (!accepting) throw new GrammyWebhookUnavailableError();
      pending += 1;
      try {
        await config.bot.handleUpdate(update, webhookReplyEnvelope);
      } catch (error) {
        reportIsolated(config.onError, error);
        throw error;
      } finally {
        pending -= 1;
        if (pending === 0) {
          for (const waiter of waiters) waiter();
          waiters.clear();
        }
      }
    },
  };
}
