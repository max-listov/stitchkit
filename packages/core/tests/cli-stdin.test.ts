import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import {
  type CliConfig,
  createCli,
  defineCliCommand,
  type RuntimeToolDefinition,
} from '../src/entrypoints/cli';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { readPipedStdin } from '../src/tools/cli/stdin';
import { zodObjectFromJsonSchema } from '../src/tools/connections/runtime';

function expectReleased(input: PassThrough) {
  for (const event of ['data', 'end', 'error', 'close'])
    expect(input.listenerCount(event)).toBe(0);
  expect(input.isPaused()).toBe(true);
  expect(input.destroyed).toBe(false);
}

test('empty open stream releases listeners and remains usable after the probe', async () => {
  const input = new PassThrough();
  expect(await readPipedStdin(input)).toBeNull();
  expectReleased(input);
  const later = readPipedStdin(input);
  input.end('later');
  expect(await later).toBe('later');
});

test('read errors propagate instead of returning partial input', async () => {
  const input = new PassThrough();
  const result = readPipedStdin(input);
  input.write('partial');
  input.emit('error', new Error('read failed'));
  await expect(result).rejects.toThrow('read failed');
  expectReleased(input);
  input.destroy();
});

test('premature close rejects rather than accepting partial data', async () => {
  const input = new PassThrough();
  const result = readPipedStdin(input);
  input.write('partial');
  input.destroy();
  await expect(result).rejects.toThrow('stdin closed before EOF');
});

test('whitespace-only data keeps the existing empty-input semantics', async () => {
  const input = new PassThrough();
  const result = readPipedStdin(input);
  input.end(' \n\t ');
  expect(await result).toBeNull();
});

describe('piped stdin coercion with explicit positional policies', () => {
  async function runWithPipedStdin(config: Partial<CliConfig>, argv: string[], piped: string) {
    let out = '';
    let err = '';
    let code = -1;
    await createCli({
      name: 'stdin-coercion',
      version: '1.0.0',
      argv,
      stdin: async () => piped,
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      exit: (value) => {
        code = value;
      },
      ...config,
      access: config.access ?? { open: 'local-operator' },
    });
    return { out, err, code };
  }

  function buildSurface(
    kind: 'native' | 'managed' | 'discovered',
    fieldType: 'string' | 'number' | 'integer',
    onCall: (input: unknown) => void,
  ): Partial<CliConfig> {
    const zodInput =
      fieldType === 'string'
        ? z.object({ payload: z.string() })
        : fieldType === 'number'
          ? z.object({ payload: z.number() })
          : z.object({ payload: z.number().int() });
    const commandSettings = { ingest: { positionals: [] as const } };

    if (kind === 'native') {
      const cmd = defineCliCommand({
        name: 'ingest',
        description: 'Ingest piped value',
        input: zodInput,
        output: z.object({ payload: z.unknown() }),
        handler: ({ input }) => {
          onCall(input);
          return input;
        },
      });
      return { commands: [cmd], commandSettings };
    }
    if (kind === 'managed') {
      const contract = defineContract(
        { prefix: 'stdin', scope: 'public' },
        {
          ingest: {
            method: 'POST',
            path: '/ingest',
            desc: 'Ingest piped value',
            expose: ['CLI'],
            input: zodInput,
            output: z.object({ payload: z.unknown() }),
            tool: { name: 'ingest' },
          },
        },
      );
      const service = implement(contract, {
        ingest: ({ input }) => {
          onCall(input);
          return input;
        },
      });
      return { services: [service], commandSettings };
    }
    const discoveredInput = zodObjectFromJsonSchema({
      type: 'object',
      properties: { payload: { type: fieldType } },
      required: ['payload'],
    });
    const runtimeTool: RuntimeToolDefinition = {
      name: 'ingest',
      description: 'Ingest discovered piped value',
      identity: { serviceName: 'remote', action: 'ingest', method: 'POST' },
      expose: ['CLI'],
      input: discoveredInput,
      output: z.object({ payload: z.unknown() }),
      handler: ({ input }) => {
        onCall(input);
        return input;
      },
    };
    return { runtimeTools: [runtimeTool], commandSettings };
  }

  for (const kind of ['native', 'managed', 'discovered'] as const) {
    test(`${kind}: option-like piped strings ("-v", "--", "---", "--hello") are accepted as literal strings`, async () => {
      for (const piped of ['-v', '--', '---', '--hello']) {
        const seen: unknown[] = [];
        const surface = buildSurface(kind, 'string', (input) => seen.push(input));
        const res = await runWithPipedStdin(surface, ['ingest', '--json'], piped);
        expect(res).toEqual({
          code: 0,
          err: '',
          out: `${JSON.stringify({ payload: piped })}\n`,
        });
        expect(seen).toEqual([{ payload: piped }]);
      }
    });

    test(`${kind}: invalid numeric stdin ("abc") exits 2 cleanly without uncaught throw`, async () => {
      const seen: unknown[] = [];
      const surface = buildSurface(kind, 'number', (input) => seen.push(input));
      const res = await runWithPipedStdin(surface, ['ingest'], 'abc');
      expect(res.code).toBe(2);
      expect(res.out).toBe('');
      expect(res.err).toContain('--payload expects a number, got "abc"');
      expect(seen).toEqual([]);
    });

    test(`${kind}: float stdin ("3.5") succeeds for number and exits 2 cleanly for integer`, async () => {
      const seenNum: unknown[] = [];
      const numSurface = buildSurface(kind, 'number', (input) => seenNum.push(input));
      const numRes = await runWithPipedStdin(numSurface, ['ingest', '--json'], '3.5');
      expect(numRes).toEqual({ code: 0, err: '', out: '{"payload":3.5}\n' });
      expect(seenNum).toEqual([{ payload: 3.5 }]);

      const seenInt: unknown[] = [];
      const intSurface = buildSurface(kind, 'integer', (input) => seenInt.push(input));
      const intBad = await runWithPipedStdin(intSurface, ['ingest'], '3.5');
      expect(intBad.code).toBe(2);
      expect(intBad.out).toBe('');
      expect(intBad.err).toContain('--payload expects a whole number, got "3.5"');
      expect(seenInt).toEqual([]);

      const intGood = await runWithPipedStdin(intSurface, ['ingest', '--json'], '42');
      expect(intGood).toEqual({ code: 0, err: '', out: '{"payload":42}\n' });
      expect(seenInt).toEqual([{ payload: 42 }]);
    });
  }
});
