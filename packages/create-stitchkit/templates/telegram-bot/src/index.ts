import { autoRetry } from '@grammyjs/auto-retry';
import { Bot } from 'grammy';
import { bindProcessSignals } from 'stitchkit/server';
import {
  createTelegramLocalFiles,
  createTelegramOperatorChannel,
  telegramOperatorSender,
} from 'stitchkit/telegram';
import { createBotApplication } from './application';
import { readEnv } from './env';
import type { OperatorTopic } from './handlers';
import { createLog } from './log';
import { runtimeBindings } from './runtime-bindings';

const env = readEnv();
const log = createLog(env);

const bot = new Bot(env.BOT_TOKEN, {
  ...(env.BOT_API_URL && { client: { apiRoot: env.BOT_API_URL } }),
});
// A 429 on a reply is Telegram asking to wait, not a failure: wait what it names, then repeat.
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

const operators =
  env.OPERATOR_CHAT_ID === undefined
    ? undefined
    : createTelegramOperatorChannel<OperatorTopic>({
        chatId: env.OPERATOR_CHAT_ID,
        // Forum topic ids of the operators' chat, when it has topics.
        topics: {},
        send: telegramOperatorSender({
          token: env.BOT_TOKEN,
          ...(env.BOT_API_URL && { apiRoot: env.BOT_API_URL }),
        }),
        onDropped: (drop) => log.warn('Operator message dropped', { ...drop }),
      });

const app = createBotApplication({
  bot,
  databasePath: env.DATABASE_PATH,
  log,
  ...(operators && { operators }),
  ...(env.BOT_API_FILES_ROOT && {
    files: createTelegramLocalFiles({ root: env.BOT_API_FILES_ROOT, token: env.BOT_TOKEN }),
  }),
  // grammY's poller does not recover in-process: stop the way a signal would,
  // and exit non-zero so the supervisor starts a fresh process.
  onPollingEnded: ({ error }) => {
    log.error('Telegram polling ended', { error });
    stopAndExit(1);
  },
});
const bindings = runtimeBindings(app, log);

let exiting = false;
async function finish(code: number): Promise<never> {
  await Promise.allSettled(bindings.map((binding) => binding.close()));
  process.exit(code);
}
function stopAndExit(code: number): void {
  if (exiting) return;
  exiting = true;
  signals.close();
  app
    .shutdown()
    .then((result) => {
      log.info('Application stopped', { outcome: result.outcome });
      return finish(code);
    })
    .catch((error: unknown) => {
      log.error('Application shutdown failed', { error });
      return finish(1);
    });
}

const signals = bindProcessSignals(app, {
  async onComplete(result) {
    if (exiting) return;
    exiting = true;
    log.info('Application stopped', { outcome: result.outcome });
    await finish(result.outcome === 'clean' && result.cleanupComplete ? 0 : 1);
  },
  onError(phase, error) {
    log.error('Application lifecycle failed', { phase, error });
    void finish(1);
  },
  onEscalationBlocked() {
    void finish(1);
  },
});

async function main(): Promise<void> {
  for (const binding of bindings) await binding.start();
  await app.start();
}

main().catch((error: unknown) => {
  log.error('Application startup failed', { error });
  void finish(1);
});
