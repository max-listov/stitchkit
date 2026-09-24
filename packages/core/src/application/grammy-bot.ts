import type { Bot, Context } from 'grammy';
import {
  type GrammyPollingEnd,
  type GrammyPollingResourceConfig,
  grammyPollingResource,
} from './grammy';
import {
  defineManagedResource,
  type ManagedResource,
  type ManagedResourceContext,
  type ManagedResourceDependency,
} from './resource';

/** The two ids a monitor, a test and a restart address the bot by. */
export const TELEGRAM_CONFIGURATION_RESOURCE_ID = 'telegram-configuration';
export const TELEGRAM_POLLING_RESOURCE_ID = 'telegram-polling';

export interface GrammyBotResourcesConfig<C extends Context> {
  readonly bot: Bot<C>;
  /**
   * What the bot needs before it may say anything to Telegram — the database
   * its handlers read, the queues they enqueue into, the HTTP server whose
   * webhooks they answer. Both resources start after all of it.
   */
  readonly dependsOn?: readonly ManagedResourceDependency[];
  /**
   * Publish what Telegram shows before the first update — the command menu,
   * the description, the menu button. Runs once per start, before polling, so
   * a menu that failed to publish fails the start instead of hiding behind a
   * bot that answers. Omit it and there is no `telegram-configuration`.
   */
  readonly configure?: (context: ManagedResourceContext) => void | Promise<void>;
  readonly polling?: GrammyPollingResourceConfig<C>['polling'];
  readonly onStart?: GrammyPollingResourceConfig<C>['onStart'];
  readonly onError?: (error: unknown) => void | Promise<void>;
  /** See `GrammyPollingResourceConfig.onEnded` — the one place the end of polling is decided. */
  readonly onEnded?: (end: GrammyPollingEnd) => void | Promise<void>;
}

export interface GrammyBotResources {
  readonly configuration?: ManagedResource;
  readonly polling: ManagedResource;
  /** Both, in start order, for `createApplication({ resources })`. */
  readonly resources: readonly ManagedResource[];
}

/**
 * A long-polling Telegram bot as resources of an application.
 *
 * Every bot assembled the same pair by hand — a configuration resource calling
 * `setMyCommands`, then `grammyPollingResource` — under its own names, and only
 * one of them held updates back while the application was not ready. One call
 * now gives the pair with stable ids, updates admitted by batch, and the end of
 * polling reported to one callback.
 */
export function grammyBotResources<C extends Context>(
  config: GrammyBotResourcesConfig<C>,
): GrammyBotResources {
  const dependsOn = config.dependsOn ?? [];
  const configure = config.configure;
  const configuration = configure
    ? defineManagedResource({
        id: TELEGRAM_CONFIGURATION_RESOURCE_ID,
        dependsOn,
        async start(context) {
          await configure(context);
        },
      })
    : undefined;
  const polling = grammyPollingResource({
    id: TELEGRAM_POLLING_RESOURCE_ID,
    bot: config.bot,
    dependsOn: configuration ? [configuration] : dependsOn,
    ...(config.polling && { polling: config.polling }),
    ...(config.onStart && { onStart: config.onStart }),
    ...(config.onError && { onError: config.onError }),
    ...(config.onEnded && { onEnded: config.onEnded }),
  });
  return {
    ...(configuration && { configuration }),
    polling,
    resources: configuration ? [configuration, polling] : [polling],
  };
}
