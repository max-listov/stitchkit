import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AppError,
  defineContract,
  isStitchErrorCode,
  STITCH_ERROR_STATUS,
} from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { defineCliCommand } from '../src/tools/cli/command';
import { type CliConfig, createCli } from '../src/tools/cli/create-cli';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

const CreateInput = z.object({ refuse: z.boolean().optional() });
const CreateOutput = z.object({
  id: z.string(),
  pendingPaths: z.array(z.string()),
  pages: z.array(z.object({ path: z.string() })),
});
const payload = { id: 'created-record', pendingPaths: ['/'], pages: [{ path: '/' }] };
const contract = defineContract(
  { prefix: 'records', scope: 'public' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create one record',
      expose: ['CLI'],
      input: CreateInput,
      output: CreateOutput,
      tool: { name: 'record_create' },
    },
  },
);

type RunConfig = Pick<
  CliConfig,
  'services' | 'runtimeTools' | 'commands' | 'exitCodes' | 'errorHint'
>;

async function run(argv: string[], config: RunConfig) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'records',
    version: '1.0.0',
    ...config,
    argv,
    stdout: (text) => {
      out += text;
    },
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

function fixture() {
  let calls = 0;
  let mutations = 0;
  const create = (input: z.output<typeof CreateInput>) => {
    calls += 1;
    if (input.refuse) {
      throw new AppError('FORBIDDEN', { details: { message: 'Denied by control' } });
    }
    mutations += 1;
    return payload;
  };
  const service = implement(contract, { create: ({ input }) => create(input) });
  const runtime = defineRuntimeTool({
    name: 'remote_create',
    description: 'A remote creation exposed through a runtime catalogue',
    identity: { serviceName: 'remote', action: 'create', method: 'POST' },
    input: CreateInput,
    output: CreateOutput,
    transports: ['CLI'],
    handler: ({ input }) => create(input),
  });
  return { service, runtime, calls: () => calls, mutations: () => mutations };
}

describe('a successful call survives a failed CLI presentation', () => {
  test('the presentation failure is a registered non-retryable framework code', () => {
    expect(isStitchErrorCode('CLI_PRESENTATION_FAILED')).toBe(true);
    expect(STITCH_ERROR_STATUS.CLI_PRESENTATION_FAILED).toBe(500);
  });
  for (const json of [false, true]) {
    test(`an ambiguous table preserves the complete creation receipt (json=${json})`, async () => {
      const f = fixture();
      const result = await run(
        ['record_create', '--table', 'id', ...(json ? ['--json'] : [])],
        { services: [f.service] },
      );
      expect(f.calls()).toBe(1);
      expect(f.mutations()).toBe(1);
      expect(result.out).not.toBe('');
      expect(result.code).toBe(8);
      expect(JSON.parse(result.out)).toEqual(payload);
      expect(result.out).toBe(`${JSON.stringify(payload, null, json ? undefined : 2)}\n`);
      const diagnostic = JSON.parse(result.err);
      expect(diagnostic.error).toBe('CLI_PRESENTATION_FAILED');
      expect(diagnostic.retryable).toBe(false);
      expect(diagnostic.details.operationSucceeded).toBe(true);
      expect(diagnostic.details.command).toBe('record_create');
      expect(diagnostic.details.cause.details.message).toContain('pendingPaths, pages');
      expect(diagnostic._hint).toContain('stdout');
      expect(diagnostic._hint).toContain('Do not repeat');
    });
  }

  test('a runtime-discovered command uses the same receipt and configurable failure code', async () => {
    const f = fixture();
    const result = await run(['remote_create', '--count-by', 'id'], {
      runtimeTools: [f.runtime],
      exitCodes: { CLI_PRESENTATION_FAILED: 42 },
      errorHint: () => 'Retry the operation',
    });
    expect(result.code).toBe(42);
    expect(JSON.parse(result.out)).toEqual(payload);
    expect(JSON.parse(result.err).details.operationSucceeded).toBe(true);
    expect(result.err).not.toContain('Retry the operation');
    expect(f.mutations()).toBe(1);
  });

  test('a real server refusal retains its error and never claims execution succeeded', async () => {
    const f = fixture();
    const result = await run(['record_create', '--refuse', '--table', 'id'], {
      services: [f.service],
    });
    expect(result.code).toBe(3);
    expect(result.out).toBe('');
    expect(JSON.parse(result.err).error).toBe('FORBIDDEN');
    expect(JSON.parse(result.err).details.message).toBe('Denied by control');
    expect(result.err).not.toContain('operationSucceeded');
    expect(f.calls()).toBe(1);
    expect(f.mutations()).toBe(0);
  });

  test('invalid view arguments are refused before execution and have no receipt', async () => {
    const f = fixture();
    const result = await run(['record_create', '--count-by', 'id', '--sum', 'id'], {
      services: [f.service],
    });
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('different shapes');
    expect(result.err).not.toContain('operationSucceeded');
    expect(f.calls()).toBe(0);
  });

  test('without a view the canonical answer stays byte-for-byte unchanged', async () => {
    const f = fixture();
    const result = await run(['record_create', '--json'], { services: [f.service] });
    expect(result).toEqual({ out: `${JSON.stringify(payload)}\n`, err: '', code: 0 });
    expect(f.mutations()).toBe(1);
  });

  for (const invalidReturn of ['throw', 'number', 'undefined']) {
    test(`a native presenter failure preserves the validated result (invalidReturn=${invalidReturn})`, async () => {
      let calls = 0;
      const command = defineCliCommand({
        name: 'native_create',
        description: 'Create and present a receipt',
        input: z.object({}),
        output: CreateOutput,
        handler: () => {
          calls += 1;
          return payload;
        },
        present: () => {
          throw new Error('private presenter failure');
        },
      });
      if (invalidReturn === 'number') Reflect.set(command, 'present', () => 42);
      if (invalidReturn === 'undefined') Reflect.set(command, 'present', () => undefined);
      const result = await run(['native_create', '--json'], { commands: [command] });
      expect(calls).toBe(1);
      expect(result.out).not.toBe('');
      expect(result.code).toBe(8);
      expect(JSON.parse(result.out)).toEqual(payload);
      expect(JSON.parse(result.err).error).toBe('CLI_PRESENTATION_FAILED');
      expect(JSON.parse(result.err).details.operationSucceeded).toBe(true);
      expect(result.err).not.toContain('private presenter failure');
    });
  }
});
