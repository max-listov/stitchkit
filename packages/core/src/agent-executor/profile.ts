import { z } from 'zod';
import { type ExecutorEngine, ExecutorEngineSchema, type ExecutorProfile } from './hello';

/**
 * A profile as the executor's machine configures it: an account's own engine
 * home and the variables the operator declared for it. Its `home` never
 * leaves the machine; `hello` carries the opaque id and the label.
 */
export const ExecutorProfileConfigSchema = z.strictObject({
  profileId: z.string().min(1).max(128),
  engine: ExecutorEngineSchema,
  /**
   * The engine's home for this account, passed as `CLAUDE_CONFIG_DIR` (Claude), `CODEX_HOME`
   * (Codex) or `HOME` (an ACP agent, which keeps its sign-in under its user's home).
   */
  home: z.string().min(1),
  accountLabel: z.string().min(1).max(200).optional(),
  /** Variables the operator declared for this profile, passed to the engine as they are. */
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
});
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
): z.output<typeof ExecutorProfileConfigSchema> {
  const profile = ExecutorProfileConfigSchema.parse(raw);
  if (profile.engine !== engine) {
    throw new TypeError(
      `Profile ${profile.profileId} is for the ${profile.engine} engine; this driver runs ${engine}`,
    );
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
  const profile = ExecutorProfileConfigSchema.parse(rawProfile);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    if (INHERITED.includes(name) || name.startsWith('LC_')) env[name] = value;
  }
  env[HOME_VARIABLE[profile.engine]] = profile.home;
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
  const profile = ExecutorProfileConfigSchema.parse(input.profile);
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
