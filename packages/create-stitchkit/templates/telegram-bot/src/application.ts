import type { Bot } from 'grammy';
import {
  type ApplicationHandle,
  createApplication,
  defineManagedResource,
  type ManagedResource,
} from 'stitchkit/application';
import { type GrammyPollingEnd, grammyBotResources } from 'stitchkit/application/grammy';
import type { TelegramLocalFiles, TelegramOperatorChannel } from 'stitchkit/telegram';
import { createDatabase } from './database';
import { COMMANDS, type OperatorTopic, registerHandlers } from './handlers';
import type { Log } from './log';

export interface BotApplicationConfig {
  readonly bot: Bot;
  readonly databasePath: string;
  readonly log: Log;
  readonly operators?: TelegramOperatorChannel<OperatorTopic>;
  /** Present when a local Bot API server shares its files directory with the bot. */
  readonly files?: TelegramLocalFiles;
  /** Polling ended on its own; the entry point turns this into its shutdown. */
  readonly onPollingEnded: (end: GrammyPollingEnd) => void;
  /** How long stopping may take. */
  readonly shutdown?: { readonly gracePeriodMs: number; readonly forceTimeoutMs: number };
}

/**
 * The graph, in start order:
 *
 *   database → [telegram-files] → telegram-configuration → telegram-polling
 *   [operator-channel]              beside the bot, not under it
 *
 * The bot depends only on what it cannot answer without — required resources.
 * An optional one (the operators' chat, metrics) stands beside the bot: a
 * required resource may not depend on an optional one, and the bot must keep
 * answering when the chat is unreachable. Queues and an HTTP server for
 * payment webhooks are required and join the bot's `dependsOn`.
 */
export function createBotApplication(config: BotApplicationConfig): ApplicationHandle {
  const database = createDatabase(config.databasePath);
  registerHandlers(config.bot, {
    store: database.store,
    ...(config.operators && { operators: config.operators }),
  });
  config.bot.catch(({ error, ctx }) => {
    config.log.error('Telegram update failed', { updateId: ctx.update.update_id, error });
    config.operators?.post(`Update ${ctx.update.update_id} failed`, 'errors');
  });

  const files = config.files;
  const botDependencies: ManagedResource[] = [database.resource];
  if (files) {
    botDependencies.push(
      defineManagedResource({
        id: 'telegram-files',
        dependsOn: [database.resource],
        async start() {
          const check = await files.check();
          if (!check.ready) throw new Error(`Local Bot API files unavailable: ${check.reason}`);
        },
      }),
    );
  }
  const operators = config.operators;
  const beside: ManagedResource[] = operators
    ? [
        defineManagedResource({
          id: 'operator-channel',
          required: false,
          start() {},
          drain: (context) => operators.drain(context.signal),
          close: () => operators.close(),
        }),
      ]
    : [];

  const telegram = grammyBotResources({
    bot: config.bot,
    dependsOn: botDependencies,
    configure: async () => {
      await config.bot.api.setMyCommands(COMMANDS);
    },
    onStart: ({ username }) => config.log.info('Telegram polling started', { username }),
    onError: (error) => config.log.error('Telegram polling failed', { error }),
    onEnded: config.onPollingEnded,
  });

  return createApplication({
    id: 'telegram-bot',
    resources: [...botDependencies, ...beside, ...telegram.resources],
    shutdown: config.shutdown ?? { gracePeriodMs: 30_000, forceTimeoutMs: 5_000 },
    onResourceFailure: ({ resourceId, phase, error }) =>
      config.log.error('Resource failed', { resourceId, phase, error }),
  });
}
