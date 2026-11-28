import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { RealtimeClientTransport } from '../src/browser/realtime-client';
import { createSocketIOClient } from '../src/browser/socket-io';
import { createRelayStreamConsumer } from '../src/device-relay/hub-streams';
import {
  createDeviceRelayAgent,
  createDeviceRelayHub,
  createMemoryRelayBroker,
  DEVICE_RELAY_ORIGIN,
  DeviceRelayError,
  DeviceRelayHelloAckSchema,
  DeviceRelayHelloSchema,
  type DeviceRelayRawSocket,
  type DeviceRelayRpcRequest,
  type DeviceRelayServerConnection,
  deviceRelayRealtimeContract,
} from '../src/entrypoints/device-relay';
import { base64ToBytes, bytesToBase64 } from '../src/internal/base64';
import { MAX_TIMER_MS } from '../src/internal/timers';
import { createServer } from '../src/server/bun';
import { bindRealtimeServer } from '../src/server/realtime';
import { createSocketIOServer } from '../src/server/socket-io';
import { eventually } from './support/agent-composition';

async function expectRejectsMatch(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(caught).toMatchObject(expected);
}

/**
 * Deterministic in-process realtime pair where server/client events deliver synchronously in
 * emission order — ideal for proving microtask-window races (e.g. `stream-event` arriving right
 * after `stream-open-ack` before awaiting promises resume) and raw malformed wire frames.
 */
function createSyncRealtimePair<TIdentity>(identity: TIdentity, socketId = 'sock-1') {
  const clientHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const serverHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const disconnectHandlers = new Set<(reason?: string) => void>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  const serverEmitted: Array<{ event: string; payload: unknown }> = [];
  const clientEmitted: Array<{ event: string; payload: unknown }> = [];
  let connected = false;

  const clientTransport: RealtimeClientTransport = {
    get connected() {
      return connected;
    },
    on(event, listener) {
      let set = clientHandlers.get(event);
      if (!set) {
        set = new Set();
        clientHandlers.set(event, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    emit(event, ...args) {
      clientEmitted.push({ event, payload: args[0] });
      const handlers = serverHandlers.get(event);
      if (handlers) {
        for (const fn of [...handlers]) fn(...args);
      }
      return connected;
    },
    emitWithAck(event, args, options) {
      clientEmitted.push({ event, payload: args[0] });
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer =
          options?.timeoutMs !== undefined
            ? setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error(`Ack timeout for ${event}`));
              }, options.timeoutMs)
            : undefined;
        const ack = (reply: unknown) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(reply);
        };
        const handlers = serverHandlers.get(event);
        if (handlers) {
          for (const fn of [...handlers]) fn(...args, ack);
        }
      });
    },
    onConnectionChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };

  const rawSocket: DeviceRelayRawSocket<TIdentity> = {
    id: socketId,
    data: identity,
    on(_event, listener) {
      disconnectHandlers.add(listener);
    },
    off(_event, listener) {
      disconnectHandlers.delete(listener);
    },
    disconnect() {
      setConnected(false);
    },
  };

  const serverConnection: DeviceRelayServerConnection<TIdentity> = {
    raw: rawSocket,
    events: {
      on(event, handler) {
        const key = String(event);
        let set = serverHandlers.get(key);
        if (!set) {
          set = new Set();
          serverHandlers.set(key, set);
        }
        const wrapped = (...args: unknown[]) => {
          Reflect.apply(handler, undefined, args);
        };
        set.add(wrapped);
        return () => set.delete(wrapped);
      },
      emit(event, ...args) {
        const key = String(event);
        serverEmitted.push({ event: key, payload: args[0] });
        const handlers = clientHandlers.get(key);
        if (handlers) {
          for (const fn of [...handlers]) fn(...args);
        }
        return connected;
      },
    } as DeviceRelayServerConnection<TIdentity>['events'],
  };

  const setConnected = (next: boolean): void => {
    if (connected === next) return;
    connected = next;
    if (!next) {
      for (const fn of [...disconnectHandlers]) fn('transport close');
    }
    for (const fn of [...connectionListeners]) fn(next);
  };

  const sendRawToAgent = (event: string, payload: unknown): void => {
    const handlers = clientHandlers.get(event);
    if (handlers) {
      for (const fn of [...handlers]) fn(payload);
    }
  };

  const sendRawToHub = (
    event: string,
    payload: unknown,
    ack?: (reply: unknown) => void,
  ): void => {
    const handlers = serverHandlers.get(event);
    if (handlers) {
      for (const fn of [...handlers]) {
        if (ack) fn(payload, ack);
        else fn(payload);
      }
    }
  };

  return {
    clientTransport,
    serverConnection,
    serverEmitted,
    clientEmitted,
    setConnected,
    sendRawToAgent,
    sendRawToHub,
  };
}

describe('device-relay security, early-event races and lifecycle hardening', () => {
  test('refuses path-traversal, encoded delimiters, foreign origins and prefix boundary bypasses on both hub and agent', async () => {
    const pair = createSyncRealtimePair({ accountId: 'alice', deviceId: 'mac-alice' });
    const hub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      authenticateDevice: ({ identity }) => identity,
    });
    hub.attachConnection(pair.serverConnection);

    const seenUrls: string[] = [];
    const agent = createDeviceRelayAgent({
      transport: pair.clientTransport,
      deviceId: 'mac-alice',
      capabilities: ['rpc'],
      allowRpc: [{ methods: ['GET', 'POST'], pathPrefix: '/api' }],
      fetch: async (input) => {
        const req = input instanceof Request ? input : new Request(input);
        seenUrls.push(req.url);
        return new Response(JSON.stringify({ pathname: new URL(req.url).pathname }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    try {
      pair.setConnected(true);
      await eventually(() => agent.getState().status === 'online', 2_000);

      const relayFetch = hub.createRelayFetch({ accountId: 'alice', deviceId: 'mac-alice' });

      // Positive controls: exact prefix, nested segment, query with encoded slash, and single-dot canonicalization.
      expect(await (await relayFetch('/api')).json()).toEqual({ pathname: '/api' });
      expect(await (await relayFetch('/api/items?next=%2Fhome')).json()).toEqual({
        pathname: '/api/items',
      });
      expect(await (await relayFetch(`${DEVICE_RELAY_ORIGIN}/api/./items`)).json()).toEqual({
        pathname: '/api/items',
      });
      expect(seenUrls).toEqual([
        `${DEVICE_RELAY_ORIGIN}/api`,
        `${DEVICE_RELAY_ORIGIN}/api/items?next=%2Fhome`,
        `${DEVICE_RELAY_ORIGIN}/api/items`,
      ]);

      const callsBeforeAttacks = seenUrls.length;

      // Prefix segment boundary: `/api-admin` and `/api2/secret` MUST be rejected with OPERATION_NOT_ALLOWED.
      for (const blocked of ['/api-admin', '/api2/secret']) {
        await expectRejectsMatch(relayFetch(blocked), {
          code: 'OPERATION_NOT_ALLOWED',
          retryable: false,
        });
      }

      // Traversal, backslash, encoded delimiters and foreign origins MUST be refused by the hub.
      const forbiddenInputs = [
        '/api/../admin',
        '/api/..\\admin',
        '/api/%2e%2e/admin',
        '/api/%2E%2e%2fadmin',
        '/api/%2fadmin',
        '/api/%5cadmin',
        'https://evil.com/api/ok',
        'http://ignored.local/api/ok',
        '//evil.com/api/ok',
        'http://device-relay.invalid@evil.com/api/ok',
      ];
      for (const bad of forbiddenInputs) {
        await expectRejectsMatch(relayFetch(bad), {
          code: 'INVALID_REQUEST',
          retryable: false,
        });
      }

      // Defence-in-depth: bypass hub and inject raw malformed/traversal frames directly into DeviceRelayAgent!
      const rawPaths = [
        '/api/../admin',
        '/api/..\\admin',
        '/api/%2e%2e/admin',
        '/api/%2fadmin',
        '/api/%5cadmin',
        'https://evil.com/api/ok',
        '//evil.com/api/ok',
        `${DEVICE_RELAY_ORIGIN}/api/ok`,
      ];
      for (const [idx, rawPath] of rawPaths.entries()) {
        const requestId = `raw-attack-${idx}`;
        const frame: DeviceRelayRpcRequest = {
          schemaVersion: 1,
          requestId,
          method: 'GET',
          path: rawPath,
          headers: [],
        };
        pair.sendRawToAgent('stitchkit.relay.rpc-request', frame);
        await eventually(
          () =>
            pair.clientEmitted.some(
              (entry) =>
                entry.event === 'stitchkit.relay.rpc-response' &&
                (entry.payload as { requestId?: string }).requestId === requestId,
            ),
          1_000,
        );
        const reply = pair.clientEmitted.find(
          (entry) =>
            entry.event === 'stitchkit.relay.rpc-response' &&
            (entry.payload as { requestId?: string }).requestId === requestId,
        )?.payload;
        expect(reply).toMatchObject({
          requestId,
          outcome: 'error',
          code: 'INVALID_REQUEST',
          retryable: false,
        });
      }

      // Malformed base64 request body returns clean INVALID_REQUEST RPC error instead of unhandled rejection / hang.
      for (const badBase64 of ['!!!not-base64!!!', 'AA==AAAA']) {
        const requestId = `bad-b64-${badBase64}`;
        const frame: DeviceRelayRpcRequest = {
          schemaVersion: 1,
          requestId,
          method: 'POST',
          path: '/api/items',
          headers: [],
          body: badBase64,
          bodyEncoding: 'base64',
        };
        pair.sendRawToAgent('stitchkit.relay.rpc-request', frame);
        await eventually(
          () =>
            pair.clientEmitted.some(
              (entry) =>
                entry.event === 'stitchkit.relay.rpc-response' &&
                (entry.payload as { requestId?: string }).requestId === requestId,
            ),
          1_000,
        );
        const reply = pair.clientEmitted.find(
          (entry) =>
            entry.event === 'stitchkit.relay.rpc-response' &&
            (entry.payload as { requestId?: string }).requestId === requestId,
        )?.payload;
        expect(reply).toMatchObject({
          requestId,
          outcome: 'error',
          code: 'INVALID_REQUEST',
          retryable: false,
        });
      }

      // Not a single attack or malformed frame ever reached local config.fetch.
      expect(seenUrls.length).toBe(callsBeforeAttacks);
    } finally {
      agent.close();
      await hub.close();
    }
  });

  test('buffers early stream-event/end/error arriving synchronously after stream-open-ack and cleans up on openTimer timeout with late-ack stream-close', async () => {
    const pair = createSyncRealtimePair({ accountId: 'alice', deviceId: 'mac-alice' });
    const hub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      authenticateDevice: ({ identity }) => identity,
      maxConcurrentStreamsPerDevice: 1,
    });
    hub.attachConnection(pair.serverConnection);

    try {
      pair.setConnected(true);
      await new Promise<void>((resolve) => {
        pair.sendRawToHub(
          'stitchkit.relay.hello',
          { schemaVersion: 1, deviceId: 'mac-alice', capabilities: ['streams'] },
          () => resolve(),
        );
      });

      // Intercept stream-open frames manually so stream-event arrives SYNCHRONOUSLY right after stream-open-ack!
      const delayedStreamIds: string[] = [];
      pair.clientTransport.on('stitchkit.relay.stream-open', (raw: unknown) => {
        const open = raw as { streamId: string; topic: string };
        if (open.topic === 'fast-data') {
          pair.sendRawToHub('stitchkit.relay.stream-open-ack', {
            schemaVersion: 1,
            streamId: open.streamId,
            outcome: 'ok',
          });
          pair.sendRawToHub('stitchkit.relay.stream-event', {
            schemaVersion: 1,
            streamId: open.streamId,
            kind: 'data',
            cursor: 'c1',
            payload: { seq: 1 },
          });
          pair.sendRawToHub('stitchkit.relay.stream-event', {
            schemaVersion: 1,
            streamId: open.streamId,
            kind: 'end',
            cursor: 'c1',
          });
          return;
        }
        if (open.topic === 'fast-empty') {
          pair.sendRawToHub('stitchkit.relay.stream-open-ack', {
            schemaVersion: 1,
            streamId: open.streamId,
            outcome: 'ok',
          });
          pair.sendRawToHub('stitchkit.relay.stream-event', {
            schemaVersion: 1,
            streamId: open.streamId,
            kind: 'end',
          });
          return;
        }
        if (open.topic === 'fast-error') {
          pair.sendRawToHub('stitchkit.relay.stream-open-ack', {
            schemaVersion: 1,
            streamId: open.streamId,
            outcome: 'ok',
          });
          pair.sendRawToHub('stitchkit.relay.stream-event', {
            schemaVersion: 1,
            streamId: open.streamId,
            kind: 'error',
            code: 'STREAM_UNAVAILABLE',
            message: 'immediate upstream failure',
            retryable: false,
          });
          return;
        }
        if (open.topic === 'slow-open') {
          delayedStreamIds.push(open.streamId);
        }
      });

      // 1. Synchronous data + end right after ack is never lost or hung.
      const fastStream = await hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'fast-data',
      });
      const fastFrames = [];
      for await (const frame of fastStream) fastFrames.push(frame);
      expect(fastFrames).toEqual([{ cursor: 'c1', payload: { seq: 1 } }]);

      // 2. Synchronous immediate end (0 frames) completes cleanly without hanging.
      const emptyStream = await hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'fast-empty',
      });
      const emptyFrames = [];
      for await (const frame of emptyStream) emptyFrames.push(frame);
      expect(emptyFrames).toEqual([]);

      // 3. Synchronous immediate error propagates cleanly.
      const errorStream = await hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'fast-error',
      });
      await expectRejectsMatch(
        (async () => {
          for await (const _frame of errorStream) {
            // drain
          }
        })(),
        { code: 'STREAM_UNAVAILABLE', message: 'immediate upstream failure' },
      );

      // 4. Synchronous early data + end on shared concurrent openers reaches BOTH subscribers!
      const [sharedA, sharedB] = await Promise.all([
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-alice',
          topic: 'fast-data',
          share: true,
        }),
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-alice',
          topic: 'fast-data',
          share: true,
        }),
      ]);
      const [itemsA, itemsB] = await Promise.all([
        (async () => {
          const out = [];
          for await (const f of sharedA) out.push(f);
          return out;
        })(),
        (async () => {
          const out = [];
          for await (const f of sharedB) out.push(f);
          return out;
        })(),
      ]);
      expect(itemsA).toEqual([{ cursor: 'c1', payload: { seq: 1 } }]);
      expect(itemsB).toEqual([{ cursor: 'c1', payload: { seq: 1 } }]);

      // 5. Open timeout frees maxConcurrentStreamsPerDevice capacity AND late ack triggers stream-close.
      await expectRejectsMatch(
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-alice',
          topic: 'slow-open',
          openTimeoutMs: 35,
        }),
        { code: 'TIMEOUT' },
      );
      expect(delayedStreamIds.length).toBe(1);
      const timedOutStreamId = delayedStreamIds[0] ?? '';

      // Because session.openStreams was cleaned up on timeout, another stream opens immediately despite cap=1!
      const recoveryStream = await hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'fast-empty',
      });
      for await (const _f of recoveryStream) {
        // drain
      }

      // Now agent sends a late ok ack for the timed-out stream -> hub emits stream-close(late-open-ack).
      const closesBefore = pair.serverEmitted.filter(
        (e) =>
          e.event === 'stitchkit.relay.stream-close' &&
          (e.payload as { streamId?: string }).streamId === timedOutStreamId &&
          (e.payload as { reason?: string }).reason === 'late-open-ack',
      ).length;
      pair.sendRawToHub('stitchkit.relay.stream-open-ack', {
        schemaVersion: 1,
        streamId: timedOutStreamId,
        outcome: 'ok',
      });
      const closesAfter = pair.serverEmitted.filter(
        (e) =>
          e.event === 'stitchkit.relay.stream-close' &&
          (e.payload as { streamId?: string }).streamId === timedOutStreamId &&
          (e.payload as { reason?: string }).reason === 'late-open-ack',
      ).length;
      expect(closesAfter).toBe(closesBefore + 1);
    } finally {
      await hub.close();
    }
  });

  test('share: true deduplicates concurrent opens, canonicalizes params key and centrally paces credits by slowest subscriber', async () => {
    const pair = createSyncRealtimePair({ accountId: 'alice', deviceId: 'mac-alice' });
    const hub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      authenticateDevice: ({ identity }) => identity,
    });
    hub.attachConnection(pair.serverConnection);

    let upstreamOpens = 0;
    let produced = 0;
    const agent = createDeviceRelayAgent({
      transport: pair.clientTransport,
      deviceId: 'mac-alice',
      capabilities: ['streams'],
      allowStreamTopics: ['metrics'],
      openStream: async function* () {
        upstreamOpens += 1;
        // Brief async open so concurrent callers overlap while opening!
        await new Promise((resolve) => setTimeout(resolve, 25));
        for (let seq = 1; seq <= 10; seq += 1) {
          produced += 1;
          yield { cursor: String(seq), payload: { seq } };
        }
      },
    });

    try {
      pair.setConnected(true);
      await eventually(() => agent.getState().status === 'online', 2_000);

      // Concurrent opens with equivalent params in different key order share ONE upstream subscription!
      const [subA, subB] = await Promise.all([
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-alice',
          topic: 'metrics',
          params: { b: 2, a: 1 },
          share: true,
          maxBufferedFrames: 4,
        }),
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-alice',
          topic: 'metrics',
          params: { a: 1, b: 2 },
          share: true,
          maxBufferedFrames: 4,
        }),
      ]);
      expect(upstreamOpens).toBe(1);

      // Wait for initial credit window (4) to be produced and paused.
      await eventually(() => produced === 4, 2_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(produced).toBe(4);

      const creditGrants = () =>
        pair.serverEmitted
          .filter((e) => e.event === 'stitchkit.relay.stream-credit')
          .reduce((sum, e) => sum + ((e.payload as { credits: number }).credits ?? 0), 0);

      // Fast subA consumes all 4 frames while slow subB consumes 0 -> ZERO new credits granted upstream!
      const iterA = subA[Symbol.asyncIterator]();
      const iterB = subB[Symbol.asyncIterator]();
      const seenA: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const step = await iterA.next();
        expect(step.done).toBe(false);
        if (!step.done) seenA.push((step.value.payload as { seq: number }).seq);
      }
      expect(seenA).toEqual([1, 2, 3, 4]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(creditGrants()).toBe(0);
      expect(produced).toBe(4);

      // Slow subB catches up by 4 frames -> total credits granted is 4 (1x, NOT 8 = 2x!).
      const seenB: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const step = await iterB.next();
        expect(step.done).toBe(false);
        if (!step.done) seenB.push((step.value.payload as { seq: number }).seq);
      }
      expect(seenB).toEqual([1, 2, 3, 4]);
      expect(creditGrants()).toBe(4);
      await eventually(() => produced === 8, 2_000);

      // Closing slow subB unblocks subA to drain remaining frames cleanly.
      subB.close();
      for (;;) {
        const step = await iterA.next();
        if (step.done) break;
        seenA.push((step.value.payload as { seq: number }).seq);
      }
      expect(seenA).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      agent.close();
      await hub.close();
    }
  });

  test('renews heartbeat with negotiated effectiveLeaseMs, guards async hello disconnect/deviceId switch, and retries retryable hello on live socket', async () => {
    let clock = 100_000;
    const broker = createMemoryRelayBroker({
      maxOfflineDevices: 2,
      offlineTtlMs: 1_000,
      now: () => clock,
    });
    let authGate: PromiseWithResolvers<void> | undefined;
    let allowedDeviceId = 'mac-alice';

    const hub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      broker,
      leaseTtlMs: 10_000,
      now: () => clock,
      authenticateDevice: async ({ identity, hello }) => {
        if (authGate) await authGate.promise;
        return {
          accountId: identity.accountId,
          deviceId: hello.deviceId === allowedDeviceId ? hello.deviceId : identity.deviceId,
        };
      },
    });

    try {
      // 1. Negotiated effectiveLeaseMs (2 000 < hub 10 000) governs heartbeat renewal.
      const pair1 = createSyncRealtimePair(
        { accountId: 'alice', deviceId: 'mac-alice' },
        's1',
      );
      hub.attachConnection(pair1.serverConnection);
      pair1.setConnected(true);
      const helloAck = await new Promise<{
        outcome: string;
        leaseTtlMs?: number;
        leaseExpiresAtMs?: number;
      }>((resolve) => {
        pair1.sendRawToHub(
          'stitchkit.relay.hello',
          { schemaVersion: 1, deviceId: 'mac-alice', capabilities: [], leaseTtlMs: 2_000 },
          (reply) =>
            resolve(
              reply as { outcome: string; leaseTtlMs?: number; leaseExpiresAtMs?: number },
            ),
        );
      });
      expect(helloAck).toMatchObject({
        outcome: 'ok',
        leaseTtlMs: 2_000,
        leaseExpiresAtMs: 102_000,
      });

      clock = 101_000;
      const hbAck = await new Promise<{ outcome: string; leaseExpiresAtMs?: number }>(
        (resolve) => {
          pair1.sendRawToHub(
            'stitchkit.relay.heartbeat',
            { schemaVersion: 1, deviceId: 'mac-alice', sentAtMs: clock },
            (reply) => resolve(reply as { outcome: string; leaseExpiresAtMs?: number }),
          );
        },
      );
      // Renews by effectiveLeaseMs (2 000 -> 103 000), NOT raw hub leaseTtlMs (10 000 -> 111 000)!
      expect(hbAck).toMatchObject({ outcome: 'ok', leaseExpiresAtMs: 103_000 });

      // 2. Second hello on the same socket switching deviceId tears down prior activeDeviceId.
      allowedDeviceId = 'mac-alice-v2';
      await new Promise<void>((resolve) => {
        pair1.sendRawToHub(
          'stitchkit.relay.hello',
          { schemaVersion: 1, deviceId: 'mac-alice-v2', capabilities: [] },
          () => resolve(),
        );
      });
      expect((await hub.getDevice('alice', 'mac-alice'))?.status).toBe('offline');
      expect((await hub.getDevice('alice', 'mac-alice'))?.offlineReason).toBe('replaced');
      expect((await hub.getDevice('alice', 'mac-alice-v2'))?.status).toBe('online');

      // 3. Disconnect during async authenticateDevice does NOT register a ghost online device.
      authGate = Promise.withResolvers<void>();
      const pair2 = createSyncRealtimePair(
        { accountId: 'alice', deviceId: 'mac-ghost' },
        's2',
      );
      hub.attachConnection(pair2.serverConnection);
      pair2.setConnected(true);
      const ghostAckPromise = new Promise<{ outcome: string; code?: string }>((resolve) => {
        pair2.sendRawToHub(
          'stitchkit.relay.hello',
          { schemaVersion: 1, deviceId: 'mac-ghost', capabilities: [] },
          (reply) => resolve(reply as { outcome: string; code?: string }),
        );
      });
      // Disconnect BEFORE authenticateDevice finishes!
      pair2.setConnected(false);
      authGate.resolve();
      authGate = undefined;
      expect(await ghostAckPromise).toMatchObject({ outcome: 'error', code: 'CLOSED' });
      expect(await hub.getDevice('alice', 'mac-ghost')).toBeUndefined();

      // 4. Retryable hello error/timeout on live socket schedules bounded backoff retry and recovers!
      const pair3 = createSyncRealtimePair(
        { accountId: 'alice', deviceId: 'mac-retry' },
        's3',
      );
      let helloAttempts = 0;
      pair3.serverConnection.events.on('stitchkit.relay.hello', (_hello, ack) => {
        helloAttempts += 1;
        if (helloAttempts === 1) {
          ack({
            schemaVersion: 1,
            outcome: 'error',
            code: 'BROKER_UNAVAILABLE',
            message: 'temporary outage',
            retryable: true,
          });
          return;
        }
        if (helloAttempts === 2) {
          // Simulate timeout by never calling ack on attempt 2!
          return;
        }
        ack({
          schemaVersion: 1,
          outcome: 'ok',
          leaseTtlMs: 5_000,
          leaseExpiresAtMs: clock + 5_000,
          serverTimeMs: clock,
          instanceId: 'hub-1',
        });
      });
      const retryAgent = createDeviceRelayAgent({
        transport: pair3.clientTransport,
        deviceId: 'mac-retry',
        capabilities: [],
        helloTimeoutMs: 40,
      });
      try {
        pair3.setConnected(true);
        await eventually(() => retryAgent.getState().status === 'online', 3_000);
        expect(helloAttempts).toBe(3);
      } finally {
        retryAgent.close();
      }
    } finally {
      await hub.close();
    }
  });

  test('createMemoryRelayBroker bounds offline entries by cap and TTL, hub-streams waiter queue is FIFO, base64 rejects mid-string padding, and leaseTtlMs respects MAX_TIMER_MS', async () => {
    // 1. Memory broker offline cap + TTL eviction.
    let clock = 10_000;
    const broker = createMemoryRelayBroker({
      maxOfflineDevices: 2,
      offlineTtlMs: 500,
      now: () => clock,
    });
    const makeDevice = (deviceId: string) => ({
      accountId: 'alice',
      deviceId,
      status: 'online' as const,
      capabilities: [],
      instanceId: 'hub-1',
      connectedAt: clock,
      lastHeartbeatAt: clock,
      leaseExpiresAt: clock + 5_000,
    });
    broker.registerDevice(makeDevice('online-keep'));
    broker.registerDevice(makeDevice('off-1'));
    broker.registerDevice(makeDevice('off-2'));
    broker.registerDevice(makeDevice('off-3'));
    broker.markDeviceOffline({
      deviceId: 'off-1',
      instanceId: 'hub-1',
      reason: 'disconnected',
    });
    clock += 10;
    broker.markDeviceOffline({
      deviceId: 'off-2',
      instanceId: 'hub-1',
      reason: 'disconnected',
    });
    clock += 10;
    broker.markDeviceOffline({
      deviceId: 'off-3',
      instanceId: 'hub-1',
      reason: 'disconnected',
    });
    // Cap=2 evicted oldest offline ('off-1'), kept 'off-2', 'off-3', and never touched 'online-keep'.
    expect(await broker.lookupDevice('off-1')).toBeUndefined();
    expect((await broker.lookupDevice('off-2'))?.status).toBe('offline');
    expect((await broker.lookupDevice('off-3'))?.status).toBe('offline');
    expect((await broker.lookupDevice('online-keep'))?.status).toBe('online');

    // Advancing past offlineTtlMs evicts remaining offline entries on lookup.
    clock += 600;
    expect(await broker.lookupDevice('off-2')).toBeUndefined();
    expect(await broker.lookupDevice('off-3')).toBeUndefined();
    expect((await broker.lookupDevice('online-keep'))?.status).toBe('online');

    // 2. Concurrent iterator.next() resolves in strict FIFO order without dropping earlier promises.
    const consumer = createRelayStreamConsumer({
      streamId: 's1',
      topic: 'events',
      deviceId: 'mac-alice',
      maxBufferedFrames: 4,
      maxFrameBytes: 1024,
      onClose: () => undefined,
      onGrantCredits: () => undefined,
    });
    const iter = consumer.stream[Symbol.asyncIterator]();
    const p1 = iter.next();
    const p2 = iter.next();
    const p3 = iter.next();
    consumer.push({
      schemaVersion: 1,
      streamId: 's1',
      kind: 'data',
      cursor: '1',
      payload: 'first',
    });
    consumer.push({
      schemaVersion: 1,
      streamId: 's1',
      kind: 'data',
      cursor: '2',
      payload: 'second',
    });
    consumer.push({ schemaVersion: 1, streamId: 's1', kind: 'end', cursor: '2' });
    expect(await Promise.all([p1, p2, p3])).toEqual([
      { value: { cursor: '1', payload: 'first' }, done: false },
      { value: { cursor: '2', payload: 'second' }, done: false },
      { value: undefined, done: true },
    ]);

    // 3. Single Hermes-safe internal/base64 round-trips and rejects mid-string/malformed padding.
    for (const sample of [
      new Uint8Array([]),
      new Uint8Array([1]),
      new Uint8Array([1, 2]),
      new Uint8Array([0, 127, 128, 255]),
    ]) {
      expect(base64ToBytes(bytesToBase64(sample))).toEqual(sample);
    }
    for (const invalid of [
      'AA==AAAA',
      'AAA=AAAA',
      'AA=A',
      '=AAA',
      'A=AA',
      '====',
      'ABC',
      'AB!D',
      'AB\u00ffD',
    ]) {
      expect(() => base64ToBytes(invalid), invalid).toThrow();
    }

    // 4. Schema timer ceiling on leaseTtlMs accepts MAX_TIMER_MS and rejects MAX_TIMER_MS + 1.
    expect(
      DeviceRelayHelloSchema.safeParse({
        schemaVersion: 1,
        deviceId: 'mac-alice',
        capabilities: [],
        leaseTtlMs: MAX_TIMER_MS,
      }).success,
    ).toBe(true);
    expect(
      DeviceRelayHelloSchema.safeParse({
        schemaVersion: 1,
        deviceId: 'mac-alice',
        capabilities: [],
        leaseTtlMs: MAX_TIMER_MS + 1,
      }).success,
    ).toBe(false);
    expect(
      DeviceRelayHelloAckSchema.safeParse({
        schemaVersion: 1,
        outcome: 'ok',
        leaseTtlMs: MAX_TIMER_MS + 1,
        leaseExpiresAtMs: 1,
        serverTimeMs: 1,
        instanceId: 'hub-1',
      }).success,
    ).toBe(false);
  });

  test('live Socket.IO relay enforces foreign-origin refusal and segment-boundary prefix allowlist end-to-end', async () => {
    const socket = await createSocketIOServer({
      handshake: {
        schema: z.object({ token: z.string() }),
        verify: ({ token }) =>
          token === 'alice-tok' ? { accountId: 'alice', deviceId: 'mac-alice' } : null,
      },
    });
    const hub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      authenticateDevice: ({ identity }) => identity,
    });
    const unbind = hub.bindRealtime(bindRealtimeServer(deviceRelayRealtimeContract, socket));
    const server = createServer({ port: 0, hostname: '127.0.0.1', socket });
    const transport = createSocketIOClient({
      url: `http://127.0.0.1:${server.port}`,
      auth: { token: 'alice-tok' },
      transports: ['websocket'],
    });
    let fetchHits = 0;
    const agent = createDeviceRelayAgent({
      transport,
      deviceId: 'mac-alice',
      capabilities: ['rpc'],
      allowRpc: [{ methods: ['GET'], pathPrefix: '/api' }],
      fetch: async () => {
        fetchHits += 1;
        return new Response('ok');
      },
    });
    try {
      transport.connect();
      await eventually(() => agent.getState().status === 'online', 5_000);
      const relayFetch = hub.createRelayFetch({ accountId: 'alice', deviceId: 'mac-alice' });
      expect(await (await relayFetch('/api/ping')).text()).toBe('ok');
      expect(fetchHits).toBe(1);
      await expectRejectsMatch(relayFetch('/api-admin'), {
        code: 'OPERATION_NOT_ALLOWED',
      });
      await expectRejectsMatch(relayFetch('https://evil.com/api/ping'), {
        code: 'INVALID_REQUEST',
      });
      expect(fetchHits).toBe(1);
    } finally {
      agent.close();
      transport.disconnect();
      unbind();
      await hub.close();
      await server.shutdown({ gracePeriodMs: 0 });
    }
  }, 15_000);

  test('rejects zombie heartbeats after sweepExpiredLeases or socket replacement and re-registers agent to online', async () => {
    let clock = 500_000;
    const hub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      leaseTtlMs: 200,
      leaseSweepIntervalMs: 60_000,
      now: () => clock,
      authenticateDevice: ({ identity }) => identity,
    });

    const pair1 = createSyncRealtimePair(
      { accountId: 'alice', deviceId: 'mac-alice' },
      'sock-1',
    );
    const pair2 = createSyncRealtimePair(
      { accountId: 'alice', deviceId: 'mac-alice' },
      'sock-2',
    );
    hub.attachConnection(pair1.serverConnection);
    hub.attachConnection(pair2.serverConnection);

    // Negative control: unregistered socket sending heartbeat before hello gets non-retryable IDENTITY_MISMATCH.
    const unregAck = await new Promise<Record<string, unknown>>((resolve) => {
      pair2.sendRawToHub(
        'stitchkit.relay.heartbeat',
        { schemaVersion: 1, deviceId: 'mac-alice', sentAtMs: clock },
        (reply) => resolve(reply as Record<string, unknown>),
      );
    });
    expect(unregAck).toMatchObject({
      outcome: 'error',
      code: 'IDENTITY_MISMATCH',
      retryable: false,
    });

    const agent1Errors: string[] = [];
    const agent1 = createDeviceRelayAgent({
      transport: pair1.clientTransport,
      deviceId: 'mac-alice',
      capabilities: ['rpc'],
      leaseTtlMs: 200,
      heartbeatIntervalMs: 30,
      allowRpc: [{ exactPath: '/ping' }],
      fetch: async () => new Response('pong-1'),
      now: () => clock,
      onError: (err) => agent1Errors.push(`${err.code}:${err.retryable}`),
    });

    try {
      pair1.setConnected(true);
      await eventually(() => agent1.getState().status === 'online', 2_000);
      const hellosAfterFirst = pair1.clientEmitted.filter(
        (entry) => entry.event === 'stitchkit.relay.hello',
      ).length;
      expect(hellosAfterFirst).toBe(1);

      // 1. Lease expiry via sweepExpiredLeases(): hub rejects old heartbeat with retryable DEVICE_OFFLINE
      //    and agent1 automatically re-registers via hello back to online!
      clock += 500;
      await hub.sweepExpiredLeases();
      expect((await hub.getDevice('alice', 'mac-alice'))?.status).toBe('offline');

      const staleLeaseAck = await new Promise<Record<string, unknown>>((resolve) => {
        pair1.sendRawToHub(
          'stitchkit.relay.heartbeat',
          { schemaVersion: 1, deviceId: 'mac-alice', sentAtMs: clock },
          (reply) => resolve(reply as Record<string, unknown>),
        );
      });
      expect(staleLeaseAck).toMatchObject({
        outcome: 'error',
        code: 'DEVICE_OFFLINE',
        retryable: true,
      });

      await eventually(
        () =>
          pair1.clientEmitted.filter((entry) => entry.event === 'stitchkit.relay.hello')
            .length >= 2 && agent1.getState().status === 'online',
        3_000,
      );
      expect(agent1Errors).toContain('DEVICE_OFFLINE:true');
      expect((await hub.getDevice('alice', 'mac-alice'))?.status).toBe('online');
      const relayFetch = hub.createRelayFetch({ accountId: 'alice', deviceId: 'mac-alice' });
      expect(await (await relayFetch('/ping')).text()).toBe('pong-1');

      // 2. Socket takeover by pair2: hub tears down sock-1, rejects sock-1 heartbeat with retryable
      //    DEVICE_OFFLINE without corrupting sock-2, and agent1 re-registers via hello!
      const hellosBeforeTakeover = pair1.clientEmitted.filter(
        (entry) => entry.event === 'stitchkit.relay.hello',
      ).length;
      pair2.setConnected(true);
      const takeOverAck = await new Promise<Record<string, unknown>>((resolve) => {
        pair2.sendRawToHub(
          'stitchkit.relay.hello',
          { schemaVersion: 1, deviceId: 'mac-alice', capabilities: ['rpc'] },
          (reply) => resolve(reply as Record<string, unknown>),
        );
      });
      expect(takeOverAck).toMatchObject({ outcome: 'ok' });

      const replacedHbAck = await new Promise<Record<string, unknown>>((resolve) => {
        pair1.sendRawToHub(
          'stitchkit.relay.heartbeat',
          { schemaVersion: 1, deviceId: 'mac-alice', sentAtMs: clock },
          (reply) => resolve(reply as Record<string, unknown>),
        );
      });
      expect(replacedHbAck).toMatchObject({
        outcome: 'error',
        code: 'DEVICE_OFFLINE',
        retryable: true,
      });

      // sock-1's periodic heartbeat receives DEVICE_OFFLINE and re-registers via hello back to online.
      await eventually(
        () =>
          pair1.clientEmitted.filter((entry) => entry.event === 'stitchkit.relay.hello')
            .length > hellosBeforeTakeover && agent1.getState().status === 'online',
        3_000,
      );
      expect((await hub.getDevice('alice', 'mac-alice'))?.status).toBe('online');
    } finally {
      agent1.close();
      await hub.close();
    }
  });

  test('cleans up AbortSignal listeners on shared stream timeout, guards duplicate stream-open-ack and duplicate agent requestId/streamId, and catches rejecting async RelayBrokerPort without unhandled rejections', async () => {
    // 1. Shared stream open timeout detaches AbortSignal listener (zero leak) AND duplicate stream-open-ack does not kill a live stream.
    const pair = createSyncRealtimePair({ accountId: 'alice', deviceId: 'mac-alice' });
    const hub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      authenticateDevice: ({ identity }) => identity,
    });
    hub.attachConnection(pair.serverConnection);

    const liveStreamIds: string[] = [];
    pair.clientTransport.on('stitchkit.relay.stream-open', (raw: unknown) => {
      const open = raw as { streamId: string; topic: string };
      if (open.topic === 'dup-ack-live') {
        liveStreamIds.push(open.streamId);
        pair.sendRawToHub('stitchkit.relay.stream-open-ack', {
          schemaVersion: 1,
          streamId: open.streamId,
          outcome: 'ok',
        });
      }
      // 'never-acks' intentionally never replies so openTimeoutMs fires.
    });

    try {
      pair.setConnected(true);
      await new Promise<void>((resolve) => {
        pair.sendRawToHub(
          'stitchkit.relay.hello',
          { schemaVersion: 1, deviceId: 'mac-alice', capabilities: ['streams'] },
          () => resolve(),
        );
      });

      const sharedAbort = new AbortController();
      let addedAbortListeners = 0;
      let removedAbortListeners = 0;
      const origAdd = sharedAbort.signal.addEventListener.bind(sharedAbort.signal);
      const origRemove = sharedAbort.signal.removeEventListener.bind(sharedAbort.signal);
      sharedAbort.signal.addEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === 'abort') addedAbortListeners += 1;
        return origAdd(type, listener, options);
      };
      sharedAbort.signal.removeEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) => {
        if (type === 'abort') removedAbortListeners += 1;
        return origRemove(type, listener, options);
      };

      await expectRejectsMatch(
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-alice',
          topic: 'never-acks',
          share: true,
          openTimeoutMs: 25,
          signal: sharedAbort.signal,
        }),
        { code: 'TIMEOUT' },
      );
      expect(addedAbortListeners).toBeGreaterThan(0);
      expect(removedAbortListeners).toBe(addedAbortListeners);

      // Duplicate stream-open-ack(ok) on an already-open live stream MUST be ignored without closing the stream.
      const liveStream = await hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-alice',
        topic: 'dup-ack-live',
      });
      const liveId = liveStreamIds[0] ?? '';
      const closesBefore = pair.serverEmitted.filter(
        (e) =>
          e.event === 'stitchkit.relay.stream-close' &&
          (e.payload as { streamId?: string }).streamId === liveId,
      ).length;
      pair.sendRawToHub('stitchkit.relay.stream-open-ack', {
        schemaVersion: 1,
        streamId: liveId,
        outcome: 'ok',
      });
      const closesAfter = pair.serverEmitted.filter(
        (e) =>
          e.event === 'stitchkit.relay.stream-close' &&
          (e.payload as { streamId?: string }).streamId === liveId,
      ).length;
      expect(closesAfter).toBe(closesBefore);

      pair.sendRawToHub('stitchkit.relay.stream-event', {
        schemaVersion: 1,
        streamId: liveId,
        kind: 'data',
        cursor: '1',
        payload: { alive: true },
      });
      pair.sendRawToHub('stitchkit.relay.stream-event', {
        schemaVersion: 1,
        streamId: liveId,
        kind: 'end',
        cursor: '1',
      });
      const frames = [];
      for await (const frame of liveStream) frames.push(frame);
      expect(frames).toEqual([{ cursor: '1', payload: { alive: true } }]);
    } finally {
      await hub.close();
    }

    // 2. Agent ignores duplicate in-flight requestId and active streamId without overwriting live controllers.
    const dupPair = createSyncRealtimePair(
      { accountId: 'alice', deviceId: 'mac-dup' },
      's-dup',
    );
    let fetchCount = 0;
    let firstRpcAborted = false;
    let streamCount = 0;
    let firstStreamEntered = false;
    let firstStreamAborted = false;
    const dupAgent = createDeviceRelayAgent({
      transport: dupPair.clientTransport,
      deviceId: 'mac-dup',
      capabilities: ['rpc', 'streams'],
      allowRpc: [{ exactPath: '/slow' }],
      allowStreamTopics: ['live'],
      fetch: async (input) => {
        fetchCount += 1;
        const req = input instanceof Request ? input : new Request(input);
        await new Promise<void>((_, reject) => {
          req.signal.addEventListener(
            'abort',
            () => {
              firstRpcAborted = true;
              reject(req.signal.reason);
            },
            { once: true },
          );
        });
        return new Response('unreachable');
      },
      openStream: ({ signal }) => {
        streamCount += 1;
        return {
          async *[Symbol.asyncIterator]() {
            firstStreamEntered = true;
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                firstStreamAborted = true;
                resolve();
                return;
              }
              signal.addEventListener(
                'abort',
                () => {
                  firstStreamAborted = true;
                  resolve();
                },
                { once: true },
              );
            });
          },
        };
      },
    });
    try {
      dupPair.setConnected(true);
      const rpcFrame: DeviceRelayRpcRequest = {
        schemaVersion: 1,
        requestId: 'dup-rpc-1',
        method: 'GET',
        path: '/slow',
        headers: [],
      };
      dupPair.sendRawToAgent('stitchkit.relay.rpc-request', rpcFrame);
      dupPair.sendRawToAgent('stitchkit.relay.rpc-request', rpcFrame);
      expect(fetchCount).toBe(1);
      dupPair.sendRawToAgent('stitchkit.relay.rpc-cancel', {
        schemaVersion: 1,
        requestId: 'dup-rpc-1',
        reason: 'cancel-original',
      });
      await eventually(() => firstRpcAborted, 1_000);

      const streamFrame = {
        schemaVersion: 1 as const,
        streamId: 'dup-stream-1',
        topic: 'live',
        initialCredits: 4,
        maxFrameBytes: 4096,
      };
      dupPair.sendRawToAgent('stitchkit.relay.stream-open', streamFrame);
      await eventually(() => firstStreamEntered, 1_000);
      dupPair.sendRawToAgent('stitchkit.relay.stream-open', streamFrame);
      expect(streamCount).toBe(1);
      dupPair.sendRawToAgent('stitchkit.relay.stream-close', {
        schemaVersion: 1,
        streamId: 'dup-stream-1',
        reason: 'close-original',
      });
      await eventually(() => firstStreamAborted, 1_000);
    } finally {
      dupAgent.close();
    }

    // 3. Rejecting async RelayBrokerPort logs warnings and produces zero UnhandledPromiseRejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const warnings: string[] = [];
    const baseBroker = createMemoryRelayBroker();
    let failRegister = true;
    let clock = 10_000;
    const flakyBroker = {
      ...baseBroker,
      async registerDevice(record: Parameters<typeof baseBroker.registerDevice>[0]) {
        if (failRegister) throw new Error('register boom');
        await baseBroker.registerDevice(record);
      },
      async refreshDeviceLease() {
        throw new Error('refresh boom');
      },
      async markDeviceOffline() {
        throw new Error('offline boom');
      },
    };
    const brokerHub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      broker: flakyBroker,
      leaseTtlMs: 100,
      leaseSweepIntervalMs: 30,
      now: () => clock,
      authenticateDevice: ({ identity }) => identity,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (msg) => warnings.push(msg),
        error: () => undefined,
      },
    });
    const bPair = createSyncRealtimePair(
      { accountId: 'alice', deviceId: 'mac-flaky' },
      's-flaky',
    );
    brokerHub.attachConnection(bPair.serverConnection);
    try {
      bPair.setConnected(true);
      const failedHello = await new Promise<Record<string, unknown>>((resolve) => {
        bPair.sendRawToHub(
          'stitchkit.relay.hello',
          { schemaVersion: 1, deviceId: 'mac-flaky', capabilities: [] },
          (reply) => resolve(reply as Record<string, unknown>),
        );
      });
      expect(failedHello).toMatchObject({
        outcome: 'error',
        code: 'BROKER_UNAVAILABLE',
        retryable: true,
      });

      failRegister = false;
      const okHello = await new Promise<Record<string, unknown>>((resolve) => {
        bPair.sendRawToHub(
          'stitchkit.relay.hello',
          { schemaVersion: 1, deviceId: 'mac-flaky', capabilities: [] },
          (reply) => resolve(reply as Record<string, unknown>),
        );
      });
      expect(okHello).toMatchObject({ outcome: 'ok' });

      // Heartbeat with rejecting async refreshDeviceLease does not throw unhandled rejection.
      const hbReply = await new Promise<Record<string, unknown>>((resolve) => {
        bPair.sendRawToHub(
          'stitchkit.relay.heartbeat',
          { schemaVersion: 1, deviceId: 'mac-flaky', sentAtMs: clock },
          (reply) => resolve(reply as Record<string, unknown>),
        );
      });
      expect(hbReply).toMatchObject({ outcome: 'ok' });

      // Lease sweep + disconnect with rejecting async markDeviceOffline still complete cleanly.
      clock += 500;
      await eventually(
        () => warnings.some((line) => line.includes('markDeviceOffline failed')),
        2_000,
      );
      bPair.setConnected(false);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(warnings.some((line) => line.includes('registerDevice failed'))).toBe(true);
      expect(warnings.some((line) => line.includes('refreshDeviceLease failed'))).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      await brokerHub.close();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('rejects hub.openRelayStream immediately without hanging when openStream throws or pre-ack stream-event arrives, and frees stream capacity', async () => {
    const pair = createSyncRealtimePair({ accountId: 'alice', deviceId: 'mac-open-err' });
    const hub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      authenticateDevice: ({ identity }) => identity,
      maxConcurrentStreamsPerDevice: 1,
    });
    hub.attachConnection(pair.serverConnection);

    const agent = createDeviceRelayAgent({
      transport: pair.clientTransport,
      deviceId: 'mac-open-err',
      capabilities: ['streams'],
      maxConcurrentStreams: 1,
      allowStreamTopics: [
        'forbidden',
        'sync-boom',
        'async-boom',
        'bad-iter',
        'post-ack-err',
        'ok',
      ],
      openStream: async ({ topic }) => {
        if (topic === 'forbidden') {
          throw new DeviceRelayError('FORBIDDEN', 'denied');
        }
        if (topic === 'sync-boom') {
          throw new Error('boom');
        }
        if (topic === 'async-boom') {
          await Promise.resolve();
          throw new Error('async boom');
        }
        if (topic === 'bad-iter') {
          return {
            [Symbol.asyncIterator]() {
              throw new Error('iterator init failed');
            },
          };
        }
        if (topic === 'post-ack-err') {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  throw new DeviceRelayError('TRANSPORT_ERROR', 'mid-stream fail', {
                    retryable: true,
                  });
                },
              };
            },
          };
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield { cursor: '1', payload: { ok: true } };
          },
        };
      },
    });

    try {
      pair.setConnected(true);
      await eventually(() => agent.getState().status === 'online', 2_000);

      // 1. Throwing DeviceRelayError('FORBIDDEN', 'denied') inside openStream rejects immediately with the real error
      const t1 = performance.now();
      await expectRejectsMatch(
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-open-err',
          topic: 'forbidden',
          openTimeoutMs: 5_000,
        }),
        { code: 'FORBIDDEN', message: 'denied', retryable: false },
      );
      expect(performance.now() - t1).toBeLessThan(500);

      // 2. Throwing plain Error('boom') rejects immediately as STREAM_UNAVAILABLE without 5s hang
      const t2 = performance.now();
      await expectRejectsMatch(
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-open-err',
          topic: 'sync-boom',
          openTimeoutMs: 5_000,
        }),
        { code: 'STREAM_UNAVAILABLE', message: 'boom', retryable: false },
      );
      expect(performance.now() - t2).toBeLessThan(500);

      // 3. Async rejection inside openStream also settles immediately
      const t3 = performance.now();
      await expectRejectsMatch(
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-open-err',
          topic: 'async-boom',
          openTimeoutMs: 5_000,
        }),
        { code: 'STREAM_UNAVAILABLE', message: 'async boom', retryable: false },
      );
      expect(performance.now() - t3).toBeLessThan(500);

      // 4. Synchronous throw in [Symbol.asyncIterator]() occurs BEFORE ack and settles openRelayStream immediately
      const t4 = performance.now();
      await expectRejectsMatch(
        hub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-open-err',
          topic: 'bad-iter',
          openTimeoutMs: 5_000,
        }),
        { code: 'STREAM_UNAVAILABLE', message: 'iterator init failed', retryable: false },
      );
      expect(performance.now() - t4).toBeLessThan(500);

      // Negative control: none of the pre-ack failures emitted a stream-event
      expect(
        pair.clientEmitted.filter((entry) => entry.event === 'stitchkit.relay.stream-event'),
      ).toEqual([]);

      // 5. Capacity slot (cap=1 on both hub & agent) was freed: healthy stream opens and drains cleanly
      const healthy = await hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-open-err',
        topic: 'ok',
        openTimeoutMs: 5_000,
      });
      const frames = [];
      for await (const frame of healthy) frames.push(frame);
      expect(frames).toEqual([{ cursor: '1', payload: { ok: true } }]);

      // 6. Post-ack error still resolves openRelayStream and delivers stream-event(error) to consumer loop
      const postAckStream = await hub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-open-err',
        topic: 'post-ack-err',
        openTimeoutMs: 5_000,
      });
      await expectRejectsMatch(
        (async () => {
          for await (const _frame of postAckStream) {
            // drain
          }
        })(),
        { code: 'TRANSPORT_ERROR', message: 'mid-stream fail', retryable: true },
      );
    } finally {
      agent.close();
      await hub.close();
    }

    // 7. Defence-in-depth: raw pre-ack stream-event(error) and stream-event(end) settle openRelayStream immediately and free slot
    const rawPair = createSyncRealtimePair(
      { accountId: 'alice', deviceId: 'mac-raw-preack' },
      's-raw-preack',
    );
    const rawHub = createDeviceRelayHub<{ accountId: string; deviceId: string }>({
      authenticateDevice: ({ identity }) => identity,
      maxConcurrentStreamsPerDevice: 1,
    });
    rawHub.attachConnection(rawPair.serverConnection);
    try {
      rawPair.setConnected(true);
      await new Promise<void>((resolve) => {
        rawPair.sendRawToHub(
          'stitchkit.relay.hello',
          { schemaVersion: 1, deviceId: 'mac-raw-preack', capabilities: ['streams'] },
          () => resolve(),
        );
      });

      rawPair.clientTransport.on('stitchkit.relay.stream-open', (raw: unknown) => {
        const open = raw as { streamId: string; topic: string };
        if (open.topic === 'raw-pre-err') {
          rawPair.sendRawToHub('stitchkit.relay.stream-event', {
            schemaVersion: 1,
            streamId: open.streamId,
            kind: 'error',
            code: 'FORBIDDEN',
            message: 'raw pre-ack deny',
            retryable: false,
          });
          return;
        }
        if (open.topic === 'raw-pre-end') {
          rawPair.sendRawToHub('stitchkit.relay.stream-event', {
            schemaVersion: 1,
            streamId: open.streamId,
            kind: 'end',
          });
          return;
        }
        if (open.topic === 'raw-ok') {
          rawPair.sendRawToHub('stitchkit.relay.stream-open-ack', {
            schemaVersion: 1,
            streamId: open.streamId,
            outcome: 'ok',
          });
          rawPair.sendRawToHub('stitchkit.relay.stream-event', {
            schemaVersion: 1,
            streamId: open.streamId,
            kind: 'end',
          });
        }
      });

      const tErr = performance.now();
      await expectRejectsMatch(
        rawHub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-raw-preack',
          topic: 'raw-pre-err',
          openTimeoutMs: 5_000,
        }),
        { code: 'FORBIDDEN', message: 'raw pre-ack deny', retryable: false },
      );
      expect(performance.now() - tErr).toBeLessThan(500);

      const tEnd = performance.now();
      await expectRejectsMatch(
        rawHub.openRelayStream({
          accountId: 'alice',
          deviceId: 'mac-raw-preack',
          topic: 'raw-pre-end',
          openTimeoutMs: 5_000,
        }),
        { code: 'STREAM_UNAVAILABLE', retryable: false },
      );
      expect(performance.now() - tEnd).toBeLessThan(500);

      // Capacity slot (cap=1) freed after both pre-ack terminations
      const okStream = await rawHub.openRelayStream({
        accountId: 'alice',
        deviceId: 'mac-raw-preack',
        topic: 'raw-ok',
        openTimeoutMs: 5_000,
      });
      const drained = [];
      for await (const frame of okStream) drained.push(frame);
      expect(drained).toEqual([]);
    } finally {
      await rawHub.close();
    }
  });
});
