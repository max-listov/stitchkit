import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/entrypoints/contract';
import { createHandler, implement } from '../src/entrypoints/server';
import { defineCliResult } from '../src/tools/cli/command';
import { type CliConfig, createCli } from '../src/tools/cli/create-cli';
import { implementRemote } from '../src/tools/remote';

const Tick = z.object({ n: z.number() });
const Job = z.object({ id: z.string() });
const JobState = z.object({ id: z.string(), status: z.string() });

const contract = defineContract(
  { prefix: 'feeds', scope: 'public' },
  {
    slow: {
      method: 'POST',
      path: '/slow',
      desc: 'A source that ignores its signal',
      expose: ['HTTP', 'CLI'],
      stream: { item: Tick, lifetimeMs: 100 },
    },
    quiet: {
      method: 'POST',
      path: '/quiet',
      desc: 'A source that never yields and ignores its signal',
      expose: ['HTTP', 'CLI'],
      stream: { item: Tick },
    },
    ticks: {
      method: 'POST',
      path: '/ticks',
      desc: 'Three ticks',
      expose: ['HTTP', 'CLI'],
      input: z.object({ count: z.number().default(3) }),
      stream: { item: Tick },
    },
    local: {
      method: 'POST',
      path: '/local',
      desc: 'A feed only a terminal carries',
      expose: ['CLI'],
      stream: { item: Tick },
    },
    start: {
      method: 'POST',
      path: '/jobs',
      desc: 'Start a job',
      expose: ['CLI'],
      output: Job,
      tool: { name: 'job_start' },
    },
    state: {
      method: 'GET',
      path: '/jobs/:id',
      desc: 'Read a job',
      expose: ['CLI'],
      output: JobState,
      tool: { name: 'job_state' },
    },
  },
);

const service = implement(contract, {
  slow: () =>
    (async function* () {
      yield { n: 1 };
      await Bun.sleep(3_000);
      yield { n: 2 };
    })(),
  quiet: () =>
    (async function* () {
      await Bun.sleep(3_000);
      yield { n: 1 };
    })(),
  ticks: ({ input }) =>
    (async function* () {
      for (let n = 1; n <= input.count; n += 1) yield { n };
    })(),
  local: () =>
    (async function* () {
      yield { n: 7 };
    })(),
  start: () => ({ id: 'job-1' }),
  state: ({ params }) => ({ id: params.id, status: 'done' }),
});

type RunConfig = Pick<CliConfig, 'services' | 'results' | 'signal' | 'wait' | 'exitCodes'>;

async function run(argv: string[], config: RunConfig) {
  let out = '';
  let err = '';
  let code = -1;
  const startedAt = performance.now();
  await createCli({
    name: 'app',
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
  return { out, err, code, ms: performance.now() - startedAt };
}

describe('a stream command ends on its own deadline, not on its source', () => {
  test('lifetimeMs ends a source that ignores its signal', async () => {
    const result = await run(['slow_feed'], { services: [service] });
    expect(result.out).toBe('{"n":1}\n');
    expect(JSON.parse(result.err)).toMatchObject({ error: 'STREAM_LIFETIME_EXCEEDED' });
    expect(result.code).toBe(7);
    // The source sleeps three seconds; the command does not wait for it.
    expect(result.ms).toBeLessThan(1_500);
  });

  test('CliConfig.signal cancels with the cancelled exit code and prints no error', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await run(['quiet_feed'], {
      services: [service],
      signal: controller.signal,
    });
    expect(result).toMatchObject({ out: '', err: '', code: 130 });
    expect(result.ms).toBeLessThan(1_500);
  });

  test('a presenter that throws ends the feed with CLI_PRESENTATION_FAILED', async () => {
    const result = await run(['ticks_feed'], {
      services: [service],
      results: {
        ticks_feed: defineCliResult(Tick, {
          present: ({ result: tick }) => {
            if (tick.n === 2) throw new Error('broken presenter');
            return `tick ${tick.n}\n`;
          },
        }),
      },
    });
    expect(result.out).toBe('tick 1\n');
    expect(result.code).toBe(8);
    expect(JSON.parse(result.err)).toMatchObject({ error: 'CLI_PRESENTATION_FAILED' });
  });

  test('a stream exposed on CLI alone is a command and no HTTP route', async () => {
    const result = await run(['local_feed'], { services: [service] });
    expect(result).toMatchObject({ out: '{"n":7}\n', code: 0 });
    const handler = createHandler({ logging: false, services: [service] });
    const response = await handler(new Request('http://x/feeds/local', { method: 'POST' }));
    expect(response.status).toBe(404);
  });
});

describe('a result policy speaks for the command own result only', () => {
  test('after --wait the polled result is printed without the starting command policy', async () => {
    const seen: unknown[] = [];
    const result = await run(['job_start', '--wait', '--quiet', '--json'], {
      services: [service],
      wait: {
        job_start: {
          tool: 'job_state',
          poll: (value) => (Job.safeParse(value).success ? { id: Job.parse(value).id } : null),
          done: (value) => JobState.safeParse(value).data?.status === 'done',
          backoff: [0],
        },
      },
      results: {
        job_start: defineCliResult(Job, {
          present: ({ result: job }) => {
            seen.push(job);
            return `started ${job.id}\n`;
          },
          exitCode: () => 9,
        }),
      },
    });
    expect(seen).toEqual([]);
    expect(JSON.parse(result.out)).toEqual({ id: 'job-1', status: 'done' });
    expect(result.code).toBe(0);
    // The control: without --wait the policy does speak.
    const direct = await run(['job_start'], {
      services: [service],
      results: {
        job_start: defineCliResult(Job, {
          present: ({ result: job }) => `started ${job.id}\n`,
        }),
      },
    });
    expect(direct.out).toBe('started job-1\n');
  });
});

describe('a CLI over a remote server', () => {
  const origin = createHandler({ logging: false, services: [service] });
  const http = createHttpClient({
    baseUrl: 'http://origin',
    fetch: (input, init) => origin(new Request(input, init)),
  });

  test('a proxied stream runs as a command, item by item', async () => {
    const proxy = implementRemote(contract, http);
    expect(proxy.methods.ticks?.stream).toBeDefined();
    const result = await run(['ticks_feed', '--count', '2'], { services: [proxy] });
    expect(result).toMatchObject({ out: '{"n":1}\n{"n":2}\n', err: '', code: 0 });
  });

  test('an operation the remote server lacks exits 4 as UNKNOWN_OPERATION', async () => {
    const newer = defineContract(
      { prefix: 'feeds', scope: 'public' },
      {
        report: {
          method: 'GET',
          path: '/report/latest',
          desc: 'Added after the server was built',
          expose: ['HTTP', 'CLI'],
          output: z.object({ ok: z.boolean() }),
          tool: { name: 'report' },
        },
      },
    );
    const result = await run(['report'], { services: [implementRemote(newer, http)] });
    expect(result.code).toBe(4);
    expect(JSON.parse(result.err)).toMatchObject({
      error: 'UNKNOWN_OPERATION',
      details: { operation: 'feeds.report' },
    });
    // The typed client says the same thing in process.
    const client = createClient(newer, http);
    await expect(client.report()).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
  });
});
