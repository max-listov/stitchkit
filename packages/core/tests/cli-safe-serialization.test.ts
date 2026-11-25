import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createCli,
  createCliInvoker,
  defineCliStreamCommand,
  runCliStream,
} from '../src/entrypoints/cli';
import { AppError, defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';

function makeCyclicPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = { ok: true, label: 'cycle' };
  payload.self = payload;
  return payload;
}

const serializationContract = defineContract(
  { prefix: '/ser' },
  {
    bigint: {
      method: 'GET',
      path: '/bigint',
      desc: 'Return a payload containing a bigint',
      expose: ['CLI'],
      tool: { name: 'ser_bigint' },
      output: z.unknown(),
    },
    cyclic: {
      method: 'GET',
      path: '/cyclic',
      desc: 'Return a cyclic payload',
      expose: ['CLI'],
      tool: { name: 'ser_cyclic' },
      output: z.unknown(),
    },
    plain: {
      method: 'GET',
      path: '/plain',
      desc: 'Return a plain JSON payload',
      expose: ['CLI'],
      tool: { name: 'ser_plain' },
      output: z.object({ id: z.number(), name: z.string(), tags: z.array(z.string()) }),
    },
    exotic: {
      method: 'GET',
      path: '/exotic',
      desc: 'Return nested cyclic array, symbol and throwing toJSON',
      expose: ['CLI'],
      tool: { name: 'ser_exotic' },
      output: z.unknown(),
    },
    fail: {
      method: 'GET',
      path: '/fail',
      desc: 'Fail with a domain error',
      expose: ['CLI'],
      tool: { name: 'ser_fail' },
      output: z.unknown(),
    },
    feed: {
      method: 'GET',
      path: '/feed',
      desc: 'Stream items containing bigint and cyclic values',
      expose: ['CLI'],
      stream: { item: z.unknown() },
    },
  },
);

const serializationService = implement(serializationContract, {
  bigint: async () => ({ count: 42n, nested: { total: 9007199254740993n } }),
  cyclic: async () => makeCyclicPayload(),
  plain: async () => ({ id: 7, name: 'alpha', tags: ['a', 'b'] }),
  exotic: async () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    return {
      nested: arr,
      tag: Symbol('mark'),
      bad: {
        toJSON() {
          throw new Error('toJSON exploded');
        },
      },
    };
  },
  fail: async () => {
    throw new AppError('CONFLICT', { message: 'already exists', status: 409 });
  },
  feed: async () =>
    (async function* () {
      yield { seq: 1n };
      yield makeCyclicPayload();
      yield { seq: 3, plain: true };
    })(),
});

async function runCli(argv: string[]) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    access: { open: 'local-operator' },
    name: 'ser-cli',
    version: '1.0.0',
    services: [serializationService],
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
  return { out, err, code };
}

describe('CLI safe serialization of successful results', () => {
  test('managed CLI projects bigint and cyclic results with exit code 0', async () => {
    const bigPretty = await runCli(['ser_bigint']);
    expect(bigPretty.code).toBe(0);
    expect(bigPretty.err).toBe('');
    expect(JSON.parse(bigPretty.out)).toEqual({
      count: '42',
      nested: { total: '9007199254740993' },
    });

    const bigJson = await runCli(['ser_bigint', '--json']);
    expect(bigJson.code).toBe(0);
    expect(bigJson.err).toBe('');
    expect(bigJson.out.trim().includes('\n')).toBe(false);
    expect(JSON.parse(bigJson.out)).toEqual({
      count: '42',
      nested: { total: '9007199254740993' },
    });

    const cyclicPretty = await runCli(['ser_cyclic']);
    expect(cyclicPretty.code).toBe(0);
    expect(cyclicPretty.err).toBe('');
    expect(JSON.parse(cyclicPretty.out)).toEqual({
      ok: true,
      label: 'cycle',
      self: '[circular]',
    });

    const cyclicJson = await runCli(['ser_cyclic', '--json']);
    expect(cyclicJson.code).toBe(0);
    expect(cyclicJson.err).toBe('');
    expect(JSON.parse(cyclicJson.out)).toEqual({
      ok: true,
      label: 'cycle',
      self: '[circular]',
    });
  });

  test('contract stream CLI projects bigint and cyclic items with exit code 0', async () => {
    const res = await runCli(['feed__ser']);
    expect(res.code).toBe(0);
    expect(res.err).toBe('');
    const lines = res.out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { seq: '1' },
      { ok: true, label: 'cycle', self: '[circular]' },
      { seq: 3, plain: true },
    ]);
  });

  test('in-process invoker and JSONL stream produce JSON-serializable projected data', async () => {
    const invoker = await createCliInvoker({
      access: { open: 'local-operator' },
      name: 'ser-cli',
      services: [serializationService],
    });

    const bigRes = await invoker.invoke('ser_bigint', {});
    expect(bigRes.ok).toBe(true);
    expect(bigRes.exitCode).toBe(0);
    expect(JSON.parse(JSON.stringify(bigRes)).data).toEqual({
      count: '42',
      nested: { total: '9007199254740993' },
    });

    const cycRes = await invoker.invoke('ser_cyclic', {});
    expect(cycRes.ok).toBe(true);
    expect(cycRes.exitCode).toBe(0);
    expect(JSON.parse(JSON.stringify(cycRes)).data).toEqual({
      ok: true,
      label: 'cycle',
      self: '[circular]',
    });

    const answers: unknown[] = [];
    async function* inputLines() {
      yield JSON.stringify({ id: '1', command: 'ser_bigint', args: {} });
      yield JSON.stringify({ id: '2', command: 'ser_cyclic', args: {} });
    }
    await runCliStream(invoker, inputLines(), (answer) => {
      answers.push(JSON.parse(JSON.stringify(answer)));
    });
    expect(answers).toEqual([
      {
        id: '1',
        ok: true,
        exitCode: 0,
        data: { count: '42', nested: { total: '9007199254740993' } },
      },
      {
        id: '2',
        ok: true,
        exitCode: 0,
        data: { ok: true, label: 'cycle', self: '[circular]' },
      },
    ]);

    let streamOut = '';
    let streamErr = '';
    let streamCode = -1;
    const streamCmd = defineCliStreamCommand({
      invoker,
      readLines: inputLines,
    });
    await createCli({
      name: 'ser-cli',
      version: '1.0.0',
      commands: [streamCmd],
      argv: ['stream'],
      stdin: async () => null,
      stdout: (text) => {
        streamOut += text;
      },
      stderr: (text) => {
        streamErr += text;
      },
      exit: (value) => {
        streamCode = value;
      },
    });
    expect(streamCode).toBe(0);
    expect(streamErr).toBe('');
    const printed = streamOut
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(printed).toEqual(answers);
  });

  test('normal JSON result without bigint or cycle prints byte-for-byte identically', async () => {
    const expected = { id: 7, name: 'alpha', tags: ['a', 'b'] };
    const pretty = await runCli(['ser_plain']);
    expect(pretty.code).toBe(0);
    expect(pretty.err).toBe('');
    expect(pretty.out).toBe(`${JSON.stringify(expected, null, 2)}\n`);

    const compact = await runCli(['ser_plain', '--json']);
    expect(compact.code).toBe(0);
    expect(compact.err).toBe('');
    expect(compact.out).toBe(`${JSON.stringify(expected)}\n`);
  });

  test('projects nested cyclic array, Symbol and throwing toJSON while keeping --json error shape unchanged', async () => {
    const exotic = await runCli(['ser_exotic', '--json']);
    expect(exotic.code).toBe(0);
    expect(exotic.err).toBe('');
    const parsedExotic = JSON.parse(exotic.out);
    expect(parsedExotic.nested).toEqual([1, '[circular]']);
    expect(parsedExotic.tag).toBe('Symbol(mark)');
    expect(typeof parsedExotic.bad.toJSON).toBe('string');

    const failed = await runCli(['ser_fail', '--json']);
    expect(failed.code).toBe(5);
    expect(failed.out).toBe('');
    expect(failed.err.trim().includes('\n')).toBe(false);
    expect(JSON.parse(failed.err)).toEqual({
      error: 'CONFLICT',
      retryable: false,
      details: { message: 'already exists' },
    });
  });
});
