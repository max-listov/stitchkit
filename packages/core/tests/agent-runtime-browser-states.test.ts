import { describe, expect, test } from 'bun:test';
import type { RealtimeClientTransport } from '../src/browser/realtime-client';
import {
  AgentBrowserRequestSchema,
  type AgentControlDelivery,
  AgentControlDeliverySchema,
  type AgentControlResponse,
  AgentControlResponseSchema,
  AgentHostAvailabilitySchema,
  AgentInputAnswerSchema,
  AgentPendingApprovalSchema,
  AgentPendingInputSchema,
  AgentPermissionModeSchema,
  type AgentSnapshot,
  createAgentController,
  createAgentControlView,
  deriveAgentConversationActivity,
  deriveAgentConversationState,
  reduceAgentControlDelivery,
  reduceAgentControlSnapshot,
} from '../src/entrypoints/agent-runtime/browser';
import { createAgentHarnessControlServer } from '../src/entrypoints/agent-runtime/harness';
import { compositionHarness, eventually } from './support/agent-composition';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function controllerFixture() {
  let connected = true;
  const listeners = new Set<(connected: boolean) => void>();
  const events = new Set<(...args: unknown[]) => void>();
  const requests: Array<{
    request: ReturnType<typeof AgentBrowserRequestSchema.parse>;
    respond(response: AgentControlResponse): void;
  }> = [];
  const transport: RealtimeClientTransport = {
    get connected() {
      return connected;
    },
    on: (_event, listener) => {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    emit: () => true,
    emitWithAck: (_event, args) =>
      new Promise((respond) => {
        requests.push({ request: AgentBrowserRequestSchema.parse(args[0]), respond });
      }),
    onConnectionChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const snapshot = (
    version: number,
    runs: AgentSnapshot['runs'] = [],
    messages: AgentSnapshot['messages'] = [],
  ): AgentSnapshot => ({
    schemaVersion: 1,
    conversationId: 'conv-1',
    version,
    runs,
    messages,
  });
  return {
    transport,
    requests,
    snapshot,
    deliver(delivery: AgentControlDelivery) {
      for (const listener of events) listener(delivery);
    },
    setConnected(value: boolean) {
      connected = value;
      for (const listener of listeners) listener(value);
    },
    respond(
      index: number,
      response: DistributiveOmit<AgentControlResponse, 'schemaVersion' | 'requestId'>,
    ) {
      const pending = requests[index];
      if (!pending) throw new Error(`Missing request at index ${index}`);
      pending.respond(
        AgentControlResponseSchema.parse({
          schemaVersion: 1,
          requestId: pending.request.requestId,
          ...response,
        }),
      );
    },
  };
}

const RUNNING_RUN: AgentSnapshot['runs'][number] = {
  schemaVersion: 1,
  id: 'run-1',
  conversationId: 'conv-1',
  inputMessageIds: ['msg-1'],
  assistantMessageId: 'msg-2',
  state: 'running',
  revision: 1,
  createdAt: '2026-11-28T01:00:00Z',
  updatedAt: '2026-11-28T01:00:00Z',
};

describe('agent-runtime/browser strict schemas for interactive and host states', () => {
  test('accept valid approval, input, permission-mode, host-status and delivery-unknown payloads and refuse loose extra fields', () => {
    expect(AgentPermissionModeSchema.parse('accept-edits')).toBe('accept-edits');
    expect(AgentPermissionModeSchema.safeParse('yolo').success).toBe(false);

    expect(
      AgentHostAvailabilitySchema.parse({
        status: 'asleep',
        validUntil: '2026-11-28T02:00:00+08:00',
        reason: 'Laptop lid closed',
        observedAt: '2026-11-28T01:50:00+08:00',
      }).status,
    ).toBe('asleep');
    expect(
      AgentHostAvailabilitySchema.safeParse({ status: 'online', extra: true }).success,
    ).toBe(false);

    expect(
      AgentPendingApprovalSchema.safeParse({
        approvalId: 'apr-1',
        toolName: 'bash',
        extraField: 1,
      }).success,
    ).toBe(false);

    expect(
      AgentPendingInputSchema.safeParse({
        inputId: 'inp-1',
        prompt: 'Choose environment',
        questions: [
          {
            id: 'env',
            prompt: 'Target env?',
            options: [{ id: 'dev', label: 'DEV', description: 'Development' }],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      AgentPendingInputSchema.safeParse({
        inputId: 'inp-1',
        prompt: 'Choose',
        unknown: true,
      }).success,
    ).toBe(false);

    expect(
      AgentInputAnswerSchema.safeParse({ answers: { env: 'dev' }, extra: 1 }).success,
    ).toBe(false);

    expect(
      AgentBrowserRequestSchema.safeParse({
        schemaVersion: 1,
        requestId: 'r-1',
        operation: 'respond-input',
        conversationId: 'conv-1',
        inputId: 'inp-1',
        idempotencyKey: 'idem-1',
        answer: { answers: { env: 'dev' } },
      }).success,
    ).toBe(true);
    expect(
      AgentBrowserRequestSchema.safeParse({
        schemaVersion: 1,
        requestId: 'r-2',
        operation: 'respond-input',
        conversationId: 'conv-1',
        inputId: 'inp-1',
        answer: { text: 'yes' },
        context: { owner: 'forged' },
      }).success,
    ).toBe(false);
    expect(
      AgentBrowserRequestSchema.safeParse({
        schemaVersion: 1,
        requestId: 'r-3',
        operation: 'set-permission-mode',
        conversationId: 'conv-1',
        permissionMode: 'plan',
      }).success,
    ).toBe(true);
    expect(
      AgentBrowserRequestSchema.safeParse({
        schemaVersion: 1,
        requestId: 'r-4',
        operation: 'set-permission-mode',
        conversationId: 'conv-1',
        permissionMode: 'plan',
        context: { owner: 'forged' },
      }).success,
    ).toBe(false);

    expect(
      AgentControlResponseSchema.parse({
        schemaVersion: 1,
        requestId: 'r-5',
        outcome: 'unknown',
        delivery: 'unknown',
        idempotencyKey: 'msg-1',
        message: 'Host disconnected while forwarding write',
      }),
    ).toMatchObject({ outcome: 'unknown', delivery: 'unknown' });

    expect(
      AgentControlDeliverySchema.safeParse({
        schemaVersion: 1,
        type: 'host-status',
        conversationId: 'conv-1',
        hostStatus: 'offline',
        reason: 'Heartbeat lease expired',
        extra: 'rejected',
      }).success,
    ).toBe(false);
  });
});

describe('agent-runtime/browser state transitions and controller actions', () => {
  test('handles waiting-approval, waiting-input, and permissionMode transitions end-to-end', async () => {
    const f = controllerFixture();
    const controller = createAgentController({
      transport: f.transport,
      conversationId: 'conv-1',
      access: 'control',
    });
    try {
      await eventually(() => f.requests.length === 1);
      f.respond(0, { outcome: 'ok', snapshot: f.snapshot(1, [RUNNING_RUN]) });
      await eventually(() => controller.getSnapshot().status === 'ready');

      expect(
        deriveAgentConversationState(controller.getSnapshot().view.conversations['conv-1']),
      ).toBe('working');

      f.deliver({
        schemaVersion: 1,
        type: 'permission-mode',
        conversationId: 'conv-1',
        permissionMode: 'default',
        supportedPermissionModes: ['default', 'plan', 'accept-edits', 'auto'],
      });
      expect(controller.getSnapshot().view.conversations['conv-1']?.permissionMode).toBe(
        'default',
      );
      expect(
        controller.getSnapshot().view.conversations['conv-1']?.supportedPermissionModes,
      ).toEqual(['default', 'plan', 'accept-edits', 'auto']);

      f.deliver({
        schemaVersion: 1,
        type: 'approval-state',
        conversationId: 'conv-1',
        pendingApprovals: [
          {
            approvalId: 'apr-1',
            runId: 'run-1',
            callId: 'call-1',
            toolName: 'run_shell',
            input: { command: 'rm -rf tmp' },
            summary: 'Delete temporary directory',
          },
        ],
      });
      expect(
        deriveAgentConversationState(controller.getSnapshot().view.conversations['conv-1']),
      ).toBe('waiting-approval');

      const approvalPromise = controller.respondApproval({
        approvalId: 'apr-1',
        approved: true,
        idempotencyKey: 'apr-idem-1',
        reason: 'Confirmed from phone',
      });
      await eventually(() => f.requests.length === 2);
      expect(f.requests[1]?.request).toMatchObject({
        operation: 'respond-approval',
        approvalId: 'apr-1',
        approved: true,
        idempotencyKey: 'apr-idem-1',
        reason: 'Confirmed from phone',
      });
      f.respond(1, { outcome: 'ok', snapshot: f.snapshot(2, [RUNNING_RUN]) });
      await approvalPromise;
      expect(controller.getSnapshot().view.conversations['conv-1']?.pendingApprovals).toEqual(
        [],
      );
      expect(
        deriveAgentConversationState(controller.getSnapshot().view.conversations['conv-1']),
      ).toBe('working');

      f.deliver({
        schemaVersion: 1,
        type: 'input-state',
        conversationId: 'conv-1',
        pendingInputs: [
          {
            inputId: 'inp-1',
            runId: 'run-1',
            prompt: 'Pick deployment target',
            questions: [
              {
                id: 'target',
                prompt: 'Which target?',
                options: [
                  { id: 'dev', label: 'DEV' },
                  { id: 'staging', label: 'Staging' },
                ],
              },
            ],
          },
        ],
      });
      expect(
        deriveAgentConversationState(controller.getSnapshot().view.conversations['conv-1']),
      ).toBe('waiting-input');

      const inputPromise = controller.respondInput({
        inputId: 'inp-1',
        idempotencyKey: 'inp-idem-1',
        answer: { answers: { target: 'dev' } },
      });
      await eventually(() => f.requests.length === 3);
      expect(f.requests[2]?.request).toMatchObject({
        operation: 'respond-input',
        inputId: 'inp-1',
        idempotencyKey: 'inp-idem-1',
        answer: { answers: { target: 'dev' } },
      });
      f.respond(2, { outcome: 'ok', snapshot: f.snapshot(3, [RUNNING_RUN]) });
      await inputPromise;
      expect(controller.getSnapshot().view.conversations['conv-1']?.pendingInputs).toEqual([]);
      expect(
        deriveAgentConversationState(controller.getSnapshot().view.conversations['conv-1']),
      ).toBe('working');

      const modePromise = controller.setPermissionMode('accept-edits');
      await eventually(() => f.requests.length === 4);
      expect(f.requests[3]?.request).toMatchObject({
        operation: 'set-permission-mode',
        permissionMode: 'accept-edits',
      });
      f.respond(3, { outcome: 'ok' });
      await modePromise;
      expect(controller.getSnapshot().view.conversations['conv-1']?.permissionMode).toBe(
        'accept-edits',
      );
    } finally {
      f.setConnected(false);
      await controller.close();
    }
  });

  test('transition to host-offline overlays host-offline without turning working into idle', () => {
    let view = reduceAgentControlSnapshot(createAgentControlView(), {
      schemaVersion: 1,
      conversationId: 'conv-1',
      version: 1,
      runs: [RUNNING_RUN],
      messages: [],
    });
    expect(deriveAgentConversationActivity(view.conversations['conv-1'])).toBe('working');
    expect(deriveAgentConversationState(view.conversations['conv-1'])).toBe('working');

    view = reduceAgentControlDelivery(view, {
      schemaVersion: 1,
      type: 'host-status',
      conversationId: 'conv-1',
      hostStatus: 'asleep',
      validUntil: '2026-11-28T02:00:00+08:00',
      reason: 'MacBook lid closed',
      observedAt: '2026-11-28T01:55:00+08:00',
    });
    expect(view.conversations['conv-1']?.hostStatus).toBe('asleep');
    expect(view.conversations['conv-1']?.hostAvailability).toEqual({
      status: 'asleep',
      validUntil: '2026-11-28T02:00:00+08:00',
      reason: 'MacBook lid closed',
      observedAt: '2026-11-28T01:55:00+08:00',
    });
    // UI sees host-offline while the underlying run activity remains working (never faked as idle).
    expect(deriveAgentConversationState(view.conversations['conv-1'])).toBe('host-offline');
    expect(deriveAgentConversationActivity(view.conversations['conv-1'])).toBe('working');
    expect(view.conversations['conv-1']?.snapshot?.runs[0]?.state).toBe('running');

    // Host comes back online: active working state is immediately restored without data loss.
    view = reduceAgentControlDelivery(view, {
      schemaVersion: 1,
      type: 'host-status',
      conversationId: 'conv-1',
      hostStatus: 'online',
      observedAt: '2026-11-28T01:58:00+08:00',
    });
    expect(deriveAgentConversationState(view.conversations['conv-1'])).toBe('working');
    expect(deriveAgentConversationActivity(view.conversations['conv-1'])).toBe('working');

    // `unknown` reachability reports status transparently without erasing working activity.
    view = reduceAgentControlDelivery(view, {
      schemaVersion: 1,
      type: 'host-status',
      conversationId: 'conv-1',
      hostStatus: 'unknown',
      reason: 'Relay heartbeat delayed',
    });
    expect(view.conversations['conv-1']?.hostStatus).toBe('unknown');
    expect(deriveAgentConversationActivity(view.conversations['conv-1'])).toBe('working');
  });

  test('records delivery: unknown on mid-flight drop and explicit unknown reply, then recovers cleanly after reconciliation', async () => {
    const f = controllerFixture();
    const controller = createAgentController({
      transport: f.transport,
      conversationId: 'conv-1',
      access: 'control',
    });
    try {
      await eventually(() => f.requests.length === 1);
      f.respond(0, { outcome: 'ok', snapshot: f.snapshot(1) });
      await eventually(() => controller.getSnapshot().status === 'ready');

      // 1. Mid-flight disconnect while submitting a message -> pendingDelivery: 'unknown'.
      const lostSubmit = controller.request({
        operation: 'submit',
        idempotencyKey: 'msg-drop-1',
        parts: [{ type: 'text', text: 'Did this arrive?' }],
      });
      await eventually(() => f.requests.length === 2);
      const sentRequestId = f.requests[1]?.request.requestId;
      if (!sentRequestId) throw new Error('Expected submitted requestId');
      f.setConnected(false);
      await expect(lostSubmit).rejects.toThrow('connection changed');

      const afterDrop = controller.getSnapshot().view.conversations['conv-1'];
      expect(afterDrop?.pendingDelivery).toEqual({
        delivery: 'unknown',
        requestId: sentRequestId,
        operation: 'submit',
        idempotencyKey: 'msg-drop-1',
        reason: 'Transport disconnected before acknowledgement',
      });
      expect(afterDrop?.resyncRequired).toBe(true);

      // Reconnect + attach snapshot retains pendingDelivery until explicitly reconciled.
      f.setConnected(true);
      await eventually(() => f.requests.length === 3);
      f.respond(2, { outcome: 'ok', snapshot: f.snapshot(2) });
      await eventually(() => controller.getSnapshot().status === 'ready');
      expect(
        controller.getSnapshot().view.conversations['conv-1']?.pendingDelivery?.delivery,
      ).toBe('unknown');

      // Backend confirms reconciliation by idempotencyKey -> pendingDelivery clears cleanly.
      f.deliver({
        schemaVersion: 1,
        type: 'delivery-state',
        conversationId: 'conv-1',
        requestId: sentRequestId ?? 'missing',
        operation: 'submit',
        idempotencyKey: 'msg-drop-1',
        delivery: 'confirmed',
      });
      expect(
        controller.getSnapshot().view.conversations['conv-1']?.pendingDelivery,
      ).toBeUndefined();

      // 2. Explicit `outcome: 'unknown', delivery: 'unknown'` response from backend relay.
      const relaySubmit = controller.request({
        operation: 'submit',
        idempotencyKey: 'msg-relay-2',
        parts: [{ type: 'text', text: 'Send to sleeping laptop' }],
      });
      await eventually(() => f.requests.length === 4);
      const relayReqId = f.requests[3]?.request.requestId ?? 'missing';
      f.respond(3, {
        outcome: 'unknown',
        delivery: 'unknown',
        idempotencyKey: 'msg-relay-2',
        message: 'Device lease expired during dispatch',
      });
      const relayResp = await relaySubmit;
      expect(relayResp).toMatchObject({ outcome: 'unknown', delivery: 'unknown' });
      expect(controller.getSnapshot().status).toBe('ready');
      expect(controller.getSnapshot().view.conversations['conv-1']?.pendingDelivery).toEqual({
        delivery: 'unknown',
        requestId: relayReqId,
        operation: 'submit',
        idempotencyKey: 'msg-relay-2',
        reason: 'Device lease expired during dispatch',
      });

      f.deliver({
        schemaVersion: 1,
        type: 'delivery-state',
        conversationId: 'conv-1',
        requestId: relayReqId,
        operation: 'submit',
        idempotencyKey: 'msg-relay-2',
        delivery: 'rejected',
        reason: 'Message not found on host after reconnect',
      });
      expect(
        controller.getSnapshot().view.conversations['conv-1']?.pendingDelivery,
      ).toBeUndefined();
    } finally {
      f.setConnected(false);
      await controller.close();
    }
  });

  test('cloud mountAgent snapshots leave native-only fields absent without synthetic defaults and cloud control refuses unsupported native ops cleanly', async () => {
    const cloudView = reduceAgentControlSnapshot(createAgentControlView(), {
      schemaVersion: 1,
      conversationId: 'cloud-1',
      version: 1,
      runs: [],
      messages: [],
    });
    const conv = cloudView.conversations['cloud-1'];
    expect(conv).toEqual({
      snapshot: {
        schemaVersion: 1,
        conversationId: 'cloud-1',
        version: 1,
        runs: [],
        messages: [],
      },
      resyncRequired: false,
      transientByRun: {},
    });
    expect(conv?.hostStatus).toBeUndefined();
    expect(conv?.permissionMode).toBeUndefined();
    expect(conv?.pendingApprovals).toBeUndefined();
    expect(conv?.pendingInputs).toBeUndefined();
    expect(conv?.pendingDelivery).toBeUndefined();
    expect(deriveAgentConversationState(conv)).toBe('idle');

    // Cloud harness control server refuses respond-input and set-permission-mode cleanly.
    const harness = compositionHarness();
    const server = createAgentHarnessControlServer(harness);
    const conn = server.connect({
      id: 'c1',
      deliver: () => undefined,
      onOverflow: () => undefined,
    });
    try {
      const attached = await conn.request({
        schemaVersion: 1,
        requestId: 'req-attach',
        operation: 'attach',
        conversationId: 'cloud-1',
        access: 'control',
      });
      expect(attached.outcome).toBe('ok');

      const inputRefused = await conn.request({
        schemaVersion: 1,
        requestId: 'req-input',
        operation: 'respond-input',
        conversationId: 'cloud-1',
        inputId: 'inp-1',
        answer: { text: 'ok' },
        context: { owner: 'alice' },
      });
      expect(inputRefused).toMatchObject({
        outcome: 'error',
        error: { code: 'UNSUPPORTED_OPERATION' },
      });

      const modeRefused = await conn.request({
        schemaVersion: 1,
        requestId: 'req-mode',
        operation: 'set-permission-mode',
        conversationId: 'cloud-1',
        permissionMode: 'plan',
        context: { owner: 'alice' },
      });
      expect(modeRefused).toMatchObject({
        outcome: 'error',
        error: { code: 'UNSUPPORTED_OPERATION' },
      });
    } finally {
      conn.close();
      server.close();
      await harness.close();
    }
  });
});
