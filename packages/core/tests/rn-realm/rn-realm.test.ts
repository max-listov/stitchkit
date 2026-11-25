/**
 * Level-1 React Native 0.88 / Hermes realm gate (items 3, 5, 6, 7, 8, 11).
 *
 * Every entrypoint bundle is compiled with `--target=browser --format=iife` and
 * executed in a strict `node:vm` realm containing only React Native 0.88 globals
 * (`whatwg-fetch@3.6.20`, RN `URL`/`URLSearchParams`, no `Buffer`, no `ReadableStream`,
 * no `Response.json`, no `URL.canParse`, no `crypto.randomUUID`, no `process.hrtime`).
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { bundleBrowserIife, CORE_SRC, createRnRealm, ZOD_ENTRY } from './rn-realm';

const HANDLER_ENTRY = join(CORE_SRC, 'entrypoints/handler.ts');
const CONTRACT_ENTRY = join(CORE_SRC, 'entrypoints/contract.ts');
const HTTP_ENTRY = join(CORE_SRC, 'entrypoints/http.ts');
const SYNC_ENTRY = join(CORE_SRC, 'entrypoints/sync.ts');
const JSON_RESPONSE_MOD = join(CORE_SRC, 'internal/json-response.ts');

const handlerBundlePromise = bundleBrowserIife(`
  import * as handlerMod from ${JSON.stringify(HANDLER_ENTRY)};
  import * as contractMod from ${JSON.stringify(CONTRACT_ENTRY)};
  import { jsonResponse } from ${JSON.stringify(JSON_RESPONSE_MOD)};
  import { z } from ${JSON.stringify(ZOD_ENTRY)};
  globalThis.__sk = { ...handlerMod, ...contractMod, jsonResponse, z };
`);

const httpBundlePromise = bundleBrowserIife(`
  import * as httpMod from ${JSON.stringify(HTTP_ENTRY)};
  import * as contractMod from ${JSON.stringify(CONTRACT_ENTRY)};
  import { z } from ${JSON.stringify(ZOD_ENTRY)};
  globalThis.__skHttp = { ...httpMod, ...contractMod, z };
`);

const sessionBundlePromise = bundleBrowserIife(`
  import { createSessionCredentials } from ${JSON.stringify(join(CORE_SRC, 'browser/session-credentials.ts'))};
  import { createSessionScope } from ${JSON.stringify(join(CORE_SRC, 'browser/session.ts'))};
  globalThis.__skSession = { createSessionCredentials, createSessionScope };
`);

const syncBundlePromise = bundleBrowserIife(`
  import * as syncMod from ${JSON.stringify(SYNC_ENTRY)};
  import { z } from ${JSON.stringify(ZOD_ENTRY)};
  globalThis.__skSync = { ...syncMod, z };
`);

const uploadProgressBundlePromise = bundleBrowserIife(`
  import { uploadProgressRoute, withUploadProgress } from ${JSON.stringify(join(CORE_SRC, 'browser/upload-progress.ts'))};
  globalThis.__skUpload = { uploadProgressRoute, withUploadProgress };
`);

describe('RN 0.88 realm — stitchkit/handler', () => {
  test('realm truly lacks Node/Bun globals, Response.json, URL.canParse, ReadableStream and crypto.randomUUID', () => {
    const realm = createRnRealm();
    const probe = realm.evaluate<Record<string, string>>(`({
      Buffer: typeof Buffer,
      setImmediate: typeof setImmediate,
      ReadableStream: typeof ReadableStream,
      ResponseJson: typeof Response.json,
      URLCanParse: typeof URL.canParse,
      TextEncoder: typeof TextEncoder,
      TextDecoder: typeof TextDecoder,
      randomUUID: typeof crypto.randomUUID,
      getRandomValues: typeof crypto.getRandomValues,
      hrtime: typeof process.hrtime,
      getBuiltinModule: typeof process.getBuiltinModule,
      DOMException: typeof DOMException,
      AbortSignalAny: typeof AbortSignal.any,
      AbortSignalAbort: typeof AbortSignal.abort,
      AbortSignalTimeout: typeof AbortSignal.timeout,
      reqBody: typeof new Request('http://bridge.invalid/a', { method: 'POST', body: '{}' }).body,
    })`);
    expect(probe).toEqual({
      Buffer: 'undefined',
      setImmediate: 'undefined',
      ReadableStream: 'undefined',
      ResponseJson: 'undefined',
      URLCanParse: 'undefined',
      TextEncoder: 'undefined',
      TextDecoder: 'undefined',
      randomUUID: 'undefined',
      getRandomValues: 'function',
      hrtime: 'undefined',
      getBuiltinModule: 'undefined',
      // React Native installs fetch, Headers, Request and Response from whatwg-fetch and
      // keeps that polyfill's DOMException to itself.
      DOMException: 'undefined',
      AbortSignalAny: 'function',
      AbortSignalAbort: 'function',
      AbortSignalTimeout: 'function',
      reqBody: 'undefined',
    });

    const abortCheck = realm.evaluate<Record<string, unknown>>(`(() => {
      let directCtorError = 'none';
      try {
        new AbortSignal();
      } catch (e) {
        directCtorError = e.name;
      }
      const a = new AbortController();
      const b = new AbortController();
      const combined = AbortSignal.any([a.signal, b.signal]);
      let onceCount = 0;
      combined.addEventListener('abort', () => { onceCount += 1; }, { once: true });
      a.abort();
      b.abort('later');
      const pre = AbortSignal.abort();
      return {
        directCtorError,
        combinedAborted: combined.aborted,
        combinedReasonName: combined.reason && combined.reason.name,
        onceCount,
        preAborted: pre.aborted,
        preReasonName: pre.reason && pre.reason.name,
        domException: typeof DOMException,
      };
    })()`);
    expect(abortCheck).toEqual({
      directCtorError: 'TypeError',
      combinedAborted: true,
      combinedReasonName: 'AbortError',
      onceCount: 1,
      preAborted: true,
      preReasonName: 'AbortError',
      domException: 'undefined',
    });
  });

  test('serves GET 200, POST JSON 200, 400 validation, 404 UNKNOWN_OPERATION, 405, maxJsonBodyBytes, malformed query %, x-request-id, and CORS policy', async () => {
    const bundle = await handlerBundlePromise;
    const realm = createRnRealm();
    realm.evaluate(bundle, 'stitchkit-handler.iife.js');

    const result = await realm.evaluate<Promise<Record<string, unknown>>>(`(async () => {
      const { createHandler, defineContract, implement, z } = globalThis.__sk;
      const items = defineContract(
        { prefix: 'items' },
        {
          list: {
            method: 'GET',
            path: '/',
            desc: 'List items',
            input: z.object({ q: z.string().optional() }),
            output: z.object({ items: z.array(z.string()), q: z.string().optional() }),
          },
          create: {
            method: 'POST',
            path: '/',
            desc: 'Create item',
            input: z.object({ name: z.string().min(2) }),
            output: z.object({ created: z.string() }),
          },
        },
      );

      const handler = createHandler({
        services: [
          implement(items, {
            list: ({ input }) => ({ items: ['alpha'], q: input.q }),
            create: ({ input }) => ({ created: input.name }),
          }),
        ],
        maxJsonBodyBytes: 32,
        cors: {
          origin: (origin) => (origin === 'https://app.example' ? { credentials: false } : false),
        },
        logging: true,
      });

      const getRes = await handler(
        new Request('http://bridge.invalid/items?q=hello', {
          headers: { origin: 'https://app.example' },
        }),
      );
      const getBody = await getRes.json();

      const postRes = await handler(
        new Request('http://bridge.invalid/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Привет 🚀' }),
        }),
      );
      const postBody = await postRes.json();

      const badValRes = await handler(
        new Request('http://bridge.invalid/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'x' }),
        }),
      );
      const badValBody = await badValRes.json();

      const notFoundRes = await handler(new Request('http://bridge.invalid/unknown'));
      const notFoundBody = await notFoundRes.json();

      const methodRes = await handler(
        new Request('http://bridge.invalid/items', { method: 'DELETE' }),
      );
      const methodBody = await methodRes.json();

      const tooBigRes = await handler(
        new Request('http://bridge.invalid/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя' }),
        }),
      );
      const tooBigBody = await tooBigRes.json();

      const badQueryRes = await handler(new Request('http://bridge.invalid/items?q=%E0%A4%A'));
      const badQueryBody = await badQueryRes.json();

      return {
        getStatus: getRes.status,
        getBody,
        getRequestId: getRes.headers.get('x-request-id'),
        getCorsOrigin: getRes.headers.get('access-control-allow-origin'),
        postStatus: postRes.status,
        postBody,
        badValStatus: badValRes.status,
        badValCode: badValBody.error.code,
        notFoundStatus: notFoundRes.status,
        notFoundCode: notFoundBody.error.code,
        methodStatus: methodRes.status,
        methodCode: methodBody.error.code,
        methodAllow: methodRes.headers.get('allow'),
        tooBigStatus: tooBigRes.status,
        tooBigCode: tooBigBody.error.code,
        tooBigMessage: tooBigBody.error.message,
        badQueryStatus: badQueryRes.status,
        badQueryCode: badQueryBody.error.code,
      };
    })()`);

    expect(result.getStatus).toBe(200);
    expect(result.getBody).toEqual({ items: ['alpha'], q: 'hello' });
    expect(typeof result.getRequestId).toBe('string');
    expect(String(result.getRequestId)).toMatch(/^[a-z0-9]+-[0-9a-f]{8}$/);
    expect(result.getCorsOrigin).toBe('https://app.example');
    expect(result.postStatus).toBe(200);
    expect(result.postBody).toEqual({ created: 'Привет 🚀' });
    expect(result.badValStatus).toBe(400);
    expect(result.badValCode).toBe('VALIDATION_ERROR');
    expect(result.notFoundStatus).toBe(404);
    expect(result.notFoundCode).toBe('UNKNOWN_OPERATION');
    expect(result.methodStatus).toBe(405);
    expect(result.methodCode).toBe('METHOD_NOT_ALLOWED');
    expect(String(result.methodAllow)).toContain('GET');
    expect(String(result.methodAllow)).toContain('POST');
    expect(result.tooBigStatus).toBe(400);
    expect(result.tooBigCode).toBe('BAD_REQUEST');
    expect(String(result.tooBigMessage)).toContain('exceeds the 32-byte limit');
    expect(result.badQueryStatus).toBe(400);
    expect(result.badQueryCode).toBe('BAD_REQUEST');
  });

  test('loads and serves cleanly without global process (bare Hermes)', async () => {
    const bundle = await handlerBundlePromise;
    const realm = createRnRealm({ process: false });
    realm.evaluate(bundle, 'stitchkit-handler-noprocess.iife.js');

    const status = await realm.evaluate<Promise<number>>(`(async () => {
      const { createHandler, defineContract, implement, z } = globalThis.__sk;
      const c = defineContract(
        { prefix: 'ping' },
        { ok: { method: 'GET', path: '/', desc: 'Ping', output: z.object({ ok: z.boolean() }) } },
      );
      const handler = createHandler({
        services: [implement(c, { ok: () => ({ ok: true }) })],
        logging: true,
      });
      const res = await handler(new Request('http://bridge.invalid/ping'));
      return res.status;
    })()`);
    expect(status).toBe(200);
  });

  test('status outside 200-599 throws RangeError in whatwg-fetch and jsonResponse', async () => {
    const bundle = await handlerBundlePromise;
    const realm = createRnRealm();
    realm.evaluate(bundle, 'stitchkit-status-range.iife.js');

    const result = realm.evaluate<{ responseErr: string; jsonResponseErr: string }>(`(() => {
      const { jsonResponse } = globalThis.__sk;
      let responseErr = 'no-error';
      try {
        new Response('bad', { status: 600 });
      } catch (e) {
        responseErr = e.name;
      }
      let jsonResponseErr = 'no-error';
      try {
        jsonResponse({ bad: true }, { status: 600 });
      } catch (e) {
        jsonResponseErr = e.name;
      }
      return { responseErr, jsonResponseErr };
    })()`);
    expect(result).toEqual({ responseErr: 'RangeError', jsonResponseErr: 'RangeError' });
  });

  test('realm without whatwg-fetch fails on Request (negative control)', async () => {
    const bundle = await handlerBundlePromise;
    const realm = createRnRealm({ withWhatwgFetch: false });
    realm.evaluate(bundle, 'stitchkit-handler-nofetch.iife.js');

    const errorName = await realm.evaluate<Promise<string>>(`(async () => {
      try {
        new Request('http://bridge.invalid/ping');
        return 'no-error';
      } catch (e) {
        return e.name;
      }
    })()`);
    expect(errorName).toBe('ReferenceError');
  });

  test('jsonResponse sets default content-type, preserves custom content-type, and BigInt throws before request.complete', async () => {
    const bundle = await handlerBundlePromise;
    const realm = createRnRealm();
    realm.evaluate(bundle, 'stitchkit-json-response.iife.js');

    const out = await realm.evaluate<Promise<Record<string, unknown>>>(`(async () => {
      const { createHandler, defineContract, implement, jsonResponse, z } = globalThis.__sk;
      const defaultRes = jsonResponse({ ok: true });
      const customRes = jsonResponse(
        { title: 'Oops' },
        { status: 422, headers: { 'content-type': 'application/problem+json' } },
      );

      const completed = [];
      const contract = defineContract(
        { prefix: 'big' },
        {
          boom: {
            method: 'GET',
            path: '/',
            desc: 'Returns BigInt',
            output: z.any(),
          },
        },
      );
      const handler = createHandler({
        services: [implement(contract, { boom: () => ({ value: 123n }) })],
        observability: {
          complete: (event) => {
            completed.push({ statusCode: event.statusCode, errorCode: event.context.error?.code });
          },
        },
      });
      const res = await handler(new Request('http://bridge.invalid/big'));
      return {
        defaultType: defaultRes.headers.get('content-type'),
        customType: customRes.headers.get('content-type'),
        customStatus: customRes.status,
        boomStatus: res.status,
        completed,
      };
    })()`);

    expect(out.defaultType).toBe('application/json');
    expect(out.customType).toBe('application/problem+json');
    expect(out.customStatus).toBe(422);
    expect(out.boomStatus).toBe(500);
    // Must never record a false 200 before the BigInt serialization throw.
    expect(out.completed).toEqual([{ statusCode: 500, errorCode: 'INTERNAL_SERVER_ERROR' }]);
  });

  test('observability.complete receives serviceName, action, error.code and payload without AsyncLocalStorage', async () => {
    const bundle = await handlerBundlePromise;
    const realm = createRnRealm();
    realm.evaluate(bundle, 'stitchkit-obs-realm.iife.js');

    const out = await realm.evaluate<Promise<Record<string, unknown>>>(`(async () => {
      const { createHandler, defineContract, implement, badRequest, z } = globalThis.__sk;
      const events = [];
      const c = defineContract(
        { prefix: 'orders' },
        {
          submit: {
            method: 'POST',
            path: '/',
            desc: 'Submit order',
            input: z.object({ item: z.string() }),
            output: z.object({ ok: z.boolean() }),
          },
        },
      );
      const handler = createHandler({
        services: [
          implement(c, {
            submit: () => badRequest('out of stock'),
          }),
        ],
        observability: {
          includePayload: true,
          complete: (entry) => {
            events.push(entry);
          },
        },
      });
      const res = await handler(
        new Request('http://bridge.invalid/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ item: 'widget' }),
        }),
      );
      const first = events[0];
      return {
        status: res.status,
        serviceName: first?.context?.serviceName,
        action: first?.context?.action,
        errorCode: first?.context?.error?.code,
        payload: await first?.payload,
        payloadTruncated: await first?.payloadTruncated,
      };
    })()`);

    expect(out).toEqual({
      status: 400,
      serviceName: 'orders',
      action: 'submit',
      errorCode: 'BAD_REQUEST',
      payload: { item: 'widget' },
      payloadTruncated: false,
    });
  });

  test('createHandler refuses construction when crypto.getRandomValues is missing', async () => {
    const bundle = await handlerBundlePromise;
    const realm = createRnRealm({ withCryptoGetRandomValues: false });
    realm.evaluate(bundle, 'stitchkit-nocrypto.iife.js');

    const message = realm.evaluate<string>(`(() => {
      const { createHandler } = globalThis.__sk;
      try {
        createHandler({ services: [] });
        return 'no-error';
      } catch (e) {
        return e.message;
      }
    })()`);
    expect(message).toContain('crypto.getRandomValues');
  });

  test('createHandler refuses stream and multipart endpoints at construction when ReadableStream is missing', async () => {
    const bundle = await handlerBundlePromise;
    const realm = createRnRealm({ withReadableStream: false });
    realm.evaluate(bundle, 'stitchkit-nostream.iife.js');

    const result = realm.evaluate<{ streamError: string; multipartError: string }>(`(() => {
      const { createHandler, defineContract, implement, z } = globalThis.__sk;
      const streamContract = defineContract(
        { prefix: 'events' },
        {
          feed: {
            method: 'GET',
            path: '/feed',
            desc: 'Event stream',
            stream: { item: z.object({ n: z.number() }) },
          },
        },
      );
      const uploadContract = defineContract(
        { prefix: 'uploads' },
        {
          send: {
            method: 'POST',
            path: '/send',
            desc: 'Upload file',
            multipart: { files: { doc: { contentTypes: ['text/plain'] } } },
            output: z.object({ ok: z.boolean() }),
          },
        },
      );

      let streamError = 'no-error';
      try {
        createHandler({
          services: [
            implement(streamContract, {
              feed: async function* () {
                yield { n: 1 };
              },
            }),
          ],
        });
      } catch (e) {
        streamError = e.message;
      }

      let multipartError = 'no-error';
      try {
        createHandler({
          services: [
            implement(uploadContract, {
              send: () => ({ ok: true }),
            }),
          ],
        });
      } catch (e) {
        multipartError = e.message;
      }

      return { streamError, multipartError };
    })()`);

    expect(result.streamError).toContain('ReadableStream');
    expect(result.streamError).toContain('events.feed');
    expect(result.multipartError).toContain('ReadableStream');
    expect(result.multipartError).toContain('uploads.send');
  });
});

describe('RN 0.88 realm — stitchkit/http and stitchkit/sync', () => {
  test('stitchkit/http loads and executes a typed contract call in RN 0.88 realm', async () => {
    const bundle = await httpBundlePromise;
    const realm = createRnRealm({ withTextEncoding: true });
    realm.evaluate(bundle, 'stitchkit-http.iife.js');

    const answer = await realm.evaluate<Promise<{ ok: boolean; echo: string }>>(`(async () => {
      const { createClient, defineContract, z } = globalThis.__skHttp;
      const c = defineContract(
        { prefix: 'echo' },
        {
          say: {
            method: 'POST',
            path: '/say',
            desc: 'Echo',
            input: z.object({ text: z.string() }),
            output: z.object({ ok: z.boolean(), echo: z.string() }),
          },
        },
      );
      const client = createClient(c, {
        baseUrl: 'http://bridge.invalid',
        fetch: async (_url, init) => {
          const parsed = JSON.parse(String(init?.body ?? '{}'));
          return new Response(JSON.stringify({ ok: true, echo: parsed.text }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      });
      return client.say({ text: 'hello-rn' });
    })()`);
    expect(answer).toEqual({ ok: true, echo: 'hello-rn' });
  });

  test('a call that outlives its timeout rejects with REQUEST_TIMEOUT where no DOMException exists', async () => {
    const bundle = await httpBundlePromise;
    const realm = createRnRealm({ withTextEncoding: true });
    realm.evaluate(bundle, 'stitchkit-http.iife.js');

    // The timeout aborts with an error the realm has to be able to construct. If it cannot,
    // the timer callback throws, the signal never aborts and the call never settles.
    const outcome = await realm.evaluate<Promise<string>>(`(async () => {
      const { createClient, defineContract, z } = globalThis.__skHttp;
      const c = defineContract(
        { prefix: 'slow' },
        { ping: { method: 'GET', path: '/ping', desc: 'Ping', output: z.object({ ok: z.boolean() }) } },
      );
      const hanging = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
        });
      const client = createClient(c, { baseUrl: 'http://bridge.invalid', fetch: hanging, timeout: 50 });
      return Promise.race([
        client.ping().then(() => 'resolved', (error) => 'rejected:' + (error && error.code)),
        new Promise((resolve) => setTimeout(() => resolve('still pending after 2000ms'), 2000)),
      ]);
    })()`);
    expect(outcome).toBe('rejected:REQUEST_TIMEOUT');
  });

  test('a refresh that outlives its timeout rejects where no DOMException exists', async () => {
    const bundle = await sessionBundlePromise;
    const realm = createRnRealm();
    realm.evaluate(bundle, 'stitchkit-session.iife.js');

    const outcome = await realm.evaluate<Promise<string>>(`(async () => {
      const { createSessionCredentials, createSessionScope } = globalThis.__skSession;
      let stored = null;
      const auth = createSessionCredentials({
        scope: createSessionScope(),
        refreshTimeoutMs: 50,
        refresh: (_credentials, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
        storage: {
          read: async () => stored,
          write: async (session, credentials) => { stored = { session, credentials }; },
          clear: async () => { stored = null; },
        },
      });
      const operation = await auth.login('A', { token: 'tok-0' });
      return Promise.race([
        auth.refresh(operation).then(() => 'resolved', (error) => 'rejected:' + (error && error.name)),
        new Promise((resolve) => setTimeout(() => resolve('still pending after 2000ms'), 2000)),
      ]);
    })()`);
    expect(outcome).toBe('rejected:TimeoutError');
  });

  test('stitchkit/sync loads and executes decideOutboxBatch, syncPushRequestSchema + createSyncSession without TextEncoder or crypto.randomUUID', async () => {
    const bundle = await syncBundlePromise;
    const realm = createRnRealm();
    realm.evaluate(bundle, 'stitchkit-sync.iife.js');

    const result = await realm.evaluate<
      Promise<{
        sendCount: number;
        sentRequests: number;
        sessionId: string;
        requestId: string;
        pushSmallOk: boolean;
        pushLargeOk: boolean;
      }>
    >(
      `(async () => {
        const { decideOutboxBatch, createSyncSession, syncPushRequestSchema, z } = globalThis.__skSync;
        const decision = decideOutboxBatch(
          [
            {
              id: 'c1',
              entity: 'note',
              entityId: 'n1',
              payloadJson: JSON.stringify({ title: 'Привет 🚀' }),
              status: 'pending',
              sentAt: null,
              attempts: 0,
            },
          ],
          {
            now: 1_000,
            policy: {
              toChange: (row, payload) => ({ id: row.id, payload }),
              emptyEnvelopeBytes: 32,
              maxBytes: 16384,
              maxChanges: 10,
              retryAfterMs: 5_000,
            },
          },
        );
        const pushSchema = syncPushRequestSchema(z.object({ text: z.string() }), {
          maxChanges: 10,
          maxBytes: 32,
        });
        const pushSmall = pushSchema.safeParse({ changes: [{ text: 'hi' }] });
        const pushLarge = pushSchema.safeParse({
          changes: [{ text: 'Привет 🚀 Привет 🚀' }],
        });
        const requests = [];
        const session = createSyncSession({
          isConnected: () => true,
          readCursor: () => 1,
          beginFullSync: () => undefined,
          send: (req) => requests.push(req),
          apply: () => undefined,
          saveCursor: () => undefined,
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        });
        await session.requestSync();
        session.stop();
        return {
          sendCount: decision.send.length,
          sentRequests: requests.length,
          sessionId: String(requests[0]?.sessionId ?? ''),
          requestId: String(requests[0]?.requestId ?? ''),
          pushSmallOk: pushSmall.success,
          pushLargeOk: pushLarge.success,
        };
      })()`,
    );
    expect(result.sendCount).toBe(1);
    expect(result.sentRequests).toBe(1);
    expect(result.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.sessionId).not.toBe(result.requestId);
    expect(result.pushSmallOk).toBe(true);
    expect(result.pushLargeOk).toBe(false);
  });

  test('createSyncSession refuses construction without newId when crypto.getRandomValues is absent (negative control)', async () => {
    const bundle = await syncBundlePromise;
    const realm = createRnRealm({ withCryptoGetRandomValues: false });
    realm.evaluate(bundle, 'stitchkit-sync-nocrypto.iife.js');

    const failure = realm.evaluate<{ name: string; message: string }>(`(() => {
      const { createSyncSession } = globalThis.__skSync;
      try {
        createSyncSession({
          isConnected: () => true,
          readCursor: () => 1,
          beginFullSync: () => undefined,
          send: () => undefined,
          apply: () => undefined,
          saveCursor: () => undefined,
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        });
        return { name: 'no-error', message: '' };
      } catch (e) {
        return { name: e.name, message: e.message };
      }
    })()`);
    expect(failure.name).toBe('TypeError');
    expect(failure.message).toContain('newId');
  });

  test('upload-progress native-xhr works without TextEncoder, ReadableStream, FormData, or Blob', async () => {
    const bundle = await uploadProgressBundlePromise;
    const realm = createRnRealm();
    realm.evaluate(bundle, 'stitchkit-upload-progress.iife.js');

    const result = await realm.evaluate<
      Promise<{
        route: string;
        status: number;
        events: Array<{ sentBytes: number; totalBytes: number; attempt: number }>;
        streamErrorName: string;
        streamErrorMessage: string;
      }>
    >(`(async () => {
      const { uploadProgressRoute, withUploadProgress } = globalThis.__skUpload;
      globalThis.navigator = { product: 'ReactNative' };
      class FakeRnXhr {
        constructor() {
          this.upload = {};
          this.headers = new Map();
        }
        open() {}
        setRequestHeader(name, value) {
          this.headers.set(name.toLowerCase(), value);
        }
        getAllResponseHeaders() {
          return 'content-type: application/json\\r\\n';
        }
        abort() {
          this.onabort?.();
        }
        send(body) {
          const total = typeof body === 'string' ? 28 : 0;
          this.upload.onprogress?.({ loaded: 10, total });
          this.upload.onload?.();
          this.status = 200;
          this.statusText = 'OK';
          this.response = new ArrayBuffer(0);
          this.onload?.();
        }
      }
      globalThis.XMLHttpRequest = FakeRnXhr;

      const route = uploadProgressRoute(false);
      const events = [];
      const transport = withUploadProgress(
        async () => new Response(null, { status: 200 }),
        (progress) => events.push(progress),
        { route },
      );
      const payload = JSON.stringify({ text: 'Привет 🚀' });
      const res = await transport('http://bridge.invalid/note', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });

      let streamErrorName = 'no-error';
      let streamErrorMessage = '';
      try {
        await transport('http://bridge.invalid/note', {
          method: 'POST',
          body: { getReader: () => ({}) },
        });
      } catch (e) {
        streamErrorName = e.name;
        streamErrorMessage = e.message;
      }

      return {
        route,
        status: res.status,
        events,
        streamErrorName,
        streamErrorMessage,
      };
    })()`);

    expect(result.route).toBe('native-xhr');
    expect(result.status).toBe(200);
    // JSON.stringify({ text: 'Привет 🚀' }) = '{"text":"Привет 🚀"}' = 12 ASCII + 12 Cyrillic + 4 emoji = 28 UTF-8 bytes
    expect(result.events).toEqual([
      { sentBytes: 0, totalBytes: 28, attempt: 1 },
      { sentBytes: 10, totalBytes: 28, attempt: 1 },
      { sentBytes: 28, totalBytes: 28, attempt: 1 },
    ]);
    expect(result.streamErrorName).toBe('TypeError');
    expect(result.streamErrorMessage).toContain('streamed body');
  });
});
