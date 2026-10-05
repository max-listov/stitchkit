import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShellOutputSchema } from '../src/agent-runtime/coding-tool-contract';
import type { AgentProcessSandbox, AgentSandboxProcess } from '../src/agent-runtime/sandbox';
import { createAgentCodingTools } from '../src/entrypoints/agent-runtime/coding-tools';
import { mountAgent } from '../src/entrypoints/tools';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A host launcher with the public structural surface, without Node Readable methods or a host PID. */
function structuralLauncher(bytes: number, finish: boolean) {
  let destroyed = 0;
  let kills = 0;
  const spawn = (): AgentSandboxProcess => {
    const childEvents = new EventEmitter();
    let exitCode: number | null = null;
    let signalCode: string | null = null;
    const pipe = () => {
      const events = new EventEmitter();
      let closed = false;
      return {
        events,
        stream: {
          get destroyed() {
            return closed;
          },
          on(event: 'data', listener: (chunk: Uint8Array) => void) {
            events.on(event, listener);
          },
          destroy() {
            if (!closed) destroyed++;
            closed = true;
          },
        },
      };
    };
    const stdout = pipe();
    const stderr = pipe();
    const close = () => {
      childEvents.emit('exit', exitCode, signalCode);
      childEvents.emit('close', exitCode, signalCode);
    };
    setTimeout(() => {
      stdout.events.emit('data', Buffer.alloc(bytes, 'a'));
      if (finish) {
        exitCode = 0;
        close();
      }
    }, 5);
    return {
      get exitCode() {
        return exitCode;
      },
      get signalCode() {
        return signalCode;
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
      on: childEvents.on.bind(childEvents),
      kill(signal) {
        kills++;
        signalCode = signal;
        queueMicrotask(close);
        return true;
      },
    };
  };
  const adapter: AgentProcessSandbox = {
    probe: () => ({ grade: 'full', restrictions: [] }),
    prepare: (command) => command,
    spawn,
  };
  return {
    adapter,
    get destroyed() {
      return destroyed;
    },
    get kills() {
      return kills;
    },
  };
}

async function tool(root: string, adapter: AgentProcessSandbox, artifact = false) {
  let saved: Uint8Array | undefined;
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root,
      authorize: () => true,
      executables: { test: process.execPath },
      sandbox: { adapter, required: [] },
      limits: { maxShellOutputBytes: 8, maxArtifactBytes: 1024, shellTimeoutMs: 100 },
      ...(artifact
        ? {
            artifacts: {
              write({ data }: { data: Uint8Array }) {
                saved = data;
                return { reference: 'opaque-output' };
              },
              read() {
                return { data: saved ?? new Uint8Array() };
              },
            },
          }
        : {}),
    }),
  });
  const execute = tools.run_command?.execute;
  if (!execute) throw new Error('Missing coding command');
  const result = ShellOutputSchema.parse(
    await execute(
      { executable: 'test' },
      { toolCallId: 'structural', messages: [], context: undefined },
    ),
  );
  return { result, saved };
}

describe('coding shell shared native ownership', () => {
  test('a structural burst keeps the prefix and output-limit semantics through the public tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-structural-burst-'));
    roots.push(root);
    const exact = structuralLauncher(8, true);
    expect((await tool(root, exact.adapter)).result).toMatchObject({
      stdout: 'aaaaaaaa',
      outcome: 'exited',
    });
    expect(exact.kills).toBe(0);
    const burst = structuralLauncher(150_000, false);
    expect((await tool(root, burst.adapter)).result).toMatchObject({
      stdout: 'aaaaaaaa',
      outcome: 'output-limit',
      signal: 'SIGKILL',
    });
    expect(burst.kills).toBe(1);
    expect(burst.destroyed).toBe(2);
    const artifact = structuralLauncher(150_000, false);
    const output = await tool(root, artifact.adapter, true);
    expect(output.result).toMatchObject({
      outcome: 'output-limit',
      artifact: { truncated: true, bytes: 1024 },
    });
    expect(output.saved?.byteLength).toBe(1024);
    expect(output.result.stdout).toBe('aaaaaaaa');
    expect(artifact.kills).toBe(1);
  });

  test('a structural PID-less launcher participates in deadline cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-structural-timeout-'));
    roots.push(root);
    const launcher = structuralLauncher(4, false);
    expect((await tool(root, launcher.adapter)).result).toMatchObject({
      stdout: 'aaaa',
      outcome: 'timeout',
      signal: 'SIGKILL',
    });
    expect(launcher.kills).toBe(1);
    expect(launcher.destroyed).toBe(2);
  });

  test('safe-integer shell budgets beyond the native timer range are chained', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-long-budgets-'));
    roots.push(root);
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { printf: process.execPath },
        limits: { shellTimeoutMs: 2_147_483_648, shellTerminationGraceMs: 2_147_483_648 },
      }),
    });
    const execute = tools.run_command?.execute;
    if (!execute) throw new Error('Missing coding command');
    expect(
      await execute(
        { executable: 'printf', args: ['-e', "process.stdout.write('ok')"] },
        { toolCallId: 'long-budgets', messages: [], context: undefined },
      ),
    ).toMatchObject({ stdout: 'ok', outcome: 'exited' });
  });

  test('group signal refusal reaches the tool as a safe error and retains the internal cause', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coding-group-refusal-'));
    roots.push(root);
    const entry = new URL('../src/entrypoints/agent-runtime/coding-tools.ts', import.meta.url)
      .pathname;
    const mount = new URL('../src/entrypoints/tools.ts', import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./fixtures/coding-group-cleanup-refusal.mjs', import.meta.url)),
        root,
        entry,
        mount,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const result = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(result, stderr).toBe(0);
    expect(await new Response(child.stdout).text()).toContain(
      'coding group cleanup refusal: ok',
    );
  });
});

test('coding normal exit bounds retained transport close while generic drain policy stays separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coding-delayed-close-'));
  roots.push(root);
  const adapter: AgentProcessSandbox = {
    probe: () => ({ grade: 'full', restrictions: [] }),
    prepare: (command) => command,
    spawn: () => {
      const events = new EventEmitter();
      let exited = false;
      const pipe = () => ({
        destroyed: false,
        on() {
          // This retained transport has no output.
        },
        destroy() {
          // Destruction is not evidence of remote transport closure.
        },
      });
      setTimeout(() => {
        exited = true;
        events.emit('exit', 0, null);
      }, 5);
      const closeTimer = setTimeout(() => events.emit('close', 0, null), 1000);
      closeTimer.unref();
      return {
        get exitCode() {
          return exited ? 0 : null;
        },
        signalCode: null,
        stdout: pipe(),
        stderr: pipe(),
        on: events.on.bind(events),
        kill: () => true,
      };
    },
  };
  const definitions = createAgentCodingTools({
    root,
    authorize: () => true,
    executables: { test: process.execPath },
    sandbox: { adapter, required: [] },
    limits: { shellTimeoutMs: 1000, shellTerminationGraceMs: 20 },
  });
  const definition = definitions.find((entry) => entry.name === 'run_command');
  if (!definition) throw new Error('Missing coding command');
  const start = performance.now();
  await expect(
    definition.handler({
      params: undefined,
      input: { executable: 'test', args: [], cwd: '.' },
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_CLEANUP' });
  expect(performance.now() - start).toBeLessThan(300);
});
