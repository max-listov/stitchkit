import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import {
  createMemoryAgentRuntimeStore,
  recordAgentSandboxProbe,
} from '../src/entrypoints/agent-runtime';
import { createAgentCodingTools } from '../src/entrypoints/agent-runtime/coding-tools';
import { defineRuntimeTool, describeToolCatalog, mountAgent } from '../src/entrypoints/tools';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function executable(tools: ToolSet, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new TypeError(`Expected executable tool: ${name}`);
  return execute;
}

describe('agent runtime sandbox and tool catalog', () => {
  test('sandbox unavailability is distinct from a policy refusal and executes no command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-sandbox-'));
    roots.push(root);
    let probes = 0;
    let preparations = 0;
    const sandbox = {
      probe() {
        probes += 1;
        return { grade: 'unavailable', reason: 'fixture has no sandbox binary' } as const;
      },
      prepare() {
        preparations += 1;
        return { executable: '/bin/false', args: [] };
      },
    };
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { echo: '/bin/echo' },
        sandbox: {
          adapter: sandbox,
          required: ['network-denied', 'write-contained', 'secrets-hidden'],
        },
      }),
    });
    const options = { toolCallId: 'sandbox', messages: [], context: undefined };
    await expect(
      executable(tools, 'run_command')(
        { executable: 'echo', args: ['ran'], cwd: '.' },
        options,
      ),
    ).rejects.toMatchObject({ output: { error: 'SANDBOX_UNAVAILABLE' } });
    await expect(
      executable(tools, 'run_command')(
        { executable: 'echo', args: ['again'], cwd: '.' },
        options,
      ),
    ).rejects.toMatchObject({ output: { error: 'SANDBOX_UNAVAILABLE' } });
    expect({ probes, preparations }).toEqual({ probes: 1, preparations: 0 });
  });

  test('a failed preparation refuses with a fixed reason and hands the adapter error to onToolError', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-sandbox-'));
    roots.push(root);
    const warnings: unknown[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.cause);
    process.on('warning', onWarning);
    const observed: unknown[] = [];
    const cause = new Error('ENOENT: posix_spawn /opt/private/launcher-bin');
    const tools = mountAgent([], {
      hooks: { onToolError: ({ error }) => void observed.push(error) },
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { echo: '/bin/echo' },
        sandbox: {
          adapter: {
            probe: () => ({ grade: 'full', restrictions: ['network-denied'] }),
            prepare: () => {
              throw cause;
            },
          },
          required: ['network-denied'],
        },
      }),
    });
    const options = { toolCallId: 'sandbox', messages: [], context: undefined };
    try {
      const refusal = await executable(tools, 'run_command')(
        { executable: 'echo', args: ['ran'], cwd: '.' },
        options,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({
        output: {
          error: 'SANDBOX_UNAVAILABLE',
          details: { grade: 'full', reason: 'sandbox prepare failed' },
        },
      });
      expect(JSON.stringify(refusal)).not.toContain('/opt/private');
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', cause });
      // The cause reached the application's hook; no process warning repeats it.
      // `emitWarning` would deliver on the next tick.
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  });

  test('a failed probe refuses with a fixed reason and hands the adapter error to onToolError', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-sandbox-'));
    roots.push(root);
    const warnings: unknown[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.cause);
    process.on('warning', onWarning);
    const observed: unknown[] = [];
    const cause = new Error('EACCES: /opt/private/launcher-bin --probe');
    const tools = mountAgent([], {
      hooks: { onToolError: ({ error }) => void observed.push(error) },
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { echo: '/bin/echo' },
        sandbox: {
          adapter: {
            probe: () => {
              throw cause;
            },
            prepare: () => ({ executable: '/bin/false', args: [] }),
          },
          required: ['network-denied'],
        },
      }),
    });
    const options = { toolCallId: 'sandbox', messages: [], context: undefined };
    try {
      for (const attempt of ['first', 'cached']) {
        const refusal = await executable(tools, 'run_command')(
          { executable: 'echo', args: [attempt], cwd: '.' },
          options,
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(refusal).toMatchObject({
          output: {
            error: 'SANDBOX_UNAVAILABLE',
            details: { reason: 'sandbox probe failed' },
          },
        });
        expect(JSON.stringify(refusal)).not.toContain('/opt/private');
      }
      // Every refusal from the cached failed probe carries the same cause.
      expect(observed).toHaveLength(2);
      for (const error of observed) {
        expect(error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE', cause });
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  });

  test('catalog reports origins and explicit schema budget without an implicit refusal', () => {
    const first = defineRuntimeTool({
      name: 'inspect',
      description: 'Inspect alpha',
      identity: { serviceName: 'alpha', action: 'inspect', method: 'POST' },
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const catalog = describeToolCatalog({ runtimeTools: [first], transport: 'AGENT' });
    expect(catalog).toEqual([
      expect.objectContaining({
        name: 'inspect',
        source: { kind: 'runtime', service: 'alpha', action: 'inspect' },
        deferred: false,
      }),
    ]);
    expect(() =>
      describeToolCatalog({ runtimeTools: [first], transport: 'AGENT', maxSchemaBytes: 1 }),
    ).toThrow('exceeding maxSchemaBytes');

    const second = defineRuntimeTool({
      name: 'inspect',
      description: 'Inspect beta',
      identity: { serviceName: 'beta', action: 'inspect', method: 'POST' },
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    expect(() =>
      describeToolCatalog({ runtimeTools: [first, second], transport: 'AGENT' }),
    ).toThrow('alpha.inspect, beta.inspect');
  });

  test('records the process sandbox grade and required gaps in the durable ledger', async () => {
    const store = createMemoryAgentRuntimeStore();
    const grade = await recordAgentSandboxProbe({
      store,
      conversationId: 'sandbox-grade',
      sandbox: {
        probe: () => ({
          grade: 'partial',
          restrictions: ['network-denied'],
          gaps: ['write-contained'],
        }),
        prepare: ({ executable, args }) => ({ executable, args }),
      },
      required: ['network-denied', 'write-contained'],
    });
    expect(grade.grade).toBe('partial');
    const event = (await store.readEvents({ conversationId: 'sandbox-grade', limit: 1 }))
      .items[0];
    expect(event?.payload).toEqual({
      result: {
        grade: 'partial',
        restrictions: ['network-denied'],
        gaps: ['write-contained'],
      },
      required: ['network-denied', 'write-contained'],
      missing: ['write-contained'],
    });
  });
});
