import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createSocketIOClient } from '../src/browser/socket-io';
import {
  createDeviceRelayAgent,
  createDeviceRelayHub,
  createMemoryRelayBroker,
  DEVICE_RELAY_ORIGIN,
  DeviceRelayError,
  type DeviceRelayState,
  deviceRelayRealtimeContract,
  isDeviceRelayRetryableCode,
  isRetryableDeviceRelayError,
} from '../src/entrypoints/device-relay';
import { createServer } from '../src/server/bun';
import { bindRealtimeServer } from '../src/server/realtime';
import { createSocketIOServer } from '../src/server/socket-io';
import { eventually } from './support/agent-composition';

async function startSocketRelayHarness(options?: {
  leaseTtlMs?: number;
  leaseSweepIntervalMs?: number;
  defaultRpcTimeoutMs?: number;
  maxRequestBodyBytes?: number;
  maxResponseBodyBytes?: number;
  maxInFlightRequestsPerDevice?: number;
  maxConcurrentStreamsPerDevice?: number;
  maxStreamFrameBytes?: number;
  maxBufferedStreamFrames?: number;
  now?: () => number;
  broker?: ReturnType<typeof createMemoryRelayBroker>;
  instanceId?: string;
  onDeviceStateChange?: (state: DeviceRelayState) => void;
  authorizeAccess?: Parameters<typeof createDeviceRelayHub>[0]['authorizeAccess'];
}) {
  const socket = await createSocketIOServer({
    handshake: {
      schema: z.object({ token: z.string() }),
      verify: ({ token }) => {
        if (token === 'alice-mac-token') return { accountId: 'alice', deviceId: 'mac-alice' };
        if (token === 'bob-mac-token') return { accountId: 'bob', deviceId: 'mac-bob' };
        return null;
      },
    },
  });
  const hub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
    authenticateDevice: ({ identity }) => ({
      accountId: identity.accountId,
      deviceId: identity.deviceId,
    }),
    ...(options?.authorizeAccess && { authorizeAccess: options.authorizeAccess }),
    ...(options?.broker && { broker: options.broker }),
    ...(options?.instanceId && { instanceId: options.instanceId }),
    ...(options?.leaseTtlMs && { leaseTtlMs: options.leaseTtlMs }),
    ...(options?.leaseSweepIntervalMs && {
      leaseSweepIntervalMs: options.leaseSweepIntervalMs,
    }),
    ...(options?.defaultRpcTimeoutMs && { defaultRpcTimeoutMs: options.defaultRpcTimeoutMs }),
    ...(options?.maxRequestBodyBytes && { maxRequestBodyBytes: options.maxRequestBodyBytes }),
    ...(options?.maxResponseBodyBytes && {
      maxResponseBodyBytes: options.maxResponseBodyBytes,
    }),
    ...(options?.maxInFlightRequestsPerDevice && {
      maxInFlightRequestsPerDevice: options.maxInFlightRequestsPerDevice,
    }),
    ...(options?.maxConcurrentStreamsPerDevice && {
      maxConcurrentStreamsPerDevice: options.maxConcurrentStreamsPerDevice,
    }),
    ...(options?.maxStreamFrameBytes && { maxStreamFrameBytes: options.maxStreamFrameBytes }),
    ...(options?.maxBufferedStreamFrames && {
      maxBufferedStreamFrames: options.maxBufferedStreamFrames,
    }),
    ...(options?.now && { now: options.now }),
    ...(options?.onDeviceStateChange && { onDeviceStateChange: options.onDeviceStateChange }),
  });
  const unbind = hub.bindRealtime(bindRealtimeServer(deviceRelayRealtimeContract, socket));
  const server = createServer({ port: 0, socket });
  return {
    hub,
    port: server.port,
    async stop() {
      unbind();
      await hub.close();
      await server.shutdown({ gracePeriodMs: 0 });
    },
  };
}

describe('stitchkit/device-relay over live Socket.IO realtime', () => {
  test('(a) unary Fetch RPC and multiplexed cursor streams succeed end-to-end with AbortSignal cancellation and upstream cleanup on last subscriber', async () => {
    const harness = await startSocketRelayHarness({ leaseTtlMs: 5_000 });
    const transport = createSocketIOClient({
      url: `http://localhost:${harness.port}`,
      auth: { token: 'alice-mac-token' },
      transports: ['websocket'],
    });
    let rpcAborted = false;
    let upstreamOpens = 0;
    let upstreamCleanups = 0;
    const seenCursors: Array<string | undefined> = [];

    const agent = createDeviceRelayAgent({
      transport,
      deviceId: 'mac-alice',
      capabilities: ['rpc', 'streams'],
      leaseTtlMs: 5_000,
      heartbeatIntervalMs: 1_500,
      allowRpc: [{ methods: ['GET', 'POST'], pathPrefix: '/control/' }],
      allowStreamTopics: ['watch', 'watchNative'],
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname === '/control/echo') {
          const body = await req.json();
          return new Response(
            JSON.stringify({ ok: true, echo: body, header: req.headers.get('x-client-id') }),
            { status: 200, headers: { 'content-type': 'application/json', 'x-relay': 'yes' } },
          );
        }
        if (url.pathname === '/control/slow') {
          await new Promise<void>((_, reject) => {
            req.signal.addEventListener(
              'abort',
              () => {
                rpcAborted = true;
                reject(req.signal.reason);
              },
              { once: true },
            );
          });
        }
        return new Response('not found', { status: 404 });
      },
      openStream: ({ topic, cursor, signal }) => {
        upstreamOpens += 1;
        seenCursors.push(cursor);
        return {
          async *[Symbol.asyncIterator]() {
            try {
              const start = cursor ? Number(cursor) + 1 : 1;
              for (let seq = start; seq <= start + 100; seq += 1) {
                if (signal.aborted) return;
                yield { cursor: String(seq), payload: { topic, seq } };
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            } finally {
              upstreamCleanups += 1;
            }
          },
        };
      },
    });

    try {
      transport.connect();
      await eventually(() => agent.getState().status === 'online', 5_000);

      const device = await harness.hub.getDevice('alice', 'mac-alice');
      expect(device).toMatchObject({
        accountId: 'alice',
        deviceId: 'mac-alice',
        status: 'online',
        capabilities: ['rpc', 'streams'],
      });
      expect((await harness.hub.listDevices('alice')).length).toBe(1);

      // 1. Unary Fetch RPC (compatible with createInjectedControlClient / createClient)
      const relayFetch = harness.hub.createRelayFetch({
        accountId: 'alice',
        deviceId: 'mac-alice',
      });
      const response = await relayFetch(`${DEVICE_RELAY_ORIGIN}/control/echo?mode=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': 'iphone-1' },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-relay')).toBe('yes');
      expect(await response.json()).toEqual({
        ok: true,
        echo: { hello: 'world' },
        header: 'iphone-1',
      });

      // 2. AbortSignal cancels RPC on both caller and desktop upstream
      const abortController = new AbortController();
      const slowCall = relayFetch('/control/slow', { signal: abortController.signal });
      setTimeout(() => abortController.abort(new Error('cancelled by mobile')), 30);
      await expect(slowCall).rejects.toThrow();
      await eventually(() => rpcAborted, 3_000);

      // 3. Resumable cursor stream with AbortSignal cancellation
      const streamAbort = new AbortController();
      const stream = await harness.hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'watchNative',
        cursor: '10',
        signal: streamAbort.signal,
      });
      const received: Array<{ cursor?: string; payload: unknown }> = [];
      for await (const frame of stream) {
        received.push(frame);
        if (received.length === 3) streamAbort.abort();
      }
      expect(received).toEqual([
        { cursor: '11', payload: { topic: 'watchNative', seq: 11 } },
        { cursor: '12', payload: { topic: 'watchNative', seq: 12 } },
        { cursor: '13', payload: { topic: 'watchNative', seq: 13 } },
      ]);
      expect(stream.cursor).toBe('13');
      expect(seenCursors[0]).toBe('10');
      await eventually(() => upstreamCleanups === 1, 3_000);

      // 4. Shared topic fan-out closes upstream ONLY when the last subscriber leaves
      const subA = await harness.hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'watch',
        share: true,
      });
      const subB = await harness.hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'watch',
        share: true,
      });
      expect(upstreamOpens).toBe(2);
      subA.close();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(upstreamCleanups).toBe(1);
      subB.close();
      await eventually(() => upstreamCleanups === 2, 3_000);
    } finally {
      agent.close();
      transport.disconnect();
      await harness.stop();
    }
  }, 15_000);

  test('(b) disconnect and heartbeat lease expiry immediately mark device offline and fail calls honestly', async () => {
    let clock = 1_000_000;
    const transitions: DeviceRelayState[] = [];
    const harness = await startSocketRelayHarness({
      leaseTtlMs: 200,
      leaseSweepIntervalMs: 50,
      now: () => clock,
      onDeviceStateChange: (state) => transitions.push(state),
    });
    const transport = createSocketIOClient({
      url: `http://localhost:${harness.port}`,
      auth: { token: 'alice-mac-token' },
      transports: ['websocket'],
    });
    const agent = createDeviceRelayAgent({
      transport,
      deviceId: 'mac-alice',
      capabilities: ['rpc'],
      leaseTtlMs: 200,
      heartbeatIntervalMs: 150,
      allowRpc: [{ exactPath: '/hang' }, { exactPath: '/ok' }],
      fetch: async (input) => {
        const req = input instanceof Request ? input : new Request(input);
        if (new URL(req.url).pathname === '/hang') {
          return new Promise<Response>(() => undefined);
        }
        return new Response('ok');
      },
      now: () => clock,
    });

    try {
      transport.connect();
      await eventually(() => agent.getState().status === 'online', 5_000);

      // 1. Mid-flight disconnect produces honest DELIVERY_UNKNOWN (`delivery: 'unknown'`, non-retryable).
      const relayFetch = harness.hub.createRelayFetch({
        accountId: 'alice',
        deviceId: 'mac-alice',
      });
      const inFlight = relayFetch('/hang');
      await new Promise((resolve) => setTimeout(resolve, 40));
      transport.disconnect();
      let caught: unknown;
      try {
        await inFlight;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DeviceRelayError);
      expect(caught).toMatchObject({
        code: 'DELIVERY_UNKNOWN',
        delivery: 'unknown',
        retryable: false,
      });
      expect((await harness.hub.getDevice('alice', 'mac-alice'))?.status).toBe('offline');
      expect(transitions.at(-1)?.offlineReason).toBe('disconnected');

      // 2. Subsequent call against offline device fails fast with DEVICE_OFFLINE (`delivery: 'not-sent'`).
      let offlineErr: unknown;
      try {
        await relayFetch('/ok');
      } catch (error) {
        offlineErr = error;
      }
      expect(offlineErr).toMatchObject({
        code: 'DEVICE_OFFLINE',
        delivery: 'not-sent',
        retryable: true,
      });

      // 3. Reconnect, then advance clock past lease TTL without heartbeat -> immediate lease-expired offline.
      transport.connect();
      await eventually(
        () => transitions.at(-1)?.status === 'online' && agent.getState().status === 'online',
        5_000,
      );
      clock += 500;
      await harness.hub.sweepExpiredLeases();
      const expired = await harness.hub.getDevice('alice', 'mac-alice');
      expect(expired?.status).toBe('offline');
      expect(expired?.offlineReason).toBe('lease-expired');
    } finally {
      agent.close();
      transport.disconnect();
      await harness.stop();
    }
  }, 15_000);

  test('(c) foreign accountId receives FORBIDDEN without ever touching the desktop device', async () => {
    const harness = await startSocketRelayHarness({ leaseTtlMs: 5_000 });
    const transport = createSocketIOClient({
      url: `http://localhost:${harness.port}`,
      auth: { token: 'alice-mac-token' },
      transports: ['websocket'],
    });
    let localCalls = 0;
    const agent = createDeviceRelayAgent({
      transport,
      deviceId: 'mac-alice',
      capabilities: ['rpc', 'streams'],
      allowRpc: [{ pathPrefix: '/' }],
      allowStreamTopics: ['watch'],
      fetch: async () => {
        localCalls += 1;
        return new Response('secret');
      },
      openStream: async function* () {
        localCalls += 1;
        yield { payload: 'secret' };
      },
    });
    try {
      transport.connect();
      await eventually(() => agent.getState().status === 'online', 5_000);

      // Foreign user cannot see Alice's device or call RPC / stream on it.
      expect(await harness.hub.getDevice('bob', 'mac-alice')).toBeUndefined();
      expect(await harness.hub.listDevices('bob')).toEqual([]);

      const bobFetch = harness.hub.createRelayFetch({
        accountId: 'bob',
        deviceId: 'mac-alice',
      });
      await expect(bobFetch('/secret')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        retryable: false,
      });
      await expect(
        harness.hub.openRelayStream({
          accountId: 'bob',
          deviceId: 'mac-alice',
          topic: 'watch',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', retryable: false });
      expect(localCalls).toBe(0);
    } finally {
      agent.close();
      transport.disconnect();
      await harness.stop();
    }
  }, 15_000);

  test('(d) DeviceRelayAgent refuses non-allowlisted RPC and stream topics locally without invoking local handlers, enforces size/credit limits and stops on non-retryable auth refusal', async () => {
    const harness = await startSocketRelayHarness({
      leaseTtlMs: 5_000,
      maxRequestBodyBytes: 64,
      maxResponseBodyBytes: 64,
      maxStreamFrameBytes: 64,
      maxBufferedStreamFrames: 2,
    });
    const transport = createSocketIOClient({
      url: `http://localhost:${harness.port}`,
      auth: { token: 'alice-mac-token' },
      transports: ['websocket'],
    });
    let fetchInvocations = 0;
    let streamInvocations = 0;
    let producedFrames = 0;

    const agent = createDeviceRelayAgent({
      transport,
      deviceId: 'mac-alice',
      capabilities: ['rpc', 'streams'],
      maxRequestBodyBytes: 64,
      maxResponseBodyBytes: 64,
      maxStreamFrameBytes: 64,
      allowRpc: [{ methods: ['POST'], pathPrefix: '/control/' }],
      allowStreamTopics: ['allowed-topic'],
      fetch: async (input) => {
        fetchInvocations += 1;
        const req = input instanceof Request ? input : new Request(input);
        if (new URL(req.url).pathname === '/control/big') {
          return new Response('x'.repeat(128));
        }
        return new Response('ok');
      },
      openStream: async function* ({ topic }) {
        streamInvocations += 1;
        for (let i = 1; i <= 6; i += 1) {
          producedFrames += 1;
          yield { cursor: String(i), payload: { topic, i } };
        }
      },
    });

    // Also prove non-retryable registration refusal (`IDENTITY_MISMATCH`) halts agent cleanly without retry storm.
    const badTransport = createSocketIOClient({
      url: `http://localhost:${harness.port}`,
      auth: { token: 'alice-mac-token' },
      transports: ['websocket'],
    });
    const agentErrors: DeviceRelayError[] = [];
    const badAgent = createDeviceRelayAgent({
      transport: badTransport,
      deviceId: 'spoofed-device-id',
      capabilities: [],
      onError: (err) => agentErrors.push(err),
    });

    try {
      transport.connect();
      badTransport.connect();
      await eventually(() => agent.getState().status === 'online', 5_000);
      await eventually(() => badAgent.getState().status === 'refused', 5_000);
      expect(agentErrors[0]).toMatchObject({ code: 'IDENTITY_MISMATCH', retryable: false });
      expect(isRetryableDeviceRelayError(agentErrors[0])).toBe(false);
      expect(isDeviceRelayRetryableCode('DEVICE_OFFLINE')).toBe(true);
      expect(isDeviceRelayRetryableCode('OPERATION_NOT_ALLOWED')).toBe(false);

      const relayFetch = harness.hub.createRelayFetch({
        accountId: 'alice',
        deviceId: 'mac-alice',
      });

      // Disallowed path and disallowed method never invoke local fetch.
      await expect(
        relayFetch('/admin/directory.list', { method: 'POST' }),
      ).rejects.toMatchObject({
        code: 'OPERATION_NOT_ALLOWED',
        retryable: false,
      });
      await expect(relayFetch('/control/echo', { method: 'GET' })).rejects.toMatchObject({
        code: 'OPERATION_NOT_ALLOWED',
        retryable: false,
      });
      expect(fetchInvocations).toBe(0);

      // Disallowed stream topic never invokes local openStream.
      await expect(
        harness.hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-alice',
          topic: 'forbidden-fleet-topic',
        }),
      ).rejects.toMatchObject({
        code: 'OPERATION_NOT_ALLOWED',
        retryable: false,
      });
      expect(streamInvocations).toBe(0);

      // Request and response payload byte bounds enforced cleanly.
      await expect(
        relayFetch('/control/ok', { method: 'POST', body: 'a'.repeat(128) }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', retryable: false });
      await expect(relayFetch('/control/big', { method: 'POST' })).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        retryable: false,
      });

      // Credit-based backpressure pauses producer after initial credit window (2 frames) until consumer reads.
      const stream = await harness.hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'allowed-topic',
        maxBufferedFrames: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(producedFrames).toBeLessThanOrEqual(2);
      const all: number[] = [];
      for await (const frame of stream) {
        all.push((frame.payload as { i: number }).i);
      }
      expect(all).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      badAgent.close();
      badTransport.disconnect();
      agent.close();
      transport.disconnect();
      await harness.stop();
    }
  }, 15_000);

  test('RelayBrokerPort routes RPC and cursor streams across two backend hub replicas', async () => {
    const sharedBroker = createMemoryRelayBroker();
    const replicaA = await startSocketRelayHarness({
      broker: sharedBroker,
      instanceId: 'replica-a',
      leaseTtlMs: 5_000,
    });
    const replicaB = createDeviceRelayHub({
      broker: sharedBroker,
      instanceId: 'replica-b',
      authenticateDevice: () => null,
    });
    const transport = createSocketIOClient({
      url: `http://localhost:${replicaA.port}`,
      auth: { token: 'alice-mac-token' },
      transports: ['websocket'],
    });
    const agent = createDeviceRelayAgent({
      transport,
      deviceId: 'mac-alice',
      capabilities: ['rpc', 'streams'],
      allowRpc: [{ exactPath: '/ping' }],
      allowStreamTopics: ['events'],
      fetch: async () => new Response(JSON.stringify({ via: 'replica-a' })),
      openStream: async function* () {
        yield { cursor: 'c1', payload: { from: 'desktop' } };
      },
    });
    try {
      transport.connect();
      await eventually(() => agent.getState().status === 'online', 5_000);

      // Client hits replica B, which transparently forwards through RelayBrokerPort to replica A.
      const fetchViaB = replicaB.createRelayFetch({
        accountId: 'alice',
        deviceId: 'mac-alice',
      });
      const res = await fetchViaB('/ping');
      expect(await res.json()).toEqual({ via: 'replica-a' });

      const streamViaB = await replicaB.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'events',
      });
      const items = [];
      for await (const frame of streamViaB) items.push(frame);
      expect(items).toEqual([{ cursor: 'c1', payload: { from: 'desktop' } }]);
    } finally {
      agent.close();
      transport.disconnect();
      await replicaB.close();
      await replicaA.stop();
    }
  }, 15_000);

  test('every declared hub, fetch, stream and agent option is load-bearing (timeouts, capacities, params, custom authorization and observers)', async () => {
    const warnings: string[] = [];
    const agentStates: string[] = [];
    const seenParams: Array<Record<string, unknown> | undefined> = [];
    const harness = await startSocketRelayHarness({
      leaseTtlMs: 4_000,
      defaultRpcTimeoutMs: 80,
      maxInFlightRequestsPerDevice: 1,
      maxConcurrentStreamsPerDevice: 1,
      authorizeAccess: ({ callerAccountId, deviceAccountId, path }) =>
        callerAccountId === deviceAccountId && path !== '/blocked-by-policy',
      onDeviceStateChange: () => {
        throw new Error('observer boom');
      },
    });
    const transport = createSocketIOClient({
      url: `http://localhost:${harness.port}`,
      auth: { token: 'alice-mac-token' },
      transports: ['websocket'],
    });
    const agent = createDeviceRelayAgent({
      transport,
      deviceId: 'mac-alice',
      capabilities: ['rpc', 'streams'],
      leaseTtlMs: 4_000,
      heartbeatIntervalMs: 1_000,
      helloTimeoutMs: 2_000,
      heartbeatTimeoutMs: 2_000,
      maxInFlightRequests: 1,
      maxConcurrentStreams: 1,
      allowRpc: [{ pathPrefix: '/' }],
      allowStreamTopics: ['events'],
      onStateChange: (state) => agentStates.push(state.status),
      fetch: async (input) => {
        const req = input instanceof Request ? input : new Request(input);
        const path = new URL(req.url).pathname;
        if (path === '/hang') return new Promise<Response>(() => undefined);
        return new Response('ok');
      },
      openStream: ({ params, signal }) => {
        seenParams.push(params);
        return {
          async *[Symbol.asyncIterator]() {
            yield { cursor: '1', payload: { params: params ?? null } };
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        };
      },
    });
    const loggerHub = createDeviceRelayHub({
      authenticateDevice: () => null,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (msg) => warnings.push(msg),
        error: (msg) => warnings.push(msg),
      },
    });
    try {
      transport.connect();
      await eventually(() => agent.getState().status === 'online', 5_000);
      expect(agentStates).toContain('online');

      // Custom authorizeAccess denies even the owner for a policy-blocked path.
      const relayFetch = harness.hub.createRelayFetch({
        accountId: 'alice',
        deviceId: 'mac-alice',
        timeoutMs: 60,
        maxRequestBodyBytes: 128,
        maxResponseBodyBytes: 128,
      });
      await expect(relayFetch('/blocked-by-policy')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });

      // Timeout fires after timeoutMs and concurrent RPC beyond maxInFlightRequestsPerDevice fails with DEVICE_BUSY.
      const slow = relayFetch('/hang');
      const busy = relayFetch('/ok');
      await expect(busy).rejects.toMatchObject({ code: 'DEVICE_BUSY', retryable: true });
      await expect(slow).rejects.toMatchObject({ code: 'TIMEOUT', delivery: 'unknown' });

      // Stream passes params, honors maxFrameBytes/openTimeoutMs, and enforces maxConcurrentStreamsPerDevice.
      const s1 = await harness.hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'events',
        params: { filter: 'active' },
        openTimeoutMs: 2_000,
        maxFrameBytes: 1024,
        maxBufferedFrames: 4,
      });
      await expect(
        harness.hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-alice',
          topic: 'events',
        }),
      ).rejects.toMatchObject({ code: 'STREAM_CAPACITY', retryable: true });
      const first = await s1[Symbol.asyncIterator]().next();
      expect(first.value).toEqual({ cursor: '1', payload: { params: { filter: 'active' } } });
      expect(seenParams[0]).toEqual({ filter: 'active' });
      s1.close();
      expect(warnings).toEqual([]);
    } finally {
      agent.close();
      transport.disconnect();
      await loggerHub.close();
      await harness.stop();
    }
  }, 15_000);
});
