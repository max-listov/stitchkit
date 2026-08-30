import type {
  AgentModelCatalog,
  AgentModelSelectionStore,
  AgentRuntimeEvent,
  AgentSnapshot,
} from 'stitchkit/agent-runtime';
import type {
  AgentHarnessPendingApproval,
  HeadlessAgentHarness,
} from 'stitchkit/agent-runtime/harness';

export interface AgentTuiControllerState {
  conversationId: string;
  snapshot: AgentSnapshot;
  selectedModelId?: string;
  pendingApproval?: AgentHarnessPendingApproval;
  streaming: Readonly<Record<string, string>>;
  notice?: { tone: 'info' | 'error'; message: string };
}

export interface AgentTuiController<_CONTEXT> {
  state(): AgentTuiControllerState;
  subscribe(listener: (state: AgentTuiControllerState) => void): () => void;
  submit(text: string, idempotencyKey?: string): Promise<string>;
  selectModel(modelId: string): Promise<void>;
  switchConversation(conversationId: string): Promise<void>;
  respondToApproval(approved: boolean, reason?: string): Promise<string>;
  interrupt(runId?: string): Promise<void>;
  close(): Promise<void>;
}

function activeRun(snapshot: AgentSnapshot) {
  return snapshot.runs.find(
    (run) => run.state === 'running' || run.state === 'interrupt_requested',
  );
}

function pinnedModel(snapshot: AgentSnapshot, runId: string): string | undefined {
  const run = snapshot.runs.find(({ id }) => id === runId);
  const inputMessage = snapshot.messages.find(({ id }) => id === run?.inputMessageIds[0]);
  const metadata = inputMessage?.metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const modelId = Reflect.get(metadata, 'modelId');
  return typeof modelId === 'string' && modelId.length > 0 ? modelId : undefined;
}

export async function createAgentTuiController<CONTEXT>(input: {
  harness: HeadlessAgentHarness<CONTEXT>;
  catalog: AgentModelCatalog;
  selections: AgentModelSelectionStore;
  conversationId: string;
  context(): CONTEXT | Promise<CONTEXT>;
  preferredModelId?: string;
  onDiagnostic?(input: {
    conversationId: string;
    runId?: string;
    event: AgentRuntimeEvent;
  }): void | Promise<void>;
}): Promise<AgentTuiController<CONTEXT>> {
  let conversationId = input.conversationId;
  const listeners = new Set<(state: AgentTuiControllerState) => void>();
  let current: AgentTuiControllerState = {
    conversationId,
    snapshot: await input.harness.snapshot(conversationId),
    streaming: {},
  };
  const emit = (): void => {
    for (const listener of listeners) listener(current);
  };
  let refreshVersion = 0;
  const refresh = async (): Promise<void> => {
    const targetConversationId = conversationId;
    const version = ++refreshVersion;
    const [snapshot, approvals, selection] = await Promise.all([
      input.harness.snapshot(targetConversationId),
      input.harness.pendingApprovals(targetConversationId),
      input.selections.load(targetConversationId),
    ]);
    if (version !== refreshVersion || targetConversationId !== conversationId) return;
    const next: AgentTuiControllerState = {
      ...current,
      conversationId: targetConversationId,
      snapshot,
      ...(selection && { selectedModelId: selection.modelId }),
      ...(approvals[0] && { pendingApproval: approvals[0] }),
    };
    if (!approvals[0]) delete next.pendingApproval;
    current = next;
    emit();
  };
  let selection = await input.selections.load(conversationId);
  if (!selection) {
    const modelId =
      (input.preferredModelId &&
        input.catalog.models.some(({ id }) => id === input.preferredModelId) &&
        input.preferredModelId) ||
      input.catalog.models[0]?.id;
    if (!modelId) throw new Error('The Agent TUI model catalog is empty');
    selection = { modelId, selectedAt: new Date().toISOString() };
    await input.selections.save(conversationId, selection);
  }
  current = { ...current, selectedModelId: selection.modelId };
  const unsubscribe = input.harness.subscribe((event) => {
    if (event.conversationId !== conversationId) return;
    void input.onDiagnostic?.({
      conversationId,
      ...(event.runId && { runId: event.runId }),
      event,
    });
    if (event.type === 'assistant-delta') {
      current = {
        ...current,
        streaming: {
          ...current.streaming,
          [event.runId]: (current.streaming[event.runId] ?? '') + event.textDelta,
        },
      };
      emit();
      return;
    }
    if (event.type === 'terminal') {
      const streaming = Object.fromEntries(
        Object.entries(current.streaming).filter(([runId]) => runId !== event.runId),
      );
      current = {
        ...current,
        streaming,
        ...(event.reason === 'provider_failure'
          ? {
              notice: {
                tone: 'error',
                message: 'The model run failed. You can send the next message.',
              },
            }
          : {}),
      };
    }
    if (
      event.type === 'admission' ||
      event.type === 'assistant-checkpoint' ||
      event.type === 'run-state' ||
      event.type === 'terminal'
    ) {
      void refresh();
    }
  });
  await refresh();

  const selected = async (): Promise<string> => {
    const found = await input.selections.load(conversationId);
    if (!found) throw new Error('Select a model before submitting');
    return found.modelId;
  };

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    async submit(rawText, idempotencyKey = crypto.randomUUID()) {
      const text = rawText.trim();
      if (!text) throw new Error('Agent message is empty');
      const modelId = await selected();
      const ticket = input.harness.submit({
        conversationId,
        idempotencyKey,
        context: await input.context(),
        parts: [{ type: 'text', text }],
        metadata: { modelId },
      });
      const admission = await ticket.admission;
      void ticket.result.catch(() => undefined);
      await refresh();
      return admission.runId;
    },
    async selectModel(modelId) {
      if (!input.catalog.models.some((model) => model.id === modelId)) {
        throw new Error(`Unknown model: ${modelId}`);
      }
      await input.selections.save(conversationId, {
        modelId,
        selectedAt: new Date().toISOString(),
      });
      await refresh();
    },
    async switchConversation(nextConversationId) {
      const previousModelId = current.selectedModelId;
      conversationId = nextConversationId;
      const version = ++refreshVersion;
      const snapshot = await input.harness.snapshot(nextConversationId);
      if (version !== refreshVersion || conversationId !== nextConversationId) return;
      current = {
        conversationId: nextConversationId,
        snapshot,
        streaming: {},
      };
      let nextSelection = await input.selections.load(nextConversationId);
      if (version !== refreshVersion || conversationId !== nextConversationId) return;
      if (!nextSelection) {
        const modelId = previousModelId ?? input.catalog.models[0]?.id;
        if (!modelId) throw new Error('The Agent TUI model catalog is empty');
        nextSelection = { modelId, selectedAt: new Date().toISOString() };
        await input.selections.save(nextConversationId, nextSelection);
        if (version !== refreshVersion || conversationId !== nextConversationId) return;
      }
      await refresh();
    },
    async respondToApproval(approved, reason) {
      const approval = current.pendingApproval;
      if (!approval) throw new Error('No approval is pending');
      const ticket = await input.harness.respondToApproval({
        conversationId,
        approvalId: approval.approvalId,
        approved,
        ...(reason && { reason }),
        context: await input.context(),
        metadata: {
          modelId: pinnedModel(current.snapshot, approval.runId) ?? (await selected()),
        },
      });
      const admission = await ticket.admission;
      void ticket.result.catch(() => undefined);
      await refresh();
      return admission.runId;
    },
    async interrupt(runId) {
      const target = runId ?? activeRun(current.snapshot)?.id;
      if (!target) throw new Error('No active run to interrupt');
      await input.harness.interrupt({ conversationId, runId: target });
      await refresh();
    },
    async close() {
      unsubscribe();
      await input.harness.close({ gracePeriodMs: 1_000, forceTimeoutMs: 1_000 });
    },
  };
}
