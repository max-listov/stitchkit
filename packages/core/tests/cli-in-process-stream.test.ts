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
import {
  defineCliBatchCommand,
  defineCliStreamCommand,
  readStdinLines,
  runCliStream,
} from '../src/tools/cli-stream';

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

/** Feed lines the way a live producer does: one at a time, never closing early. */
function feed(lines: string): () => AsyncIterable<string> {
  return async function* () {
    for (const line of lines.split('\n')) yield line;
  };
}

async function runCli(argv: string[], stdin?: string) {
  let out = '';
  let err = '';
  let code = -1;
  const surface = await invoker();
  const readLines = feed(stdin ?? '');
  await createCli({
    ...base,
    version: '1.0.0',
    commands: [
      defineCliStreamCommand({ name: 'jsonl', invoker: surface, readLines }),
      defineCliBatchCommand({ name: 'batch', invoker: surface, readLines }),
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

  test('a failed line is retried on the next run, not replayed as a failure forever', async () => {
    // The first version recorded every outcome. One rate limit or dropped
    // connection and the line replayed its own failure on every future run,
    // with the only escape being to delete the checkpoint — which also throws
    // away the lines that did succeed. Recording exists because re-running a
    // SUCCESS repeats its effect; a failure had no effect to repeat.
    const checkpoint = join(scratch(), 'batch.json');
    const line = JSON.stringify({ id: 'a', command: 'fail_item', args: {} });
    const first = await runCli(['batch', '--checkpoint', checkpoint], line);
    expect(answers(first.out)[0]?.ok).toBe(false);

    const retry = await runCli(
      ['batch', '--checkpoint', checkpoint],
      JSON.stringify({ id: 'a', command: 'create_item', args: { title: 'recovered' } }),
    );
    // Not a CONFLICT either: nothing was recorded under that id, so the line is
    // free to be corrected and run.
    expect(answers(retry.out)[0]?.ok).toBe(true);
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

/*
 * The half that makes it a conversation rather than a pipe.
 *
 * The framework's ordinary stdin routing accumulates the whole stream and hands
 * a command one string. For `--prompt "$(cat file)"` that is right; here it is
 * fatal — an agent that writes one line and waits for the answer would be
 * waiting for its own EOF, which never comes. The first version of this command
 * did exactly that, and every test passed, because a test feeds a closed pipe.
 */
describe('a line is answered before the next one is read', () => {
  test('the first answer arrives while the producer is still open', async () => {
    const surface = await invoker();
    let released!: () => void;
    const secondLine = new Promise<void>((resolve) => {
      released = resolve;
    });
    const answered: string[] = [];

    async function* producer(): AsyncIterable<string> {
      yield JSON.stringify({ id: 'a', command: 'create_item', args: { title: 'one' } });
      // Nothing more is produced until the first answer has been seen. If the
      // reader waited for EOF this would deadlock rather than fail.
      await secondLine;
      yield JSON.stringify({ id: 'b', command: 'create_item', args: { title: 'two' } });
    }

    const finished = runCliStream(surface, producer(), (answer) => {
      answered.push(answer.id);
      if (answer.id === 'a') released();
    });
    await Promise.race([
      finished,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('stream waited for EOF')), 2_000),
      ),
    ]);
    expect(answered).toEqual(['a', 'b']);
  });

  test('a producer that never closes still gets its answers', async () => {
    const surface = await invoker();
    const answered: string[] = [];
    let stop!: () => void;
    const closed = new Promise<void>((resolve) => {
      stop = resolve;
    });

    async function* endless(): AsyncIterable<string> {
      let n = 0;
      while (n < 3) {
        n += 1;
        yield JSON.stringify({
          id: `n${n}`,
          command: 'create_item',
          args: { title: `t${n}` },
        });
      }
      // Hold the stream open the way a live agent's stdin is held open.
      await closed;
    }

    const finished = runCliStream(surface, endless(), (answer) => {
      answered.push(answer.id);
      if (answered.length === 3) stop();
    });
    await finished;
    expect(answered).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('lines are split the way producers actually write them', () => {
  async function linesOf(chunks: string[]): Promise<string[]> {
    const out: string[] = [];
    async function* source(): AsyncIterable<string> {
      for (const chunk of chunks) yield chunk;
    }
    for await (const line of readStdinLines(source())) out.push(line);
    return out;
  }

  test('a line split across two chunks is one line', async () => {
    expect(await linesOf(['{"id":"a","comm', 'and":"x","args":{}}\n'])).toEqual([
      '{"id":"a","command":"x","args":{}}',
    ]);
  });

  test('CRLF does not become a parse failure on every line', async () => {
    expect(await linesOf(['one\r\ntwo\r\n'])).toEqual(['one', 'two']);
  });

  test('a final line with no newline is delivered, not dropped', async () => {
    expect(await linesOf(['one\ntwo'])).toEqual(['one', 'two']);
  });

  test('several lines in one chunk are all delivered', async () => {
    expect(await linesOf(['a\nb\nc\n'])).toEqual(['a', 'b', 'c']);
  });
});

/*
 * The two paths cannot disagree — not by discipline, by construction.
 *
 * "One surface, one runner, one exit table" is easy to say and easy to lose:
 * the invoker started with an unparsed `{}` for the application's globals and
 * an unmerged exit-code map, so a line of a stream could run as a different
 * identity and report a different code than the same call typed at a prompt.
 */
describe('a stream and a prompt resolve the same way', () => {
  const globalOptions = z.object({ caller: z.string().default('default-key') });

  test('a declared global default reaches the invoker, not an empty object', async () => {
    let seen: unknown;
    await createCliInvoker({
      ...base,
      globalOptions,
      resolveAuth: (globals) => {
        seen = globals.caller;
        return { identity: globals.caller };
      },
    });
    // Skipped, this is `undefined`, and `resolveAuth` selects a different
    // identity than the command line would for the same invocation.
    expect(seen).toBe('default-key');
  });

  test('an application code map does not erase the framework defaults', async () => {
    const surface = await createCliInvoker({ ...base, exitCodes: { MY_OWN: 9 } });
    const outcome = await surface.invoke('fail_item', {});
    // `CONFLICT` still maps the way the printed path maps it; before the merge
    // a partial map made every other code fall through to 1.
    const printed = await runCli(['fail_item', '--json']);
    expect(outcome.exitCode).toBe(printed.code);
  });

  test('a code that names an Object property is not an exit code', async () => {
    // A tool error code is a free string and can arrive from a remote service.
    // Read off the prototype, `constructor` returns a function, which
    // `JSON.stringify` drops from the answer and `process.exit` cannot use.
    const surface = await createCliInvoker(base);
    const outcome = await surface.invoke('constructor', {});
    expect(typeof outcome.exitCode).toBe('number');
  });

  test('both paths list the same commands', async () => {
    const surface = await createCliInvoker(base);
    const { out } = await runCli(['--help']);
    for (const command of surface.commands) {
      expect(out).toContain(command.name);
    }
    expect(surface.commands.map((command) => command.name).sort()).toEqual([
      'create_item',
      'fail_item',
    ]);
  });
});

process.on('exit', () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
