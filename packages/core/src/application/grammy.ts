import { type Bot, Context, type PollingOptions, type WebhookReplyEnvelope } from 'grammy';
import { defineManagedResource, type ManagedResource } from './resource';

if (typeof Context !== 'function') {
  throw new TypeError('[stitchkit] stitchkit/application/grammy requires the grammY peer');
}

export interface GrammyPollingResourceConfig<C extends Context> {
  readonly id: string;
  readonly bot: Bot<C>;
  readonly dependsOn?: readonly string[];
  readonly required?: boolean;
  readonly polling?: Omit<PollingOptions, 'onStart'>;
  readonly onStart?: PollingOptions['onStart'];
  readonly onError?: (error: unknown) => void | Promise<void>;
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

/** Thin lifecycle adapter for grammY's built-in long polling. */
export function grammyPollingResource<C extends Context>(
  config: GrammyPollingResourceConfig<C>,
): ManagedResource {
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
    start() {
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
          if (!becameReady) {
            rejectReady(
              new Error('[stitchkit] grammY polling stopped before reaching readiness'),
            );
          }
        },
        (error: unknown) => {
          if (!becameReady) rejectReady(error);
          reportIsolated(config.onError, error);
          throw error;
        },
      );
      // Observe immediately; the kernel also consumes this promise as resource completion.
      void completion.catch(() => undefined);
      return { ready, completion };
    },
    stopAdmission() {
      return stop();
    },
    async drain() {
      await completion;
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
  readonly dependsOn?: readonly string[];
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

/**
 * Deliberately NOT in `STITCH_ERROR_STATUS`: that registry is the generic core's
 * (→ ADR 0002), and a provider name has no place in a union every consumer
 * imports. This code travels as itself through a partial `codeMap`, exactly the
 * way a code the project threw does.
 */
export class GrammyWebhookUnavailableError extends Error {
  readonly code = 'GRAMMY_WEBHOOK_NOT_ACCEPTING';

  constructor() {
    super('grammY webhook resource is not accepting updates');
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
      await config.bot.init(context.signal);
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
