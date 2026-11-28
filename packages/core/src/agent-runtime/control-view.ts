import type {
  AgentConversationActivity,
  AgentConversationState,
  AgentHostAvailability,
  AgentHostStatus,
  AgentPendingApproval,
  AgentPendingDelivery,
  AgentPendingInput,
  AgentPermissionMode,
} from './control-interaction-schema';
import {
  type AgentControlDelivery,
  AgentControlDeliverySchema,
  type AgentMultiSessionCursor,
  advanceAgentMultiSessionCursor,
} from './control-schema';
import { isDurableAgentRuntimeEvent } from './event-durability';
import { type AgentRuntimeEvent, AgentRuntimeEventSchema } from './event-schema';
import { type AgentSnapshot, AgentSnapshotSchema } from './schemas';

/** A tool call still running, with the last progress it reported. */
export interface AgentToolActivity {
  toolName: string;
  message?: string;
  progress?: number;
  total?: number;
}

/** What a run shows while it streams, before its next checkpoint makes it durable. */
export interface AgentRunTransient {
  text: string;
  reasoning: string;
  /** Running tool calls that reported progress, by call id; a call leaves on its terminal status. */
  tools: Readonly<Record<string, AgentToolActivity>>;
}

/** Projected browser state for one conversation across durable snapshots, streams, and host reachability. */
export interface AgentConversationView {
  snapshot?: AgentSnapshot;
  resyncRequired: boolean;
  transientByRun: Readonly<Record<string, AgentRunTransient>>;
  /** Pending tool approvals reported for interactive/native sessions; absent on cloud sessions unless reported. */
  pendingApprovals?: readonly AgentPendingApproval[];
  /** Pending structured input prompts reported for interactive/native sessions; absent until reported. */
  pendingInputs?: readonly AgentPendingInput[];
  /** Current permission mode reported by the runtime; absent when unsupported. */
  permissionMode?: AgentPermissionMode;
  /** Permission modes supported by the runtime; absent when unsupported. */
  supportedPermissionModes?: readonly AgentPermissionMode[];
  /** Reachability status of the executor host; absent on in-process cloud sessions. */
  hostStatus?: AgentHostStatus;
  /** Detailed executor host reachability with optional lease expiry and reason. */
  hostAvailability?: AgentHostAvailability;
  /** Unreconciled write delivery status (for example `delivery: 'unknown'` after a disconnect mid-send). */
  pendingDelivery?: AgentPendingDelivery;
}

/** Multi-conversation browser view pairing a reconnect cursor with each conversation's projection. */
export interface AgentControlView {
  cursor: AgentMultiSessionCursor;
  conversations: Readonly<Record<string, AgentConversationView>>;
}

const EMPTY_TRANSIENT: AgentRunTransient = { text: '', reasoning: '', tools: {} };
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'interrupt_requested']);

function hasSnapshotPendingApproval(snapshot: AgentSnapshot | undefined): boolean {
  if (!snapshot) return false;
  const answered = new Set<string>();
  const requested: string[] = [];
  for (const message of snapshot.messages) {
    for (const part of message.parts) {
      if (part.type === 'tool-approval-response') answered.add(part.approvalId);
      else if (part.type === 'tool-approval-request') requested.push(part.approvalId);
    }
  }
  return requested.some((id) => !answered.has(id));
}

/**
 * Derive the underlying conversation activity (`waiting-approval`, `waiting-input`, `working`,
 * or `idle`) without erasing active work when a remote host transitions to `offline` or `asleep`.
 */
export function deriveAgentConversationActivity(
  conversation: AgentConversationView | undefined,
): AgentConversationActivity {
  if (!conversation) return 'idle';
  if (
    (conversation.pendingApprovals && conversation.pendingApprovals.length > 0) ||
    hasSnapshotPendingApproval(conversation.snapshot)
  ) {
    return 'waiting-approval';
  }
  if (conversation.pendingInputs && conversation.pendingInputs.length > 0) {
    return 'waiting-input';
  }
  const hasActiveRun =
    conversation.snapshot?.runs.some((run) => ACTIVE_RUN_STATES.has(run.state)) ?? false;
  if (hasActiveRun || Object.keys(conversation.transientByRun).length > 0) {
    return 'working';
  }
  return 'idle';
}

/**
 * Derive the effective UI conversation state, overlaying `host-offline` when the executor host
 * is `offline` or `asleep` while preserving the underlying activity on `AgentConversationView`.
 */
export function deriveAgentConversationState(
  conversation: AgentConversationView | undefined,
): AgentConversationState {
  if (!conversation) return 'idle';
  if (conversation.hostStatus === 'offline' || conversation.hostStatus === 'asleep') {
    return 'host-offline';
  }
  return deriveAgentConversationActivity(conversation);
}

/** Internal helper retaining observed interactive/host metadata across snapshot and reconnect updates. */
export function retainConversationMetadata(
  current: AgentConversationView | undefined,
): Pick<
  AgentConversationView,
  | 'pendingApprovals'
  | 'pendingInputs'
  | 'permissionMode'
  | 'supportedPermissionModes'
  | 'hostStatus'
  | 'hostAvailability'
  | 'pendingDelivery'
> {
  if (!current) return {};
  return {
    ...(current.pendingApprovals !== undefined && {
      pendingApprovals: current.pendingApprovals,
    }),
    ...(current.pendingInputs !== undefined && { pendingInputs: current.pendingInputs }),
    ...(current.permissionMode !== undefined && { permissionMode: current.permissionMode }),
    ...(current.supportedPermissionModes !== undefined && {
      supportedPermissionModes: current.supportedPermissionModes,
    }),
    ...(current.hostStatus !== undefined && { hostStatus: current.hostStatus }),
    ...(current.hostAvailability !== undefined && {
      hostAvailability: current.hostAvailability,
    }),
    ...(current.pendingDelivery !== undefined && { pendingDelivery: current.pendingDelivery }),
  };
}

/** The run's transient state after one event; an event that is not about it leaves it as it was. */
function nextRunTransient(
  transient: AgentRunTransient,
  event: AgentRuntimeEvent,
): AgentRunTransient {
  switch (event.type) {
    case 'assistant-delta':
      return { ...transient, text: transient.text + event.textDelta };
    case 'reasoning-delta':
      return { ...transient, reasoning: transient.reasoning + event.textDelta };
    case 'attempt-reset':
      return EMPTY_TRANSIENT;
    case 'tool-progress': {
      const { toolName, message, progress, total } = event;
      return {
        ...transient,
        tools: {
          ...transient.tools,
          [event.callId]: {
            toolName,
            ...(message !== undefined && { message }),
            ...(progress !== undefined && { progress }),
            ...(total !== undefined && { total }),
          },
        },
      };
    }
    case 'tool-status': {
      if (event.status === 'started' || !Object.hasOwn(transient.tools, event.callId)) {
        return transient;
      }
      return {
        ...transient,
        tools: Object.fromEntries(
          Object.entries(transient.tools).filter(([callId]) => callId !== event.callId),
        ),
      };
    }
    default:
      return transient;
  }
}

/** Create an empty multi-conversation control view. */
export function createAgentControlView(): AgentControlView {
  return { cursor: { conversations: {} }, conversations: {} };
}

/** Apply a durable `AgentSnapshot` to the control view, preserving observed host/interactive metadata. */
export function reduceAgentControlSnapshot(
  view: AgentControlView,
  rawSnapshot: AgentSnapshot,
): AgentControlView {
  const snapshot = AgentSnapshotSchema.parse(rawSnapshot);
  const previous = view.cursor.conversations[snapshot.conversationId] ?? { runs: {} };
  const current = view.conversations[snapshot.conversationId];
  return {
    cursor: {
      conversations: {
        ...view.cursor.conversations,
        [snapshot.conversationId]: {
          ...previous,
          snapshotVersion: snapshot.version,
          durableEventIds: [],
        },
      },
    },
    conversations: {
      ...view.conversations,
      [snapshot.conversationId]: {
        ...retainConversationMetadata(current),
        snapshot,
        resyncRequired: false,
        transientByRun: {},
      },
    },
  };
}

/** Apply one runtime event to the control view and advance its deduplication cursor. */
export function reduceAgentControlEvent(
  view: AgentControlView,
  rawEvent: AgentRuntimeEvent,
): AgentControlView {
  const event = AgentRuntimeEventSchema.parse(rawEvent);
  const advanced = advanceAgentMultiSessionCursor(view.cursor, event);
  if (advanced.status === 'duplicate') return view;
  const current = view.conversations[event.conversationId] ?? {
    resyncRequired: false,
    transientByRun: {},
  };
  if (advanced.status === 'gap') {
    return {
      cursor: advanced.cursor,
      conversations: {
        ...view.conversations,
        [event.conversationId]: { ...current, resyncRequired: true },
      },
    };
  }
  const nextTransient = nextRunTransient(
    current.transientByRun[event.runId] ?? EMPTY_TRANSIENT,
    event,
  );
  const snapshotStale =
    isDurableAgentRuntimeEvent(event) && current.snapshot?.version !== event.snapshotVersion;
  const transientByRun =
    event.type === 'terminal'
      ? Object.fromEntries(
          Object.entries(current.transientByRun).filter(([runId]) => runId !== event.runId),
        )
      : { ...current.transientByRun, [event.runId]: nextTransient };
  return {
    cursor: advanced.cursor,
    conversations: {
      ...view.conversations,
      [event.conversationId]: {
        ...current,
        resyncRequired: current.resyncRequired || snapshotStale,
        transientByRun,
      },
    },
  };
}

/** Reduce any validated `AgentControlDelivery` frame (runtime event, approval/input/mode/host/delivery state). */
export function reduceAgentControlDelivery(
  view: AgentControlView,
  rawDelivery: AgentControlDelivery,
): AgentControlView {
  const delivery = AgentControlDeliverySchema.parse(rawDelivery);
  if (delivery.type === 'event') {
    return reduceAgentControlEvent(view, delivery.event);
  }
  if (delivery.type === 'access-denied') {
    return view;
  }
  const current = view.conversations[delivery.conversationId] ?? {
    resyncRequired: false,
    transientByRun: {},
  };
  const withConversation = (next: AgentConversationView): AgentControlView => ({
    ...view,
    conversations: {
      ...view.conversations,
      [delivery.conversationId]: next,
    },
  });
  if (delivery.type === 'resync-required') {
    return withConversation({ ...current, resyncRequired: true });
  }
  if (delivery.type === 'approval-state') {
    return withConversation({ ...current, pendingApprovals: delivery.pendingApprovals });
  }
  if (delivery.type === 'input-state') {
    return withConversation({ ...current, pendingInputs: delivery.pendingInputs });
  }
  if (delivery.type === 'permission-mode') {
    return withConversation({
      ...current,
      permissionMode: delivery.permissionMode,
      ...(delivery.supportedPermissionModes !== undefined && {
        supportedPermissionModes: delivery.supportedPermissionModes,
      }),
    });
  }
  if (delivery.type === 'host-status') {
    const availability: AgentHostAvailability = {
      status: delivery.hostStatus,
      ...(delivery.validUntil !== undefined && { validUntil: delivery.validUntil }),
      ...(delivery.reason !== undefined && { reason: delivery.reason }),
      ...(delivery.observedAt !== undefined && { observedAt: delivery.observedAt }),
    };
    return withConversation({
      ...current,
      hostStatus: delivery.hostStatus,
      hostAvailability: availability,
    });
  }
  if (delivery.delivery === 'unknown') {
    const pending: AgentPendingDelivery = {
      delivery: 'unknown',
      requestId: delivery.requestId,
      operation: delivery.operation,
      ...(delivery.idempotencyKey !== undefined && {
        idempotencyKey: delivery.idempotencyKey,
      }),
      ...(delivery.reason !== undefined && { reason: delivery.reason }),
      ...(delivery.recordedAt !== undefined && { recordedAt: delivery.recordedAt }),
    };
    return withConversation({
      ...current,
      resyncRequired: true,
      pendingDelivery: pending,
    });
  }
  const existing = current.pendingDelivery;
  const matchesExisting =
    existing === undefined ||
    existing.requestId === delivery.requestId ||
    (delivery.idempotencyKey !== undefined &&
      existing.idempotencyKey === delivery.idempotencyKey);
  if (!matchesExisting) return view;
  const { pendingDelivery: _cleared, ...rest } = current;
  return withConversation(rest);
}
