import type { ToolSet } from 'ai';
import type { AgentRuntimeEvent, AgentRuntimePublisher } from './events';
import {
  type AgentHarnessPendingApproval,
  AgentHarnessProfileEventSchema,
  type HarnessPendingProfile,
  type HeadlessAgentHarness,
  type HeadlessAgentHarnessConfig,
} from './harness-contract';
import {
  renderHarnessResources,
  resolveHarnessLimits,
  validateHarnessResources,
} from './harness-resources';
import { composeAgentPrompt } from './prompt';
import { createAgentRuntime } from './runtime';
import type { AgentMessage, AgentSnapshot } from './schemas';

export * from './harness-contract';
export * from './harness-file-resources';

/**
 * The response-time policy refused this responder. The pending request is left
 * in place, so a different responder may still answer it. → ADR 0177
 */
export class AgentHarnessApprovalRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Approval response rejected: ${reason}`);
    this.name = 'AgentHarnessApprovalRejectedError';
    this.reason = reason;
  }
}

function activeRunId(snapshot: AgentSnapshot): string {
  const active = snapshot.runs.filter(
    (run) => run.state === 'running' || run.state === 'interrupt_requested',
  );
  if (active.length !== 1) {
    throw new Error('Agent harness prompt requires exactly one active run');
  }
  const run = active[0];
  if (!run) throw new Error('Agent harness active run is unavailable');
  return run.id;
}

/**
 * Compose the public AgentRuntime into a resource-aware process-local harness.
 * The caller still owns supervision, model/provider policy, permissions and
 * idempotency of effects outside the runtime store.
 */
export function createHeadlessAgentHarness<CONTEXT, TOOLS extends ToolSet>(
  config: HeadlessAgentHarnessConfig<CONTEXT, TOOLS>,
): HeadlessAgentHarness<CONTEXT> {
  const {
    models,
    resources,
    tools,
    promptBudget,
    estimateResourceTokens,
    limits: inputLimits,
    onProfile,
    onProfileError,
    publish: applicationPublish,
    blockingPresentation = 'local',
    ...runtimeConfig
  } = config;
  const limits = resolveHarnessLimits(inputLimits);
  const pending = new Map<string, HarnessPendingProfile>();
  const subscribers = new Set<(event: AgentRuntimeEvent) => void | Promise<void>>();

  const emitProfile = async (runId: string): Promise<void> => {
    const entry = pending.get(runId);
    if (!entry?.prompt || !entry.toolNames || entry.emitting) return entry?.emitting;
    const event = AgentHarnessProfileEventSchema.parse({
      schemaVersion: 1,
      type: 'profile-applied',
      conversationId: entry.prompt.conversationId,
      runId,
      model: entry.prompt.model.descriptor,
      resources: entry.prompt.resources.map(({ kind, name, provenance }) => ({
        kind,
        name,
        provenance,
      })),
      diagnostics: entry.prompt.diagnostics,
      toolNames: entry.toolNames,
    });
    const emitting = (async () => {
      try {
        await onProfile?.(event);
      } catch (error) {
        try {
          await onProfileError?.({ event, error });
        } catch {
          // Profile delivery is observation and cannot replace a canonical run outcome.
        }
      } finally {
        pending.delete(runId);
      }
    })();
    entry.emitting = emitting;
    return emitting;
  };

  const presentationMessage = (message: AgentMessage): AgentMessage =>
    blockingPresentation === 'parent'
      ? {
          ...message,
          parts: message.parts.filter((part) => part.type !== 'tool-approval-request'),
        }
      : message;
  const publish: AgentRuntimePublisher = async (rawEvent) => {
    let event = rawEvent;
    if (
      blockingPresentation === 'parent' &&
      (event.type === 'assistant-checkpoint' || event.type === 'terminal')
    ) {
      event = { ...event, message: presentationMessage(event.message) };
    }
    try {
      await applicationPublish?.(event);
    } finally {
      for (const subscriber of subscribers) {
        void Promise.resolve(subscriber(event)).catch(() => {
          // A control observer cannot delay or replace the canonical run outcome.
        });
      }
      if (event.type === 'terminal') pending.delete(event.runId);
    }
  };

  const runtime = createAgentRuntime({
    ...runtimeConfig,
    models,
    publish,
    prompt: async ({ context, signal, model, snapshot, event }) => {
      const loaded = validateHarnessResources(
        await resources.load({ context, signal, model, snapshot }),
        limits,
      );
      try {
        await resources.onDiagnostics?.({ context, diagnostics: loaded.diagnostics });
      } catch {
        // Resource diagnostics are evidence; their observer does not own execution.
      }
      const runId = activeRunId(snapshot);
      const entry = pending.get(runId) ?? {};
      entry.prompt = {
        conversationId: snapshot.conversationId,
        model,
        resources: loaded.resources,
        diagnostics: loaded.diagnostics,
      };
      pending.set(runId, entry);
      await emitProfile(runId);
      const prompt = composeAgentPrompt<CONTEXT>([
        {
          name: 'harness-resources',
          stability: 'dynamic',
          render: () => renderHarnessResources(loaded.resources),
          ...(estimateResourceTokens && { estimateTokens: estimateResourceTokens }),
        },
      ]);
      return prompt({
        context,
        signal,
        event,
        budget: await promptBudget({
          context,
          contextWindow: model.descriptor.contextWindow,
        }),
      });
    },
    tools: async (runContext) => {
      const mounted = await tools(runContext);
      const entry = pending.get(runContext.run.id) ?? {};
      entry.toolNames = Object.keys(mounted).sort();
      pending.set(runContext.run.id, entry);
      await emitProfile(runContext.run.id);
      return mounted;
    },
  });

  const pendingApprovals = async (
    conversationId: string,
  ): Promise<readonly AgentHarnessPendingApproval[]> => {
    const snapshot = await config.store.loadSnapshot(conversationId);
    const responded = new Set(
      snapshot.messages.flatMap((message) =>
        message.parts
          .filter((part) => part.type === 'tool-approval-response')
          .map((part) => part.approvalId),
      ),
    );
    const pendingApprovals: AgentHarnessPendingApproval[] = [];
    for (const message of snapshot.messages) {
      const calls = new Map(
        message.parts
          .filter((part) => part.type === 'tool-call')
          .map((part) => [part.callId, part]),
      );
      for (const request of message.parts.filter(
        (part) => part.type === 'tool-approval-request',
      )) {
        if (responded.has(request.approvalId)) continue;
        const call = calls.get(request.callId);
        if (!call || !message.runId) continue;
        pendingApprovals.push({
          conversationId,
          runId: message.runId,
          messageId: message.id,
          approvalId: request.approvalId,
          callId: request.callId,
          toolName: call.toolName,
          input: call.input,
          ...(request.signature && { signature: request.signature }),
        });
      }
    }
    return pendingApprovals;
  };

  return {
    ...runtime,
    snapshot: async (conversationId) => {
      const snapshot = await config.store.loadSnapshot(conversationId);
      return { ...snapshot, messages: snapshot.messages.map(presentationMessage) };
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    pendingApprovals,
    async respondToApproval(input) {
      const pending = (await pendingApprovals(input.conversationId)).filter(
        (approval) => approval.approvalId === input.approvalId,
      );
      if (pending.length !== 1) {
        throw new Error('Approval request is missing, stale or already answered');
      }
      const request = pending[0];
      if (!request) {
        throw new Error('Approval request is missing, stale or already answered');
      }
      const authorization = config.authorizeApprovalResponse
        ? await config.authorizeApprovalResponse({
            responder: input.context,
            conversationId: input.conversationId,
            request: {
              approvalId: request.approvalId,
              callId: request.callId,
              toolName: request.toolName,
              input: request.input,
            },
            approved: input.approved,
          })
        : ({ status: 'allowed' } as const);
      if (authorization.status === 'rejected') {
        // The policy judged the responder, not the approval: record the refusal
        // and leave the request pending so a valid responder can still answer.
        await runtimeConfig.store.appendEvent({
          conversationId: input.conversationId,
          kind: 'approval/response-rejected',
          payload: {
            approvalId: request.approvalId,
            callId: request.callId,
            toolName: request.toolName,
            reason: authorization.reason,
          },
        });
        throw new AgentHarnessApprovalRejectedError(authorization.reason);
      }
      const ticket = runtime.submit({
        conversationId: input.conversationId,
        idempotencyKey: `tool-approval:${input.approvalId}`,
        context: input.context,
        role: 'tool',
        ...(input.metadata !== undefined && { metadata: input.metadata }),
        parts: [
          {
            type: 'tool-approval-response',
            approvalId: input.approvalId,
            approved: input.approved,
            ...(input.reason && { reason: input.reason }),
          },
        ],
      });
      const checkedAdmission = ticket.admission.then(async (admission) => {
        const response = admission.input.parts.find(
          (part) => part.type === 'tool-approval-response',
        );
        if (
          !response ||
          response.approvalId !== input.approvalId ||
          response.approved !== input.approved ||
          response.reason !== input.reason
        ) {
          throw new Error('Approval decision conflicts with the durable decision');
        }
        return admission;
      });
      return { ...ticket, admission: checkedAdmission };
    },
  };
}

export * from './harness-control';
