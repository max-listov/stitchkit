import type {
  AccountInfo,
  ModelInfo,
  Options,
  SDKControlInitializeResponse,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { raceAbort } from '../../internal/abort-race';
import { assertTimerMs, withSignalDeadline } from '../../internal/deadline';
import type { PlanLimits } from '../hello';
import { type ExecutorProfileConfig, engineEnvironment, engineProfile } from '../profile';
import { normalizeClaudeSdkUsageRead, unpublishedClaudeSdkUsageRead } from './controls';
import type { ClaudeSdkDriverConfig, ClaudeSdkRun, ClaudeSdkUsageRead } from './driver';
import { closeQuerySafely } from './query-loop';

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Input for {@link ClaudeSdkDriver.probeCapabilities}. */
export interface ClaudeSdkProbeCapabilitiesInput {
  readonly profile: ExecutorProfileConfig;
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  /** Maximum milliseconds to wait before aborting and closing the probe query. Default 30 000 ms. */
  readonly timeoutMs?: number | undefined;
  /** When `true`, also pull subscription plan limits via `get_usage({ skipBehaviors: true })`. */
  readonly includeUsage?: boolean | undefined;
}

/** Result of a non-inference {@link ClaudeSdkDriver.probeCapabilities} call. */
export interface ClaudeSdkCapabilitiesProbe {
  readonly initializationResult?: SDKControlInitializeResponse;
  readonly models?: ModelInfo[];
  readonly commands?: SlashCommand[];
  readonly account?: AccountInfo;
  readonly usage?: ClaudeSdkUsageRead;
}

/**
 * Prompt iterable that never yields a user message and completes cleanly on abort, allowing
 * Claude Code initialization and metadata RPCs to run without triggering model inference.
 */
function createNeverYieldingPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next() {
          if (signal.aborted) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
            signal.addEventListener('abort', () => resolve({ value: undefined, done: true }), {
              once: true,
            });
          });
        },
        return() {
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function buildProbeOptions(input: {
  config: ClaudeSdkDriverConfig;
  cwd: string;
  env: Record<string, string>;
  abortController: AbortController;
}): Options {
  const { config } = input;
  return {
    cwd: input.cwd,
    env: input.env,
    abortController: input.abortController,
    persistSession: false,
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    mcpServers: {},
    allowedTools: [],
    canUseTool: async () => ({
      behavior: 'deny',
      message: 'Capability probe does not execute tools',
      interrupt: true,
    }),
    ...(config.pathToClaudeCodeExecutable !== undefined && {
      pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
    }),
    ...(config.settingSources !== undefined && { settingSources: config.settingSources }),
    ...(config.extraArgs !== undefined && { extraArgs: config.extraArgs }),
    ...(config.stderr !== undefined && { stderr: config.stderr }),
    ...(config.spawnClaudeCodeProcess !== undefined && {
      spawnClaudeCodeProcess: config.spawnClaudeCodeProcess,
    }),
  };
}

/**
 * Run a bounded, isolated non-inference probe against `config.query` to read models, commands,
 * account metadata, initialization state, and optionally plan usage. Always closes the query
 * in `finally` regardless of success, timeout, abort, or RPC failure.
 */
export async function probeClaudeSdkCapabilities(
  config: ClaudeSdkDriverConfig,
  limits: Map<string, PlanLimits>,
  input: ClaudeSdkProbeCapabilitiesInput,
): Promise<ClaudeSdkCapabilitiesProbe> {
  const ambient = config.ambient ?? process.env;
  const profile = engineProfile('claude-sdk', input.profile, ambient);
  if (input.timeoutMs !== undefined) {
    assertTimerMs('timeoutMs', input.timeoutMs);
  }
  input.signal?.throwIfAborted();
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const env = engineEnvironment(profile, ambient);

  return withSignalDeadline(
    timeoutMs,
    input.signal,
    () => new Error(`Claude SDK capability probe timed out after ${timeoutMs} ms`),
    async (deadlineSignal) => {
      const probeAbort = new AbortController();
      const onDeadlineAbort = () => probeAbort.abort(deadlineSignal.reason);
      if (deadlineSignal.aborted) {
        onDeadlineAbort();
      } else {
        deadlineSignal.addEventListener('abort', onDeadlineAbort, { once: true });
      }
      let query: ClaudeSdkRun | undefined;
      try {
        query = config.query({
          prompt: createNeverYieldingPrompt(probeAbort.signal),
          options: buildProbeOptions({
            config,
            cwd: input.cwd,
            env,
            abortController: probeAbort,
          }),
        });
        const initFn = query.initializationResult;
        const modelsFn = query.supportedModels;
        const commandsFn = query.supportedCommands;
        const accountFn = query.accountInfo;
        if (
          typeof initFn !== 'function' &&
          typeof modelsFn !== 'function' &&
          typeof commandsFn !== 'function' &&
          typeof accountFn !== 'function'
        ) {
          throw new Error(
            'The configured Claude SDK query does not expose capability probe RPCs',
          );
        }
        const initializationResult =
          typeof initFn === 'function'
            ? await raceAbort(initFn.call(query), deadlineSignal)
            : undefined;
        const usageFn =
          input.includeUsage === true
            ? query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
            : undefined;
        const [models, commands, account, rawUsage] = await Promise.all([
          typeof modelsFn === 'function'
            ? raceAbort(modelsFn.call(query), deadlineSignal)
            : Promise.resolve(initializationResult?.models),
          typeof commandsFn === 'function'
            ? raceAbort(commandsFn.call(query), deadlineSignal)
            : Promise.resolve(initializationResult?.commands),
          typeof accountFn === 'function'
            ? raceAbort(accountFn.call(query), deadlineSignal)
            : Promise.resolve(initializationResult?.account),
          typeof usageFn === 'function'
            ? raceAbort(usageFn.call(query, { skipBehaviors: true }), deadlineSignal)
            : Promise.resolve(undefined),
        ]);
        let usage: ClaudeSdkUsageRead | undefined;
        if (input.includeUsage === true) {
          usage =
            typeof usageFn === 'function' && rawUsage !== undefined
              ? normalizeClaudeSdkUsageRead(rawUsage, (planLimits) => {
                  limits.set(profile.profileId, planLimits);
                })
              : unpublishedClaudeSdkUsageRead();
        }
        return {
          ...(initializationResult !== undefined && { initializationResult }),
          ...(models !== undefined && { models }),
          ...(commands !== undefined && { commands }),
          ...(account !== undefined && { account }),
          ...(usage !== undefined && { usage }),
        };
      } finally {
        deadlineSignal.removeEventListener('abort', onDeadlineAbort);
        if (!probeAbort.signal.aborted) probeAbort.abort();
        closeQuerySafely(query);
      }
    },
  );
}
