import { abortReason } from '../../internal/abort-race';
import { assertTimerMs, withSignalDeadline } from '../../internal/deadline';
import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcError } from '../json-rpc-peer';
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
import { mergeInitialAcpConfigOptions } from './v1-session-options';

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
}

const ProbeSessionId = AcpNewSessionResultSchema.pick({ sessionId: true });

/** Every supported cleanup operation is attempted exactly once, including after a malformed reply. */
async function readProbeSession(
  config: AcpDriverConfig,
  connection: AcpConnection,
  cwd: string,
  signal?: AbortSignal,
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
  if (signal?.aborted) throw abortReason(signal);
  // A provider may already have persisted the ID even if another field is malformed.
  const { sessionId } = ProbeSessionId.parse(reply);
  const parsed = AcpNewSessionResultSchema.safeParse(reply);
  const failures: Error[] = parsed.success ? [] : [parsed.error];
  const timeoutMs = closeRequestTimeoutMs(config);
  const cleanupOptions = { timeoutMs, ...(signal !== undefined && { signal }) };
  const recordFailure = (method: string, cause: unknown) =>
    failures.push(
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
      if (signal?.aborted) throw abortReason(signal);
      // Some agents advertise close but implement only delete. Its reply decides cleanup.
      const canFallBack =
        cause instanceof JsonRpcError &&
        cause.code === JSON_RPC_METHOD_NOT_FOUND &&
        acpCan(connection, 'delete');
      if (!canFallBack) recordFailure('session/close', cause);
    }
  }
  if (signal?.aborted) throw abortReason(signal);
  if (acpCan(connection, 'delete')) {
    try {
      await connection.peer.request('session/delete', { sessionId }, cleanupOptions);
    } catch (cause) {
      if (signal?.aborted) throw abortReason(signal);
      recordFailure('session/delete', cause);
    }
  }
  if (signal?.aborted) throw abortReason(signal);
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map((error) => error.message).join('; '), {
      cause: failures[0],
    });
  }
  if (!parsed.success) throw parsed.error;
  if (failures[0] !== undefined) throw failures[0];
  return parsed.data;
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
 * `config_option_update` notifications and always cleaning up the session and process in `finally`.
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
      const connection = await connectAcp(config, profile, input.cwd, deadlineSignal, {
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
      });
      let result: AcpCapabilitiesProbe;
      try {
        const session = await readProbeSession(config, connection, input.cwd, deadlineSignal);
        configOptions = mergeInitialAcpConfigOptions(
          configOptions,
          session.configOptions,
          sawConfigOptionUpdate,
        );
        deadlineSignal.throwIfAborted();
        const models = extractProbeModels(configOptions, session.models?.availableModels);
        result = {
          initialized: connection.initialized,
          configOptions,
          commands,
          models,
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
