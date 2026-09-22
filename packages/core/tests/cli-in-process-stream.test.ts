/*
 * One operation per line, without a process per line.
 *
 * The framework owned the parsing, the routing, the JSON mode, the exit codes
 * and the error shape — and handed out no way to say "run this parsed call and
 * give me the result". So a consuming stream loop re-spawned the binary for
 * every line: arguments serialised back into `--flag value` strings, nested
 * objects pushed through `JSON.stringify` into an argv slot and parsed again on
 * the other side, the result read back out of stdout text. Three conversions of
 * data the framework was already holding, plus a process start — 0.15 s each,
 * thirty seconds for a two-hundred-line manifest before any work begins.
 *
 * The ban on nesting one stream inside another was a consequence of the child
 * process, not a rule anybody wanted.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError, defineContract } from '../src/contract';
import { createImplement } from '../src/server/implement';
import { createCli } from '../src/tools/cli';
import { createCliInvoker } from '../src/tools/cli-invoke';
import { defineCliBatchCommand, defineCliStreamCommand } from '../src/tools/cli-stream';

const contract = defineContract(
  { prefix: 'items' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create an item',
      expose: ['CLI'],
      input: z.object({ title: z.string().min(2), tags: z.array(z.string()).default([]) }),
      output: z.object({ id: z.string(), title: z.string(), tags: z.array(z.string()) }),
    },
    fail: {
      method: 'POST',
      path: '/fail',
      desc: 'Always refuses',
      expose: ['CLI'],
      input: z.object({}),
      output: z.object({ never: z.string() }),
    },
  },
);

let created = 0;
const service = createImplement()(contract, {
  create: (context) => {
    created += 1;
    return { id: `item-${created}`, title: context.input.title, tags: context.input.tags };
  },
  fail: () => {
    throw new AppError('CONFLICT', 'nope', 409);
  },
});

const base = { name: 'app', services: [service] };

async function invoker() {
  return createCliInvoker(base);
}

async function runCli(argv: string[], stdin?: string) {
  let out = '';
  let err = '';
  let code = -1;
  const surface = await invoker();
  await createCli({
    ...base,
    version: '1.0.0',
    commands: [
      defineCliStreamCommand({ name: 'jsonl', invoker: surface }),
      defineCliBatchCommand({ name: 'batch', invoker: surface }),
    ],
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
    stdin: async () => stdin ?? null,
  });
  return { out, err, code };
}

function answers(out: string): Array<Record<string, unknown>> {
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const directories: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-batch-'));
  directories.push(directory);
  return directory;
}

describe('a parsed call runs in this process', () => {
  test('the result is the typed handler output, not text parsed back out of stdout', async () => {
    const surface = await invoker();
    const outcome = await surface.invoke('create_item', { title: 'hello', tags: ['a'] });
    expect(outcome.ok).toBe(true);
    expect(outcome.data).toEqual({ id: expect.any(String), title: 'hello', tags: ['a'] });
    expect(outcome.exitCode).toBe(0);
  });

  test('a nested object survives without a round trip through argv', async () => {
    // The shape that cost the most: `argsToArgv` had to stringify it into one
    // command-line slot and the child had to parse it again.
    const surface = await invoker();
    const outcome = await surface.invoke('create_item', {
      title: 'nested',
      tags: ['x', 'y', 'z'],
    });
    expect((outcome.data as { tags: string[] }).tags).toEqual(['x', 'y', 'z']);
  });

  test('a refusal carries the same code and exit code the printed path gives', async () => {
    const surface = await invoker();
    const outcome = await surface.invoke('fail_item', {});
    const printed = await runCli(['fail_item', '--json']);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('CONFLICT');
    // One exit table, read by both. Before, the code lived inside the function
    // that printed, so the only way to learn it was to print.
    expect(outcome.exitCode).toBe(printed.code);
  });

  test('a validation failure is the same on both paths too', async () => {
    const surface = await invoker();
    const outcome = await surface.invoke('create_item', { title: 'x' });
    const printed = await runCli(['create_item', '--title', 'x', '--json']);
    expect(outcome.error?.code).toBe('VALIDATION_ERROR');
    expect(outcome.exitCode).toBe(printed.code);
  });

  test('an unknown command answers instead of throwing', async () => {
    // A stream must answer the line that was wrong and keep reading.
    const surface = await invoker();
    const outcome = await surface.invoke('no_such_command', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('NOT_FOUND');
  });

  test('nothing is written and nothing exits', async () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const surface = await invoker();
      await surface.invoke('create_item', { title: 'quiet' });
    } finally {
      process.stdout.write = original;
    }
    expect(writes).toEqual([]);
  });
});

describe('one operation per line', () => {
  test('every line is answered under its own id, in order', async () => {
    const { out, code } = await runCli(
      ['jsonl'],
      [
        JSON.stringify({ id: 'a', command: 'create_item', args: { title: 'first' } }),
        JSON.stringify({ id: 'b', command: 'create_item', args: { title: 'second' } }),
      ].join('\n'),
    );
    expect(answers(out).map((answer) => answer.id)).toEqual(['a', 'b']);
    expect(code).toBe(0);
  });

  test('a malformed line answers and the stream keeps going', async () => {
    const { out } = await runCli(
      ['jsonl'],
      [
        'not json at all',
        JSON.stringify({ id: 'b', command: 'create_item', args: { title: 'ok' } }),
      ].join('\n'),
    );
    const [bad, good] = answers(out);
    expect(bad?.ok).toBe(false);
    expect(good?.id).toBe('b');
    expect(good?.ok).toBe(true);
  });

  test('a failing operation does not stop the stream either', async () => {
    const { out } = await runCli(
      ['jsonl'],
      [
        JSON.stringify({ id: 'a', command: 'fail_item', args: {} }),
        JSON.stringify({ id: 'b', command: 'create_item', args: { title: 'after' } }),
      ].join('\n'),
    );
    const [first, second] = answers(out);
    expect(first?.ok).toBe(false);
    expect(second?.ok).toBe(true);
  });

  test('a stream inside a stream works, because there is no nesting left to ban', async () => {
    // The consumer's own rule against this existed only because execution went
    // through a child process.
    const inner = JSON.stringify({
      id: 'inner',
      command: 'create_item',
      args: { title: 'deep' },
    });
    const { out } = await runCli(
      ['jsonl'],
      JSON.stringify({ id: 'outer', command: 'jsonl', args: { lines: inner } }),
    );
    const [answer] = answers(out);
    // `jsonl` is a native command and is deliberately NOT part of the managed
    // surface — it writes, and an operation that writes has no result to return.
    expect(answer?.ok).toBe(false);
    expect(answer?.error).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a batch resumes instead of repeating', () => {
  test('a second run replays instead of running the operation again', async () => {
    const checkpoint = join(scratch(), 'batch.json');
    const lines = JSON.stringify({ id: 'a', command: 'create_item', args: { title: 'once' } });
    const before = created;

    const first = await runCli(['batch', '--checkpoint', checkpoint], lines);
    const second = await runCli(['batch', '--checkpoint', checkpoint], lines);

    expect(created).toBe(before + 1);
    expect(answers(first.out)[0]?.replayed).toBeUndefined();
    expect(answers(second.out)[0]?.replayed).toBe(true);
    expect(answers(second.out)[0]?.data).toEqual(answers(first.out)[0]?.data);
  });

  test('a line edited under the same id is refused, not silently replayed', async () => {
    // Replaying would report success for an operation nobody ran; re-running
    // would double a paid call. Both answer a question nobody asked.
    const checkpoint = join(scratch(), 'batch.json');
    await runCli(
      ['batch', '--checkpoint', checkpoint],
      JSON.stringify({ id: 'a', command: 'create_item', args: { title: 'original' } }),
    );
    const { out } = await runCli(
      ['batch', '--checkpoint', checkpoint],
      JSON.stringify({ id: 'a', command: 'create_item', args: { title: 'CHANGED' } }),
    );
    expect(answers(out)[0]?.ok).toBe(false);
    expect(answers(out)[0]?.error).toMatchObject({ code: 'CONFLICT' });
  });

  test('the checkpoint is written per line, so an interrupted run keeps what it did', async () => {
    const checkpoint = join(scratch(), 'batch.json');
    const lines = [
      JSON.stringify({ id: 'a', command: 'create_item', args: { title: 'one' } }),
      JSON.stringify({ id: 'b', command: 'create_item', args: { title: 'two' } }),
    ].join('\n');
    await runCli(['batch', '--checkpoint', checkpoint], lines);
    const recorded: unknown = JSON.parse(readFileSync(checkpoint, 'utf8'));
    expect(Object.keys((recorded as { entries: Record<string, unknown> }).entries)).toEqual([
      'a',
      'b',
    ]);
  });

  test('an unreadable checkpoint starts a new one rather than refusing to run', async () => {
    const checkpoint = join(scratch(), 'batch.json');
    writeFileSync(checkpoint, 'not json');
    const { out } = await runCli(
      ['batch', '--checkpoint', checkpoint],
      JSON.stringify({ id: 'a', command: 'create_item', args: { title: 'fresh' } }),
    );
    expect(answers(out)[0]?.ok).toBe(true);
  });
});

process.on('exit', () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
