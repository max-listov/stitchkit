import { z } from 'zod';
import type { AgentEngineDriver } from '../engine';
import type { ExecutorDriverCapabilities, PlanLimits } from '../hello';
import { validateImageOptions } from '../image-input';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import { runEngineCli } from '../session-primitives';
import { openClaudeSession } from './session';
import { findTranscriptInput } from './transcript';

/**
 * What `claude auth status` (JSON, its default) answers, as far as the driver reads it.
 * `loginExpiresAt` is an ISO-8601 time: recorded from Claude Code 2.1.331 on 2026-11-24
 * as `"loginExpiresAt": "2026-12-11T21:50:02.038Z"` (a string, milliseconds, UTC).
 */
const AuthStatusSchema = z.looseObject({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  loginExpiresAt: z.unknown().optional(),
});

/** An ISO-8601 date and time with a zone, as `Date#toISOString` writes it. */
const IsoTimeSchema = z.iso.datetime({ offset: true });

/**
 * Whether the login is still good by its `loginExpiresAt`. Absent or `null` — the login
 * names no expiry — is `valid`; an ISO time is compared with now; anything else is a
 * format the CLI was not seen to write, so it is `unknown`, never guessed.
 */
function loginExpiryState(
  loginExpiresAt: unknown,
  nowMs: number,
): 'valid' | 'expired' | 'unknown' {
  if (loginExpiresAt === undefined || loginExpiresAt === null) return 'valid';
  const iso = IsoTimeSchema.safeParse(loginExpiresAt);
  if (!iso.success) return 'unknown';
  return Date.parse(iso.data) <= nowMs ? 'expired' : 'valid';
}

/** Configuration for {@link createClaudeCliDriver}. */
export interface ClaudeCliDriverConfig {
  /** The CLI to run. Default `claude`, found on the engine's `PATH`. */
  executable?: string;
  /** Arguments before the driver's own — a runtime running a script, as a fake engine is run. */
  prefixArgs?: readonly string[];
  /** Passed as `--model` when set. */
  model?: string;
  /**
   * Passed as `--permission-mode`. Default `default`: every tool the profile
   * does not already allow is asked of the host, so the server decides. A
   * profile's own setting (`auto`, `acceptEdits`) is not inherited by accident.
   */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto';
  /** Read the bytes behind a `file` part's `reference`; without it a file part is refused. */
  resolveFile?: (reference: string) => Promise<Uint8Array>;
  /** Maximum decoded size of one image attachment in bytes. Default 5 MiB. */
  maxImageBytes?: number;
  /** The executor's own environment, read for the allowlist. Default `process.env`. */
  ambient?: Readonly<Record<string, string | undefined>>;
}

/**
 * Claude Code, unmodified, driven through `--print` with `stream-json` on
 * both sides: the executor writes user messages under its own ids, answers
 * permission requests on stdin (`--permission-prompts host`), interrupts
 * with a control request, and learns whether an input arrived from the
 * session's transcript in the profile.
 */
export function createClaudeCliDriver(
  config: ClaudeCliDriverConfig = {},
): AgentEngineDriver & { readonly capabilities: ExecutorDriverCapabilities } {
  validateImageOptions(config);
  const executable = config.executable ?? 'claude';
  const prefix = config.prefixArgs ?? [];
  const ambient = config.ambient ?? process.env;
  const limits = new Map<string, PlanLimits>();
  const capabilities: ExecutorDriverCapabilities = {
    runtimePolicyEnforcement: 'native',
    sessionApproval: true,
    interruptOnDeny: true,
    updatedToolInput: true,
    structuredInput: false,
    steer: false,
    fork: false,
    revert: false,
    compact: false,
    injectItems: false,
    backgroundWorkOutlivesTurn: false,
    multiThreadPerProcess: false,
    images: config.resolveFile !== undefined,
    planLimits: 'passive',
  };

  const cli = (profile: ExecutorProfileConfig, args: string[]) =>
    runEngineCli({ executable, prefix, args, profile, ambient });

  return {
    engine: 'claude-cli',
    reconcile: 'client-id',
    capabilities,
    async info() {
      const probe = engineProfile('claude-cli', {
        profileId: 'version-probe',
        engine: 'claude-cli',
        home: ambient.HOME ?? '/',
      });
      const result = await cli(probe, ['--version']);
      const out = result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : '';
      const version = out.split(/\s+/)[0] || 'unknown';
      return {
        engine: 'claude-cli',
        version,
        reconcile: 'client-id',
        models: { answer: 'not-asked' },
        capabilities,
      };
    },
    async status(rawProfile) {
      const profile = engineProfile('claude-cli', rawProfile);
      const result = await cli(profile, ['auth', 'status']);
      let decoded: unknown = {};
      try {
        decoded = JSON.parse(new TextDecoder().decode(result.stdout) || '{}');
      } catch {
        decoded = null;
      }
      const parsed = AuthStatusSchema.safeParse(decoded);
      const known = limits.get(profile.profileId);
      if (!parsed.success) {
        return {
          login: { state: 'unknown' },
          effectiveCredential: 'unknown',
          ...(known && { planLimits: known }),
        };
      }
      const { loggedIn, authMethod, loginExpiresAt } = parsed.data;
      const expiry = loginExpiryState(loginExpiresAt, Date.now());
      const loginState = !loggedIn
        ? 'signed-out'
        : expiry === 'expired'
          ? 'expired'
          : expiry === 'unknown'
            ? 'unknown'
            : 'signed-in';
      const credential = !loggedIn
        ? 'none'
        : authMethod === 'claude.ai'
          ? 'subscription'
          : authMethod === undefined
            ? 'unknown'
            : 'api-key';
      // An API key bills per token: there is no subscription window to report.
      const planLimits: PlanLimits | undefined =
        credential === 'api-key'
          ? { answer: 'no-plan-limit', windows: [], observedAt: new Date().toISOString() }
          : known;
      return {
        login: { state: loginState },
        effectiveCredential: credential,
        ...(planLimits && { planLimits }),
      };
    },
    findInput: (input) => findTranscriptInput('claude-cli', input),
    open: (input) =>
      openClaudeSession(
        {
          executable,
          prefix,
          ...(config.model !== undefined && { model: config.model }),
          permissionMode: config.permissionMode ?? 'default',
          ambient,
          limits,
          ...(config.resolveFile !== undefined && { resolveFile: config.resolveFile }),
          ...(config.maxImageBytes !== undefined && { maxImageBytes: config.maxImageBytes }),
        },
        input,
      ),
  };
}
