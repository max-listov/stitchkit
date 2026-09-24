/**
 * A file the local Bot API server already wrote to disk.
 *
 * `telegram-bot-api` keeps what it downloads under `<dir>/<bot token>/`, and a
 * bot sharing that directory reads the file straight from disk instead of
 * downloading it again, then deletes it once handled. Two bots did this two
 * ways: one refused anything leaving the bot's directory, the other joined
 * `file_path` onto the root and read whatever that named. `file_path` comes
 * from a server over the network; `../` in it, or a link inside the directory
 * pointing out of it, turned the second into a read — and a delete — of any
 * file the bot's user could reach.
 *
 * The containment is decided on real paths, after links are resolved, so a
 * link inside the directory is judged by where it leads. A refusal is a
 * reason, and its message never carries the path or the token: both are
 * secrets in a journal, the token literally so.
 */

import { constants } from 'node:fs';
import { access, lstat, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Why a file will not be handed out.
 *
 * - `root-not-absolute` — the configured root is relative, so it would mean
 *   something different in every working directory.
 * - `bot-directory-unavailable` — the root has no readable, writable directory
 *   for this bot: the server is not sharing it, or the process may not delete.
 * - `outside-bot-directory` — `file_path` leaves the bot's directory, by `../`,
 *   by an absolute path elsewhere, or through a link.
 * - `missing` — nothing is there (already handled, or never finished).
 * - `not-a-file` — something is there, and it is not a regular file.
 */
export type TelegramLocalFileRefusal =
  | 'root-not-absolute'
  | 'bot-directory-unavailable'
  | 'outside-bot-directory'
  | 'missing'
  | 'not-a-file';

export class TelegramLocalFileError extends Error {
  readonly reason: TelegramLocalFileRefusal;

  constructor(reason: TelegramLocalFileRefusal) {
    super(`Telegram local file refused: ${reason}`);
    this.name = 'TelegramLocalFileError';
    this.reason = reason;
  }
}

export interface TelegramLocalFilesConfig {
  /**
   * The directory the Bot API server was started with (`--dir`), absolute, as
   * this process sees it. The recommended variable is `BOT_API_FILES_ROOT`.
   */
  readonly root: string;
  /** The bot's token: the server names the bot's directory after it. */
  readonly token: string;
}

export type TelegramLocalFilesCheck =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: TelegramLocalFileRefusal };

export interface TelegramLocalFiles {
  /**
   * The absolute path of `file_path` as `getFile` returned it — relative, or
   * absolute inside the bot's directory as a `--local` server answers.
   * Throws `TelegramLocalFileError`.
   */
  resolve(filePath: string): Promise<string>;
  /** Delete a handled file, within the same boundary. Already gone is not an error. */
  remove(filePath: string): Promise<void>;
  /** Whether the bot's directory is there to read and delete from — for readiness. */
  check(): Promise<TelegramLocalFilesCheck>;
}

const absent = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

function inside(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

export function createTelegramLocalFiles(
  config: TelegramLocalFilesConfig,
): TelegramLocalFiles {
  const rootIsAbsolute = isAbsolute(config.root);
  const botDirectory = resolve(config.root, config.token);

  const realBotDirectory = async (): Promise<string> => {
    if (!rootIsAbsolute) throw new TelegramLocalFileError('root-not-absolute');
    try {
      return await realpath(botDirectory);
    } catch (error) {
      if (absent(error)) throw new TelegramLocalFileError('bot-directory-unavailable');
      throw error;
    }
  };

  /** The contained real path, before anything is read. */
  const locate = async (filePath: string): Promise<string> => {
    const directory = await realBotDirectory();
    const lexical = isAbsolute(filePath) ? resolve(filePath) : resolve(botDirectory, filePath);
    // Judged twice: lexically, so `../` is refused before touching the disk,
    // and on the real path, so a link is judged by where it leads.
    if (!inside(botDirectory, lexical) && !inside(directory, lexical)) {
      throw new TelegramLocalFileError('outside-bot-directory');
    }
    let real: string;
    try {
      real = await realpath(lexical);
    } catch (error) {
      if (absent(error)) throw new TelegramLocalFileError('missing');
      throw error;
    }
    if (!inside(directory, real)) throw new TelegramLocalFileError('outside-bot-directory');
    return real;
  };

  return {
    async resolve(filePath) {
      const path = await locate(filePath);
      const info = await stat(path);
      if (!info.isFile()) throw new TelegramLocalFileError('not-a-file');
      return path;
    },
    async remove(filePath) {
      let path: string;
      try {
        path = await locate(filePath);
      } catch (error) {
        if (error instanceof TelegramLocalFileError && error.reason === 'missing') return;
        throw error;
      }
      if (!(await lstat(path)).isFile()) throw new TelegramLocalFileError('not-a-file');
      try {
        await unlink(path);
      } catch (error) {
        if (!absent(error)) throw error;
      }
    },
    async check() {
      try {
        const directory = await realBotDirectory();
        await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
        return { ready: true };
      } catch (error) {
        if (error instanceof TelegramLocalFileError)
          return { ready: false, reason: error.reason };
        return { ready: false, reason: 'bot-directory-unavailable' };
      }
    },
  };
}
