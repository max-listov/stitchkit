import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { type ExecutorEngine, ExecutorEngineSchema, type ExecutorProfile } from './hello';

/** Pattern matched by every environment variable name accepted in {@link ExecutorProfileConfigSchema}. */
export const EXECUTOR_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Filter an environment record down to entries whose keys match {@link EXECUTOR_ENV_KEY_PATTERN}
 * and whose values are defined strings, preserving empty strings without trimming.
 */
export function sanitizeProfileEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (env === undefined) return sanitized;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && EXECUTOR_ENV_KEY_PATTERN.test(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * A profile as the executor's machine configures it: an account's own engine
 * home and the variables the operator declared for it. Its `home` never
 * leaves the machine; `hello` carries the opaque id and the label.
 */
export const ExecutorProfileConfigSchema = z
  .strictObject({
    profileId: z.string().min(1).max(128),
    engine: ExecutorEngineSchema,
    /**
     * The engine's home for this account. Explicit profiles pass it as `CLAUDE_CONFIG_DIR` (Claude),
     * `CODEX_HOME` (Codex) or `HOME` (ACP). Claude also reads transcripts from this directory.
     */
    home: z.string().min(1),
    /** Use Claude's native sign-in and leave CLAUDE_CONFIG_DIR unset. The transcript home is still required. */
    claudeConfigDir: z.literal('default').optional(),
    accountLabel: z.string().min(1).max(200).optional(),
    /** Variables the operator declared for this profile, passed to the engine as they are. */
    env: z.record(z.string().regex(EXECUTOR_ENV_KEY_PATTERN), z.string()).default({}),
  })
  .refine(
    (profile) =>
      profile.claudeConfigDir === undefined ||
      ((profile.engine === 'claude-sdk' || profile.engine === 'claude-cli') &&
        profile.env.CLAUDE_CONFIG_DIR === undefined),
    {
      path: ['claudeConfigDir'],
      message:
        'Default Claude configuration requires a Claude engine and no declared CLAUDE_CONFIG_DIR',
    },
  );
/** Input configuration for one local engine profile, parsed by {@link ExecutorProfileConfigSchema}. */
export type ExecutorProfileConfig = z.input<typeof ExecutorProfileConfigSchema>;

/**
 * The profile a driver of `engine` runs under, parsed — a `TypeError` when it names another
 * engine. Its home is kept under that engine's variable, so the engine would find no home of
 * its own and run on the executor's account. Every driver method that takes a profile asks
 * this first, before it reads a file or starts a process.
 */
export function engineProfile(
  engine: ExecutorEngine,
  raw: ExecutorProfileConfig,
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): z.output<typeof ExecutorProfileConfigSchema> {
  const profile = ExecutorProfileConfigSchema.parse(raw);
  if (profile.engine !== engine) {
    throw new TypeError(
      `Profile ${profile.profileId} is for the ${profile.engine} engine; this driver runs ${engine}`,
    );
  }
  if (profile.claudeConfigDir === 'default') {
    const userHome = profile.env.HOME ?? ambient.HOME ?? homedir();
    if (
      !isAbsolute(userHome) ||
      !isAbsolute(profile.home) ||
      resolve(profile.home) !== resolve(userHome, '.claude')
    ) {
      throw new TypeError(
        'The default Claude profile home must match .claude under the engine user home',
      );
    }
  }
  return profile;
}

/** The variables an engine process inherits from the executor's environment, and no others. */
const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM', 'TZ'];

/**
 * Credential variables an engine would bill against. They are never passed
 * on — the allowlist already keeps them out — and their names, without
 * values, are reported in `hello` so an operator sees what the executor's
 * own environment holds.
 */
export const CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];

/** The variable each engine reads its home from. */
const HOME_VARIABLE: Record<ExecutorEngine, string> = {
  'claude-cli': 'CLAUDE_CONFIG_DIR',
  'claude-sdk': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  acp: 'HOME',
};

/**
 * The engine's environment: an allowlist of the executor's own variables,
 * `LC_*`, the profile's home under the engine's variable (for an ACP agent it
 * replaces the executor's `HOME`), and the profile's
 * declared variables. A credential in the executor's environment does not
 * reach the engine unless the operator declared it for this profile.
 */
export function engineEnvironment(
  rawProfile: ExecutorProfileConfig,
  ambient: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const profile = engineProfile(rawProfile.engine, rawProfile, ambient);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    if (INHERITED.includes(name) || name.startsWith('LC_')) env[name] = value;
  }
  if (profile.claudeConfigDir === 'default') {
    // Pin the validated transcript user's home even when the caller supplied no ambient HOME.
    env.HOME = profile.env.HOME ?? env.HOME ?? dirname(resolve(profile.home));
  } else {
    env[HOME_VARIABLE[profile.engine]] = profile.home;
  }
  return { ...env, ...profile.env };
}

/** Names of credential variables present in `ambient` — what `hello` reports, never a value. */
export function ownCredentials(
  ambient: Readonly<Record<string, string | undefined>>,
): string[] {
  return CREDENTIAL_VARIABLES.filter((name) => (ambient[name] ?? '') !== '');
}

/** The profile as `hello` carries it: the opaque id, the label, the statuses — no path, no variable. */
export function helloProfile(input: {
  profile: ExecutorProfileConfig;
  status: Pick<ExecutorProfile, 'login' | 'effectiveCredential' | 'planLimits'>;
  ambient: Readonly<Record<string, string | undefined>>;
}): ExecutorProfile {
  const profile = engineProfile(input.profile.engine, input.profile, input.ambient);
  return {
    profileId: profile.profileId,
    engine: profile.engine,
    ...(profile.accountLabel !== undefined && { accountLabel: profile.accountLabel }),
    login: input.status.login,
    effectiveCredential: input.status.effectiveCredential,
    ownCredentials: ownCredentials(input.ambient),
    ...(input.status.planLimits !== undefined && { planLimits: input.status.planLimits }),
  };
}
