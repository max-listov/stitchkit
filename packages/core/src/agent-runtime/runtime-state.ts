import type { ToolSet } from 'ai';
import { createRuntimeAdmissionLanes, type RuntimeAdmissionLanes } from './admission-lanes';
import { type AgentSessionCoordinator, createAgentSessionCoordinator } from './coordinator';
import type { AgentRuntimeEvent } from './events';
import { type AgentInjectionRegistry, createAgentInjectionRegistry } from './injection';
import { createRunExecutor } from './run-execution';
import type { RunExecutionInput } from './run-execution-state';
import type { AgentRuntimeAdmission, AgentRuntimeConfig } from './runtime';
import {
  createRuntimeAdmissionGate,
  type RuntimeAdmissionGate,
} from './runtime-admission-gate';
import type { AgentRuntimeResult } from './runtime-result';

export interface RuntimeTicket {
  accepted: Promise<void>;
  admission: Promise<AgentRuntimeAdmission>;
  result: Promise<AgentRuntimeResult>;
}

/**
 * What every entry point of one runtime reads and writes.
 *
 * These were locals of the `createAgentRuntime` closure; they are one object now
 * so each phase (submit, recovery, control, close) names what it touches by
 * taking it, rather than by being written inside the scope that declares it.
 */
export interface AgentRuntimeState<CONTEXT, TOOLS extends ToolSet> {
  config: AgentRuntimeConfig<CONTEXT, TOOLS>;
  coordinator: AgentSessionCoordinator;
  /** Live tickets by conversation, then idempotency key, so a retry gets the same one. */
  tickets: Map<string, Map<string, RuntimeTicket>>;
  generateId(): string;
  now(): Date;
  admissionLanes: RuntimeAdmissionLanes;
  gate: RuntimeAdmissionGate;
  injection?: AgentInjectionRegistry;
  publish(event: AgentRuntimeEvent): Promise<void>;
  executeRun(input: RunExecutionInput<CONTEXT>): Promise<AgentRuntimeResult>;
}

interface LoopLimits {
  checkpointEveryEvents: number;
  maxSteps: number;
  idleTimeoutMs?: number;
}

/** Defaults applied and every limit validated before the runtime exists. */
function resolveLoopLimits<CONTEXT, TOOLS extends ToolSet>(
  config: AgentRuntimeConfig<CONTEXT, TOOLS>,
): LoopLimits {
  const checkpointEveryEvents = config.loop?.checkpointEveryEvents ?? 20;
  const maxSteps = config.loop?.maxSteps ?? 50;
  // A default, because the alternative is "hang forever" and that is what a
  // consumer who configured nothing used to get.
  const declaredIdleTimeoutMs = config.loop?.idleTimeoutMs;
  const idleTimeoutMs =
    declaredIdleTimeoutMs === null ? undefined : (declaredIdleTimeoutMs ?? 60_000);
  if (!Number.isSafeInteger(checkpointEveryEvents) || checkpointEveryEvents < 1) {
    throw new TypeError('checkpointEveryEvents must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError('maxSteps must be a positive safe integer');
  }
  if (
    idleTimeoutMs !== undefined &&
    (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1)
  ) {
    throw new TypeError('idleTimeoutMs must be a positive safe integer');
  }
  const policyNames = new Set<string>(['max-steps']);
  for (const policy of config.loop?.stopPolicies ?? []) {
    if (!policy.name || policyNames.has(policy.name)) {
      throw new TypeError('Agent stop policy names must be non-empty and unique');
    }
    policyNames.add(policy.name);
  }
  return {
    checkpointEveryEvents,
    maxSteps,
    ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
  };
}

export function createAgentRuntimeState<CONTEXT, TOOLS extends ToolSet>(
  config: AgentRuntimeConfig<CONTEXT, TOOLS>,
): AgentRuntimeState<CONTEXT, TOOLS> {
  const coordinator = createAgentSessionCoordinator();
  const generateId = config.generateId ?? (() => crypto.randomUUID());
  const now = config.now ?? (() => new Date());
  const runtimeEpoch = generateId();
  const admissionLanes = createRuntimeAdmissionLanes();
  /**
   * Whether this runtime can ever inject, decided once from the configuration.
   *
   * A function policy might return `'inject'` for any input, so its mere
   * presence enables the machinery. When it cannot, the executor keeps exactly
   * the path it had before — no `prepareStep` it did not ask for, and no work
   * at any boundary.
   */
  const injectionPossible =
    typeof config.runs?.inputPolicy === 'function' || config.runs?.inputPolicy === 'inject';
  const injection = injectionPossible ? createAgentInjectionRegistry() : undefined;
  const { checkpointEveryEvents, maxSteps, idleTimeoutMs } = resolveLoopLimits(config);

  const publish = async (event: AgentRuntimeEvent): Promise<void> => {
    try {
      await config.publish?.(event);
    } catch (error) {
      // Product delivery cannot roll back an already committed runtime transition.
      try {
        await config.onPublishError?.({ event, error });
      } catch {
        // Delivery diagnostics are isolated from the canonical run as well.
      }
    }
  };

  const executeRun = createRunExecutor<CONTEXT, TOOLS>({
    config,
    publish,
    runtimeEpoch,
    generateId,
    now,
    checkpointEveryEvents,
    maxSteps,
    ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
    ...(injection && { injection }),
  });

  return {
    config,
    coordinator,
    tickets: new Map(),
    generateId,
    now,
    admissionLanes,
    gate: createRuntimeAdmissionGate(),
    ...(injection && { injection }),
    publish,
    executeRun,
  };
}
