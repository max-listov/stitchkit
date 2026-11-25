/**
 * Bridge tests (`serveBridge` + `createBridgeFetch`) over a string-only
 * `MessageChannel` port, covering correlation, limits, cancellation, host
 * restart (`hello` & lost initial `hello`), origin/secret trust, authenticated
 * `abort`, deterministic replay suppression, binary refusal, `close()` races,
 * oversized `AbortSignal.reason`, repeated `Set-Cookie`, `204 No Content`,
 * UTF-8 fidelity under `whatwg-fetch@3.6.20`, and the Expo DOM `invoke` adapter.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';
import { classifyBridgeTransportRetry } from '../src/browser/bridge-errors';
import { defineContract } from '../src/entrypoints/contract';
import {
  type BridgeHostPort,
  badRequest,
  createHandler,
  implement,
  serveBridge,
} from '../src/entrypoints/handler';
import {
  ApiError,
  BRIDGE_ORIGIN,
  type BridgeClientPort,
  BridgeFailureError,
  createBridgeFetch,
  createClient,
  createHttpClient,
} from '../src/entrypoints/http';
import { parseBody } from '../src/server/raw';
import { bundleBrowserIife, CORE_SRC, createRnRealm, ZOD_ENTRY } from './rn-realm/rn-realm';

const ALLOWED_ORIGIN = 'https://window.app.local';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Allow queued `MessageChannel` frames (such as an initial `hello`) to drain. */
const flushPort = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Pair of string-only bridge ports backed by a real `MessageChannel`. */
function createStringChannelPair(origin = ALLOWED_ORIGIN): {
  clientPort: BridgeClientPort;
  hostPort: BridgeHostPort;
  sendRawToHost: (data: string, senderOrigin?: string) => void;
  sendRawToClient: (data: string) => void;
  close: () => void;
} {
  const channel = new MessageChannel();
  const hostListeners = new Set<(msg: { data: string; origin: string }) => void>();
  const clientListeners = new Set<(frame: string) => void>();

  channel.port1.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      throw new TypeError(
        `Bridge channel expected string frame, received ${typeof event.data}`,
      );
    }
    for (const listener of clientListeners) listener(event.data);
  };
  channel.port2.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      throw new TypeError(
        `Bridge channel expected string frame, received ${typeof event.data}`,
      );
    }
    for (const listener of hostListeners) listener({ data: event.data, origin });
  };

  return {
    clientPort: {
      postMessage(frame) {
        if (typeof frame !== 'string') throw new TypeError('clientPort requires string frame');
        channel.port1.postMessage(frame);
      },
      subscribe(listener) {
        clientListeners.add(listener);
        return () => clientListeners.delete(listener);
      },
    },
    hostPort: {
      postMessage(frame) {
        if (typeof frame !== 'string') throw new TypeError('hostPort requires string frame');
        channel.port2.postMessage(frame);
      },
      subscribe(listener) {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    },
    sendRawToHost(data, senderOrigin = origin) {
      for (const listener of hostListeners) listener({ data, origin: senderOrigin });
    },
    sendRawToClient(data) {
      for (const listener of clientListeners) listener(data);
    },
    close() {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe('postMessage bridge — serveBridge + createBridgeFetch', () => {
  test('typed client calls succeed, out-of-order responses correlate, and 204 No Content works', async () => {
    const slowGate = deferred();
    const fastDone = deferred();
    const contract = defineContract(
      { prefix: 'notes' },
      {
        get: {
          method: 'GET',
          path: '/:id',
          desc: 'Get note',
          params: z.object({ id: z.string() }),
          output: z.object({ id: z.string(), order: z.string() }),
        },
        create: {
          method: 'POST',
          path: '/',
          desc: 'Create note',
          input: z.object({ title: z.string() }),
          output: z.object({ saved: z.string() }),
        },
        clear: {
          method: 'DELETE',
          path: '/:id',
          desc: 'Delete note',
          params: z.object({ id: z.string() }),
        },
      },
    );

    const handler = createHandler({
      services: [
        implement(contract, {
          get: async ({ params }) => {
            if (params.id === 'slow') {
              await slowGate.promise;
              return { id: 'slow', order: 'second' };
            }
            const res = { id: params.id, order: 'first' };
            fastDone.resolve();
            return res;
          },
          create: ({ input }) => ({ saved: input.title }),
          clear: () => undefined,
        }),
      ],
    });

    const pair = createStringChannelPair();
    const bridgeFetch = createBridgeFetch(pair.clientPort);
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      logger: silentLogger,
    });
    await flushPort();
    const client = createClient(contract, { baseUrl: BRIDGE_ORIGIN, fetch: bridgeFetch });

    try {
      const slowPromise = client.get({ id: 'slow' });
      const fastPromise = client.get({ id: 'fast' });
      await fastDone.promise;
      slowGate.resolve();

      const [slow, fast, created, cleared, raw204] = await Promise.all([
        slowPromise,
        fastPromise,
        client.create({ title: 'Bridge Note' }),
        client.clear({ id: 'n1' }),
        bridgeFetch(`${BRIDGE_ORIGIN}/notes/n2`, { method: 'DELETE' }),
      ]);
      expect(slow).toEqual({ id: 'slow', order: 'second' });
      expect(fast).toEqual({ id: 'fast', order: 'first' });
      expect(created).toEqual({ saved: 'Bridge Note' });
      expect(cleared).toBeUndefined();
      expect(raw204.status).toBe(204);
      expect(await raw204.text()).toBe('');
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('duplicate id in flight is refused with duplicate-id and maxInFlight + 1 with host-busy', async () => {
    const gate = deferred();
    const entered = deferred();
    const contract = defineContract(
      { prefix: 'busy' },
      {
        hold: {
          method: 'GET',
          path: '/',
          desc: 'Hold',
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    const handler = createHandler({
      services: [
        implement(contract, {
          hold: async () => {
            entered.resolve();
            await gate.promise;
            return { ok: true };
          },
        }),
      ],
    });

    const pair = createStringChannelPair();
    const replies: Array<Record<string, unknown>> = [];
    const unsub = pair.clientPort.subscribe((raw) => {
      replies.push(JSON.parse(raw) as Record<string, unknown>);
    });
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      maxInFlight: 1,
      logger: silentLogger,
    });

    try {
      pair.sendRawToHost(
        JSON.stringify({
          v: 1,
          kind: 'request',
          id: 'req-1',
          method: 'GET',
          path: '/busy',
          headers: [],
        }),
      );
      await entered.promise;

      pair.sendRawToHost(
        JSON.stringify({
          v: 1,
          kind: 'request',
          id: 'req-1',
          method: 'GET',
          path: '/busy',
          headers: [],
        }),
      );
      pair.sendRawToHost(
        JSON.stringify({
          v: 1,
          kind: 'request',
          id: 'req-2',
          method: 'GET',
          path: '/busy',
          headers: [],
        }),
      );

      gate.resolve();
      await new Promise((r) => setTimeout(r, 25));

      expect(replies).toContainEqual(
        expect.objectContaining({ kind: 'failure', id: 'req-1', code: 'duplicate-id' }),
      );
      expect(replies).toContainEqual(
        expect.objectContaining({ kind: 'failure', id: 'req-2', code: 'host-busy' }),
      );
      expect(replies).toContainEqual(
        expect.objectContaining({ kind: 'response', id: 'req-1', status: 200 }),
      );
      expect(host.stats.rejectedDuplicateId).toBe(1);
      expect(host.stats.rejectedBusy).toBe(1);
    } finally {
      unsub();
      host.close();
      pair.close();
    }
  });

  test('oversized ASCII and multi-byte UTF-8 frames are rejected BEFORE JSON.parse on host and client, plus outbound frame-too-large', async () => {
    const contract = defineContract(
      { prefix: 'cap' },
      {
        ping: {
          method: 'GET',
          path: '/',
          desc: 'Ping',
          output: z.object({ ok: z.boolean() }),
        },
        huge: {
          method: 'GET',
          path: '/huge',
          desc: 'Large response',
          output: z.object({ data: z.string() }),
        },
      },
    );
    const handler = createHandler({
      services: [
        implement(contract, {
          ping: () => ({ ok: true }),
          huge: () => ({ data: '🚀'.repeat(120) }),
        }),
      ],
    });

    const pair = createStringChannelPair();
    const clientDrops: string[] = [];
    const bridgeFetch = createBridgeFetch(pair.clientPort, {
      maxFrameBytes: 256,
      onDroppedFrame: (reason) => clientDrops.push(reason),
    });
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      maxFrameBytes: 256,
      logger: silentLogger,
    });
    await flushPort();
    const client = createClient(contract, { baseUrl: BRIDGE_ORIGIN, fetch: bridgeFetch });

    // Multi-byte UTF-8 frame: string.length < 256, but UTF-8 byte length > 256.
    const multiBytePayload = JSON.stringify({
      v: 1,
      kind: 'request',
      id: 'mb-1',
      method: 'POST',
      path: '/cap',
      headers: [],
      body: '🚀'.repeat(60),
    });
    expect(multiBytePayload.length).toBeLessThan(256);

    const originalParse = JSON.parse;
    let parseCount = 0;
    try {
      JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
        parseCount += 1;
        return originalParse(...args);
      }) as typeof JSON.parse;

      const oversizedAscii = JSON.stringify({
        v: 1,
        kind: 'request',
        id: 'too-big',
        method: 'POST',
        path: '/cap',
        headers: [],
        body: 'x'.repeat(500),
      });
      pair.sendRawToHost(oversizedAscii);
      pair.sendRawToHost(multiBytePayload);
      pair.sendRawToClient(multiBytePayload);
      expect(parseCount).toBe(0);
      expect(host.stats.rejectedOversize).toBe(2);
      expect(clientDrops).toEqual(['frame-too-large']);

      // Malformed frame also must not break the channel.
      pair.sendRawToHost('{not-json');
      expect(host.stats.rejectedInvalid).toBe(1);
    } finally {
      JSON.parse = originalParse;
    }

    try {
      expect(await client.ping()).toEqual({ ok: true });

      let tooBigReply: unknown;
      try {
        await bridgeFetch(`${BRIDGE_ORIGIN}/cap/huge`);
      } catch (e) {
        tooBigReply = e;
      }
      expect(tooBigReply).toBeInstanceOf(BridgeFailureError);
      expect((tooBigReply as BridgeFailureError).code).toBe('frame-too-large');
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('a response larger than one frame is refused after one frame of reading, not after all of it', async () => {
    // The handler answers with a megabyte, one kilobyte at a time. The host stops pulling
    // once the body cannot fit a frame; it does not hold the megabyte to find that out.
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    let pulled = 0;
    let cancelled = false;
    const handler = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled >= 1024) {
              controller.close();
              return;
            }
            pulled += 1;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/plain' } },
      );

    const pair = createStringChannelPair();
    const bridgeFetch = createBridgeFetch(pair.clientPort, { maxFrameBytes: 4096 });
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      maxFrameBytes: 4096,
      logger: silentLogger,
    });
    await flushPort();
    try {
      let refusal: unknown;
      try {
        await bridgeFetch(`${BRIDGE_ORIGIN}/big`);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(BridgeFailureError);
      expect(refusal).toMatchObject({ code: 'frame-too-large' });
      expect(cancelled).toBe(true);
      // Four kilobytes fit a frame; a few more chunks may be buffered ahead, never all 1024.
      expect(pulled).toBeLessThan(16);
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('createBridgeFetch bounds streaming Request bodies before buffering and skips reading when signal is already aborted', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    let posted = 0;
    const port: BridgeClientPort = {
      postMessage() {
        posted += 1;
      },
      subscribe: () => () => undefined,
    };
    const bridgeFetch = createBridgeFetch(port, { maxFrameBytes: 4096 });
    try {
      // 1. Streaming Request larger than maxFrameBytes aborts before buffering the whole stream.
      let pulled = 0;
      let cancelled = false;
      const bigStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= 1024) {
            controller.close();
            return;
          }
          pulled += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      const bigReq = new Request(`${BRIDGE_ORIGIN}/upload`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: bigStream,
      });
      const bigErr = await bridgeFetch(bigReq).catch((error: unknown) => error);
      expect(bigErr).toBeInstanceOf(BridgeFailureError);
      expect(bigErr).toMatchObject({ code: 'frame-too-large' });
      expect(cancelled).toBe(true);
      expect(pulled).toBeLessThan(16);
      expect(posted).toBe(0);

      // 2. Declared content-length exceeding maxFrameBytes refuses without pulling any chunks.
      let clPulled = 0;
      let clCancelled = false;
      const clStream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            clPulled += 1;
            controller.enqueue(chunk);
          },
          cancel() {
            clCancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const clReq = new Request(`${BRIDGE_ORIGIN}/upload`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'content-length': '1048576' },
        body: clStream,
      });
      const clErr = await bridgeFetch(clReq).catch((error: unknown) => error);
      expect(clErr).toBeInstanceOf(BridgeFailureError);
      expect(clErr).toMatchObject({ code: 'frame-too-large' });
      expect(clCancelled).toBe(true);
      expect(clPulled).toBe(0);
      expect(posted).toBe(0);

      // 3. Pre-aborted init.signal and Request.signal never read, pull, or lock the Request body stream.
      let abortedPulled = 0;
      const abortedStream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            abortedPulled += 1;
            controller.enqueue(chunk);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const abortedReq = new Request(`${BRIDGE_ORIGIN}/upload`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: abortedStream,
      });
      const abortCtrl = new AbortController();
      const abortMarker = new Error('already-aborted');
      abortCtrl.abort(abortMarker);
      const abortedErr = await bridgeFetch(abortedReq, { signal: abortCtrl.signal }).catch(
        (error: unknown) => error,
      );
      expect(abortedErr).toBe(abortMarker);
      expect(abortedPulled).toBe(0);
      expect(abortedStream.locked).toBe(false);

      let reqSignalPulled = 0;
      const reqSignalStream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reqSignalPulled += 1;
            controller.enqueue(chunk);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const reqSignalCtrl = new AbortController();
      const reqSignalMarker = new Error('request-already-aborted');
      reqSignalCtrl.abort(reqSignalMarker);
      const preAbortedReq = new Request(`${BRIDGE_ORIGIN}/upload`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: reqSignalStream,
        signal: reqSignalCtrl.signal,
      });
      const reqSignalErr = await bridgeFetch(preAbortedReq).catch((error: unknown) => error);
      expect(reqSignalErr).toBe(reqSignalMarker);
      expect(reqSignalPulled).toBe(0);
      expect(reqSignalStream.locked).toBe(false);
      expect(posted).toBe(0);
    } finally {
      bridgeFetch.close();
    }
  });

  test('cancellation mid-handler (including oversized AbortSignal.reason) aborts ctx.signal, logs cancelled (499), and drops late response', async () => {
    const handlerStarted = deferred();
    const handlerAborted = deferred();
    let sawSignalAborted = false;
    const completedEvents: Array<{ statusCode: number | undefined; outcome?: string }> = [];

    const contract = defineContract(
      { prefix: 'slow' },
      {
        wait: {
          method: 'GET',
          path: '/',
          desc: 'Wait',
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    const handler = createHandler({
      services: [
        implement(contract, {
          wait: async (ctx) => {
            handlerStarted.resolve();
            const signal = ctx.signal;
            if (!signal) throw new Error('Expected ctx.signal');
            return new Promise<{ ok: boolean }>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  sawSignalAborted = signal.aborted;
                  handlerAborted.resolve();
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          },
        }),
      ],
      observability: {
        includePayload: false,
        complete: (event) => {
          completedEvents.push({ statusCode: event.statusCode, outcome: event.outcome });
        },
      },
    });

    const pair = createStringChannelPair();
    const droppedReasons: string[] = [];
    const secret = 's3cr3t-abort-token-123456';
    const bridgeFetch = createBridgeFetch(pair.clientPort, {
      secret,
      maxFrameBytes: 256,
      onDroppedFrame: (reason) => droppedReasons.push(reason),
    });
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      secret,
      maxFrameBytes: 256,
      logger: silentLogger,
    });
    await flushPort();

    try {
      const controller = new AbortController();
      const pending = bridgeFetch(`${BRIDGE_ORIGIN}/slow`, { signal: controller.signal });
      await handlerStarted.promise;
      // Oversized reason (> maxFrameBytes=256) must be dropped so the abort frame still lands on host.
      controller.abort(new DOMException('x'.repeat(2_000), 'AbortError'));

      let caught: unknown;
      try {
        await pending;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe('AbortError');

      await handlerAborted.promise;
      await new Promise((r) => setTimeout(r, 15));
      expect(sawSignalAborted).toBe(true);
      expect(completedEvents).toEqual([{ statusCode: 499, outcome: 'cancelled' }]);

      pair.sendRawToClient(
        JSON.stringify({
          v: 1,
          kind: 'response',
          id: 'late-unknown-id',
          status: 200,
          statusText: 'OK',
          headers: [],
          body: '{}',
        }),
      );
      expect(droppedReasons).toContain('unknown-id');
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('new hello replays GET automatically while non-idempotent POST fails without replay (including when initial hello was lost)', async () => {
    const getStuck = deferred();
    const postStuck = deferred();
    let getCalls = 0;
    let postCalls = 0;

    const contract = defineContract(
      { prefix: 'restart' },
      {
        ping: {
          method: 'GET',
          path: '/ping',
          desc: 'Ping',
          output: z.object({ ok: z.boolean() }),
        },
        read: {
          method: 'GET',
          path: '/',
          desc: 'Read',
          output: z.object({ attempt: z.number() }),
        },
        write: {
          method: 'POST',
          path: '/',
          desc: 'Write once',
          input: z.object({ value: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
      },
    );

    const handler = createHandler({
      services: [
        implement(contract, {
          ping: () => ({ ok: true }),
          read: async () => {
            getCalls += 1;
            if (getCalls === 1) {
              getStuck.resolve();
              return new Promise(() => undefined);
            }
            return { attempt: getCalls };
          },
          write: async () => {
            postCalls += 1;
            postStuck.resolve();
            return new Promise(() => undefined);
          },
        }),
      ],
    });

    const pair = createStringChannelPair();
    // Real RN boot order: host starts BEFORE WebView mounts, so the initial `hello` is lost.
    const host1 = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      hostInstance: 'host-v1',
      logger: silentLogger,
    });
    await flushPort();

    // Now WebView mounts `createBridgeFetch` — it NEVER saw `host-v1`'s initial `hello`.
    const bridgeFetch = createBridgeFetch(pair.clientPort);
    const client = createClient(contract, {
      baseUrl: BRIDGE_ORIGIN,
      fetch: bridgeFetch,
      retry: { limit: 2 },
    });

    let host2: ReturnType<typeof serveBridge> | undefined;
    try {
      // Subcase A: restart happens BEFORE any response ever arrived (currentHostInstance is undefined).
      const readPromise = client.read();
      const writePromise = client.write({ value: 'once' }).then(
        () => 'ok',
        (err: unknown) => err,
      );
      await Promise.all([getStuck.promise, postStuck.promise]);

      host1.close();
      host2 = serveBridge(pair.hostPort, handler, {
        origins: [ALLOWED_ORIGIN],
        hostInstance: 'host-v2',
        logger: silentLogger,
      });

      const [readResult, writeResult] = await Promise.all([readPromise, writePromise]);
      expect(readResult).toEqual({ attempt: 2 });
      expect(getCalls).toBe(2);
      expect(writeResult).toBeInstanceOf(ApiError);
      expect(postCalls).toBe(1);

      // Subcase B: a second client that also missed `host-v2`'s initial hello learns `host-v2` from `response.hostInstance`.
      const lateClientFetch = createBridgeFetch(pair.clientPort);
      const lateClient = createClient(contract, {
        baseUrl: BRIDGE_ORIGIN,
        fetch: lateClientFetch,
        retry: { limit: 2 },
      });
      try {
        expect(await lateClient.ping()).toEqual({ ok: true });
      } finally {
        lateClientFetch.close();
      }
    } finally {
      bridgeFetch.close();
      host1.close();
      host2?.close();
      pair.close();
    }
  });

  test('handler HTTP errors travel as Response frames (never reject), so POST is not replayed', async () => {
    let calls = 0;
    const contract = defineContract(
      { prefix: 'errs' },
      {
        submit: {
          method: 'POST',
          path: '/',
          desc: 'Submit',
          idempotent: true,
          input: z.object({ n: z.number() }),
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    const handler = createHandler({
      services: [
        implement(contract, {
          submit: () => {
            calls += 1;
            return badRequest('rejected by domain');
          },
        }),
      ],
    });

    const pair = createStringChannelPair();
    const bridgeFetch = createBridgeFetch(pair.clientPort);
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      logger: silentLogger,
    });
    await flushPort();
    const client = createClient(contract, {
      baseUrl: BRIDGE_ORIGIN,
      fetch: bridgeFetch,
      retry: { limit: 2 },
    });

    try {
      let caught: unknown;
      try {
        await client.submit({ n: 1 });
      } catch (error) {
        caught = error;
      }
      expect(ApiError.is(caught)).toBe(true);
      if (ApiError.is(caught)) {
        expect(caught.status).toBe(400);
        expect(caught.code).toBe('BAD_REQUEST');
      }
      expect(calls).toBe(1);
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('deterministic BridgeFailureError and closed bridgeFetch do not replay on GET for both createClient and createHttpClient', async () => {
    let binaryCalls = 0;
    let hugeCalls = 0;
    const contract = defineContract(
      { prefix: 'det' },
      {
        binary: {
          method: 'GET',
          path: '/bin',
          desc: 'Binary response',
          rawResponse: true,
        },
        huge: {
          method: 'GET',
          path: '/huge',
          desc: 'Oversized response',
          output: z.object({ data: z.string() }),
        },
        ok: {
          method: 'GET',
          path: '/ok',
          desc: 'Ok',
          output: z.object({ ok: z.boolean() }),
        },
      },
    );

    const handler = createHandler({
      services: [
        implement(contract, {
          binary: () => {
            binaryCalls += 1;
            return new Response('raw', {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
            });
          },
          huge: () => {
            hugeCalls += 1;
            return { data: 'a'.repeat(600) };
          },
          ok: () => ({ ok: true }),
        }),
      ],
    });

    const secret = 's3cr3t-det-replay-123456';
    const pair = createStringChannelPair();
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      secret,
      maxFrameBytes: 300,
      logger: silentLogger,
    });
    await flushPort();

    const validFetch = createBridgeFetch(pair.clientPort, { secret, maxFrameBytes: 300 });
    const badSecretFetch = createBridgeFetch(pair.clientPort, {
      secret: 'wrong-secret-000000',
      maxFrameBytes: 300,
    });
    const closedFetch = createBridgeFetch(pair.clientPort, { secret });
    closedFetch.close();

    const typedClient = createClient(contract, {
      baseUrl: BRIDGE_ORIGIN,
      fetch: validFetch,
      retry: { limit: 3 },
    });
    const badTypedClient = createClient(contract, {
      baseUrl: BRIDGE_ORIGIN,
      fetch: badSecretFetch,
      retry: { limit: 3 },
    });
    const closedTypedClient = createClient(contract, {
      baseUrl: BRIDGE_ORIGIN,
      fetch: closedFetch,
      retry: { limit: 3 },
    });
    const httpClient = createHttpClient({
      baseUrl: BRIDGE_ORIGIN,
      fetch: validFetch,
      retry: { limit: 3 },
    });
    const badHttpClient = createHttpClient({
      baseUrl: BRIDGE_ORIGIN,
      fetch: badSecretFetch,
      retry: { limit: 3 },
    });

    try {
      await expect(typedClient.binary()).rejects.toThrow();
      expect(binaryCalls).toBe(1);

      await expect(httpClient.get('/det/bin', { responseType: 'response' })).rejects.toThrow();
      expect(binaryCalls).toBe(2);

      await expect(typedClient.huge()).rejects.toThrow();
      expect(hugeCalls).toBe(1);

      await expect(httpClient.get('/det/huge')).rejects.toThrow();
      expect(hugeCalls).toBe(2);

      await expect(badTypedClient.ok()).rejects.toThrow();
      expect(host.stats.rejectedSecret).toBe(1);

      await expect(badHttpClient.get('/det/ok')).rejects.toThrow();
      expect(host.stats.rejectedSecret).toBe(2);

      await expect(closedTypedClient.ok()).rejects.toThrow('closed');
    } finally {
      validFetch.close();
      badSecretFetch.close();
      host.close();
      pair.close();
    }
  });

  test('origin trust, secret enforcement on abort & id-collision, logger.warn diagnostics, trustProxy refusal, and mixed-case header stripping', async () => {
    let handlerCalls = 0;
    let observedHeaders: Record<string, string | null> = {};
    const holdGate = deferred();
    const holdEntered = deferred();
    const hostWarnings: string[] = [];
    const capturingLogger = {
      ...silentLogger,
      warn: (msg: string) => {
        hostWarnings.push(msg);
      },
    };

    const contract = defineContract(
      { prefix: 'trust' },
      {
        inspect: {
          method: 'GET',
          path: '/',
          desc: 'Inspect headers',
          output: z.object({ ok: z.boolean() }),
        },
        hold: {
          method: 'GET',
          path: '/hold',
          desc: 'Hold open',
          output: z.object({ ok: z.boolean() }),
        },
      },
    );

    const pair = createStringChannelPair();
    expect(() =>
      serveBridge(pair.hostPort, createHandler({ services: [], trustProxy: true }), {
        origins: [ALLOWED_ORIGIN],
        logger: silentLogger,
      }),
    ).toThrow('trustProxy: true');
    expect(() =>
      serveBridge(pair.hostPort, createHandler({ services: [] }), {
        origins: [ALLOWED_ORIGIN],
        hostInstance: '',
      }),
    ).toThrow(TypeError);
    expect(() => createBridgeFetch(pair.clientPort, { windowInstance: '' })).toThrow(
      TypeError,
    );

    const handler = createHandler({
      services: [
        implement(contract, {
          inspect: ({ req }) => {
            handlerCalls += 1;
            if (!req) throw new Error('Expected req');
            observedHeaders = {
              origin: req.headers.get('origin'),
              host: req.headers.get('host'),
              xff: req.headers.get('x-forwarded-for'),
              xri: req.headers.get('x-real-ip'),
              forwarded: req.headers.get('forwarded'),
              custom: req.headers.get('x-app-token'),
            };
            return { ok: true };
          },
          hold: async (ctx) => {
            holdEntered.resolve();
            await holdGate.promise;
            if (ctx.signal?.aborted) throw new Error('Should not have been aborted');
            return { ok: true };
          },
        }),
      ],
    });

    const secret = 's3cr3t-launch-token-123456';
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      secret,
      logger: capturingLogger,
    });
    await flushPort();
    const wrongSecretFetch = createBridgeFetch(pair.clientPort, {
      secret: 'wrong-secret-000000',
    });
    const validFetch = createBridgeFetch(pair.clientPort, {
      secret,
      windowInstance: 'win-auth',
    });

    try {
      // Disallowed origin -> handler never invoked, full reason logged on host.
      pair.sendRawToHost(
        JSON.stringify({
          v: 1,
          kind: 'request',
          id: 'evil-1',
          method: 'GET',
          path: '/trust',
          headers: [],
          secret,
        }),
        'https://evil.example',
      );
      await flushPort();
      expect(handlerCalls).toBe(0);
      expect(host.stats.rejectedOrigin).toBe(1);
      expect(hostWarnings.some((w) => w.includes('https://evil.example'))).toBe(true);

      // Wrong secret -> opaque refusal, handler never invoked, reason logged on host.
      let wrongErr: unknown;
      try {
        await wrongSecretFetch(`${BRIDGE_ORIGIN}/trust`);
      } catch (e) {
        wrongErr = e;
      }
      expect(wrongErr).toBeInstanceOf(BridgeFailureError);
      expect((wrongErr as BridgeFailureError).code).toBe('refused');
      expect((wrongErr as BridgeFailureError).message).not.toContain('secret');
      expect(handlerCalls).toBe(0);
      expect(host.stats.rejectedSecret).toBe(1);
      expect(hostWarnings.some((w) => w.includes('secret mismatch'))).toBe(true);

      // Legitimate in-flight request (`win-auth:1`): forged abort and forged request with SAME id must not disrupt it.
      const legitHold = validFetch(`${BRIDGE_ORIGIN}/trust/hold`);
      await holdEntered.promise;

      pair.sendRawToHost(
        JSON.stringify({ v: 1, kind: 'abort', id: 'win-auth:1', reason: 'spoofed' }),
      );
      pair.sendRawToHost(
        JSON.stringify({
          v: 1,
          kind: 'abort',
          id: 'win-auth:1',
          secret: 'wrong-secret-000000',
        }),
      );
      pair.sendRawToHost(
        JSON.stringify({
          v: 1,
          kind: 'request',
          id: 'win-auth:1',
          method: 'GET',
          path: '/trust',
          headers: [],
          secret: 'wrong-secret-000000',
        }),
      );
      await flushPort();
      holdGate.resolve();
      const holdRes = await legitHold;
      expect(holdRes.status).toBe(200);
      expect(await holdRes.json()).toEqual({ ok: true });

      // Valid origin + secret with mixed-case forged trust headers -> stripped before handler.
      const res = await validFetch(`${BRIDGE_ORIGIN}/trust`, {
        headers: {
          Origin: 'https://forged.example',
          Host: '127.0.0.1:9999',
          'X-Forwarded-For': '203.0.113.5',
          'X-Real-IP': '203.0.113.6',
          Forwarded: 'for=203.0.113.7',
          'X-App-Token': 'kept',
        },
      });
      expect(res.status).toBe(200);
      expect(handlerCalls).toBe(1);
      expect(observedHeaders).toEqual({
        origin: null,
        host: null,
        xff: null,
        xri: null,
        forwarded: null,
        custom: 'kept',
      });
    } finally {
      wrongSecretFetch.close();
      validFetch.close();
      host.close();
      pair.close();
    }
  });

  test('host.close() aborts active in-flight requests and close() races during prepareRequestFrame and invoke', async () => {
    const started = deferred();
    const aborted = deferred();
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/hang',
          handler: (req) => {
            started.resolve();
            return new Promise<Response>((_resolve, reject) => {
              req.signal.addEventListener(
                'abort',
                () => {
                  aborted.resolve();
                  reject(req.signal.reason);
                },
                { once: true },
              );
            });
          },
        },
      ],
    });

    const pair = createStringChannelPair();
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      logger: silentLogger,
    });
    await flushPort();

    let postedCount = 0;
    const wrappedClientPort: BridgeClientPort = {
      postMessage(frame) {
        postedCount += 1;
        pair.clientPort.postMessage(frame);
      },
      subscribe: (listener) => pair.clientPort.subscribe(listener),
    };
    const bridgeFetch = createBridgeFetch(wrappedClientPort);

    try {
      // 1. host.close() aborts active request on host.
      void bridgeFetch(`${BRIDGE_ORIGIN}/hang`).catch(() => undefined);
      await started.promise;
      host.close();
      await aborted.promise;

      // 2. close() while prepareRequestFrame is awaiting a real ReadableStream aborts immediately,
      // cancels the stream, and never posts a frame.
      const beforeRacePosts = postedCount;
      let raceCancelled = false;
      const slowBody = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel() {
          raceCancelled = true;
        },
      });
      const req = new Request(`${BRIDGE_ORIGIN}/hang`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: slowBody,
      });
      const raceFetch = createBridgeFetch(wrappedClientPort);
      const racePromise = raceFetch(req);
      await Bun.sleep(5);
      raceFetch.close();
      const raceResult = await Promise.race([
        racePromise.then(
          () => 'unexpected-resolve',
          (error: unknown) => error,
        ),
        Bun.sleep(500).then(() => 'hung'),
      ]);
      expect(raceResult).toBeInstanceOf(TypeError);
      expect(String(raceResult)).toMatch(/Bridge fetch (is )?closed/);
      expect(classifyBridgeTransportRetry(raceResult)).toBe(false);
      expect(raceCancelled).toBe(true);
      expect(postedCount).toBe(beforeRacePosts);

      // 3. invoke-mode close() immediately rejects an in-flight invoke call.
      const invokeEntered = deferred();
      const invokeFetch = createBridgeFetch(() => {
        invokeEntered.resolve();
        return new Promise<string>(() => undefined);
      });
      const invokePending = invokeFetch(`${BRIDGE_ORIGIN}/hang`);
      await invokeEntered.promise;
      invokeFetch.close();
      await expect(invokePending).rejects.toThrow('Bridge fetch closed');
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('two Set-Cookie response headers arrive as two distinct Set-Cookie entries', async () => {
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/cookies',
          handler: () => {
            const headers = new Headers({ 'content-type': 'application/json' });
            headers.append('Set-Cookie', 'a=1; Path=/; HttpOnly');
            headers.append('Set-Cookie', 'b=2; Path=/; SameSite=Lax');
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
          },
        },
      ],
    });

    const pair = createStringChannelPair();
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      logger: silentLogger,
    });
    await flushPort();
    const bridgeFetch = createBridgeFetch(pair.clientPort);

    try {
      const res = await bridgeFetch(`${BRIDGE_ORIGIN}/cookies`);
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toEqual([
        'a=1; Path=/; HttpOnly',
        'b=2; Path=/; SameSite=Lax',
      ]);
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('UTF-8 (Cyrillic, emoji, U+2028, </script>) passes intact with whatwg-fetch@3.6.20 on the host side', async () => {
    const handlerEntry = join(CORE_SRC, 'entrypoints/handler.ts');
    const contractEntry = join(CORE_SRC, 'entrypoints/contract.ts');
    const bundle = await bundleBrowserIife(`
      import * as h from ${JSON.stringify(handlerEntry)};
      import * as c from ${JSON.stringify(contractEntry)};
      import { z } from ${JSON.stringify(ZOD_ENTRY)};
      globalThis.__host = { ...h, ...c, z };
    `);

    const hostRealm = createRnRealm();
    hostRealm.evaluate(bundle, 'bridge-host-rn.iife.js');

    const pair = createStringChannelPair();
    hostRealm.context.__hostPort = pair.hostPort;
    hostRealm.context.__origin = ALLOWED_ORIGIN;
    const closeVmHost = hostRealm.evaluate<() => void>(`(() => {
      const { createHandler, defineContract, implement, serveBridge, z } = globalThis.__host;
      const echo = defineContract(
        { prefix: 'utf8' },
        {
          roundtrip: {
            method: 'POST',
            path: '/',
            desc: 'Echo UTF-8 text',
            input: z.object({ text: z.string() }),
            output: z.object({ text: z.string() }),
          },
        },
      );
      const handler = createHandler({
        services: [implement(echo, { roundtrip: ({ input }) => ({ text: input.text }) })],
      });
      const handle = serveBridge(globalThis.__hostPort, handler, {
        origins: [globalThis.__origin],
      });
      return () => handle.close();
    })()`);

    await flushPort();
    const bridgeFetch = createBridgeFetch(pair.clientPort);
    const sample = 'Привет мир 🚀 line\u2028sep </script>';
    try {
      const res = await bridgeFetch(`${BRIDGE_ORIGIN}/utf8`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: sample }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: sample });
    } finally {
      bridgeFetch.close();
      closeVmHost();
      pair.close();
    }
  });

  test('binary body (init and Request), non-textual response fail with unsupported; Expo DOM invoke adapter and aborted raw parseBody work', async () => {
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/bin',
          handler: () =>
            new Response('raw', {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
            }),
        },
        {
          method: 'GET',
          path: '/ok',
          handler: () =>
            new Response(JSON.stringify({ via: 'invoke' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        },
      ],
    });

    const pair = createStringChannelPair();
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ALLOWED_ORIGIN],
      logger: silentLogger,
    });
    await flushPort();
    const bridgeFetch = createBridgeFetch(pair.clientPort);

    try {
      // Binary body in RequestInit
      let binaryReqErr: unknown;
      try {
        await bridgeFetch(`${BRIDGE_ORIGIN}/ok`, {
          method: 'POST',
          body: new Uint8Array([1, 2, 3]),
        });
      } catch (e) {
        binaryReqErr = e;
      }
      expect(binaryReqErr).toBeInstanceOf(BridgeFailureError);
      expect((binaryReqErr as BridgeFailureError).code).toBe('unsupported');

      // Binary body inside `input instanceof Request`
      let binaryRequestObjErr: unknown;
      try {
        await bridgeFetch(
          new Request(`${BRIDGE_ORIGIN}/ok`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array([1, 2, 3]),
          }),
        );
      } catch (e) {
        binaryRequestObjErr = e;
      }
      expect(binaryRequestObjErr).toBeInstanceOf(BridgeFailureError);
      expect((binaryRequestObjErr as BridgeFailureError).code).toBe('unsupported');

      // Non-textual response
      let binaryResErr: unknown;
      try {
        await bridgeFetch(`${BRIDGE_ORIGIN}/bin`);
      } catch (e) {
        binaryResErr = e;
      }
      expect(binaryResErr).toBeInstanceOf(BridgeFailureError);
      expect((binaryResErr as BridgeFailureError).code).toBe('unsupported');
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }

    // Aborted `parseBody` on a whatwg-fetch-like request (`body: undefined`) returns null.
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const fakeReq = {
      body: undefined,
      signal: abortCtrl.signal,
      text: async () => '{"ok":true}',
    } as unknown as Request;
    expect(await parseBody(fakeReq, z.object({ ok: z.boolean() }))).toBeNull();

    // Expo DOM `invoke(frame) => Promise<frame>` adapter over serveBridge:
    const invokeFetch = createBridgeFetch(async (frame) => {
      return new Promise<string>((resolve) => {
        const single = createStringChannelPair();
        const unsub = single.clientPort.subscribe((reply) => {
          const parsed = JSON.parse(reply) as { kind: string };
          if (parsed.kind === 'hello') return;
          unsub();
          h.close();
          single.close();
          resolve(reply);
        });
        const h = serveBridge(single.hostPort, handler, {
          origins: [ALLOWED_ORIGIN],
          logger: silentLogger,
        });
        single.clientPort.postMessage(frame);
      });
    });

    try {
      const res = await invokeFetch(`${BRIDGE_ORIGIN}/ok`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ via: 'invoke' });
    } finally {
      invokeFetch.close();
    }
  });
});
