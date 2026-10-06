import { afterEach, describe, expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { createServer, type Server, Socket } from 'node:net';
import {
  callTelegramBotApi,
  classifyTelegramSendFailure,
  createTelegramBotTransport,
  createTelegramOperatorChannel,
  type TelegramBotTransportOpen,
  TelegramNotDispatchedError,
} from '../src/entrypoints/telegram';
import { classifyBotBroadcastFailure } from '../src/telegram/broadcast-failure';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A local HTTP/1.1 server that answers each request with `answer(request)`. */
async function serve(
  answer: (request: string, socket: Socket) => void,
): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((socket) => {
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      const headEnd = received.indexOf('\r\n\r\n');
      if (headEnd < 0) return;
      const length = Number(/content-length: (\d+)/i.exec(received)?.[1] ?? 0);
      if (received.length < headEnd + 4 + length) return;
      requests.push(received);
      answer(received, socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, requests };
}

/** A port nothing listens on: bound once, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

const json = (status: number, body: unknown) => {
  const text = JSON.stringify(body);
  return `HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`;
};

/** Plain TCP to the local server whatever the scheme says, so tests need no certificate. */
const plain: TelegramBotTransportOpen = ({ address, port }) =>
  new Socket().connect(port, address);

describe('createTelegramBotTransport', () => {
  test('a call returns its result over the transport and sends the JSON body', async () => {
    const { port, requests } = await serve((_, socket) =>
      socket.end(json(200, { ok: true, result: { message_id: 7 } })),
    );
    const result = await callTelegramBotApi({
      token: '123:secret',
      method: 'sendMessage',
      params: { chat_id: 1, text: 'hi' },
      apiRoot: `http://127.0.0.1:${port}`,
      fetch: createTelegramBotTransport({ open: plain }),
    });
    expect(result).toEqual({ message_id: 7 });
    const [request] = requests;
    expect(request).toStartWith('POST /bot123:secret/sendMessage HTTP/1.1\r\n');
    expect(request).toContain('Connection: close');
    expect(request).toEndWith('{"chat_id":1,"text":"hi"}');
  });

  test('a chunked answer and a Telegram refusal keep their meaning', async () => {
    const body = JSON.stringify({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 3',
      parameters: { retry_after: 3 },
    });
    const { port } = await serve((_, socket) =>
      socket.end(
        `HTTP/1.1 429 X\r\ntransfer-encoding: chunked\r\n\r\n${(10).toString(16)}\r\n${body.slice(0, 10)}\r\n${(body.length - 10).toString(16)}\r\n${body.slice(10)}\r\n0\r\n\r\n`,
      ),
    );
    const failure = await callTelegramBotApi({
      token: '1:s',
      method: 'sendMessage',
      apiRoot: `http://127.0.0.1:${port}`,
      fetch: createTelegramBotTransport({ open: plain }),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(classifyTelegramSendFailure(failure)).toMatchObject({
      reason: 'rate-limited',
      retryAfterSeconds: 3,
    });
  });

  test('a refused connection is not dispatched: retryable, and a broadcast retries it', async () => {
    const port = await closedPort();
    const failure = await callTelegramBotApi({
      token: '1:s',
      method: 'sendMessage',
      apiRoot: `http://127.0.0.1:${port}`,
      fetch: createTelegramBotTransport({
        open: plain,
        connectAttemptMs: 200,
        connectBudgetMs: 400,
      }),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TelegramNotDispatchedError);
    expect(failure).toMatchObject({ stage: 'connect', code: 'TELEGRAM_NOT_DISPATCHED' });
    expect(String(failure)).not.toContain('secret');
    expect(classifyTelegramSendFailure(failure)).toEqual({
      reason: 'not-dispatched',
      retryable: true,
      recipientUnreachable: false,
      evidence: 'transport',
    });
    expect(classifyBotBroadcastFailure(failure)).toMatchObject({ kind: 'transient' });
  });

  test('a connection dropped after the request was written stays unknown and is never retried', async () => {
    const { port, requests } = await serve((_, socket) => socket.destroy());
    const failure = await callTelegramBotApi({
      token: '1:s',
      method: 'sendMessage',
      apiRoot: `http://127.0.0.1:${port}`,
      fetch: createTelegramBotTransport({ open: plain }),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(requests).toHaveLength(1);
    expect(failure).not.toBeInstanceOf(TelegramNotDispatchedError);
    expect(classifyTelegramSendFailure(failure)).toMatchObject({
      reason: 'unknown',
      retryable: false,
    });
    expect(classifyBotBroadcastFailure(failure)).toMatchObject({ kind: 'ambiguous' });
  });

  test('a lookup failure is not dispatched at the lookup stage', async () => {
    const transport = createTelegramBotTransport({
      resolve: async () => {
        throw new Error('NXDOMAIN');
      },
    });
    const failure = await transport('https://api.telegram.org/bot1:s/getMe', {}).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ name: 'TelegramNotDispatchedError', stage: 'lookup' });
  });

  test('a silent address loses the race to the next one (Happy Eyeballs)', async () => {
    const { port } = await serve((_, socket) =>
      socket.end(json(200, { ok: true, result: 1 })),
    );
    const opened: string[] = [];
    const transport = createTelegramBotTransport({
      resolve: async () => ['192.0.2.1', '127.0.0.1'],
      open: ({ address }) => {
        opened.push(address);
        // 192.0.2.1 (TEST-NET-1) never answers; a socket that never connects stands for it.
        return address === '127.0.0.1' ? new Socket().connect(port, address) : new Socket();
      },
    });
    const response = await transport(`http://bot.example:${port}/bot1:s/getMe`, {
      method: 'POST',
    });
    expect(await response.json()).toEqual({ ok: true, result: 1 });
    expect(opened).toEqual(['192.0.2.1', '127.0.0.1']);
  });

  test('a connection that never comes is not dispatched within the budget', async () => {
    const started = performance.now();
    const failure = await createTelegramBotTransport({
      resolve: async () => ['192.0.2.1'],
      open: () => new Socket(),
      connectAttemptMs: 50,
      connectBudgetMs: 120,
    })('https://api.telegram.org/bot1:s/getMe', {}).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ stage: 'connect' });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('an answer past the size limit or the time limit is an unknown outcome', async () => {
    const { port } = await serve((_, socket) =>
      socket.end(json(200, { big: 'x'.repeat(4096) })),
    );
    const tooLarge = await createTelegramBotTransport({ open: plain, maxResponseBytes: 1024 })(
      `http://127.0.0.1:${port}/bot1:s/getMe`,
      {},
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(tooLarge)).toContain('exceeded 1024 bytes');
    expect(tooLarge).not.toBeInstanceOf(TelegramNotDispatchedError);

    const silent = await serve(() => undefined);
    const tooSlow = await createTelegramBotTransport({ open: plain, responseTimeoutMs: 50 })(
      `http://127.0.0.1:${silent.port}/bot1:s/getMe`,
      {},
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(tooSlow)).toContain('longer than 50 ms');
    expect(silent.requests).toHaveLength(1);
  });

  test('an abort rejects with its reason', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(
      createTelegramBotTransport()('https://api.telegram.org/bot1:s/getMe', {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  test('a multipart body is serialised with its boundary', async () => {
    const { port, requests } = await serve((_, socket) =>
      socket.end(json(200, { ok: true, result: true })),
    );
    const form = new FormData();
    form.set('chat_id', '1');
    await createTelegramBotTransport({ open: plain })(
      `http://127.0.0.1:${port}/bot1:s/sendDocument`,
      {
        method: 'POST',
        body: form,
      },
    );
    const [request] = requests;
    expect(request).toMatch(/content-type: multipart\/form-data; boundary=/i);
    expect(request).toContain('name="chat_id"');
  });

  test('a framed answer completes before the server closes the connection', async () => {
    const { port } = await serve((_, socket) =>
      // Content-Length framing, connection left open: the answer is complete anyway.
      socket.write(json(200, { ok: true, result: 'kept-alive' })),
    );
    const started = performance.now();
    const response = await createTelegramBotTransport({
      open: plain,
      responseTimeoutMs: 5_000,
    })(`http://127.0.0.1:${port}/bot1:s/getMe`, {});
    expect(await response.json()).toEqual({ ok: true, result: 'kept-alive' });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('the transport frames the request: caller framing headers are not repeated', async () => {
    const { port, requests } = await serve((_, socket) =>
      socket.end(json(200, { ok: true, result: true })),
    );
    await createTelegramBotTransport({ open: plain })(
      `http://127.0.0.1:${port}/bot1:s/getMe`,
      {
        method: 'POST',
        headers: { 'content-length': '999', connection: 'keep-alive', 'x-trace': 'a' },
        body: '{}',
      },
    );
    const [request] = requests;
    expect(request?.match(/content-length/gi)).toHaveLength(1);
    expect(request?.match(/^connection:/gim)).toHaveLength(1);
    expect(request).toContain('x-trace: a');
  });

  test('an abort during a lookup that never answers rejects at once', async () => {
    const controller = new AbortController();
    const pending = createTelegramBotTransport({
      resolve: () => new Promise(() => undefined),
    })('https://api.telegram.org/bot1:s/getMe', { signal: controller.signal });
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test('the operator channel sends a not-dispatched message again', async () => {
    let calls = 0;
    const channel = createTelegramOperatorChannel({
      chatId: 1,
      minIntervalMs: 1,
      send: async () => {
        calls += 1;
        if (calls === 1) throw new TelegramNotDispatchedError('connect', 'no connection');
      },
      sleep: async () => undefined,
    });
    channel.post('alert');
    await channel.drain();
    expect(calls).toBe(2);
  });
});

describe('every wait of the transport is bounded or abortable', () => {
  test('a lookup that never answers is not dispatched within the connection budget', async () => {
    const started = performance.now();
    const failure = await createTelegramBotTransport({
      resolve: () => new Promise(() => undefined),
      connectBudgetMs: 100,
    })('https://api.telegram.org/bot1:s/getMe', {}).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ name: 'TelegramNotDispatchedError', stage: 'lookup' });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('a shared signal keeps no listener from a finished call', async () => {
    const { port } = await serve((_, socket) =>
      socket.end(json(200, { ok: true, result: true })),
    );
    const controller = new AbortController();
    const transport = createTelegramBotTransport({
      open: plain,
      resolve: async () => ['127.0.0.1'],
    });
    for (let call = 0; call < 5; call++)
      await transport(`http://bot.example:${port}/bot1:s/getMe`, {
        method: 'POST',
        signal: controller.signal,
      });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('an abort ends the read of a request body that never finishes', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    // A streamed request body needs `duplex`, which the DOM `RequestInit` type does not declare.
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      body,
      duplex: 'half',
      signal: controller.signal,
    };
    const pending = createTelegramBotTransport()(
      'https://api.telegram.org/bot1:s/sendDocument',
      init,
    );
    const reason = new Error('stop');
    setTimeout(() => controller.abort(reason), 30);
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (error: unknown) => (error === reason ? 'rejected' : 'other'),
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1_000)),
    ]);
    expect(outcome).toBe('rejected');
  });

  test('a socket that connected as the caller aborted is closed, not left open', async () => {
    const socket = new Socket();
    const controller = new AbortController();
    const reason = new Error('stop');
    const pending = createTelegramBotTransport({
      resolve: async () => ['127.0.0.1'],
      open: () => socket,
    })('http://bot.example/bot1:s/getMe', { signal: controller.signal });
    while (socket.listenerCount('connect') === 0) await Bun.sleep(5);
    socket.emit('connect');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(socket.destroyed).toBe(true);
  });
});

describe('the transport frames what it reads', () => {
  const answerWith = async (raw: string) => {
    const { port } = await serve((_, socket) => socket.end(raw));
    return createTelegramBotTransport({ open: plain })(
      `http://127.0.0.1:${port}/bot1:s/getMe`,
      {},
    );
  };
  const failureOf = (promise: Promise<Response>) =>
    promise.then(
      () => null,
      (error: unknown) => error,
    );

  test('one length repeated is one declaration; two different ones are refused', async () => {
    const head = 'HTTP/1.1 200 X\r\ncontent-type: application/json\r\n';
    const response = await answerWith(`${head}content-length: 11, 11\r\n\r\n{"ok":true}`);
    expect(await response.json()).toEqual({ ok: true });
    const conflict = await failureOf(
      answerWith(`${head}content-length: 11, 12\r\n\r\n{"ok":true}`),
    );
    expect(String(conflict)).toContain('invalid Content-Length');
    expect(conflict).not.toBeInstanceOf(TelegramNotDispatchedError);
  });

  test('chunks frame the body and a length beside them is dropped', async () => {
    const response = await answerWith(
      'HTTP/1.1 200 X\r\ntransfer-encoding: chunked\r\ncontent-length: 3\r\n\r\nb\r\n{"ok":true}\r\n0\r\n\r\n',
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('content-length')).toBeNull();
  });

  test('an interim answer is named as one, not a final answer', async () => {
    const failure = await failureOf(answerWith('HTTP/1.1 100 Continue\r\n\r\n'));
    expect(String(failure)).toContain('interim response (HTTP 100)');
  });
});

describe('a not-dispatched error crosses the sender unchanged', () => {
  const rejectWith = (error: Error) =>
    callTelegramBotApi({
      token: '1:secret',
      method: 'getMe',
      fetch: async () => {
        throw error;
      },
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );

  test("another copy of the package's error keeps its meaning", async () => {
    const foreign = Object.assign(new Error('no connection'), {
      name: 'TelegramNotDispatchedError',
      code: 'TELEGRAM_NOT_DISPATCHED',
    });
    const thrown = await rejectWith(foreign);
    expect(thrown).toBe(foreign);
    expect(classifyTelegramSendFailure(thrown).reason).toBe('not-dispatched');
  });

  test('an error that only carries the code is not trusted to hold no address', async () => {
    const carrier = Object.assign(
      new Error('https://api.telegram.org/bot1:secret/getMe failed'),
      {
        code: 'TELEGRAM_NOT_DISPATCHED',
      },
    );
    const thrown = await rejectWith(carrier);
    expect(thrown).not.toBe(carrier);
    expect(String(thrown)).not.toContain('secret');
  });
});
