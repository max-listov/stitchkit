import { z } from 'zod';
import { nonEmptyString } from '../session-primitives';

const MAX_BACKGROUND_TASKS = 1024;

/** Token, tool-use and duration counters reported on Claude task progress/notification events. */
export const ClaudeTaskUsageSchema = z.strictObject({
  totalTokens: z.int().nonnegative(),
  toolUses: z.int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

/** Inferred from {@link ClaudeTaskUsageSchema}. */
export type ClaudeTaskUsage = z.infer<typeof ClaudeTaskUsageSchema>;

const ClaudeBackgroundTaskEntrySchema = z.strictObject({
  taskId: z.string().min(1),
  runId: z.string().min(1).optional(),
  taskType: z.string().min(1),
  subagentType: z.string().min(1).optional(),
  description: z.string(),
  parentTaskId: z.string().min(1).optional(),
  ambient: z.boolean().optional(),
});

const ClaudeTaskUpdatedPatchSchema = z.strictObject({
  /** Known Claude SDK values: `'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused'`. */
  status: z.string().min(1).optional(),
  description: z.string().optional(),
  endTime: z.number().nonnegative().optional(),
  totalPausedMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  isBackgrounded: z.boolean().optional(),
});

const ClaudeApiRetryNoResponseSchema = z.strictObject({
  waitedMs: z.number().nonnegative(),
  retryWaitMs: z.number().nonnegative(),
});

const ClaudeSubagentRetrySchema = z.strictObject({
  agentId: z.string().min(1),
  attempt: z.int().nonnegative(),
  maxRetries: z.int().nonnegative(),
  retryDelayMs: z.number().nonnegative(),
  errorStatus: z.int().nullable(),
  errorCategory: z.string().min(1),
});

const eventBase = {
  uuid: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
};

/**
 * Typed non-delta runtime events emitted by Claude Code and the Claude Agent SDK
 * (`task_*`, `background_tasks_changed`, `api_retry`, `elicitation_complete`, `tool_progress`).
 * Delivered out-of-band via `onEvent` so high-frequency progress and post-turn background
 * notifications never flood `TurnReport.deltas` (512-delta cap).
 */
export const ClaudeRuntimeEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('task_started'),
    taskId: z.string().min(1),
    runId: z.string().min(1).optional(),
    toolUseId: z.string().min(1).optional(),
    description: z.string(),
    subagentType: z.string().min(1).optional(),
    isBackgrounded: z.boolean().optional(),
    spawnDepth: z.int().nonnegative().optional(),
    parentTaskId: z.string().min(1).optional(),
    taskType: z.string().min(1).optional(),
    workflowName: z.string().min(1).optional(),
    prompt: z.string().optional(),
    skipTranscript: z.boolean().optional(),
    ambient: z.boolean().optional(),
    ...eventBase,
  }),
  z.strictObject({
    type: z.literal('task_updated'),
    taskId: z.string().min(1),
    runId: z.string().min(1).optional(),
    patch: ClaudeTaskUpdatedPatchSchema,
    ...eventBase,
  }),
  z.strictObject({
    type: z.literal('task_progress'),
    taskId: z.string().min(1),
    runId: z.string().min(1).optional(),
    toolUseId: z.string().min(1).optional(),
    description: z.string(),
    subagentType: z.string().min(1).optional(),
    usage: ClaudeTaskUsageSchema.optional(),
    lastToolName: z.string().min(1).optional(),
    summary: z.string().optional(),
    ...eventBase,
  }),
  z.strictObject({
    type: z.literal('task_notification'),
    taskId: z.string().min(1),
    runId: z.string().min(1).optional(),
    toolUseId: z.string().min(1).optional(),
    /** Known Claude SDK values: `'completed' | 'failed' | 'stopped'`. */
    status: z.string().min(1),
    /** Known Claude SDK value: `'worker_restart'`. */
    reason: z.string().min(1).optional(),
    outputFile: z.string().optional(),
    summary: z.string(),
    usage: ClaudeTaskUsageSchema.optional(),
    skipTranscript: z.boolean().optional(),
    ambient: z.boolean().optional(),
    ...eventBase,
  }),
  z.strictObject({
    type: z.literal('background_tasks_changed'),
    tasks: z.array(ClaudeBackgroundTaskEntrySchema).max(MAX_BACKGROUND_TASKS),
    ...eventBase,
  }),
  z.strictObject({
    type: z.literal('api_retry'),
    attempt: z.int().nonnegative(),
    maxRetries: z.int().nonnegative(),
    retryDelayMs: z.number().nonnegative(),
    errorStatus: z.int().nullable(),
    error: z.string().min(1),
    noResponse: ClaudeApiRetryNoResponseSchema.optional(),
    ...eventBase,
  }),
  z.strictObject({
    type: z.literal('elicitation_complete'),
    mcpServerName: z.string().min(1),
    elicitationId: z.string().min(1),
    ...eventBase,
  }),
  z.strictObject({
    type: z.literal('tool_progress'),
    toolUseId: z.string().min(1),
    toolName: z.string().min(1),
    parentToolUseId: z.string().nullable(),
    elapsedTimeSeconds: z.number().nonnegative(),
    taskId: z.string().min(1).optional(),
    heartbeat: z.boolean().optional(),
    subagentType: z.string().min(1).optional(),
    subagentRetry: ClaudeSubagentRetrySchema.optional(),
    ...eventBase,
  }),
]);

/** Typed non-delta runtime event inferred from {@link ClaudeRuntimeEventSchema}. */
export type ClaudeRuntimeEvent = z.infer<typeof ClaudeRuntimeEventSchema>;

const optWireStr = z.string().optional().transform(nonEmptyString);
const WireTaskUsageSchema = z
  .looseObject({
    total_tokens: z.int().nonnegative(),
    tool_uses: z.int().nonnegative(),
    duration_ms: z.number().nonnegative(),
  })
  .transform((u) => ({
    totalTokens: u.total_tokens,
    toolUses: u.tool_uses,
    durationMs: u.duration_ms,
  }));
const WireBase = { uuid: optWireStr, session_id: optWireStr };

const WireTaskStartedSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_started'),
  task_id: z.string().min(1),
  run_id: optWireStr,
  tool_use_id: optWireStr,
  description: z.string(),
  subagent_type: optWireStr,
  is_backgrounded: z.boolean().optional(),
  spawn_depth: z.int().nonnegative().optional(),
  parent_task_id: optWireStr,
  task_type: optWireStr,
  workflow_name: optWireStr,
  prompt: z.string().optional(),
  skip_transcript: z.boolean().optional(),
  ambient: z.boolean().optional(),
  ...WireBase,
});

const WireTaskUpdatedSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_updated'),
  task_id: z.string().min(1),
  run_id: optWireStr,
  patch: z.looseObject({
    status: optWireStr,
    description: z.string().optional(),
    end_time: z.number().nonnegative().optional(),
    total_paused_ms: z.number().nonnegative().optional(),
    error: z.string().optional(),
    is_backgrounded: z.boolean().optional(),
  }),
  ...WireBase,
});

const WireTaskProgressSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_progress'),
  task_id: z.string().min(1),
  run_id: optWireStr,
  tool_use_id: optWireStr,
  description: z.string(),
  subagent_type: optWireStr,
  usage: WireTaskUsageSchema.optional(),
  last_tool_name: optWireStr,
  summary: z.string().optional(),
  ...WireBase,
});

const WireTaskNotificationSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_notification'),
  task_id: z.string().min(1),
  run_id: optWireStr,
  tool_use_id: optWireStr,
  status: z.string().min(1),
  reason: optWireStr,
  output_file: z.string().optional(),
  summary: z.string(),
  usage: WireTaskUsageSchema.optional(),
  skip_transcript: z.boolean().optional(),
  ambient: z.boolean().optional(),
  ...WireBase,
});

const WireBackgroundTasksChangedSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('background_tasks_changed'),
  tasks: z
    .array(
      z.looseObject({
        task_id: z.string().min(1),
        run_id: optWireStr,
        task_type: z.string().min(1),
        subagent_type: optWireStr,
        description: z.string(),
        parent_task_id: optWireStr,
        ambient: z.boolean().optional(),
      }),
    )
    .max(MAX_BACKGROUND_TASKS),
  ...WireBase,
});

const WireApiRetrySchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('api_retry'),
  attempt: z.int().nonnegative(),
  max_retries: z.int().nonnegative(),
  retry_delay_ms: z.number().nonnegative(),
  error_status: z.int().nullable(),
  error: z.string().min(1),
  no_response: z
    .looseObject({
      waited_ms: z.number().nonnegative(),
      retry_wait_ms: z.number().nonnegative(),
    })
    .optional(),
  ...WireBase,
});

const WireElicitationCompleteSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('elicitation_complete'),
  mcp_server_name: z.string().min(1),
  elicitation_id: z.string().min(1),
  ...WireBase,
});

const WireToolProgressSchema = z.looseObject({
  type: z.literal('tool_progress'),
  tool_use_id: z.string().min(1),
  tool_name: z.string().min(1),
  parent_tool_use_id: z.string().nullable().optional(),
  elapsed_time_seconds: z.number().nonnegative(),
  task_id: optWireStr,
  heartbeat: z.boolean().optional(),
  subagent_type: optWireStr,
  subagent_retry: z
    .looseObject({
      agent_id: z.string().min(1),
      attempt: z.int().nonnegative(),
      max_retries: z.int().nonnegative(),
      retry_delay_ms: z.number().nonnegative(),
      error_status: z.int().nullable(),
      error_category: z.string().min(1),
    })
    .optional(),
  ...WireBase,
});

const RUNTIME_SYSTEM_SUBTYPES = new Set([
  'task_started',
  'task_updated',
  'task_progress',
  'task_notification',
  'background_tasks_changed',
  'api_retry',
  'elicitation_complete',
]);

/** Whether a Claude `system` record subtype maps to a {@link ClaudeRuntimeEvent}. */
export function isClaudeRuntimeSystemSubtype(subtype: string): boolean {
  return RUNTIME_SYSTEM_SUBTYPES.has(subtype);
}

function baseFields(wire: { uuid: string | undefined; session_id: string | undefined }) {
  return {
    ...(wire.uuid !== undefined && { uuid: wire.uuid }),
    ...(wire.session_id !== undefined && { sessionId: wire.session_id }),
  };
}

function parseSystemRuntimeEvent(
  subtype: string,
  record: unknown,
): ClaudeRuntimeEvent | undefined {
  if (subtype === 'task_started') {
    const p = WireTaskStartedSchema.safeParse(record);
    if (!p.success) return undefined;
    const d = p.data;
    return {
      type: 'task_started',
      taskId: d.task_id,
      description: d.description,
      ...(d.run_id !== undefined && { runId: d.run_id }),
      ...(d.tool_use_id !== undefined && { toolUseId: d.tool_use_id }),
      ...(d.subagent_type !== undefined && { subagentType: d.subagent_type }),
      ...(d.is_backgrounded !== undefined && { isBackgrounded: d.is_backgrounded }),
      ...(d.spawn_depth !== undefined && { spawnDepth: d.spawn_depth }),
      ...(d.parent_task_id !== undefined && { parentTaskId: d.parent_task_id }),
      ...(d.task_type !== undefined && { taskType: d.task_type }),
      ...(d.workflow_name !== undefined && { workflowName: d.workflow_name }),
      ...(d.prompt !== undefined && { prompt: d.prompt }),
      ...(d.skip_transcript !== undefined && { skipTranscript: d.skip_transcript }),
      ...(d.ambient !== undefined && { ambient: d.ambient }),
      ...baseFields(d),
    };
  }
  if (subtype === 'task_updated') {
    const p = WireTaskUpdatedSchema.safeParse(record);
    if (!p.success) return undefined;
    const d = p.data;
    return {
      type: 'task_updated',
      taskId: d.task_id,
      ...(d.run_id !== undefined && { runId: d.run_id }),
      patch: {
        ...(d.patch.status !== undefined && { status: d.patch.status }),
        ...(d.patch.description !== undefined && { description: d.patch.description }),
        ...(d.patch.end_time !== undefined && { endTime: d.patch.end_time }),
        ...(d.patch.total_paused_ms !== undefined && {
          totalPausedMs: d.patch.total_paused_ms,
        }),
        ...(d.patch.error !== undefined && { error: d.patch.error }),
        ...(d.patch.is_backgrounded !== undefined && {
          isBackgrounded: d.patch.is_backgrounded,
        }),
      },
      ...baseFields(d),
    };
  }
  if (subtype === 'task_progress') {
    const p = WireTaskProgressSchema.safeParse(record);
    if (!p.success) return undefined;
    const d = p.data;
    return {
      type: 'task_progress',
      taskId: d.task_id,
      description: d.description,
      ...(d.run_id !== undefined && { runId: d.run_id }),
      ...(d.tool_use_id !== undefined && { toolUseId: d.tool_use_id }),
      ...(d.subagent_type !== undefined && { subagentType: d.subagent_type }),
      ...(d.usage !== undefined && { usage: d.usage }),
      ...(d.last_tool_name !== undefined && { lastToolName: d.last_tool_name }),
      ...(d.summary !== undefined && { summary: d.summary }),
      ...baseFields(d),
    };
  }
  if (subtype === 'task_notification') {
    const p = WireTaskNotificationSchema.safeParse(record);
    if (!p.success) return undefined;
    const d = p.data;
    return {
      type: 'task_notification',
      taskId: d.task_id,
      status: d.status,
      summary: d.summary,
      ...(d.run_id !== undefined && { runId: d.run_id }),
      ...(d.tool_use_id !== undefined && { toolUseId: d.tool_use_id }),
      ...(d.reason !== undefined && { reason: d.reason }),
      ...(d.output_file !== undefined && { outputFile: d.output_file }),
      ...(d.usage !== undefined && { usage: d.usage }),
      ...(d.skip_transcript !== undefined && { skipTranscript: d.skip_transcript }),
      ...(d.ambient !== undefined && { ambient: d.ambient }),
      ...baseFields(d),
    };
  }
  if (subtype === 'background_tasks_changed') {
    const p = WireBackgroundTasksChangedSchema.safeParse(record);
    if (!p.success) return undefined;
    const d = p.data;
    return {
      type: 'background_tasks_changed',
      tasks: d.tasks.map((t) => ({
        taskId: t.task_id,
        taskType: t.task_type,
        description: t.description,
        ...(t.run_id !== undefined && { runId: t.run_id }),
        ...(t.subagent_type !== undefined && { subagentType: t.subagent_type }),
        ...(t.parent_task_id !== undefined && { parentTaskId: t.parent_task_id }),
        ...(t.ambient !== undefined && { ambient: t.ambient }),
      })),
      ...baseFields(d),
    };
  }
  if (subtype === 'api_retry') {
    const p = WireApiRetrySchema.safeParse(record);
    if (!p.success) return undefined;
    const d = p.data;
    return {
      type: 'api_retry',
      attempt: d.attempt,
      maxRetries: d.max_retries,
      retryDelayMs: d.retry_delay_ms,
      errorStatus: d.error_status,
      error: d.error,
      ...(d.no_response !== undefined && {
        noResponse: {
          waitedMs: d.no_response.waited_ms,
          retryWaitMs: d.no_response.retry_wait_ms,
        },
      }),
      ...baseFields(d),
    };
  }
  if (subtype === 'elicitation_complete') {
    const p = WireElicitationCompleteSchema.safeParse(record);
    if (!p.success) return undefined;
    const d = p.data;
    return {
      type: 'elicitation_complete',
      mcpServerName: d.mcp_server_name,
      elicitationId: d.elicitation_id,
      ...baseFields(d),
    };
  }
  return undefined;
}

/**
 * Parse a validated Claude `system` (task/retry/elicitation) or top-level `tool_progress`
 * wire record into a normalized {@link ClaudeRuntimeEvent}. Returns `undefined` when required
 * fields are missing or malformed so the classifier can surface `unhandled` fail-closed.
 */
export function parseClaudeRuntimeEvent(record: {
  readonly type: string;
  readonly subtype?: string;
}): ClaudeRuntimeEvent | undefined {
  if (record.type === 'system' && record.subtype !== undefined) {
    return parseSystemRuntimeEvent(record.subtype, record);
  }
  if (record.type !== 'tool_progress') return undefined;
  const p = WireToolProgressSchema.safeParse(record);
  if (!p.success) return undefined;
  const d = p.data;
  return {
    type: 'tool_progress',
    toolUseId: d.tool_use_id,
    toolName: d.tool_name,
    parentToolUseId: d.parent_tool_use_id ?? null,
    elapsedTimeSeconds: d.elapsed_time_seconds,
    ...(d.task_id !== undefined && { taskId: d.task_id }),
    ...(d.heartbeat !== undefined && { heartbeat: d.heartbeat }),
    ...(d.subagent_type !== undefined && { subagentType: d.subagent_type }),
    ...(d.subagent_retry !== undefined && {
      subagentRetry: {
        agentId: d.subagent_retry.agent_id,
        attempt: d.subagent_retry.attempt,
        maxRetries: d.subagent_retry.max_retries,
        retryDelayMs: d.subagent_retry.retry_delay_ms,
        errorStatus: d.subagent_retry.error_status,
        errorCategory: d.subagent_retry.error_category,
      },
    }),
    ...baseFields(d),
  };
}
