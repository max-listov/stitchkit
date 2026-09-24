import { z } from 'zod';

const blankIsAbsent = (value: unknown) => (value === '' ? undefined : value);

/** The variables `project.json` declares, parsed once at the edge of the process. */
export const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required — the token from @BotFather'),
  LOG_LEVEL: z.preprocess(
    blankIsAbsent,
    z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ),
  DATABASE_PATH: z.preprocess(blankIsAbsent, z.string().min(1).default('.data/bot.sqlite')),
  OPERATOR_CHAT_ID: z.preprocess(blankIsAbsent, z.coerce.number().int().optional()),
  BOT_API_URL: z.preprocess(blankIsAbsent, z.url().optional()),
  BOT_API_FILES_ROOT: z.preprocess(
    blankIsAbsent,
    z.string().startsWith('/', 'BOT_API_FILES_ROOT must be absolute').optional(),
  ),
});
export type Env = z.infer<typeof EnvSchema>;

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const env = EnvSchema.parse(source);
  if (env.BOT_API_URL && !env.BOT_API_FILES_ROOT) {
    throw new Error(
      'BOT_API_FILES_ROOT is required with BOT_API_URL: the bot reads its files from there',
    );
  }
  return env;
}
