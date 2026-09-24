import { createJsonLogger } from 'stitchkit/observability';
import { TELEGRAM_BOT_TOKEN_PATTERN } from 'stitchkit/telegram';
import type { Env } from './env';

/**
 * The process journal: one JSON line per event on standard output. An `Error`
 * under any key keeps its name, message, stack and cause, and a bot token
 * inside a URL or an error message is masked. A line with `"level":50` is an
 * error — the one contract a supervisor reading the journal relies on.
 */
export function createLog(env: Pick<Env, 'LOG_LEVEL'>) {
  return createJsonLogger({
    level: env.LOG_LEVEL,
    sensitiveUrlPatterns: [TELEGRAM_BOT_TOKEN_PATTERN],
  });
}

export type Log = ReturnType<typeof createLog>;
