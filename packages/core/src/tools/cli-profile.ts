/**
 * Named credential profiles for a CLI that talks to more than one deployment.
 *
 * A person picks an environment by name — `--profile prod` — and the whole
 * safety of that gesture rests on one rule that is easy to write the wrong way
 * round: **a name that was given and not found is a refusal, never a
 * substitution.** The convenient version reads as kindness ("only one profile is
 * configured, use it") and is correct exactly while a single profile exists. The
 * day a second appears it becomes a command run against the wrong deployment,
 * with nothing in the output to say so — a consumer hit precisely that, asking
 * for `prod` on a machine holding only `dev` and reading a plausible answer.
 *
 * The distinction has to be drawn here, at resolution. One step later "prod" and
 * "prod by default" are the same string.
 *
 * Substitution survives in the one case that cannot be wrong: no name was given
 * at all and exactly one profile exists — and even then it is announced.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { AppError } from '../contract/errors';
import { safeJsonParse } from '../internal/safe-json';

const PROFILE_SUFFIX = '.json';
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** A refusal a CLI can report as an ordinary error result. */
export class CliProfileError extends AppError {
  constructor(message: string, code: 'NOT_FOUND' | 'BAD_REQUEST' | 'FORBIDDEN' = 'NOT_FOUND') {
    super(code, message, code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : 400);
    this.name = 'CliProfileError';
  }
}

export interface CliProfileStoreConfig<TSchema extends z.ZodType> {
  /** Directory holding one `<name>.json` per profile, mode 0700. */
  directory: string;
  /** What one profile file must contain — an address and a credential, typically. */
  schema: TSchema;
  /**
   * How to create a missing profile, in the application's own words. It is
   * printed with the refusal, because "profile not found" without the command
   * that creates it leaves the reader to guess the file format.
   */
  createHint?: (name: string, path: string) => string;
  /** Where the substitution notice goes; default stderr. */
  announce?: (line: string) => void;
}

export interface ResolvedCliProfile<TValue> {
  name: string;
  path: string;
  value: TValue;
  /** True when no name was asked for and the only configured profile was taken. */
  substituted: boolean;
}

export interface CliProfileStore<TValue> {
  directory: string;
  pathFor(name: string): string;
  list(): string[];
  read(name: string): TValue;
  /** Write a profile, creating the directory 0700 and the file 0600. */
  write(name: string, value: unknown): string;
  /** The rule this module exists for. `undefined` means "no name was given". */
  resolve(name: string | undefined): ResolvedCliProfile<TValue>;
}

function assertProfileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new CliProfileError(
      `"${name}" is not a usable profile name — letters, digits, dot, dash and underscore`,
      'BAD_REQUEST',
    );
  }
}

/** Build a profile store over a directory of `0600` JSON files. */
export function createCliProfileStore<TSchema extends z.ZodType>(
  config: CliProfileStoreConfig<TSchema>,
): CliProfileStore<z.output<TSchema>> {
  const announce = config.announce ?? ((line: string) => process.stderr.write(`${line}\n`));
  const pathFor = (name: string): string => {
    assertProfileName(name);
    return join(config.directory, `${name}${PROFILE_SUFFIX}`);
  };

  const list = (): string[] => {
    if (!existsSync(config.directory)) return [];
    return readdirSync(config.directory)
      .filter((entry) => entry.endsWith(PROFILE_SUFFIX))
      .map((entry) => entry.slice(0, -PROFILE_SUFFIX.length))
      .sort();
  };

  const read = (name: string): z.output<TSchema> => {
    const path = pathFor(name);
    if (!existsSync(path)) {
      throw new CliProfileError(missingMessage(name, path, config));
    }
    // A profile holds a credential. A file anyone on the machine can read is a
    // leak whether or not it is ever read, and saying so is cheaper than the
    // incident.
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) {
      throw new CliProfileError(
        `profile "${name}" is readable by other users — run: chmod 600 ${path}`,
        'FORBIDDEN',
      );
    }
    const parsed = safeJsonParse(readFileSync(path, 'utf8'));
    const result = config.schema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path.join('.');
      throw new CliProfileError(
        `profile "${name}" (${path}) is not usable: ${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}`,
        'BAD_REQUEST',
      );
    }
    return result.data;
  };

  return {
    directory: config.directory,
    pathFor,
    list,
    read,
    write(name, value) {
      const path = pathFor(name);
      mkdirSync(config.directory, { recursive: true, mode: DIRECTORY_MODE });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
      // `writeFileSync`'s mode applies to a file it creates, not to one that
      // already exists — an overwrite would otherwise keep the old permissions.
      chmodSync(path, FILE_MODE);
      return path;
    },
    resolve(name) {
      if (name !== undefined) {
        const path = pathFor(name);
        return { name, path, value: read(name), substituted: false };
      }
      const configured = list();
      const only = configured[0];
      if (configured.length === 1 && only !== undefined) {
        const path = pathFor(only);
        announce(`[${only}] using the only configured profile (${path})`);
        return { name: only, path, value: read(only), substituted: true };
      }
      if (configured.length === 0) {
        // The example path is built directly: `pathFor` validates a real name,
        // and a placeholder is not one.
        const example = join(config.directory, `<name>${PROFILE_SUFFIX}`);
        throw new CliProfileError(
          `no profile is configured in ${config.directory}${
            config.createHint ? ` — ${config.createHint('<name>', example)}` : ''
          }`,
        );
      }
      throw new CliProfileError(
        `several profiles are configured (${configured.join(', ')}) — name one`,
        'BAD_REQUEST',
      );
    },
  };
}

function missingMessage<TSchema extends z.ZodType>(
  name: string,
  path: string,
  config: CliProfileStoreConfig<TSchema>,
): string {
  const hint = config.createHint ? ` — ${config.createHint(name, path)}` : '';
  return `profile "${name}" is not configured; expected ${path}${hint}`;
}
