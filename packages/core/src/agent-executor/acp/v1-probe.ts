import { abortReason, linkAbortSignals } from '../../internal/abort-race';
import { assertTimerMs, withSignalDeadline } from '../../internal/deadline';
import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcError, type JsonRpcValue } from '../json-rpc-peer';
import { type ExecutorProfileConfig, engineProfile } from '../profile';
import { stopConnection } from '../session-primitives';
import type { ExecutorStartupPhase } from '../vocabulary';
import {
  type AcpConnection,
  type AcpDriverConfig,
  acpCan,
  assertAcpDriverOptions,
  closeRequestTimeoutMs,
  connectAcp,
  extractAcpSessionMeta,
  resolveAcpSessionMeta,
} from './v1-connect';
import { normalizeTransformedUpdates } from './v1-handlers';
import {
  type AcpConfigOption,
  type AcpInitializeResult,
  AcpNewSessionResultSchema,
  type AcpSessionUpdate,
  AcpUpdateNotificationSchema,
  acpOptionValues,
} from './v1-protocol';
import { mergeInitialAcpConfigOptions, setAcpConfigOption } from './v1-session-options';

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Input for {@link AcpDriver.probeCapabilities}. */
export interface AcpProbeCapabilitiesInput {
  /** Profile whose environment and `HOME` will be used for the probe process. */
  readonly profile: ExecutorProfileConfig;
  /** Working directory passed to `session/new`. */
  readonly cwd: string;
  /** Optional cancellation signal aborting the probe and stopping its process. */
  readonly signal?: AbortSignal | undefined;
  /** Maximum milliseconds to wait for initialization, `session/new`, and cleanup. Default 30 000 ms. */
  readonly timeoutMs?: number | undefined;
  /** Optional observer invoked with startup phases (`spawning`, `initializing`) during the probe. */
  readonly onStartupPhase?: ((phase: ExecutorStartupPhase) => void) | undefined;
  /**
   * Also read every model's own options (an agent may describe `thought_level` only for the
   * active model): the probe switches the `model` option to each value in its ephemeral session,
   * still without inference, before closing and deleting it. Default `false`.
   */
  readonly eachModel?: boolean | undefined;
}

/** Result of a structured non-inference {@link AcpDriver.probeCapabilities} call. */
export interface AcpCapabilitiesProbe {
  /** Parsed `initialize` result returned by the agent. */
  readonly initialized: AcpInitializeResult;
  /** Latest session configuration options reported by `session/new` or `config_option_update`. */
  readonly configOptions: readonly AcpConfigOption[];
  /** Slash command names advertised via `available_commands_update` during session startup. */
  readonly commands: readonly string[];
  /** Model identifiers discovered from the `model` config option or `session.models.availableModels`. */
  readonly models: readonly string[];
  /** With `eachModel`: the options the agent reported with each model value selected. */
  readonly optionsByModel?: Readonly<Record<string, readonly AcpConfigOption[]>>;
  /** Optional `_meta` object returned by the agent in its `session/new` response. */
  readonly sessionMeta?: Readonly<Record<string, JsonRpcValue>>;
}

const ProbeSessionId = AcpNewSessionResultSchema.pick({ sessionId: true });

/**
 * Once `session/new` answered, the agent holds a session: every supported cleanup operation is
 * attempted exactly once, including after a malformed reply and after `signal` aborted. Cleanup
 * runs under its own bound (`closeRequestTimeoutMs`), not the probe's signal; an aborted probe
 * still rejects with its reason, joined by any cleanup that failed (ADR 0326).
 */
async function readProbeSession<T = undefined>(
  config: AcpDriverConfig,
  connection: AcpConnection,
  cwd: string,
  signal?: AbortSignal,
  inspect?: (session: { sessionId: string; reply: unknown }) => Promise<T>,
) {
  const meta = resolveAcpSessionMeta(config.sessionMeta, connection.initialized);
  const reply = await connection.peer.request(
    'session/new',
    {
      cwd,
      mcpServers: [],
      ...(meta !== undefined && { _meta: meta }),
    },
    { signal },
  );
  // A provider may already have persisted the ID even if another field is malformed.
  const identified = ProbeSessionId.safeParse(reply);
  if (!identified.success) {
    if (signal?.aborted) throw abortReason(signal);
    throw identified.error;
  }
  const { sessionId } = identified.data;
  const parsed = AcpNewSessionResultSchema.safeParse(reply);
  // Whatever the inspection does, the session is cleaned up below; its failure comes after that.
  let inspected: { value: T } | { error: unknown } | undefined;
  if (inspect !== undefined && parsed.success && signal?.aborted !== true) {
    try {
      inspected = { value: await inspect({ sessionId, reply }) };
    } catch (error) {
      inspected = { error };
    }
  }
  const cleanupFailures: Error[] = [];
  const cleanupOptions = { timeoutMs: closeRequestTimeoutMs(config) };
  const recordFailure = (method: string, cause: unknown) =>
    cleanupFailures.push(
      new Error(
        `${method} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          cause,
        },
      ),
    );
  if (acpCan(connection, 'close')) {
    try {
      await connection.peer.request('session/close', { sessionId }, cleanupOptions);
    } catch (cause) {
      // Some agents advertise close but implement only delete. Its reply decides cleanup.
      const canFallBack =
        cause instanceof JsonRpcError &&
        cause.code === JSON_RPC_METHOD_NOT_FOUND &&
        acpCan(connection, 'delete');
      if (!canFallBack) recordFailure('session/close', cause);
    }
  }
  if (acpCan(connection, 'delete')) {
    try {
      await connection.peer.request('session/delete', { sessionId }, cleanupOptions);
    } catch (cause) {
      recordFailure('session/delete', cause);
    }
  }
  if (signal?.aborted) {
    const reason = abortReason(signal);
    if (cleanupFailures.length === 0) throw reason;
    const all = [reason, ...cleanupFailures];
    throw new AggregateError(all, all.map(messageOf).join('; '), { cause: reason });
  }
  const failures = [...(parsed.success ? [] : [parsed.error]), ...cleanupFailures];
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map((error) => error.message).join('; '), {
      cause: failures[0],
    });
  }
  if (!parsed.success) throw parsed.error;
  if (failures[0] !== undefined) throw failures[0];
  if (inspected !== undefined && 'error' in inspected) throw inspected.error;
  return { ...parsed.data, inspected: inspected?.value };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Each value of the session's `model` option selected in turn, with the options the agent answered
 * for it — the only way to learn options an agent describes for the active model alone.
 */
async function readEachModelOptions(
  connection: AcpConnection,
  sessionId: string,
  reply: unknown,
  signal: AbortSignal,
): Promise<Readonly<Record<string, readonly AcpConfigOption[]>>> {
  let options: readonly AcpConfigOption[] =
    AcpNewSessionResultSchema.parse(reply).configOptions ?? [];
  const model = options.find((option) => option.category === 'model');
  const byModel: Record<string, readonly AcpConfigOption[]> = {};
  if (model === undefined) return byModel;
  for (const value of acpOptionValues(model)) {
    options = await setAcpConfigOption(
      connection.peer,
      sessionId,
      options,
      'model',
      value,
      signal,
    );
    byModel[value] = options;
  }
  return byModel;
}

function extractProbeModels(
  configOptions: readonly AcpConfigOption[],
  availableModels: readonly { readonly modelId: string }[] | undefined,
): string[] {
  const option = configOptions.find((candidate) => candidate.category === 'model');
  if (option !== undefined) return acpOptionValues(option);
  return availableModels?.map((model) => model.modelId) ?? [];
}

/** The values of the session's model option, or its model list; none when the agent offers neither. */
export async function probeAcpModels(
  config: AcpDriverConfig,
  connection: AcpConnection,
  cwd: string,
): Promise<string[]> {
  const session = await readProbeSession(config, connection, cwd);
  return extractProbeModels(session.configOptions ?? [], session.models?.availableModels);
}

function applyProbeNotification(
  config: AcpDriverConfig,
  method: string,
  params: unknown,
  onMeta: (meta: {
    readonly configOptions?: readonly AcpConfigOption[];
    readonly commands?: readonly string[];
  }) => void,
): void {
  if (method !== 'session/update') return;
  const parsed = AcpUpdateNotificationSchema.safeParse(params);
  if (!parsed.success) return;
  let updates: readonly AcpSessionUpdate[];
  try {
    updates = normalizeTransformedUpdates(parsed.data.update, config.transformUpdate);
  } catch {
    return;
  }
  for (const update of updates) {
    if (update.configOptions !== undefined) {
      onMeta({ configOptions: update.configOptions });
    }
    if (update.availableCommands !== undefined) {
      onMeta({ commands: update.availableCommands.map((command) => command.name) });
    }
  }
}

/**
 * Run a bounded, non-inference capability probe (`initialize` + ephemeral `session/new` +
 * `session/close` + `session/delete`), capturing asynchronous `available_commands_update` and
 * `config_option_update` notifications and cleaning up the session — after an abort or timeout too,
 * under its own bound — and the process.
 * Runs actively regardless of `config.probeMode`.
 */
export async function probeAcpCapabilities(
  config: AcpDriverConfig,
  input: AcpProbeCapabilitiesInput,
): Promise<AcpCapabilitiesProbe> {
  assertAcpDriverOptions(config);
  const profile = engineProfile('acp', input.profile);
  if (input.timeoutMs !== undefined) {
    assertTimerMs('timeoutMs', input.timeoutMs);
  }
  input.signal?.throwIfAborted();
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return withSignalDeadline(
    timeoutMs,
    input.signal,
    () => new Error(`ACP capability probe timed out after ${timeoutMs} ms`),
    async (deadlineSignal) => {
      let configOptions: readonly AcpConfigOption[] = [];
      let sawConfigOptionUpdate = false;
      let commands: readonly string[] = [];
      // The deadline bounds the start; after it, the process lives until this probe stops it, so
      // an aborted probe can still clean up the session it created.
      // A link of one source would be that source itself: an own controller makes it detachable.
      const startup = linkAbortSignals(deadlineSignal, new AbortController().signal);
      const connection = await connectAcp(config, profile, input.cwd, startup.signal, {
        onNotification: (method, params) => {
          applyProbeNotification(config, method, params, (meta) => {
            if (meta.configOptions !== undefined) {
              configOptions = meta.configOptions;
              sawConfigOptionUpdate = true;
            }
            if (meta.commands !== undefined) commands = meta.commands;
          });
        },
        ...(input.onStartupPhase !== undefined && { onStartupPhase: input.onStartupPhase }),
      }).finally(() => startup.release());
      let result: AcpCapabilitiesProbe;
      try {
        const session = await readProbeSession(
          config,
          connection,
          input.cwd,
          deadlineSignal,
          input.eachModel === true
            ? ({ sessionId, reply }) =>
                readEachModelOptions(connection, sessionId, reply, deadlineSignal)
            : undefined,
        );
        configOptions = mergeInitialAcpConfigOptions(
          configOptions,
          session.configOptions,
          sawConfigOptionUpdate,
        );
        deadlineSignal.throwIfAborted();
        const models = extractProbeModels(configOptions, session.models?.availableModels);
        const sessionMeta = extractAcpSessionMeta(session._meta);
        result = {
          initialized: connection.initialized,
          configOptions,
          commands,
          models,
          ...(session.inspected !== undefined && { optionsByModel: session.inspected }),
          ...(sessionMeta !== undefined && { sessionMeta }),
        };
      } catch (error) {
        await stopConnection(connection, { error });
        throw error;
      }
      await stopConnection(connection);
      deadlineSignal.throwIfAborted();
      return result;
    },
  );
}
