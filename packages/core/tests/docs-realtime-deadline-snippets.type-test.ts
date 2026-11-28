import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import {
  createDeviceRelayAgent,
  createDeviceRelayHub,
  createMemoryRelayBroker,
  DEVICE_RELAY_ORIGIN,
  type DeviceRelayErrorCode,
  deviceRelayRealtimeContract,
} from '../src/entrypoints/device-relay';
import { createClient, createHttpClient } from '../src/entrypoints/http';
import {
  createDevicePresenceClient,
  createDevicePresenceContract,
  type RealtimeClientTransport,
} from '../src/entrypoints/realtime';
import {
  AppError,
  bindDevicePresence,
  bindRealtimeServer,
  implement,
  type RealtimeServerHandle,
} from '../src/entrypoints/server';

interface SocketIdentity {
  readonly userId: string | null;
  readonly deviceId: string;
}

declare const socket: RealtimeServerHandle<SocketIdentity>;
declare const transport: RealtimeClientTransport;
declare const localHandler: (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// 1. docs/guide/realtime.md — Account-scoped device presence
const devicePresence = createDevicePresenceContract({
  mic: {
    state: z.strictObject({ recording: z.boolean() }),
    command: z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('start') }),
      z.strictObject({ action: z.literal('stop') }),
    ]),
    result: z.strictObject({ recording: z.boolean() }),
  },
});

const presence = bindDevicePresence(devicePresence, socket, {
  accountOf: (identity) => identity.userId ?? null,
});

const presenceClient = createDevicePresenceClient(devicePresence, {
  transport,
  device: { deviceId: 'desktop-1', name: 'Desktop', platform: 'macos' },
  capabilities: ['mic'],
  initialStates: { mic: { recording: false } },
});

const offMic = presenceClient.onCommand('mic', async (command) => ({
  recording: command.action === 'start',
}));

async function checkPresenceClient() {
  await presence.readmit('sock-1');
  const ack = await presenceClient.sendCommand({
    targetDeviceId: 'desktop-1',
    capability: 'mic',
    command: { action: 'stop' },
  });
  if (ack.outcome === 'ok') {
    const recording: boolean | undefined = ack.result?.recording;
    void recording;
  }
  await presenceClient.publishState('mic', { recording: true });
  await presenceClient.publishState('mic', null);
  offMic();

  // Negative control: invalid command action is refused at compile time.
  await presenceClient.sendCommand({
    targetDeviceId: 'desktop-1',
    capability: 'mic',
    // @ts-expect-error — 'pause' is not a declared mic command action.
    command: { action: 'pause' },
  });
}
void checkPresenceClient;

// 2. docs/guide/realtime.md — User Device Relay (stitchkit/device-relay)
const relayHub = createDeviceRelayHub<SocketIdentity>({
  broker: createMemoryRelayBroker(),
  authenticateDevice: ({ identity }) =>
    identity.userId ? { accountId: identity.userId, deviceId: identity.deviceId } : null,
});
const unbindRelay = relayHub.bindRealtime(
  bindRealtimeServer(deviceRelayRealtimeContract, socket),
);

const relayAgent = createDeviceRelayAgent({
  transport,
  deviceId: 'mac-1',
  capabilities: ['rpc'],
  allowRpc: [{ methods: ['GET'], pathPrefix: '/local/' }],
  fetch: (input, init) => localHandler(input, init),
});

async function checkDeviceRelay() {
  const relayOrigin: 'http://device-relay.invalid' = DEVICE_RELAY_ORIGIN;
  const relayFetch = relayHub.createRelayFetch({ accountId: 'user-1', deviceId: 'mac-1' });
  const response: Response = await relayFetch(`${relayOrigin}/local/status`);
  const stream = await relayHub.openRelayStream({
    accountId: 'user-1',
    deviceId: 'mac-1',
    topic: 'events',
    share: true,
  });
  void [response, stream, unbindRelay, relayAgent];

  // Exhaustive check of every error code listed in docs/guide/realtime.md.
  const documentedCodes: readonly DeviceRelayErrorCode[] = [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'IDENTITY_MISMATCH',
    'OPERATION_NOT_ALLOWED',
    'INVALID_REQUEST',
    'PAYLOAD_TOO_LARGE',
    'DEVICE_OFFLINE',
    'DELIVERY_UNKNOWN',
    'DEVICE_BUSY',
    'STREAM_CAPACITY',
    'STREAM_UNAVAILABLE',
    'STREAM_OVERFLOW',
    'FRAME_UNREPRESENTABLE',
    'TIMEOUT',
    'TRANSPORT_ERROR',
    'BROKER_UNAVAILABLE',
    'CLOSED',
  ];
  void documentedCodes;

  // Negative control: fabricated error codes do not satisfy DeviceRelayErrorCode.
  // @ts-expect-error — RPC_FORBIDDEN is not a real DeviceRelayErrorCode.
  const bogusCode: DeviceRelayErrorCode = 'RPC_FORBIDDEN';
  void bogusCode;
}
void checkDeviceRelay;

// 3. docs/guide/server.md & docs/guide/client.md — Inbound & outbound deadline budgets
const reportsContract = defineContract(
  { prefix: '/reports' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List reports',
      timeout: 5_000,
      output: z.object({ items: z.array(z.string()) }),
    },
    generate: {
      method: 'POST',
      path: '/:id/generate',
      desc: 'Generate a report',
      params: z.object({ id: z.string() }),
      timeout: 5_000,
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const http = createHttpClient({ baseUrl: '/api', propagateDeadline: true });
const downstream = createClient(reportsContract, { baseUrl: 'https://downstream.example' });
void http;

const reportsService = implement(reportsContract, {
  list: async (ctx) => {
    const remaining = ctx.remainingTimeoutMs?.(200);
    if (remaining !== undefined && remaining <= 0) {
      throw new AppError('REQUEST_TIMEOUT', {
        status: 408,
        message: 'Request deadline budget exhausted',
      });
    }
    return downstream.list.withOptions(remaining !== undefined ? { timeout: remaining } : {});
  },
  generate: async (ctx) => {
    await downstream.generate.withOptions({ id: ctx.params.id }, { timeout: 5_000 });
    await downstream.generate.withOptions(
      { id: ctx.params.id },
      { timeout: 5_000, propagateDeadline: false },
    );
    return { ok: true };
  },
});
void reportsService;
