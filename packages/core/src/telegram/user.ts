/**
 * A Telegram user in one shape, wherever it came from.
 *
 * Telegram sends a user in `snake_case` twice over — the Bot API's `from` on
 * every update, the Mini App's signed `user` — and every other name this
 * package publishes is `camelCase`. An application with one `ensureAccount`
 * receives both, and a surface that switched convention by source would make
 * it write the same translation twice. So both pass through this schema and
 * arrive as the same `TelegramUser`.
 */

import { z } from 'zod';

const TelegramUserSchema = z
  .object({
    id: z.int(),
    is_bot: z.boolean().optional(),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
    language_code: z.string().optional(),
    is_premium: z.boolean().optional(),
    /** Mini App only: the user let the bot write to them. */
    allows_write_to_pm: z.boolean().optional(),
    /** Mini App only. */
    photo_url: z.string().optional(),
  })
  .transform((user) => ({
    id: user.id,
    firstName: user.first_name,
    ...(user.is_bot !== undefined && { isBot: user.is_bot }),
    ...(user.last_name !== undefined && { lastName: user.last_name }),
    ...(user.username !== undefined && { username: user.username }),
    ...(user.language_code !== undefined && { languageCode: user.language_code }),
    ...(user.is_premium !== undefined && { isPremium: user.is_premium }),
    ...(user.allows_write_to_pm !== undefined && { allowsWriteToPm: user.allows_write_to_pm }),
    ...(user.photo_url !== undefined && { photoUrl: user.photo_url }),
  }));

/** A Telegram user as this package names it; fields Telegram did not send are absent. */
export type TelegramUser = z.infer<typeof TelegramUserSchema>;

/**
 * Telegram's user record — grammY's `ctx.from`, a Bot API `User`, a Mini App's
 * `user` — as a `TelegramUser`; `undefined` when it is not one.
 */
export function parseTelegramUser(value: unknown): TelegramUser | undefined {
  const parsed = TelegramUserSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
