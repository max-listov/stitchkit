import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { defineCliCommand, defineCliResult } from '../src/tools/cli/command';
import { type CliConfig, createCli, createCliInvoker } from '../src/tools/cli/create-cli';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const LookupInput = z.object({ name: z.string() });
const LookupOutput = z.object({
  found: z.boolean(),
  machine: z.enum(['reachable', 'unreachable']),
  address: z.string().optional(),
});
const Tick = z.object({ n: z.number(), done: z.boolean().optional() });

const contract = defineContract(
  { prefix: 'records', scope: 'public' },
  {
    lookup: {
      method: 'POST',
      path: '/lookup',
      desc: 'Find one record by name',
      expose: ['CLI'],
      input: LookupInput,
      output: LookupOutput,
      tool: { name: 'lookup' },
    },
    watch: {
      method: 'POST',
      path: '/watch',
      desc: 'Follow record ticks',
      expose: ['HTTP', 'CLI'],
      input: z.object({ count: z.number().default(3), bad: z.boolean().optional() }),
      stream: { item: Tick },
    },
  },
);

function fixture() {
  const state = { produced: 0, closed: false, aborted: false };
  const service = implement(contract, {
    lookup: ({ input }) =>
      input.name === 'main'
        ? { found: true, machine: 'reachable' as const, address: 'node-a/main' }
        : { found: false, machine: input.name === 'far' ? 'unreachable' : 'reachable' },
    watch: ({ input, signal }) =>
      (async function* () {
        signal.addEventListener('abort', () => {
          state.aborted = true;
        });
        try {
          for (let n = 1; n <= input.count; n += 1) {
            state.produced += 1;
            yield { n: input.bad && n === 2 ? Number.NaN : n };
          }
        } finally {
          state.closed = true;
        }
      })(),
  });
  const results = {
    lookup: defineCliResult(LookupOutput, {
      present: ({ result, options }) =>
        options.json
          ? `${JSON.stringify(result)}\n`
          : result.found
            ? `FOUND ${result.address}\n`
            : 'NOT FOUND\n',
      exitCode: (result) => (result.found ? 0 : result.machine === 'unreachable' ? 2 : 1),
    }),
  };
  return { state, service, results };
}

/** The JSON Schema Zod itself derives, as it reads after one trip through JSON. */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io, target: 'draft-7' })));
}

type RunConfig = Pick<CliConfig, 'services' | 'results' | 'commands' | 'signal' | 'stdout'>;

async function run(argv: string[], config: RunConfig) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'app',
    version: '1.0.0',
    stdout: (text) => {
      out += text;
    },
    ...config,
    argv,
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
    stdin: async () => null,
  });
  return { out, err, code };
}

describe('a managed command prints and exit-codes its own result', () => {
  test('present writes text without --json and JSON with it', async () => {
    const { service, results } = fixture();
    const text = await run(['lookup', 'main'], { services: [service], results });
    expect(text).toEqual({ out: 'FOUND node-a/main\n', err: '', code: 0 });
    const json = await run(['lookup', 'main', '--json'], { services: [service], results });
    expect(JSON.parse(json.out)).toEqual({
      found: true,
      machine: 'reachable',
      address: 'node-a/main',
    });
    expect(json.code).toBe(0);
  });

  test('without a policy the canonical JSON and exit 0 are unchanged', async () => {
    const { service } = fixture();
    const result = await run(['lookup', 'nobody'], { services: [service] });
    expect(JSON.parse(result.out)).toEqual({ found: false, machine: 'reachable' });
    expect(result.out).toContain('\n  ');
    expect(result.code).toBe(0);
    const compact = await run(['lookup', 'nobody', '--json'], { services: [service] });
    expect(compact.out).toBe('{"found":false,"machine":"reachable"}\n');
  });

  test('present receives the run options, so --json is for the presenter to honour', async () => {
    const { service } = fixture();
    const seen: boolean[] = [];
    const results = {
      lookup: defineCliResult(LookupOutput, {
        present: ({ options }) => {
          seen.push(options.json);
          return 'x\n';
        },
      }),
    };
    await run(['lookup', 'main'], { services: [service], results });
    await run(['lookup', 'main', '--json'], { services: [service], results });
    expect(seen).toEqual([false, true]);
  });

  test('a policy typed against another schema is refused at startup', async () => {
    const { service } = fixture();
    await expect(
      run(['lookup', 'main'], {
        services: [service],
        results: { lookup: defineCliResult(z.object({ other: z.string() }), {}) },
      }),
    ).rejects.toThrow(
      'is typed against a schema that is not the one the command answers with',
    );
  });

  test('exitCode classifies a successful result, on the command line and in process', async () => {
    const { service, results } = fixture();
    const config = { services: [service], results };
    expect((await run(['lookup', 'nobody'], config)).code).toBe(1);
    expect((await run(['lookup', 'far'], config)).code).toBe(2);
    expect((await run(['lookup', 'main'], config)).code).toBe(0);
    const invoker = await createCliInvoker({ name: 'app', ...config });
    const missing = await invoker.invoke('lookup', { name: 'far' });
    expect(missing).toMatchObject({ ok: true, exitCode: 2, data: { found: false } });
  });

  test('a throwing present keeps the result and reports CLI_PRESENTATION_FAILED', async () => {
    const { service } = fixture();
    const result = await run(['lookup', 'main'], {
      services: [service],
      results: {
        lookup: defineCliResult(LookupOutput, {
          present: () => {
            throw new Error('broken presenter');
          },
        }),
      },
    });
    expect(result.code).toBe(8);
    expect(JSON.parse(result.out)).toMatchObject({ found: true });
    expect(JSON.parse(result.err)).toMatchObject({ error: 'CLI_PRESENTATION_FAILED' });
  });

  test('an invalid exit code is a failed result, not a silent zero', async () => {
    const { service } = fixture();
    const result = await run(['lookup', 'main'], {
      services: [service],
      results: { lookup: defineCliResult(LookupOutput, { exitCode: () => 999 }) },
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err)).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
  });

  test('a policy for an unknown or native command is a startup error', async () => {
    const { service } = fixture();
    const native = defineCliCommand({
      name: 'doctor',
      description: 'Inspect',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const policy = defineCliResult(z.object({ ok: z.boolean() }), { present: () => 'x\n' });
    await expect(
      run(['lookup', 'main'], { services: [service], results: { missing: policy } }),
    ).rejects.toThrow('unavailable command "missing"');
    await expect(
      run(['lookup', 'main'], {
        services: [service],
        commands: [native],
        results: { doctor: policy },
      }),
    ).rejects.toThrow('not managed');
  });
});

describe('--schema prints the schemas a command is validated against', () => {
  test('a managed command answers one JSON line equal to the Zod schemas', async () => {
    const { service } = fixture();
    const result = await run(['lookup', '--schema'], { services: [service] });
    expect(result.code).toBe(0);
    expect(result.out.endsWith('\n')).toBe(true);
    expect(result.out.trimEnd().includes('\n')).toBe(false);
    const schema = JSON.parse(result.out);
    expect(schema.command).toBe('lookup');
    const input = jsonSchema(LookupInput, 'input');
    expect(schema.input.properties).toEqual(input.properties);
    expect(schema.input.required).toEqual(input.required);
    expect(schema.output).toEqual(jsonSchema(LookupOutput, 'output'));
  });

  test('the printed schema follows the declaration: another contract prints another schema', async () => {
    const wider = defineContract(
      { prefix: 'records', scope: 'public' },
      {
        lookup: {
          ...contract.endpoints.lookup,
          output: LookupOutput.extend({ extra: z.string() }),
        },
      },
    );
    const service = implement(wider, {
      lookup: () => ({ found: false, machine: 'reachable' as const, extra: 'x' }),
    });
    const printed = JSON.parse(
      (await run(['lookup', '--schema'], { services: [service] })).out,
    );
    expect(printed.output).toEqual(
      jsonSchema(LookupOutput.extend({ extra: z.string() }), 'output'),
    );
    expect(printed.output).not.toEqual(jsonSchema(LookupOutput, 'output'));
  });

  test('input and output are one JSON Schema dialect', async () => {
    const { service } = fixture();
    const printed = JSON.parse(
      (await run(['lookup', '--schema'], { services: [service] })).out,
    );
    expect(printed.output.$schema).toBe(printed.input.$schema);
  });

  test('a native command and a stream answer too, without running anything', async () => {
    const { service, state } = fixture();
    let ran = false;
    const native = defineCliCommand({
      name: 'doctor',
      description: 'Inspect',
      input: z.object({ deep: z.boolean().optional() }),
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        ran = true;
        return { ok: true };
      },
    });
    const doctor = JSON.parse(
      (await run(['doctor', '--schema'], { services: [service], commands: [native] })).out,
    );
    expect(doctor.output.properties.ok).toEqual({ type: 'boolean' });
    expect(doctor.input.properties.deep).toBeDefined();
    expect(ran).toBe(false);
    const watch = JSON.parse(
      (await run(['watch_record', '--schema'], { services: [service] })).out,
    );
    expect(watch.item).toEqual(jsonSchema(Tick, 'output'));
    expect(watch.output).toBeUndefined();
    expect(state.produced).toBe(0);
  });
});

describe('a contract stream runs as a command', () => {
  test('one JSON line per item, exit 0, source closed', async () => {
    const { service, state } = fixture();
    const result = await run(['watch_record', '--count', '3'], { services: [service] });
    expect(result.out).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(result).toMatchObject({ err: '', code: 0 });
    expect(state.closed).toBe(true);
  });

  test('the command presents each item itself', async () => {
    const { service } = fixture();
    const result = await run(['watch_record', '--count', '2'], {
      services: [service],
      results: {
        watch_record: defineCliResult(Tick, {
          present: ({ result }) => `tick ${result.n}\n`,
        }),
      },
    });
    expect(result.out).toBe('tick 1\ntick 2\n');
  });

  test('an item outside the contract fails the command after the valid ones', async () => {
    const { service } = fixture();
    const result = await run(['watch_record', '--bad'], { services: [service] });
    expect(result.out).toBe('{"n":1}\n');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err)).toMatchObject({ error: 'STREAM_ITEM_INVALID' });
  });

  test('a closed stdout stops the feed and cancels the operation', async () => {
    const { service, state } = fixture();
    let lines = 0;
    const result = await run(['watch_record', '--count', '1000'], {
      services: [service],
      stdout: () => {
        lines += 1;
        if (lines === 2) throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
    });
    expect(result.code).toBe(0);
    expect(state.produced).toBe(2);
    expect(state.closed).toBe(true);
    expect(state.aborted).toBe(true);
  });

  test('exitCode on a stream command is refused at startup', async () => {
    const { service } = fixture();
    await expect(
      run(['watch_record'], {
        services: [service],
        results: { watch_record: defineCliResult(Tick, { exitCode: () => 1 }) },
      }),
    ).rejects.toThrow('stream command');
  });

  test('a real pipe closed by its reader ends the process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sk-cli-stream-'));
    try {
      const file = join(directory, 'feed.ts');
      const root = join(import.meta.dir, '../src/entrypoints');
      await writeFile(
        file,
        `import { z } from 'zod';
import { defineContract } from '${root}/contract.ts';
import { implement } from '${root}/server.ts';
import { createCli } from '${root}/cli.ts';
const contract = defineContract({ prefix: 'feed', scope: 'public' }, {
  watch: { method: 'POST', path: '/watch', desc: 'Endless feed', expose: ['HTTP', 'CLI'],
    stream: { item: z.object({ n: z.number() }) } },
});
const service = implement(contract, {
  watch: () => (async function* () {
    for (let n = 1; ; n += 1) { yield { n }; await new Promise((r) => setTimeout(r, 5)); }
  })(),
});
await createCli({ name: 'feed', version: '1.0.0', services: [service] });
`,
      );
      // The producer's own status, not the pipeline's: `head` exits 0 whatever
      // the command on its left did.
      const shell = Bun.spawn(
        [
          'bash',
          '-c',
          `bun "${file}" watch_feed | head -n 2; echo "producer=\${PIPESTATUS[0]}"`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      trackProcess(shell.pid);
      const exited = await Promise.race([
        shell.exited,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
      ]);
      expect(exited).toBe(0);
      expect(await new Response(shell.stdout).text()).toBe('{"n":1}\n{"n":2}\nproducer=0\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
