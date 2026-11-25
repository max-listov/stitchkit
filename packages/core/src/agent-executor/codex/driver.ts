import type { AgentEngineDriver } from '../engine';
import type { PlanLimits } from '../hello';
import { mergeRateLimitEvent, planLimitsReadFailed } from '../plan-limits';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import { runEngineCli, withEphemeralConnection } from '../session-primitives';
import { codexPlanWindows } from './limits';
import { CodexTurnsPageSchema } from './protocol';
import { type CodexSessionConfig, connectCodex, openCodexSession } from './session';

/** Configuration for {@link createCodexDriver}. */
export interface CodexDriverConfig {
  /** The CLI to run. Default `codex`, found on the engine's `PATH`. */
  executable?: string;
  /** Arguments before the driver's own — a runtime running a script, as a fake engine is run. */
  prefixArgs?: readonly string[];
  model?: string;
  /** `approvalPolicy` of a new thread. Default `on-request`: the engine asks the host. */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  /** `sandbox` of a new thread. Default `workspace-write`. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  ambient?: Readonly<Record<string, string | undefined>>;
}

/**
 * Codex through its app-server over stdio: a thread per session,
 * `turn/start` under the executor's `clientUserMessageId`, interrupts, the
 * engine's approval and input requests answered by the host, limits read
 * with `account/rateLimits/read`, and reconcile by the client id in
 * `thread/turns/list`.
 */
export function createCodexDriver(config: CodexDriverConfig = {}): AgentEngineDriver {
  const executable = config.executable ?? 'codex';
  const prefix = config.prefixArgs ?? [];
  const ambient = config.ambient ?? process.env;
  const limits = new Map<string, PlanLimits>();
  let version = 'unknown';
  const session = (): CodexSessionConfig => ({
    executable,
    prefix,
    ...(config.model !== undefined && { model: config.model }),
    approvalPolicy: config.approvalPolicy ?? 'on-request',
    sandbox: config.sandbox ?? 'workspace-write',
    ambient,
    limits,
    version,
  });
  const cli = (profile: ExecutorProfileConfig, args: string[]) =>
    runEngineCli({ executable, prefix, args, profile, ambient });
  /** Open an app-server just to ask it one question, and stop it. */
  const ask = <T>(
    profile: ExecutorProfileConfig,
    cwd: string,
    question: (peer: Awaited<ReturnType<typeof connectCodex>>['peer']) => Promise<T>,
  ) =>
    withEphemeralConnection(
      (signal) => connectCodex(session(), engineProfile('codex', profile), cwd, signal),
      (connection) => question(connection.peer),
    );
  return {
    engine: 'codex',
    reconcile: 'client-id',
    async info() {
      const probe = {
        profileId: 'version-probe',
        engine: 'codex' as const,
        home: ambient.HOME ?? '/',
      };
      const result = await cli(probe, ['--version']);
      const out = result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : '';
      version = out.split(/\s+/).at(-1) || 'unknown';
      return {
        engine: 'codex',
        version,
        reconcile: 'client-id',
        models: { answer: 'not-asked' },
      };
    },
    async status(profile) {
      const parsed = engineProfile('codex', profile);
      const loginResult = await cli(parsed, ['login', 'status']);
      const decoder = new TextDecoder();
      // Real `codex login status` writes its status line to stderr; check both streams.
      const text =
        `${decoder.decode(loginResult.stdout)}\n${decoder.decode(loginResult.stderr)}`.trim();
      const signedIn = loginResult.exitCode === 0 && /(?:^|\n)Logged in/im.test(text);
      const credential = !signedIn
        ? 'none'
        : /chatgpt/i.test(text)
          ? 'subscription'
          : /api key/i.test(text)
            ? 'api-key'
            : 'unknown';
      let planLimits: PlanLimits | undefined = limits.get(parsed.profileId);
      if (credential === 'subscription') {
        try {
          const answer = await ask(parsed, process.cwd(), (peer) =>
            peer.request('account/rateLimits/read'),
          );
          const windows = codexPlanWindows(Reflect.get(Object(answer), 'rateLimits'));
          planLimits = mergeRateLimitEvent({ previous: planLimits, windows, now: new Date() });
          limits.set(parsed.profileId, planLimits);
        } catch (error) {
          planLimits = planLimitsReadFailed({
            previous: planLimits,
            error: error instanceof Error ? error.message : String(error),
            now: new Date(),
          });
        }
      } else if (credential === 'api-key') {
        planLimits = {
          answer: 'no-plan-limit',
          windows: [],
          observedAt: new Date().toISOString(),
        };
      }
      return {
        login: { state: signedIn ? 'signed-in' : 'signed-out' },
        effectiveCredential: credential,
        ...(planLimits && { planLimits }),
      };
    },
    async findInput(input) {
      return ask(input.profile, input.cwd, async (peer) => {
        const page = CodexTurnsPageSchema.parse(
          await peer.request('thread/turns/list', {
            threadId: input.nativeThreadId,
            limit: 50,
            itemsView: 'full',
          }),
        );
        return page.data.some((turn) =>
          (turn.items ?? []).some((item) => item.clientId === input.clientId),
        );
      });
    },
    open: (input) => openCodexSession(session(), input),
  };
}
