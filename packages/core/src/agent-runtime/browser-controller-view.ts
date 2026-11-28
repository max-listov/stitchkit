import type { AgentBrowserRequest } from './browser-control-contract';
import type {
  AgentInputAnswer,
  AgentPendingDelivery,
  AgentPermissionMode,
  AgentWriteOperation,
} from './control-interaction-schema';
import {
  type AgentControlView,
  createAgentControlView,
  reduceAgentControlSnapshot,
  retainConversationMetadata,
} from './control-view';
import type { AgentSnapshot } from './schemas';

/**
 * A browser request without `schemaVersion`, `requestId` and `conversationId`; the controller
 * fills those in.
 */
export type AgentBrowserCommand<T extends AgentBrowserRequest = AgentBrowserRequest> =
  T extends unknown ? Omit<T, 'schemaVersion' | 'requestId' | 'conversationId'> : never;

/** Input for `AgentController.respondApproval`. */
export interface AgentApprovalResponseInput {
  approvalId: string;
  approved: boolean;
  reason?: string;
  idempotencyKey?: string;
  metadata?: unknown;
}

/** Input for `AgentController.respondInput`. */
export interface AgentInputResponseInput {
  inputId: string;
  answer: AgentInputAnswer;
  idempotencyKey?: string;
  metadata?: unknown;
}

/** Whether a browser command mutates remote state and can settle as `delivery: 'unknown'` on drop. */
export function isWriteOperation(
  operation: AgentBrowserCommand['operation'],
): operation is AgentWriteOperation {
  return (
    operation === 'submit' ||
    operation === 'respond-approval' ||
    operation === 'respond-input' ||
    operation === 'set-permission-mode'
  );
}

/** Extract the optional idempotency key from a write command. */
export function commandIdempotencyKey(command: AgentBrowserCommand): string | undefined {
  if (
    command.operation === 'submit' ||
    command.operation === 'respond-approval' ||
    command.operation === 'respond-input'
  ) {
    return command.idempotencyKey;
  }
  return undefined;
}

/**
 * The view across a reconnect: each conversation keeps its last snapshot, observed
 * host/interactive metadata and snapshot version so the screen does not go blank;
 * connection-local streaming deltas and event cursors are dropped and rebuilt by attach.
 */
export function retainSnapshots(view: AgentControlView): AgentControlView {
  const conversations: Record<string, AgentControlView['conversations'][string]> = {};
  const cursors: Record<string, AgentControlView['cursor']['conversations'][string]> = {};
  for (const [id, conversation] of Object.entries(view.conversations)) {
    const metadata = retainConversationMetadata(conversation);
    if (!conversation.snapshot && Object.keys(metadata).length === 0) continue;
    conversations[id] = {
      ...metadata,
      ...(conversation.snapshot !== undefined && { snapshot: conversation.snapshot }),
      resyncRequired: conversation.resyncRequired,
      transientByRun: {},
    };
    if (!conversation.snapshot) continue;
    const version = conversation.snapshot.version;
    cursors[id] = {
      runs: {},
      durableEventIds: [],
      ...(version !== undefined && { snapshotVersion: version }),
    };
  }
  return { ...createAgentControlView(), cursor: { conversations: cursors }, conversations };
}

/**
 * Preserve active transient progress and host/interactive metadata across a durable refresh;
 * terminal runs lose transient state.
 */
export function refreshedView(
  view: AgentControlView,
  snapshot: AgentSnapshot,
  answer: 'attach' | 'refresh',
): AgentControlView {
  const current = view.conversations[snapshot.conversationId];
  if (
    answer === 'refresh' &&
    Math.max(
      current?.snapshot?.version ?? 0,
      view.cursor.conversations[snapshot.conversationId]?.snapshotVersion ?? 0,
    ) > snapshot.version
  ) {
    return view;
  }
  const next = reduceAgentControlSnapshot(view, snapshot);
  const transientByRun = Object.fromEntries(
    Object.entries(current?.transientByRun ?? {}).filter(([id]) =>
      snapshot.runs.some(
        (run) => run.id === id && ['running', 'interrupt_requested'].includes(run.state),
      ),
    ),
  );
  return {
    ...next,
    conversations: {
      ...next.conversations,
      [snapshot.conversationId]: {
        ...retainConversationMetadata(current),
        snapshot,
        resyncRequired: false,
        transientByRun,
      },
    },
  };
}

/** Record an unreconciled `delivery: 'unknown'` marker and flag resync on one conversation. */
export function withUnknownDelivery(
  view: AgentControlView,
  conversationId: string,
  pending: AgentPendingDelivery,
): AgentControlView {
  const current = view.conversations[conversationId] ?? {
    resyncRequired: true,
    transientByRun: {},
  };
  return {
    ...view,
    conversations: {
      ...view.conversations,
      [conversationId]: { ...current, resyncRequired: true, pendingDelivery: pending },
    },
  };
}

/** Apply confirmed local interactive state updates after an `outcome: 'ok'` write acknowledgement. */
export function withConfirmedWriteOutcome(
  view: AgentControlView,
  conversationId: string,
  command: AgentBrowserCommand,
): AgentControlView | undefined {
  const current = view.conversations[conversationId];
  if (!current) return undefined;
  if (command.operation === 'respond-approval' && current.pendingApprovals) {
    const pendingApprovals = current.pendingApprovals.filter(
      (item) => item.approvalId !== command.approvalId,
    );
    return {
      ...view,
      conversations: {
        ...view.conversations,
        [conversationId]: { ...current, pendingApprovals },
      },
    };
  }
  if (command.operation === 'respond-input' && current.pendingInputs) {
    const pendingInputs = current.pendingInputs.filter(
      (item) => item.inputId !== command.inputId,
    );
    return {
      ...view,
      conversations: {
        ...view.conversations,
        [conversationId]: { ...current, pendingInputs },
      },
    };
  }
  if (command.operation === 'set-permission-mode') {
    const permissionMode: AgentPermissionMode = command.permissionMode;
    return {
      ...view,
      conversations: {
        ...view.conversations,
        [conversationId]: { ...current, permissionMode },
      },
    };
  }
  return undefined;
}
