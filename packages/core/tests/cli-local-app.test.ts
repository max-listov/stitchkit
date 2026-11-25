import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  cliExitCode,
  createCli,
  createCliInvoker,
  DEFAULT_EXIT_CODES,
} from '../src/entrypoints/cli';
import { defineContract } from '../src/entrypoints/contract';
import { createHttpClient } from '../src/entrypoints/http';
import { implementRemote } from '../src/entrypoints/remote';
import {
  createServer,
  createUnixClientTransport,
  implement,
  type UnixClientTransport,
} from '../src/entrypoints/server';
import { defineRuntimeTool } from '../src/entrypoints/tools';
import { UnixClientTransportError } from '../src/internal/unix-client-error';
import { projectCliUnixFailure } from '../src/tools/cli/unix-outcome';
import { toolResultFromError } from '../src/tools/execute-result';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const LocalAppContract = defineContract(
  { prefix: '/local', scope: 'public' },
  {
    whoami: {
      method: 'GET',
      path: '/whoami',
      desc: 'Identify the running local application instance',
      expose: ['HTTP', 'CLI'],
      tool: { name: 'local_whoami' },
      output: z.object({ app: z.string() }),
    },
    create: {
      method: 'POST',
      path: '/create',
      desc: 'Create an item (non-idempotent)',
      expose: ['HTTP', 'CLI'],
      tool: { name: 'local_create' },
      input: z.object({ title: z.string() }),
      output: z.object({ created: z.string() }),
    },
    sync: {
      method: 'POST',
      path: '/sync',
      desc: 'Synchronize an item (idempotent)',
      expose: ['HTTP', 'CLI'],
      idempotent: true,
      tool: { name: 'local_sync' },
      input: z.object({ title: z.string() }),
      output: z.object({ synced: z.string() }),
    },
  },
);

const tempDirs: string[] = [];

function makePrivateSocketDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sk-la-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runLocalCli(argv: string[], defaultSocket: string) {
  let out = '';
  let err = '';
  let code = -1;
  const transports: UnixClientTransport[] = [];
  try {
    await createCli({
      access: { open: 'local-operator' },
      name: 'local-app',
      version: '1.0.0',
      globalOptions: z.object({ socket: z.string().optional() }),
      services: (_auth, globals) => {
        const transport = createUnixClientTransport({
          socketPath: globals.socket ?? defaultSocket,
        });
        transports.push(transport);
        const http = createHttpClient({
          baseUrl: 'http://local-app',
          fetch: transport.fetch,
        });
        return [implementRemote(LocalAppContract, http)];
      },
      argv,
      stdin: async () => null,
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      exit: (value) => {
        code = value;
      },
    });
  } finally {
    await Promise.all(transports.map((t) => t.close()));
  }
  return { out, err, code, closedAll: transports.every((t) => t.closed) };
}

describe('CLI targeting a local application over a unix socket', () => {
  test('services and runtimeTools factories receive parsed globals to select the local unix socket', async () => {
    const dir = makePrivateSocketDir();
    const socketA = join(dir, 'a.sock');
    const socketB = join(dir, 'b.sock');
    expect(Buffer.byteLength(socketA)).toBeLessThanOrEqual(103);
    expect(Buffer.byteLength(socketB)).toBeLessThanOrEqual(103);

    const serverA = createServer({
      unix: { path: socketA, mode: 0o600 },
      logging: false,
      services: [
        implement(LocalAppContract, {
          whoami: async () => ({ app: 'alpha' }),
          create: async ({ input }) => ({ created: `alpha:${input.title}` }),
          sync: async ({ input }) => ({ synced: `alpha:${input.title}` }),
        }),
      ],
    });
    const serverB = createServer({
      unix: { path: socketB, mode: 0o600 },
      logging: false,
      services: [
        implement(LocalAppContract, {
          whoami: async () => ({ app: 'beta' }),
          create: async ({ input }) => ({ created: `beta:${input.title}` }),
          sync: async ({ input }) => ({ synced: `beta:${input.title}` }),
        }),
      ],
    });

    try {
      const hitA = await runLocalCli(['--socket', socketA, 'local_whoami', '--json'], socketA);
      expect(hitA.code).toBe(0);
      expect(hitA.err).toBe('');
      expect(hitA.closedAll).toBe(true);
      expect(JSON.parse(hitA.out)).toEqual({ app: 'alpha' });

      const hitB = await runLocalCli(['local_whoami', '--socket', socketB, '--json'], socketA);
      expect(hitB.code).toBe(0);
      expect(hitB.err).toBe('');
      expect(hitB.closedAll).toBe(true);
      expect(JSON.parse(hitB.out)).toEqual({ app: 'beta' });

      // `runtimeTools` factory and `createCliInvoker` also receive parsed globals.
      const invokerTransports: UnixClientTransport[] = [];
      try {
        const invoker = await createCliInvoker(
          {
            access: { open: 'local-operator' },
            name: 'local-app',
            globalOptions: z.object({ socket: z.string().optional() }),
            services: (_auth, globals) => {
              const transport = createUnixClientTransport({
                socketPath: globals.socket ?? socketA,
              });
              invokerTransports.push(transport);
              return [
                implementRemote(
                  LocalAppContract,
                  createHttpClient({ baseUrl: 'http://local-app', fetch: transport.fetch }),
                ),
              ];
            },
            runtimeTools: (_auth, globals) => [
              defineRuntimeTool({
                name: 'echo_socket',
                description: 'Report selected socket',
                identity: { serviceName: 'local', action: 'echo', method: 'GET' },
                expose: ['CLI'],
                input: z.object({}),
                output: z.object({ socket: z.string().optional() }),
                handler: () => ({ socket: globals.socket }),
              }),
            ],
          },
          { socket: socketB },
        );
        expect(await invoker.invoke('local_whoami', {})).toEqual({
          ok: true,
          exitCode: 0,
          data: { app: 'beta' },
        });
        expect(await invoker.invoke('echo_socket', {})).toEqual({
          ok: true,
          exitCode: 0,
          data: { socket: socketB },
        });
      } finally {
        await Promise.all(invokerTransports.map((t) => t.close()));
      }

      // Real subprocess exits cleanly after closing its unix transport (no dangling handle).
      const scriptPath = join(dir, 'cli-entry.ts');
      const entryRoot = join(import.meta.dir, '../src/entrypoints');
      writeFileSync(
        scriptPath,
        `import { z } from 'zod';
import { createHttpClient } from '${entryRoot}/http.ts';
import { createCli } from '${entryRoot}/cli.ts';
import { defineContract } from '${entryRoot}/contract.ts';
import { createUnixClientTransport } from '${entryRoot}/server.ts';
import { implementRemote } from '${entryRoot}/remote.ts';

const contract = defineContract({ prefix: '/local', scope: 'public' }, {
  whoami: {
    method: 'GET',
    path: '/whoami',
    desc: 'Identify app',
    expose: ['HTTP', 'CLI'],
    tool: { name: 'local_whoami' },
    output: z.object({ app: z.string() }),
  },
});

let transport: ReturnType<typeof createUnixClientTransport> | undefined;
try {
  await createCli({
    name: 'local-app',
    version: '1.0.0',
    access: { open: 'remote' },
    globalOptions: z.object({ socket: z.string() }),
    services: (_auth, globals) => {
      transport = createUnixClientTransport({ socketPath: globals.socket });
      return [implementRemote(contract, createHttpClient({ baseUrl: 'http://local-app', fetch: transport.fetch }))];
    },
  });
} finally {
  await transport?.close();
}
`,
      );
      const child = Bun.spawn(
        [process.execPath, scriptPath, '--socket', socketB, 'local_whoami', '--json'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      trackProcess(child.pid);
      const exitCode = await child.exited;
      const stdoutText = await new Response(child.stdout).text();
      const stderrText = await new Response(child.stderr).text();
      expect(exitCode).toBe(0);
      expect(stderrText).toBe('');
      expect(JSON.parse(stdoutText)).toEqual({ app: 'beta' });
    } finally {
      await Promise.all([serverA.shutdown(), serverB.shutdown()]);
    }
  });

  test('distinguishes possibly-dispatched, not-dispatched, and response-received unix outcomes', async () => {
    const dir = makePrivateSocketDir();
    const dropSocket = join(dir, 'drop.sock');
    const missingSocket = join(dir, 'missing.sock');
    const symlinkSocket = join(dir, 'link.sock');
    let handlerCalls = 0;
    let mode: 'drop-all' | 'drop-once-then-ok' | 'partial-response' = 'drop-all';

    const rawServer = createNetServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const headEnd = buffer.indexOf('\r\n\r\n');
        if (headEnd === -1) return;
        const lengthMatch = /content-length:\s*(\d+)/i.exec(buffer.slice(0, headEnd));
        const expectedBodyBytes = lengthMatch ? Number(lengthMatch[1]) : 0;
        if (Buffer.byteLength(buffer.slice(headEnd + 4)) < expectedBodyBytes) return;
        handlerCalls += 1;
        if (mode === 'drop-once-then-ok' && handlerCalls >= 2) {
          const body = JSON.stringify({ synced: 'ok' });
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
          return;
        }
        if (mode === 'partial-response') {
          socket.write(
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\nConnection: close\r\n\r\n{"partial":true',
          );
          socket.destroy();
          return;
        }
        socket.destroy();
      });
    });

    await new Promise<void>((resolve, reject) => {
      rawServer.once('error', reject);
      rawServer.listen(dropSocket, () => {
        rawServer.off('error', reject);
        resolve();
      });
    });
    symlinkSync(dropSocket, symlinkSocket);

    try {
      // 1. Non-idempotent POST dropped after body: handler ran once, CLI reports unknown outcome and never retries.
      handlerCalls = 0;
      mode = 'drop-all';
      const uncertain = await runLocalCli(
        ['--socket', dropSocket, 'local_create', '--title', 'one', '--json'],
        dropSocket,
      );
      expect(handlerCalls).toBe(1);
      expect(uncertain.out).toBe('');
      expect(DEFAULT_EXIT_CODES.UNIX_DELIVERY_UNCERTAIN).toBe(10);
      expect(uncertain.code).toBe(10);
      const uncertainErr = JSON.parse(uncertain.err);
      expect(uncertainErr.error).toBe('UNIX_DELIVERY_UNCERTAIN');
      expect(uncertainErr.retryable).toBe(false);
      expect(uncertainErr.details.delivery).toBe('possibly-dispatched');
      expect(uncertainErr.details.message).toContain('Outcome unknown, not retried');

      // 2. Positive control: idempotent POST dropped on attempt 1 retries and succeeds on attempt 2.
      handlerCalls = 0;
      mode = 'drop-once-then-ok';
      const retried = await runLocalCli(
        ['--socket', dropSocket, 'local_sync', '--title', 'two', '--json'],
        dropSocket,
      );
      expect(handlerCalls).toBe(2);
      expect(retried.code).toBe(0);
      expect(retried.err).toBe('');
      expect(JSON.parse(retried.out)).toEqual({ synced: 'ok' });

      // 3. Missing socket: handler never ran, distinct not-dispatched exit code and message.
      handlerCalls = 0;
      const missing = await runLocalCli(
        ['--socket', missingSocket, 'local_create', '--title', 'three', '--json'],
        missingSocket,
      );
      expect(handlerCalls).toBe(0);
      expect(missing.out).toBe('');
      expect(DEFAULT_EXIT_CODES.UNIX_CONNECT_FAILED).toBe(9);
      expect(missing.code).toBe(9);
      expect(missing.code).not.toBe(uncertain.code);
      const missingErr = JSON.parse(missing.err);
      expect(missingErr.error).toBe('UNIX_CONNECT_FAILED');
      expect(missingErr.details.delivery).toBe('not-dispatched');
      expect(missingErr.details.socketPath).toBe(missingSocket);
      expect(missingErr.details.message).toContain('Not executed');
      expect(missingErr.details.message).toContain('not listening');
      expect(missingErr.details.message).toContain(missingSocket);

      // 4. Refused unix target (symlink): handler never ran, not-dispatched exit code, non-retryable.
      handlerCalls = 0;
      const refused = await runLocalCli(
        ['--socket', symlinkSocket, 'local_create', '--title', 'four', '--json'],
        symlinkSocket,
      );
      expect(handlerCalls).toBe(0);
      expect(DEFAULT_EXIT_CODES.UNIX_TARGET_REFUSED).toBe(9);
      expect(refused.code).toBe(9);
      const refusedErr = JSON.parse(refused.err);
      expect(refusedErr.error).toBe('UNIX_TARGET_REFUSED');
      expect(refusedErr.retryable).toBe(false);
      expect(refusedErr.details.delivery).toBe('not-dispatched');
      expect(refusedErr.details.message).toContain('Not executed');
      expect(refusedErr.details.message).toContain('must not be a symlink');

      // 5. Response aborted after headers: delivery is response-received, NOT confused with 9 or 10.
      handlerCalls = 0;
      mode = 'partial-response';
      const aborted = await runLocalCli(
        ['--socket', dropSocket, 'local_create', '--title', 'five', '--json'],
        dropSocket,
      );
      expect(handlerCalls).toBe(1);
      expect(aborted.code).toBe(1);
      expect(aborted.code).not.toBe(missing.code);
      expect(aborted.code).not.toBe(uncertain.code);
      const abortedErr = JSON.parse(aborted.err);
      expect(abortedErr.error).toBe('UNIX_RESPONSE_ABORTED');
      expect(abortedErr.retryable).toBe(false);
      expect(abortedErr.details.delivery).toBe('response-received');
    } finally {
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    }
  });

  test('projectCliUnixFailure maps UNIX_CLIENT_CLOSED deliveries and UNIX_HEADERS_TIMEOUT to distinct codes', () => {
    const closedBefore = projectCliUnixFailure(
      toolResultFromError(
        new UnixClientTransportError(
          'UNIX_CLIENT_CLOSED',
          'Unix client transport is closed',
          'not-dispatched',
          { socketPath: '/tmp/app.sock' },
        ),
      ),
    );
    expect(closedBefore.code).toBe('UNIX_CLIENT_CLOSED');
    expect(cliExitCode(closedBefore)).toBe(9);
    expect(closedBefore.retryable).toBe(false);
    expect(closedBefore.details).toMatchObject({
      delivery: 'not-dispatched',
      socketPath: '/tmp/app.sock',
    });

    const closedAfter = projectCliUnixFailure(
      toolResultFromError(
        new UnixClientTransportError(
          'UNIX_CLIENT_CLOSED',
          'Unix client transport is closed',
          'possibly-dispatched',
          { socketPath: '/tmp/app.sock' },
        ),
      ),
    );
    expect(closedAfter.code).toBe('UNIX_DELIVERY_UNCERTAIN');
    expect(cliExitCode(closedAfter)).toBe(10);
    expect(closedAfter.retryable).toBe(false);
    expect(closedAfter.details).toMatchObject({
      delivery: 'possibly-dispatched',
      socketPath: '/tmp/app.sock',
    });

    const timedOut = projectCliUnixFailure(
      toolResultFromError(
        new UnixClientTransportError(
          'UNIX_HEADERS_TIMEOUT',
          'Unix response headers did not arrive within 5000ms',
          'possibly-dispatched',
          { socketPath: '/tmp/app.sock' },
        ),
      ),
    );
    expect(timedOut.code).toBe('UNIX_HEADERS_TIMEOUT');
    expect(cliExitCode(timedOut)).toBe(10);
    expect(timedOut.retryable).toBe(false);
    expect(timedOut.details).toMatchObject({
      delivery: 'possibly-dispatched',
      socketPath: '/tmp/app.sock',
      message: expect.stringContaining('Outcome unknown, not retried'),
    });
  });
});
