import { expect, test } from 'bun:test';
import { join } from 'node:path';

const fixture = join(import.meta.dir, 'fixtures/cli-stdin.ts');

test('required input fails within one second on an empty open pipe', async () => {
  const start = performance.now();
  const child = Bun.spawn([process.execPath, fixture, 'need', '--json'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const guard = setTimeout(() => child.kill(), 1500);
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(code).not.toBe(0);
    expect(out + err).toContain('text');
    expect(child.signalCode).toBeNull();
  } finally {
    clearTimeout(guard);
    child.stdin.end();
    child.kill();
  }
});

async function runPipe(
  args: string[],
  feed: (stdin: ReturnType<typeof pipeInput>) => Promise<void>,
  explicitReader = false,
) {
  const child = spawnProbe(args, explicitReader);
  const input = pipeInput(child.stdin);
  const guard = setTimeout(() => child.kill(), 4000);
  try {
    let feedError: unknown;
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      feed(input).catch((error: unknown) => {
        feedError = error;
      }),
    ]);
    if (feedError)
      throw new Error(
        `stdin writer failed; child exit=${code}, stdout=${out.slice(0, 500)}, stderr=${err}`,
        { cause: feedError },
      );
    expect(child.signalCode).toBeNull();
    return { code, out, err };
  } finally {
    clearTimeout(guard);
    await input.end();
    child.kill();
  }
}

/** A producer owns EOF exactly once, including cleanup after a failed assertion. */
function pipeInput(stdin: Bun.FileSink) {
  let ended = false;
  return {
    write: (data: Uint8Array | string) => stdin.write(data),
    flush: () => stdin.flush(),
    end: async () => {
      if (ended) return;
      ended = true;
      // Drain pending writes before closing the producer's pipe.
      await stdin.flush();
      await stdin.end();
    },
  };
}

function spawnProbe(args: string[], explicitReader = false) {
  return Bun.spawn([process.execPath, fixture, ...args], {
    env: { ...process.env, STITCHKIT_TEST_EXPLICIT_STDIN: explicitReader ? '1' : '0' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

test('explicit stdin hook waits for a producer starting after the probe window', async () => {
  const result = await runPipe(
    ['need', '--json'],
    async (stdin) => {
      await Bun.sleep(600);
      stdin.write('delayed producer');
      await stdin.end();
    },
    true,
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ text: 'delayed producer' });
});

for (const command of ['need', 'managed']) {
  test(`${command}: EOF without bytes gives a field validation error`, async () => {
    const result = await runPipe([command, '--json'], async (stdin) => {
      stdin.end();
    });
    expect(result.code).toBe(1);
    expect(result.out + result.err).toContain('text');
  });

  test(`${command}: explicit argument succeeds with empty open stdin`, async () => {
    const result = await runPipe([command, '--text', 'explicit', '--json'], async () => {
      // Keep stdin open without providing data.
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ text: 'explicit' });
  });

  test(`${command}: large multipart UTF-8 input survives pauses beyond the probe window`, async () => {
    const text = `start-${'ёж🦊'.repeat(80_000)}-tail`;
    const bytes = Buffer.from(text);
    const result = await runPipe([command, '--json'], async (stdin) => {
      stdin.write(bytes.subarray(0, 7)); // Split a multibyte character across chunks.
      await stdin.flush();
      await Bun.sleep(400);
      stdin.write(bytes.subarray(7, 400_001));
      await stdin.flush();
      await Bun.sleep(400);
      stdin.write(bytes.subarray(400_001));
      await stdin.end();
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ text });
  });
}

test('stream command accepts its first line after the automatic probe window', async () => {
  const result = await runPipe(['stream'], async (stdin) => {
    await Bun.sleep(600);
    stdin.write(
      `${JSON.stringify({ id: 'late', command: 'managed', args: { text: 'late input' } })}\n`,
    );
    await stdin.end();
  });
  expect(result.code).toBe(0);
  const answer = JSON.parse(result.out);
  expect(answer.id).toBe('late');
  expect(answer.ok).toBe(true);
});

test('TTY without data gives the ordinary required-field error', async () => {
  let output = '';
  const child = Bun.spawn([process.execPath, fixture, 'need', '--json'], {
    terminal: {
      cols: 80,
      rows: 24,
      data(_terminal, data) {
        output += Buffer.from(data).toString();
      },
    },
  });
  const guard = setTimeout(() => child.kill(), 1500);
  try {
    expect(await child.exited).toBe(1);
    expect(output).toContain('VALIDATION_ERROR');
    expect(output).toContain('text');
  } finally {
    clearTimeout(guard);
    child.terminal?.close();
    child.kill();
  }
});
