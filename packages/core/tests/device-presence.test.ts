import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createDeviceRelayAgent,
  createDeviceRelayHub,
  deviceRelayRealtimeContract,
} from '../src/entrypoints/device-relay';
import { createSocketIOClient } from '../src/entrypoints/index';
import {
  createDevicePresenceClient,
  createDevicePresenceContract,
  createDevicePresenceRelayAdapter,
  DevicePresenceRelayStateSchema,
  type DevicePresenceSnapshot,
} from '../src/entrypoints/realtime';
import {
  bindDevicePresence,
  bindRealtimeServer,
  createServer,
  createSocketIOServer,
} from '../src/entrypoints/server';
import { watchContract } from '../src/live/watch-contract';
import { eventually } from './support/agent-composition';

const MediaStateSchema = z.strictObject({
  trackId: z.string().min(1),
  title: z.string().min(1),
  playing: z.boolean(),
  positionSec: z.number().nonnegative(),
});

const MediaCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('play') }),
  z.strictObject({ action: z.literal('pause') }),
  z.strictObject({ action: z.literal('seek'), positionSec: z.number().nonnegative() }),
]);

const MediaResultSchema = z.strictObject({
  accepted: z.boolean(),
  playing: z.boolean(),
});

const ReadingStateSchema = z.strictObject({
  documentId: z.string().min(1),
  scrollOffset: z.number().nonnegative(),
});

const ReadingCommandSchema = z.strictObject({
  action: z.literal('handoff'),
  documentId: z.string().min(1),
});

const RelayCommandSchema = z.strictObject({
  action: z.literal('ping'),
});

const presenceContract = createDevicePresenceContract({
  media: { state: MediaStateSchema, command: MediaCommandSchema, result: MediaResultSchema },
  reading: { state: ReadingStateSchema, command: ReadingCommandSchema },
  relay: { state: DevicePresenceRelayStateSchema, command: RelayCommandSchema },
});

interface TestSocketIdentity {
  accountId: string | null;
  principalKind: 'user' | 'spaceKey';
  deviceId?: string;
}

async function startPresenceHarness(
  options: {
    contract?: typeof presenceContract;
    commandTimeoutMs?: number;
    maxDevicesPerAccount?: number;
    now?: () => number;
    onSnapshot?: (
      snapshot: DevicePresenceSnapshot<typeof presenceContract.capabilities>,
    ) => void;
    onRejected?: Parameters<typeof bindDevicePresence>[2]['onRejected'];
    logger?: Parameters<typeof bindDevicePresence>[2]['logger'];
    tokens?: Record<string, TestSocketIdentity>;
  } = {},
) {
  const tokenMap: Record<string, TestSocketIdentity> = {
    'alice-mac': { accountId: 'alice', principalKind: 'user', deviceId: 'mac-alice' },
    'alice-mac-2': { accountId: 'alice', principalKind: 'user', deviceId: 'mac-alice' },
    'alice-iphone': { accountId: 'alice', principalKind: 'user', deviceId: 'iphone-alice' },
    'bob-mac': { accountId: 'bob', principalKind: 'user', deviceId: 'mac-bob' },
    'space-key-token': { accountId: null, principalKind: 'spaceKey' },
    ...options.tokens,
  };

  const contract = options.contract ?? presenceContract;
  const socket = await createSocketIOServer({
    transports: ['websocket'],
    handshake: {
      schema: z.object({ token: z.string() }),
      verify: ({ token }): TestSocketIdentity | null => tokenMap[token] ?? null,
    },
  });

  const presence = bindDevicePresence(contract, socket, {
    accountOf: (identity) => (identity.principalKind === 'user' ? identity.accountId : null),
    ...(options.commandTimeoutMs !== undefined && {
      commandTimeoutMs: options.commandTimeoutMs,
    }),
    ...(options.maxDevicesPerAccount !== undefined && {
      maxDevicesPerAccount: options.maxDevicesPerAccount,
    }),
    ...(options.now !== undefined && { now: options.now }),
    ...(options.onSnapshot !== undefined && { onSnapshot: options.onSnapshot }),
    ...(options.onRejected !== undefined && { onRejected: options.onRejected }),
    ...(options.logger !== undefined && { logger: options.logger }),
  });

  // Also mount watchContract and DeviceRelayHub on the SAME RealtimeServerHandle to prove
  // zero wire collisions and single-socket composition.
  const watchServer = bindRealtimeServer(watchContract, socket);
  let watchOpens = 0;
  watchServer.onConnection((conn) => {
    conn.events.on('stitchkit.watch.open', (_frame, ack) => {
      watchOpens += 1;
      ack({ accepted: true });
    });
  });

  const relayHub = createDeviceRelayHub<TestSocketIdentity>({
    leaseTtlMs: 5_000,
    authenticateDevice: ({ identity, hello }) =>
      identity.principalKind === 'user' && identity.accountId
        ? { accountId: identity.accountId, deviceId: identity.deviceId ?? hello.deviceId }
        : null,
  });
  relayHub.bindRealtime(bindRealtimeServer(deviceRelayRealtimeContract, socket));

  const server = createServer({
    port: 0,
    hostname: '127.0.0.1',
    socket,
  });

  return {
    port: server.port,
    socket,
    presence,
    relayHub,
    tokenMap,
    getWatchOpens: () => watchOpens,
    async stop() {
      presence.unbind();
      await relayHub.close();
      await server.shutdown({ gracePeriodMs: 0 });
    },
  };
}

describe('account device presence, live capability states and remote command bus', () => {
  test('mounts on one shared RealtimeServerHandle alongside watchContract and DeviceRelayHub, syncs states and executes typed remote commands', async () => {
    const snapshots: Array<DevicePresenceSnapshot<typeof presenceContract.capabilities>> = [];
    const harness = await startPresenceHarness({
      now: () => Date.parse('2026-11-28T02:15:00.000Z'),
      onSnapshot: (snap) => snapshots.push(snap),
    });

    const macTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-mac' },
      transports: ['websocket'],
    });
    const iphoneTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-iphone' },
      transports: ['websocket'],
    });

    const macPresence = createDevicePresenceClient(presenceContract, {
      transport: macTransport,
      device: { deviceId: 'mac-alice', name: 'MacBook Pro', platform: 'macos' },
      capabilities: ['media', 'relay'],
      initialStates: {
        media: { trackId: 'trk-1', title: 'Midnight City', playing: true, positionSec: 42 },
      },
    });
    const iphonePresence = createDevicePresenceClient(presenceContract, {
      transport: iphoneTransport,
      device: { deviceId: 'iphone-alice', name: 'iPhone 17 Pro', platform: 'ios' },
      capabilities: ['media', 'reading'],
    });

    // Share the SAME Socket.IO connection on Mac with DeviceRelayAgent and connect via relay adapter.
    const relayAdapter = createDevicePresenceRelayAdapter({
      presence: macPresence,
      capability: 'relay',
      capabilities: ['rpc'],
    });
    const relayAgent = createDeviceRelayAgent({
      transport: macTransport,
      deviceId: 'mac-alice',
      capabilities: ['rpc'],
      leaseTtlMs: 5_000,
      allowRpc: [{ exactPath: '/ping' }],
      fetch: async () => new Response('pong'),
      onStateChange: (state) => {
        void relayAdapter.onStateChange(state);
      },
    });

    let macPauseCalls = 0;
    let lastFromDeviceId = '';
    const offMedia = macPresence.onCommand('media', (cmd, ctx) => {
      lastFromDeviceId = ctx.fromDeviceId;
      if (cmd.action === 'pause') {
        macPauseCalls += 1;
        return { accepted: true, playing: false };
      }
      return { accepted: true, playing: true };
    });

    const observedByIphone: number[] = [];
    const unsubIphone = iphonePresence.subscribe((devices) => {
      observedByIphone.push(devices.length);
    });

    try {
      macTransport.connect();
      iphoneTransport.connect();

      await eventually(
        () =>
          iphonePresence.getDevices().length === 2 &&
          macPresence.getDevices().length === 2 &&
          relayAgent.getState().status === 'online' &&
          iphonePresence.getDevices().find((d) => d.deviceId === 'mac-alice')?.states.relay
            ?.status === 'online',
        5_000,
      );

      // 1. iPhone sees Mac's initial media state + live relay status + deterministic connectedAt.
      const macSeenFromIphone = iphonePresence
        .getDevices()
        .find((d) => d.deviceId === 'mac-alice');
      expect(macSeenFromIphone).toMatchObject({
        deviceId: 'mac-alice',
        name: 'MacBook Pro',
        platform: 'macos',
        connectedAt: '2026-11-28T02:15:00.000Z',
        states: {
          media: { trackId: 'trk-1', title: 'Midnight City', playing: true, positionSec: 42 },
          relay: { status: 'online', deviceId: 'mac-alice', capabilities: ['rpc'] },
        },
      });
      expect(observedByIphone.at(-1)).toBe(2);
      expect(snapshots.length).toBeGreaterThan(0);

      // 2. Single-socket coexistence: DeviceRelay RPC still works on the very same Mac socket.
      const relayFetch = harness.relayHub.createRelayFetch({
        accountId: 'alice',
        deviceId: 'mac-alice',
      });
      expect(await (await relayFetch('/ping')).text()).toBe('pong');

      // 3. iPhone sends typed remote media command to Mac and gets typed ack.
      const pauseAck = await iphonePresence.sendCommand({
        targetDeviceId: 'mac-alice',
        capability: 'media',
        command: { action: 'pause' },
      });
      expect(pauseAck).toMatchObject({
        schemaVersion: 1,
        outcome: 'ok',
        result: { accepted: true, playing: false },
      });
      expect(macPauseCalls).toBe(1);
      expect(lastFromDeviceId).toBe('iphone-alice');

      // 4. Mac updates and then clears its media state; iPhone observes both updates immediately.
      const updateAck = await macPresence.publishState('media', {
        trackId: 'trk-1',
        title: 'Midnight City',
        playing: false,
        positionSec: 55,
      });
      expect(updateAck.outcome).toBe('ok');
      await eventually(
        () =>
          iphonePresence.getDevices().find((d) => d.deviceId === 'mac-alice')?.states.media
            ?.playing === false,
        3_000,
      );

      const clearAck = await macPresence.publishState('media', null);
      expect(clearAck.outcome).toBe('ok');
      await eventually(
        () =>
          iphonePresence.getDevices().find((d) => d.deviceId === 'mac-alice')?.states.media ===
          undefined,
        3_000,
      );

      // 5. Reconnect auto-re-announces and republishes retained local states (including reading slot).
      await iphonePresence.publishState('reading', {
        documentId: 'doc-42',
        scrollOffset: 120,
      });
      await eventually(
        () =>
          macPresence.getDevices().find((d) => d.deviceId === 'iphone-alice')?.states.reading
            ?.documentId === 'doc-42',
        3_000,
      );

      iphoneTransport.disconnect();
      await eventually(() => macPresence.getDevices().length === 1, 3_000);

      // While disconnected, local publishState retains state and returns honest DISCONNECTED.
      const offlinePublish = await iphonePresence.publishState('reading', {
        documentId: 'doc-99',
        scrollOffset: 300,
      });
      expect(offlinePublish).toMatchObject({ outcome: 'error', code: 'DISCONNECTED' });

      // On reconnect, iPhone automatically re-announces with doc-99!
      iphoneTransport.connect();
      await eventually(
        () =>
          macPresence.getDevices().find((d) => d.deviceId === 'iphone-alice')?.states.reading
            ?.documentId === 'doc-99',
        5_000,
      );

      // 6. Relay adapter clears relay slot on close.
      await relayAdapter.close();
      await eventually(
        () =>
          iphonePresence.getDevices().find((d) => d.deviceId === 'mac-alice')?.states.relay ===
          undefined,
        3_000,
      );
    } finally {
      offMedia();
      unsubIphone();
      relayAgent.close();
      macPresence.close();
      iphonePresence.close();
      macTransport.disconnect();
      iphoneTransport.disconnect();
      await harness.stop();
    }
  }, 15_000);

  test('enforces strict accountId isolation, refuses non-user principals without breaking other protocols, and never retries failing/timed-out commands', async () => {
    const harness = await startPresenceHarness({ commandTimeoutMs: 120 });
    const aliceTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-mac' },
      transports: ['websocket'],
    });
    const bobTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'bob-mac' },
      transports: ['websocket'],
    });
    const spaceKeyTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'space-key-token' },
      transports: ['websocket'],
    });

    const alicePresence = createDevicePresenceClient(presenceContract, {
      transport: aliceTransport,
      device: { deviceId: 'mac-alice', name: 'Alice Mac', platform: 'macos' },
    });
    const bobPresence = createDevicePresenceClient(presenceContract, {
      transport: bobTransport,
      device: { deviceId: 'mac-bob', name: 'Bob Mac', platform: 'macos' },
    });
    const spaceErrors: Error[] = [];
    const spacePresence = createDevicePresenceClient(presenceContract, {
      transport: spaceKeyTransport,
      device: { deviceId: 'guest-browser', name: 'Guest', platform: 'web' },
      onError: (err) => spaceErrors.push(err),
    });

    let aliceHandlerCalls = 0;
    alicePresence.onCommand('media', () => {
      aliceHandlerCalls += 1;
      return { accepted: true, playing: true };
    });

    let hangingCalls = 0;
    alicePresence.onCommand('reading', async () => {
      hangingCalls += 1;
      await new Promise(() => undefined);
      return undefined;
    });

    let aliceCallerTransport: ReturnType<typeof createSocketIOClient> | undefined;
    let aliceCallerPresence:
      | ReturnType<typeof createDevicePresenceClient<typeof presenceContract.capabilities>>
      | undefined;

    try {
      aliceTransport.connect();
      bobTransport.connect();
      spaceKeyTransport.connect();

      await eventually(
        () =>
          alicePresence.getDevices().length === 1 &&
          bobPresence.getDevices().length === 1 &&
          spaceErrors.length >= 1,
        5_000,
      );

      // 1. Bob never sees Alice's devices; Alice never sees Bob's devices.
      expect(bobPresence.getDevices().map((d) => d.deviceId)).toEqual(['mac-bob']);
      expect(alicePresence.getDevices().map((d) => d.deviceId)).toEqual(['mac-alice']);

      // 2. Bob attempting sendCommand to Alice's device gets FORBIDDEN and Alice's handler is NEVER invoked.
      const crossAccount = await bobPresence.sendCommand({
        targetDeviceId: 'mac-alice',
        capability: 'media',
        command: { action: 'pause' },
      });
      expect(crossAccount).toMatchObject({ outcome: 'error', code: 'FORBIDDEN' });
      expect(aliceHandlerCalls).toBe(0);

      // 3. Non-user spaceKey principal gets FORBIDDEN on presence, yet its socket stays alive for watchContract!
      expect(spacePresence.getDevices()).toEqual([]);
      const spaceCommand = await spacePresence.sendCommand({
        targetDeviceId: 'mac-alice',
        capability: 'media',
        command: { action: 'pause' },
      });
      expect(spaceCommand).toMatchObject({ outcome: 'error', code: 'FORBIDDEN' });
      expect(spaceKeyTransport.connected).toBe(true);
      const watchReply = await spaceKeyTransport.emitWithAck(
        'stitchkit.watch.open',
        [{ key: { service: 'items', action: 'list', digest: 'd1' }, args: {} }],
        { timeoutMs: 2_000 },
      );
      expect(watchReply).toEqual({ accepted: true });
      expect(harness.getWatchOpens()).toBe(1);

      // 4. Same-account command to missing device -> DEVICE_OFFLINE; unsupported capability -> UNSUPPORTED_CAPABILITY;
      //    timeout -> TIMEOUT with exactly 1 invocation (no side-effect auto-retry!).
      aliceCallerTransport = createSocketIOClient({
        url: `http://127.0.0.1:${harness.port}`,
        auth: { token: 'alice-iphone' },
        transports: ['websocket'],
      });
      aliceCallerPresence = createDevicePresenceClient(presenceContract, {
        transport: aliceCallerTransport,
        device: { deviceId: 'iphone-alice', name: 'Alice iPhone', platform: 'ios' },
      });
      aliceCallerTransport.connect();
      await eventually(() => aliceCallerPresence?.getDevices().length === 2, 5_000);

      expect(
        await aliceCallerPresence.sendCommand({
          targetDeviceId: 'missing-ipad',
          capability: 'media',
          command: { action: 'play' },
        }),
      ).toMatchObject({ outcome: 'error', code: 'DEVICE_OFFLINE' });

      expect(
        await aliceCallerPresence.sendCommand({
          targetDeviceId: 'mac-alice',
          capability: 'relay',
          command: { action: 'ping' },
        }),
      ).toMatchObject({ outcome: 'error', code: 'UNSUPPORTED_CAPABILITY' });

      const timedOut = await aliceCallerPresence.sendCommand({
        targetDeviceId: 'mac-alice',
        capability: 'reading',
        command: { action: 'handoff', documentId: 'doc-1' },
        timeoutMs: 80,
      });
      expect(timedOut).toMatchObject({ outcome: 'error', code: 'TIMEOUT' });
      expect(hangingCalls).toBe(1);
    } finally {
      alicePresence.close();
      bobPresence.close();
      spacePresence.close();
      aliceCallerPresence?.close();
      aliceTransport.disconnect();
      bobTransport.disconnect();
      spaceKeyTransport.disconnect();
      aliceCallerTransport?.disconnect();
      await harness.stop();
    }
  }, 15_000);

  test('survives reconnect-vs-stale-disconnect race for one deviceId, evicts on readmit and leaves zero memory leaks after all sockets close', async () => {
    const harness = await startPresenceHarness();
    const oldMacTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-mac' },
      transports: ['websocket'],
    });
    const newMacTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-mac-2' },
      transports: ['websocket'],
    });
    const iphoneTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-iphone' },
      transports: ['websocket'],
    });

    const oldMac = createDevicePresenceClient(presenceContract, {
      transport: oldMacTransport,
      device: { deviceId: 'mac-alice', name: 'Mac Old Socket', platform: 'macos' },
    });
    const newMac = createDevicePresenceClient(presenceContract, {
      transport: newMacTransport,
      device: { deviceId: 'mac-alice', name: 'Mac Fresh Socket', platform: 'macos' },
    });
    const iphone = createDevicePresenceClient(presenceContract, {
      transport: iphoneTransport,
      device: { deviceId: 'iphone-alice', name: 'Alice iPhone', platform: 'ios' },
    });

    let oldSocketCmds = 0;
    let newSocketCmds = 0;
    oldMac.onCommand('media', async () => {
      oldSocketCmds += 1;
      await new Promise(() => undefined);
      return { accepted: false, playing: false };
    });
    newMac.onCommand('media', () => {
      newSocketCmds += 1;
      return { accepted: true, playing: true };
    });

    try {
      oldMacTransport.connect();
      iphoneTransport.connect();
      await eventually(() => iphone.getDevices().length === 2, 5_000);

      // Start an in-flight command on the old socket before the fresh socket reconnects.
      const stuckCommand = iphone.sendCommand({
        targetDeviceId: 'mac-alice',
        capability: 'media',
        command: { action: 'play' },
        timeoutMs: 3_000,
      });
      await eventually(() => oldSocketCmds === 1, 3_000);

      // Fresh socket for the SAME deviceId connects & announces BEFORE old socket disconnects!
      newMacTransport.connect();
      await eventually(
        () =>
          iphone.getDevices().find((d) => d.deviceId === 'mac-alice')?.name ===
          'Mac Fresh Socket',
        5_000,
      );

      // Command stuck on the superseded socket fails immediately with DEVICE_OFFLINE.
      expect(await stuckCommand).toMatchObject({ outcome: 'error', code: 'DEVICE_OFFLINE' });

      // Stale socket's delayed disconnect MUST NOT wipe the fresh socket's device registration!
      oldMacTransport.disconnect();
      await eventually(() => harness.presence.snapshot().activeSockets === 2, 3_000);
      expect(harness.presence.listDevices('alice').map((d) => d.deviceId)).toEqual([
        'iphone-alice',
        'mac-alice',
      ]);
      expect(iphone.getDevices().find((d) => d.deviceId === 'mac-alice')?.name).toBe(
        'Mac Fresh Socket',
      );

      // New command routes cleanly to the fresh socket!
      const freshAck = await iphone.sendCommand({
        targetDeviceId: 'mac-alice',
        capability: 'media',
        command: { action: 'play' },
      });
      expect(freshAck).toMatchObject({
        outcome: 'ok',
        result: { accepted: true, playing: true },
      });
      expect(newSocketCmds).toBe(1);

      // Readmit revoking authorization evicts the device immediately from the account snapshot.
      const macSocket = [...harness.socket.io.sockets.sockets.values()].find(
        (s) => s.data.deviceId === 'mac-alice',
      );
      expect(macSocket).toBeDefined();
      if (macSocket) {
        macSocket.data.accountId = null;
        await harness.presence.readmit(macSocket.id);
      }
      await eventually(() => iphone.getDevices().length === 1, 3_000);
      expect(harness.presence.listDevices('alice').map((d) => d.deviceId)).toEqual([
        'iphone-alice',
      ]);

      // Disconnecting all sockets leaves zero memory leaks in internal maps.
      newMacTransport.disconnect();
      iphoneTransport.disconnect();
      await eventually(() => harness.presence.snapshot().activeSockets === 0, 3_000);
      expect(harness.presence.snapshot()).toEqual({
        accounts: {},
        activeSockets: 0,
        pendingCommands: 0,
      });
    } finally {
      oldMac.close();
      newMac.close();
      iphone.close();
      oldMacTransport.disconnect();
      newMacTransport.disconnect();
      iphoneTransport.disconnect();
      await harness.stop();
    }
  }, 15_000);

  test('every declared contract, server, client and relay-adapter option is load-bearing', async () => {
    const customContract = createDevicePresenceContract(
      {
        relay: { state: DevicePresenceRelayStateSchema, command: RelayCommandSchema },
      },
      { eventPrefix: 'custom.presence' },
    );
    expect(customContract.events.announce).toBe('custom.presence.announce');

    const rejected: string[] = [];
    const logs: string[] = [];
    const logger = {
      debug: (msg: string) => logs.push(msg),
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
    };

    const socket = await createSocketIOServer({
      transports: ['websocket'],
      handshake: {
        schema: z.object({ token: z.string() }),
        verify: ({ token }): TestSocketIdentity =>
          token === 't1'
            ? { accountId: 'acc', principalKind: 'user', deviceId: 'd1' }
            : { accountId: 'acc', principalKind: 'user', deviceId: 'd2' },
      },
    });
    const presence = bindDevicePresence(customContract, socket, {
      accountOf: (id) => id.accountId,
      commandTimeoutMs: 150,
      maxDevicesPerAccount: 1,
      now: () => Date.parse('2026-11-28T00:00:00.000Z'),
      onSnapshot: () => {
        throw new Error('observer boom');
      },
      onRejected: (ev) => {
        rejected.push(ev.event);
      },
      logger,
    });
    const server = createServer({
      port: 0,
      hostname: '127.0.0.1',
      socket,
    });

    const t1 = createSocketIOClient({
      url: `http://127.0.0.1:${server.port}`,
      auth: { token: 't1' },
      transports: ['websocket'],
    });
    const t2 = createSocketIOClient({
      url: `http://127.0.0.1:${server.port}`,
      auth: { token: 't2' },
      transports: ['websocket'],
    });
    const clientSnapshots: number[] = [];
    const clientErrors: Error[] = [];
    const c1 = createDevicePresenceClient(customContract, {
      transport: t1,
      device: { deviceId: 'd1', name: 'D1', platform: 'macos' },
      capabilities: ['relay'],
      requestTimeoutMs: 2_000,
      commandTimeoutMs: 120,
      onSnapshot: (snap) => clientSnapshots.push(snap.revision),
    });
    const c2 = createDevicePresenceClient(customContract, {
      transport: t2,
      device: { deviceId: 'd2', name: 'D2', platform: 'ios' },
      onError: (err) => clientErrors.push(err),
    });
    const adapter = createDevicePresenceRelayAdapter({
      presence: c1,
      capability: 'relay',
      capabilities: ['rpc', 'streams'],
      getState: () => ({ status: 'online', deviceId: 'd1', leaseExpiresAt: 9_999 }),
      clearOnClose: false,
    });

    try {
      t1.connect();
      await eventually(() => c1.getDevices().length === 1, 5_000);
      await adapter.sync();
      await eventually(
        () => c1.getDevices()[0]?.states.relay?.leaseExpiresAt === 9_999,
        3_000,
      );
      await adapter.close();
      // clearOnClose: false keeps the relay state intact after adapter.close().
      expect(c1.getDevices()[0]?.states.relay?.leaseExpiresAt).toBe(9_999);

      // maxDevicesPerAccount: 1 refuses a second distinct deviceId with INVALID_COMMAND -> onError.
      t2.connect();
      await eventually(() => clientErrors.length >= 1, 5_000);
      expect(clientErrors[0]?.message).toContain('maximum online devices');
      expect(clientSnapshots.length).toBeGreaterThan(0);
      expect(logs.some((line) => line.includes('onSnapshot threw'))).toBe(true);

      // Invalid wire frame triggers onRejected hook.
      t1.emit(customContract.events.announce, { bad: true });
      await eventually(() => rejected.includes(customContract.events.announce), 3_000);
    } finally {
      c1.close();
      c2.close();
      t1.disconnect();
      t2.disconnect();
      presence.unbind();
      await server.shutdown({ gracePeriodMs: 0 });
    }
  }, 15_000);

  test('enforces pendingCommands and command timeoutMs ceilings, isolates commandId across accounts, maintains O(1) device ownership and preserves monotonic revision across reconnect', async () => {
    const harness = await startPresenceHarness({
      tokens: {
        'alice-shared-laptop': {
          accountId: 'alice',
          principalKind: 'user',
          deviceId: 'shared-laptop',
        },
        'bob-shared-laptop': {
          accountId: 'bob',
          principalKind: 'user',
          deviceId: 'shared-laptop',
        },
        'bob-iphone': { accountId: 'bob', principalKind: 'user', deviceId: 'iphone-bob' },
        'carol-mac': { accountId: 'carol', principalKind: 'user', deviceId: 'mac-carol' },
      },
    });

    const aliceMacTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-shared-laptop' },
      transports: ['websocket'],
    });
    const alicePhoneTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-iphone' },
      transports: ['websocket'],
    });
    const bobMacTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'bob-shared-laptop' },
      transports: ['websocket'],
    });
    const bobPhoneTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'bob-iphone' },
      transports: ['websocket'],
    });
    const carolTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'carol-mac' },
      transports: ['websocket'],
    });

    const aliceMac = createDevicePresenceClient(presenceContract, {
      transport: aliceMacTransport,
      device: { deviceId: 'shared-laptop', name: 'Alice Laptop', platform: 'macos' },
    });
    const alicePhone = createDevicePresenceClient(presenceContract, {
      transport: alicePhoneTransport,
      device: { deviceId: 'iphone-alice', name: 'Alice iPhone', platform: 'ios' },
    });
    const bobMac = createDevicePresenceClient(presenceContract, {
      transport: bobMacTransport,
      device: { deviceId: 'shared-laptop', name: 'Bob Laptop', platform: 'macos' },
    });
    const bobPhone = createDevicePresenceClient(presenceContract, {
      transport: bobPhoneTransport,
      device: { deviceId: 'iphone-bob', name: 'Bob iPhone', platform: 'ios' },
    });
    const carolMac = createDevicePresenceClient(presenceContract, {
      transport: carolTransport,
      device: { deviceId: 'mac-carol', name: 'Carol Mac', platform: 'macos' },
    });

    const releaseAliceMedia = Promise.withResolvers<void>();
    const releaseBobMedia = Promise.withResolvers<void>();
    let aliceMediaCalls = 0;
    let bobMediaCalls = 0;
    aliceMac.onCommand('media', async () => {
      aliceMediaCalls += 1;
      await releaseAliceMedia.promise;
      return { accepted: true, playing: true };
    });
    bobMac.onCommand('media', async () => {
      bobMediaCalls += 1;
      await releaseBobMedia.promise;
      return { accepted: true, playing: false };
    });
    aliceMac.onCommand('reading', async () => {
      await new Promise(() => undefined);
      return undefined;
    });

    try {
      aliceMacTransport.connect();
      alicePhoneTransport.connect();
      bobMacTransport.connect();
      bobPhoneTransport.connect();
      carolTransport.connect();
      await eventually(
        () =>
          alicePhone.getDevices().length === 2 &&
          bobPhone.getDevices().length === 2 &&
          carolMac.getDevices().length === 1,
        5_000,
      );

      // 1. Server-side command timeoutMs ceiling (> 60 000ms) is refused with INVALID_COMMAND without invoking target handler.
      const overCeiling = await alicePhone.sendCommand({
        targetDeviceId: 'shared-laptop',
        capability: 'media',
        command: { action: 'play' },
        timeoutMs: 60_001,
      });
      expect(overCeiling).toMatchObject({ outcome: 'error', code: 'INVALID_COMMAND' });
      expect(aliceMediaCalls).toBe(0);

      // 2. Cross-account commandId isolation: Alice and Bob can simultaneously use the exact same commandId!
      const sharedCommandId = 'same-cmd-id-across-tenants';
      const aliceCmdPromise = alicePhoneTransport.emitWithAck(
        presenceContract.events.sendCommand,
        [
          {
            schemaVersion: 1,
            commandId: sharedCommandId,
            targetDeviceId: 'shared-laptop',
            capability: 'media',
            command: { action: 'play' },
            timeoutMs: 3_000,
          },
        ],
        { timeoutMs: 4_000 },
      );
      const bobCmdPromise = bobPhoneTransport.emitWithAck(
        presenceContract.events.sendCommand,
        [
          {
            schemaVersion: 1,
            commandId: sharedCommandId,
            targetDeviceId: 'shared-laptop',
            capability: 'media',
            command: { action: 'pause' },
            timeoutMs: 3_000,
          },
        ],
        { timeoutMs: 4_000 },
      );
      await eventually(() => aliceMediaCalls === 1 && bobMediaCalls === 1, 3_000);
      // Duplicate commandId within the SAME account is still refused.
      const sameAccountDup = await alicePhoneTransport.emitWithAck(
        presenceContract.events.sendCommand,
        [
          {
            schemaVersion: 1,
            commandId: sharedCommandId,
            targetDeviceId: 'shared-laptop',
            capability: 'media',
            command: { action: 'play' },
            timeoutMs: 3_000,
          },
        ],
        { timeoutMs: 2_000 },
      );
      expect(sameAccountDup).toMatchObject({ outcome: 'error', code: 'INVALID_COMMAND' });

      // Release Bob first -> settles ONLY Bob's command; Alice stays independent and succeeds when released!
      releaseBobMedia.resolve();
      expect(await bobCmdPromise).toMatchObject({
        commandId: sharedCommandId,
        outcome: 'ok',
        result: { accepted: true, playing: false },
      });
      releaseAliceMedia.resolve();
      expect(await aliceCmdPromise).toMatchObject({
        commandId: sharedCommandId,
        outcome: 'ok',
        result: { accepted: true, playing: true },
      });

      // 3. Per-account pendingCommands cap (64) refuses the 65th concurrent command without blocking Bob!
      const pendingBatch: Array<Promise<unknown>> = [];
      for (let i = 0; i < 64; i += 1) {
        pendingBatch.push(
          alicePhone.sendCommand({
            targetDeviceId: 'shared-laptop',
            capability: 'reading',
            command: { action: 'handoff', documentId: `doc-${i}` },
            timeoutMs: 3_000,
          }),
        );
      }
      await eventually(() => harness.presence.snapshot().pendingCommands === 64, 3_000);
      const overflowAck = await alicePhone.sendCommand({
        targetDeviceId: 'shared-laptop',
        capability: 'reading',
        command: { action: 'handoff', documentId: 'doc-overflow' },
        timeoutMs: 3_000,
      });
      expect(overflowAck).toMatchObject({ outcome: 'error', code: 'INVALID_COMMAND' });
      // Bob is NOT starved by Alice's per-account cap!
      const bobStillWorks = await bobPhone.sendCommand({
        targetDeviceId: 'shared-laptop',
        capability: 'media',
        command: { action: 'play' },
      });
      expect(bobStillWorks).toMatchObject({ outcome: 'ok' });

      // 4. O(1) device-owner index handles shared deviceId across Alice + Bob accurately for Carol.
      expect(
        await carolMac.sendCommand({
          targetDeviceId: 'shared-laptop',
          capability: 'media',
          command: { action: 'play' },
        }),
      ).toMatchObject({ outcome: 'error', code: 'FORBIDDEN' });

      // Disconnect Bob's laptop -> Alice still owns 'shared-laptop', so Carol STILL gets FORBIDDEN!
      bobMacTransport.disconnect();
      await eventually(() => harness.presence.listDevices('bob').length === 1, 3_000);
      expect(
        await carolMac.sendCommand({
          targetDeviceId: 'shared-laptop',
          capability: 'media',
          command: { action: 'play' },
        }),
      ).toMatchObject({ outcome: 'error', code: 'FORBIDDEN' });

      // Disconnect Alice's laptop & phone -> all pending commands fail cleanly, account becomes empty,
      // AND Carol now sees DEVICE_OFFLINE!
      const revisionBeforeDisconnect = harness.presence.getAccountSnapshot('alice').revision;
      expect(revisionBeforeDisconnect).toBeGreaterThanOrEqual(2);
      aliceMacTransport.disconnect();
      alicePhoneTransport.disconnect();
      await Promise.all(pendingBatch);
      await eventually(
        () =>
          harness.presence.listDevices('alice').length === 0 &&
          harness.presence.snapshot().pendingCommands === 0,
        3_000,
      );
      expect(harness.presence.snapshot().accounts.alice).toBeUndefined();
      expect(
        await carolMac.sendCommand({
          targetDeviceId: 'shared-laptop',
          capability: 'media',
          command: { action: 'play' },
        }),
      ).toMatchObject({ outcome: 'error', code: 'DEVICE_OFFLINE' });

      // 5. Empty-account reconnect preserves monotonic revision (never resets back to 1!).
      aliceMacTransport.connect();
      await eventually(() => harness.presence.listDevices('alice').length === 1, 5_000);
      const revisionAfterReconnect = harness.presence.getAccountSnapshot('alice').revision;
      expect(revisionAfterReconnect).toBeGreaterThan(revisionBeforeDisconnect);

      // 6. Relay adapter constructor catches rejecting initial publishState without unhandled rejection.
      const rejectingAdapter = createDevicePresenceRelayAdapter({
        presence: {
          publishState: () => Promise.reject(new Error('initial publish boom')),
        },
        capability: 'relay',
        capabilities: ['rpc'],
        getState: () => ({ status: 'online', deviceId: 'shared-laptop' }),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejectingAdapter).toBeDefined();
    } finally {
      aliceMac.close();
      alicePhone.close();
      bobMac.close();
      bobPhone.close();
      carolMac.close();
      aliceMacTransport.disconnect();
      alicePhoneTransport.disconnect();
      bobMacTransport.disconnect();
      bobPhoneTransport.disconnect();
      carolTransport.disconnect();
      await harness.stop();
    }
  }, 15_000);

  test('unbind() fails in-flight commands with raw commandId (not scoped key) and clears all registry state', async () => {
    const harness = await startPresenceHarness();
    const macTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-mac' },
      transports: ['websocket'],
    });
    const iphoneTransport = createSocketIOClient({
      url: `http://127.0.0.1:${harness.port}`,
      auth: { token: 'alice-iphone' },
      transports: ['websocket'],
    });
    const mac = createDevicePresenceClient(presenceContract, {
      transport: macTransport,
      device: { deviceId: 'mac-alice', name: 'Alice Mac', platform: 'macos' },
    });
    const iphone = createDevicePresenceClient(presenceContract, {
      transport: iphoneTransport,
      device: { deviceId: 'iphone-alice', name: 'Alice iPhone', platform: 'ios' },
    });

    let delivered = false;
    mac.onCommand('reading', async () => {
      delivered = true;
      await new Promise(() => undefined);
      return undefined;
    });

    try {
      macTransport.connect();
      iphoneTransport.connect();
      await eventually(() => iphone.getDevices().length === 2, 5_000);

      const rawCommandId = 'cmd-unbind-plain-id';
      const inFlight = iphoneTransport.emitWithAck(
        presenceContract.events.sendCommand,
        [
          {
            schemaVersion: 1,
            commandId: rawCommandId,
            targetDeviceId: 'mac-alice',
            capability: 'reading',
            command: { action: 'handoff', documentId: 'doc-unbind' },
            timeoutMs: 5_000,
          },
        ],
        { timeoutMs: 6_000 },
      );
      await eventually(
        () => delivered && harness.presence.snapshot().pendingCommands === 1,
        3_000,
      );

      harness.presence.unbind();
      const settled = await inFlight;
      expect(settled).toMatchObject({
        schemaVersion: 1,
        commandId: rawCommandId,
        outcome: 'error',
        code: 'DEVICE_OFFLINE',
      });
      expect(harness.presence.snapshot()).toEqual({
        accounts: {},
        activeSockets: 0,
        pendingCommands: 0,
      });
    } finally {
      mac.close();
      iphone.close();
      macTransport.disconnect();
      iphoneTransport.disconnect();
      await harness.stop();
    }
  }, 15_000);
});
