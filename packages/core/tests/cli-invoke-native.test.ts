import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineCliCommand } from '../src/tools/cli/command';
import { createCliInvoker } from '../src/tools/cli/invoke';

/** The consumer's case: a native command that returns and never prints. */
const describeCommand = defineCliCommand({
  name: 'describe',
  description: 'Describe the compiled catalogue',
  input: z.object({ model: z.string() }),
  output: z.object({ model: z.string(), ratios: z.array(z.string()) }),
  handler: ({ input }) => ({ model: input.model, ratios: ['1:1', '16:9'] }),
});

const printing = defineCliCommand({
  name: 'jsonl',
  description: 'Stream JSON lines',
  input: z.object({}),
  handler: ({ stdout }) => {
    stdout('{"line":1}\n');
  },
});

const coded = defineCliCommand({
  name: 'audit',
  description: 'Audit and report by exit code',
  input: z.object({ strict: z.boolean().default(false) }),
  output: z.object({ findings: z.number() }),
  handler: ({ input }) => ({ findings: input.strict ? 2 : 0 }),
  exitCode: (result) => (result.findings > 0 ? 3 : 0),
  present: () => {
    throw new Error('present must not run without a stdout to print to');
  },
});

const invoker = () =>
  createCliInvoker({ name: 'gg', commands: [describeCommand, printing, coded] });

describe('a native command that returns a result is invokable in process', () => {
  test('describe answers with its validated result, not NOT_FOUND', async () => {
    const result = await (await invoker()).invoke('describe', { model: 'flux' });
    expect(result).toEqual({
      ok: true,
      exitCode: 0,
      data: { model: 'flux', ratios: ['1:1', '16:9'] },
    });
  });

  test('it is listed among the commands', async () => {
    expect((await invoker()).commands.map((command) => command.name)).toContain('describe');
  });

  test('a printing command stays outside and answers NOT_FOUND', async () => {
    const result = await (await invoker()).invoke('jsonl', {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
    expect((await invoker()).commands.map((command) => command.name)).not.toContain('jsonl');
  });

  test('input is validated by the declared schema', async () => {
    const result = await (await invoker()).invoke('describe', { model: 7 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
  });

  test('declared defaults reach the handler', async () => {
    const result = await (await invoker()).invoke('audit', {});
    expect(result.data).toEqual({ findings: 0 });
  });

  test("the command's own exit code is applied, and present is not called", async () => {
    const result = await (await invoker()).invoke('audit', { strict: true });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(3);
  });
});

describe('what a returning command writes is returned, not printed', () => {
  const chatty = defineCliCommand({
    name: 'chatty',
    description: 'Returns a result and logs on the way',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    handler: ({ stderr }) => {
      stderr('warming the cache\n');
      return { ok: true };
    },
  });

  test('the text comes back on the result', async () => {
    const result = await (await createCliInvoker({ name: 'gg', commands: [chatty] })).invoke(
      'chatty',
      {},
    );
    expect(result.data).toEqual({ ok: true });
    expect(result.written).toEqual({ stderr: 'warming the cache\n' });
  });

  test('a silent command carries no written field at all', async () => {
    const result = await (await invoker()).invoke('describe', { model: 'flux' });
    expect('written' in result).toBe(false);
  });
});
