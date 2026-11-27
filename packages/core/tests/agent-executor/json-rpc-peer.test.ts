/** JSON-RPC peer error handling, idempotent close, and timeout validation. */
import { describe, expect, test } from 'bun:test';
import {
  createJsonRpcPeer,
  JSON_RPC_LOCAL_TIMEOUT,
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcError,
  type JsonRpcPeer,
} from '../../src/entrypoints/agent-executor';
import { MAX_TIMER_MS } from '../../src/internal/timers';

function makePeer(config: Record<string, unknown>): JsonRpcPeer {
  return Reflect.apply(createJsonRpcPeer, undefined, [config]);
}

async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe('json-rpc-peer', () => {
  test('non-JSON onRequest return values answer with -32603 for matching id without unhandled rejections', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const writes: string[] = [];
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const peer = makePeer({
        header: 'jsonrpc-2.0',
        requestTimeoutMs: 500,
        send: (line: string) => {
          writes.push(line);
        },
        onRequest: (method: string) => {
          switch (method) {
            case 'bigint':
              return { bad: 1n };
            case 'circular':
              return circular;
            case 'undef-async':
              return Promise.resolve(undefined);
            case 'undef-sync':
              return undefined;
            case 'function':
              return { bad: () => undefined };
            case 'valid-null':
              return Promise.resolve(null);
            default:
              return { ok: true };
          }
        },
      });

      const cases = [
        { id: 'id-bigint', method: 'bigint' },
        { id: 'id-circular', method: 'circular' },
        { id: 'id-undef-async', method: 'undef-async' },
        { id: 'id-undef-sync', method: 'undef-sync' },
        { id: 'id-fn', method: 'function' },
        { id: 'id-null', method: 'valid-null' },
      ];
      for (const entry of cases) {
        peer.receive(JSON.stringify({ jsonrpc: '2.0', id: entry.id, method: entry.method }));
      }
      await flushMicrotasks();

      const responses = writes.map((line) => JSON.parse(line));
      for (const badId of [
        'id-bigint',
        'id-circular',
        'id-undef-async',
        'id-undef-sync',
        'id-fn',
      ]) {
        const match = responses.find((msg) => msg.id === badId);
        expect(match).toMatchObject({
          jsonrpc: '2.0',
          id: badId,
          error: { code: -32603 },
        });
        expect(match?.result).toBeUndefined();
      }
      expect(responses.find((msg) => msg.id === 'id-null')).toEqual({
        jsonrpc: '2.0',
        id: 'id-null',
        result: null,
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('non-JSON JsonRpcError.data answers with -32603 for matching id while valid JSON data preserves code', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const writes: string[] = [];
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const peer = createJsonRpcPeer({
        header: 'jsonrpc-2.0',
        requestTimeoutMs: 500,
        send: (line) => {
          writes.push(line);
        },
        onRequest(method) {
          if (method === 'bad-fn-data') {
            throw new JsonRpcError(-32001, 'custom', { bad: () => undefined });
          }
          if (method === 'bad-bigint-data') {
            throw new JsonRpcError(-32001, 'custom', { bad: 1n });
          }
          if (method === 'bad-circular-data') {
            throw new JsonRpcError(-32001, 'custom', circular);
          }
          throw new JsonRpcError(-32002, 'valid custom', { detail: 'kept' });
        },
      });

      peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 'e-fn', method: 'bad-fn-data' }));
      peer.receive(
        JSON.stringify({ jsonrpc: '2.0', id: 'e-bigint', method: 'bad-bigint-data' }),
      );
      peer.receive(
        JSON.stringify({ jsonrpc: '2.0', id: 'e-circular', method: 'bad-circular-data' }),
      );
      peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 'e-valid', method: 'valid-data' }));
      await flushMicrotasks();

      const responses = writes.map((line) => JSON.parse(line));
      for (const badId of ['e-fn', 'e-bigint', 'e-circular']) {
        const match = responses.find((msg) => msg.id === badId);
        expect(match).toMatchObject({
          jsonrpc: '2.0',
          id: badId,
          error: { code: -32603 },
        });
        expect(match?.error?.data).toBeUndefined();
      }
      expect(responses.find((msg) => msg.id === 'e-valid')).toEqual({
        jsonrpc: '2.0',
        id: 'e-valid',
        error: { code: -32002, message: 'valid custom', data: { detail: 'kept' } },
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('transport send errors while answering incoming requests do not recurse or emit unhandled rejections', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let sendCalls = 0;
      const peer = makePeer({
        header: 'jsonrpc-2.0',
        requestTimeoutMs: 500,
        send() {
          sendCalls += 1;
          throw new Error('EPIPE');
        },
        onRequest: (method: string) =>
          method === 'bad' ? { bad: 1n } : Promise.resolve({ ok: true }),
      });

      peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 'tx-1', method: 'ping' }));
      peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 'tx-2', method: 'bad' }));
      await flushMicrotasks();

      expect(sendCalls).toBe(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('close is idempotent and preserves the first reason, including undefined', async () => {
    const peer1 = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 500,
      send: () => undefined,
    });
    const err1 = new Error('first-close');
    const err2 = new Error('second-close');
    const pending1 = peer1.request('op');
    peer1.close(err1);
    peer1.close(err2);
    await expect(pending1).rejects.toBe(err1);
    await expect(peer1.request('after')).rejects.toBe(err1);

    const peer2 = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 500,
      send: () => undefined,
    });
    const pending2 = peer2.request('op');
    peer2.close(undefined);
    peer2.close(err2);
    await expect(pending2).rejects.toBeUndefined();
    await expect(peer2.request('after')).rejects.toBeUndefined();
  });

  test('dispatches server requests in wire order before a following resolution or turn end', async () => {
    const seen: string[] = [];
    const writes: string[] = [];
    const reply = Promise.withResolvers<string>();
    const peer = createJsonRpcPeer({
      header: 'omitted',
      requestTimeoutMs: 500,
      send: (line) => {
        writes.push(line);
      },
      onRequest(method) {
        seen.push(method);
        return reply.promise;
      },
      onNotification(method) {
        seen.push(method);
      },
    });
    peer.receive(JSON.stringify({ id: 7, method: 'approval' }));
    peer.receive(JSON.stringify({ method: 'serverRequest/resolved' }));
    peer.receive(JSON.stringify({ method: 'turn/completed' }));
    expect(seen).toEqual(['approval', 'serverRequest/resolved', 'turn/completed']);
    expect(writes).toEqual([]);
    reply.resolve('approved');
    await flushMicrotasks();
    expect(writes.map((line) => JSON.parse(line))).toEqual([{ id: 7, result: 'approved' }]);
    peer.close();
  });

  test('receive and notify are ignored after close', async () => {
    const writes: string[] = [];
    let requests = 0;
    let notifications = 0;
    const peer = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 500,
      send: (line) => {
        writes.push(line);
      },
      onRequest: () => {
        requests += 1;
        return { ok: true };
      },
      onNotification: () => {
        notifications += 1;
      },
    });

    peer.close(new Error('done'));
    peer.notify('late/note', { x: 1 });
    peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 'late-1', method: 'late/req' }));
    peer.receive(JSON.stringify({ jsonrpc: '2.0', method: 'late/note' }));
    expect(() => peer.receive('not-valid-json')).not.toThrow();
    await flushMicrotasks();

    expect(writes).toEqual([]);
    expect(requests).toBe(0);
    expect(notifications).toBe(0);
  });

  test('invalid timeouts throw or reject before send (a missing one TypeError, one out of range RangeError), timeoutMs null is preserved, and real timeout fires -32099', async () => {
    const invalidTimeouts = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_TIMER_MS + 1,
    ];
    for (const bad of invalidTimeouts) {
      expect(() =>
        createJsonRpcPeer({
          header: 'jsonrpc-2.0',
          requestTimeoutMs: bad,
          send: () => undefined,
        }),
      ).toThrow(RangeError);
    }
    expect(() =>
      makePeer({
        header: 'jsonrpc-2.0',
        requestTimeoutMs: undefined,
        send: () => undefined,
      }),
    ).toThrow(TypeError);

    const writes: string[] = [];
    const peer = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 25,
      send: (line) => {
        writes.push(line);
      },
    });
    for (const bad of invalidTimeouts) {
      await expect(peer.request('op', {}, { timeoutMs: bad })).rejects.toThrow(RangeError);
    }
    expect(writes).toEqual([]);

    // Boundary valid MAX_TIMER_MS is accepted without throwing.
    const maxCall = peer.request('max', {}, { timeoutMs: MAX_TIMER_MS });
    expect(writes).toHaveLength(1);
    const maxReq = JSON.parse(writes[0] ?? '{}');
    peer.receive(JSON.stringify({ jsonrpc: '2.0', id: maxReq.id, result: { ok: true } }));
    expect(await maxCall).toEqual({ ok: true });

    // timeoutMs: null disables timeout and survives past requestTimeoutMs (25ms).
    const noTimeout = peer.request('long', {}, { timeoutMs: null });
    await Bun.sleep(45);
    const longReq = JSON.parse(writes[1] ?? '{}');
    peer.receive(JSON.stringify({ jsonrpc: '2.0', id: longReq.id, result: { waited: true } }));
    expect(await noTimeout).toEqual({ waited: true });

    // Real timeout rejects with JsonRpcError carrying exported JSON_RPC_LOCAL_TIMEOUT (-32099).
    expect(JSON_RPC_LOCAL_TIMEOUT).toBe(-32099);
    await expect(peer.request('slow', {}, { timeoutMs: 15 })).rejects.toMatchObject({
      name: 'JsonRpcError',
      code: JSON_RPC_LOCAL_TIMEOUT,
    });
    // Omitting per-call timeoutMs uses JsonRpcPeerConfig.requestTimeoutMs (25 ms).
    await expect(peer.request('slow-default')).rejects.toMatchObject({
      name: 'JsonRpcError',
      code: JSON_RPC_LOCAL_TIMEOUT,
      message: expect.stringContaining('25 ms'),
    });

    peer.close(new Error('cleanup'));
  });

  test('header omitted omits jsonrpc on outgoing requests, notifications, and responses while accepting headerless replies', async () => {
    const writes: string[] = [];
    const notifications: Array<{ method: string; params: unknown }> = [];
    const peer = createJsonRpcPeer({
      header: 'omitted',
      requestTimeoutMs: 500,
      send: (line) => {
        writes.push(line);
      },
      onRequest(method) {
        if (method === 'fail') throw new JsonRpcError(-32010, 'denied');
        return { accepted: true };
      },
      onNotification(method, params) {
        notifications.push({ method, params });
      },
    });

    const pending = peer.request('thread/start', { cwd: '/tmp' });
    peer.notify('initialized', { ready: true });
    peer.receive(JSON.stringify({ id: 'srv-ok', method: 'approve', params: {} }));
    peer.receive(JSON.stringify({ id: 'srv-err', method: 'fail', params: {} }));
    peer.receive(JSON.stringify({ method: 'turn/started', params: { turnId: 't1' } }));
    await flushMicrotasks();

    const parsed = writes.map((line) => JSON.parse(line));
    expect(parsed).toHaveLength(4);
    for (const msg of parsed) {
      expect('jsonrpc' in msg).toBe(false);
    }
    const req = parsed[0];
    expect(req).toMatchObject({ method: 'thread/start', params: { cwd: '/tmp' } });
    expect(parsed[1]).toEqual({ method: 'initialized', params: { ready: true } });
    expect(parsed[2]).toEqual({ id: 'srv-ok', result: { accepted: true } });
    expect(parsed[3]).toEqual({ id: 'srv-err', error: { code: -32010, message: 'denied' } });
    expect(notifications).toEqual([{ method: 'turn/started', params: { turnId: 't1' } }]);

    peer.receive(JSON.stringify({ id: req?.id, result: { threadId: 'th-1' } }));
    expect(await pending).toEqual({ threadId: 'th-1' });
    peer.close(new Error('cleanup'));
  });

  test('a request with timeoutMs null outlives the peer requestTimeoutMs', async () => {
    const writes: string[] = [];
    const peer = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 25,
      send: (line) => writes.push(line),
      onRequest: async () => ({ ok: true }),
    });
    const longCall = peer.request('session/prompt', { x: 1 }, { timeoutMs: null });
    await Bun.sleep(45);
    const request = JSON.parse(writes[0] ?? '{}');
    peer.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { done: true } }));
    expect(await longCall).toEqual({ done: true });
    peer.close(new Error('cleanup'));
  });

  test('a send that throws synchronously rejects its request with that error', async () => {
    const peer = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 25,
      send() {
        throw new Error('broken pipe');
      },
      onRequest: async () => ({ ok: true }),
    });
    await expect(peer.request('boom', {})).rejects.toThrow('broken pipe');
    peer.close(new Error('cleanup'));
  });

  test('an incoming request that settles after close() writes nothing', async () => {
    const writes: string[] = [];
    const peer = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 25,
      send: (line) => writes.push(line),
      async onRequest() {
        await Bun.sleep(10);
        return { ok: true };
      },
    });
    peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'ping', params: {} }));
    peer.close(new Error('closed'));
    await Bun.sleep(25);
    expect(writes).toEqual([]);
  });

  test('a peer without onRequest answers an incoming request -32601 at once', () => {
    const writes: string[] = [];
    const peer = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 25,
      send: (line) => writes.push(line),
    });
    peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'ping', params: {} }));
    // Synchronously, before any microtask: nothing is left for the other side to wait on.
    expect(writes.map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: '2.0',
        id: 'srv-1',
        error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'ping is not handled' },
      },
    ]);
    peer.close(new Error('done'));
  });

  test('request accepts per-call AbortSignal without closing the peer and cleans up listeners', async () => {
    const writes: string[] = [];
    const peer = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 5_000,
      send: (line) => writes.push(line),
    });

    // 1. Pre-aborted signal rejects before writing anything to the wire.
    const preAborted = new AbortController();
    const preReason = new Error('pre-aborted');
    preAborted.abort(preReason);
    await expect(
      peer.request('never/sent', { x: 1 }, { signal: preAborted.signal }),
    ).rejects.toBe(preReason);
    expect(writes).toEqual([]);

    // 2. Mid-flight abort rejects only that call, keeps the peer usable, and ignores a late reply.
    const controller = new AbortController();
    const midReason = new Error('mid-flight-abort');
    const abortedCall = peer.request('slow/op', { a: 1 }, { signal: controller.signal });
    const siblingCall = peer.request('sibling/op', { b: 2 });
    expect(writes).toHaveLength(2);
    const abortedReq = JSON.parse(writes[0] ?? '{}');
    const siblingReq = JSON.parse(writes[1] ?? '{}');

    controller.abort(midReason);
    await expect(abortedCall).rejects.toBe(midReason);

    // Late reply for the aborted id is silently ignored and does not affect siblingCall.
    peer.receive(
      JSON.stringify({ jsonrpc: '2.0', id: abortedReq.id, result: { late: true } }),
    );
    peer.receive(
      JSON.stringify({ jsonrpc: '2.0', id: siblingReq.id, result: { alive: true } }),
    );
    expect(await siblingCall).toEqual({ alive: true });

    // 3. After normal resolution, aborting the caller signal later has no effect (listener removed).
    const doneController = new AbortController();
    let listeners = 0;
    const origAdd = doneController.signal.addEventListener.bind(doneController.signal);
    const origRemove = doneController.signal.removeEventListener.bind(doneController.signal);
    doneController.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
      listeners += 1;
      return origAdd(...args);
    }) as typeof origAdd;
    doneController.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
      listeners -= 1;
      return origRemove(...args);
    }) as typeof origRemove;
    const okCall = peer.request('fast/op', {}, { signal: doneController.signal });
    const okReq = JSON.parse(writes[2] ?? '{}');
    peer.receive(JSON.stringify({ jsonrpc: '2.0', id: okReq.id, result: { ok: 1 } }));
    expect(await okCall).toEqual({ ok: 1 });
    expect(listeners).toBe(0);
    doneController.abort(new Error('late-abort'));

    peer.close(new Error('cleanup'));
  });
});
