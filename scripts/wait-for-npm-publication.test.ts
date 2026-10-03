import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_NPM_PUBLICATION_TIMEOUT_MS,
  type NpmPublicationDependencies,
  waitForNpmPublication,
} from './wait-for-npm-publication';

function fixture(fetchPackage: NpmPublicationDependencies['fetch'], clock = { elapsedMs: 0 }) {
  const sleeps: number[] = [];
  const warnings: string[] = [];
  const dependencies: NpmPublicationDependencies = {
    now: () => clock.elapsedMs,
    fetch: fetchPackage,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock.elapsedMs += milliseconds;
    },
    onRetry: (message) => warnings.push(message),
  };
  return { clock, sleeps, warnings, dependencies };
}
const policy = { timeoutMs: 100, requestTimeoutMs: 100, retryDelayMs: 25 };
const exact = () => Response.json({ name: '@scope/package', version: '1.2.3' });

test('late exact package/version inside the elapsed budget succeeds and preserves encoded registry path', async () => {
  const clock = { elapsedMs: 0 };
  const urls: string[] = [];
  const run = fixture(async (url) => {
    urls.push(url);
    clock.elapsedMs += 10;
    return urls.length === 3 ? exact() : new Response('', { status: 404 });
  }, clock);
  expect(
    await waitForNpmPublication('@scope/package', '1.2.3', policy, run.dependencies),
  ).toEqual({
    attempts: 3,
    elapsedMs: 80,
  });
  expect(urls).toEqual(
    [1, 2, 3].map(
      (attempt) => `https://registry.npmjs.org/%40scope%2Fpackage/1.2.3?attempt=${attempt}`,
    ),
  );
  expect(run.sleeps).toEqual([25, 25]);
});

test('wrong identity, malformed metadata/JSON and HTTP errors exhaust the deadline with the last refusal', async () => {
  const cases = [
    {
      response: () => Response.json({ name: 'another', version: '1.2.3' }),
      reason: 'another@1.2.3',
    },
    {
      response: () => Response.json({ name: '@scope/package', version: '0.9.0' }),
      reason: '@scope/package@0.9.0',
    },
    {
      response: () => Response.json({ name: '@scope/package' }),
      reason: 'invalid package metadata',
    },
    {
      response: () => Response.json({ name: 1, version: '1.2.3' }),
      reason: 'invalid package metadata',
    },
    { response: () => new Response('invalid JSON'), reason: 'JSON' },
    { response: () => new Response('', { status: 503 }), reason: 'HTTP 503' },
  ];
  for (const { response, reason } of cases) {
    let attempts = 0;
    const run = fixture(async () => {
      attempts++;
      return response();
    });
    await expect(
      waitForNpmPublication('@scope/package', '1.2.3', policy, run.dependencies),
    ).rejects.toThrow(reason);
    expect(run.clock.elapsedMs).toBe(100);
    expect(attempts).toBe(4);
    expect(run.sleeps).toEqual([25, 25, 25, 25]);
  }
});

test('network API refusals preserve their actual final cause', async () => {
  let attempts = 0;
  const run = fixture(async () => {
    throw new Error(`network failure ${++attempts}`);
  });
  await expect(
    waitForNpmPublication('@scope/package', '1.2.3', policy, run.dependencies),
  ).rejects.toThrow('network failure 4');
  expect(attempts).toBe(4);
});

test('slow fetch spends the total budget and never admits exact identity at or after its deadline', async () => {
  for (const delay of [100, 101]) {
    let attempts = 0;
    const clock = { elapsedMs: 0 };
    const run = fixture(async () => {
      attempts++;
      clock.elapsedMs += delay;
      return exact();
    }, clock);
    await expect(
      waitForNpmPublication('@scope/package', '1.2.3', policy, run.dependencies),
    ).rejects.toThrow('elapsed deadline');
    expect(attempts).toBe(1);
    expect(run.sleeps).toEqual([]);
  }
});

test('response body time belongs to the same deadline as response headers', async () => {
  for (const bodyTime of [59, 60, 61]) {
    const clock = { elapsedMs: 0 };
    class SlowBody extends Response {
      override async json(): Promise<unknown> {
        clock.elapsedMs += bodyTime;
        return { name: '@scope/package', version: '1.2.3' };
      }
    }
    const run = fixture(async () => {
      clock.elapsedMs += 40;
      return new SlowBody();
    }, clock);
    const waiting = waitForNpmPublication('@scope/package', '1.2.3', policy, run.dependencies);
    if (bodyTime === 59) expect(await waiting).toEqual({ attempts: 1, elapsedMs: 99 });
    else await expect(waiting).rejects.toThrow('elapsed deadline');
  }
});

test('request timeout bounds headers and body together independently of the larger total budget', async () => {
  const clock = { elapsedMs: 0 };
  let attempts = 0;
  class SlowBody extends Response {
    override async json(): Promise<unknown> {
      clock.elapsedMs += 6;
      return { name: '@scope/package', version: '1.2.3' };
    }
  }
  const run = fixture(async () => {
    attempts++;
    clock.elapsedMs += 5;
    return new SlowBody();
  }, clock);
  await expect(
    waitForNpmPublication(
      '@scope/package',
      '1.2.3',
      { ...policy, requestTimeoutMs: 10 },
      run.dependencies,
    ),
  ).rejects.toThrow('elapsed deadline');
  expect(attempts).toBe(3);
  expect(run.sleeps).toEqual([25, 25, 17]);
});

test('retry sleep is capped at remaining time and no request starts after exhaustion', async () => {
  let attempts = 0;
  const clock = { elapsedMs: 0 };
  const run = fixture(async () => {
    attempts++;
    clock.elapsedMs += 90;
    return new Response('', { status: 404 });
  }, clock);
  await expect(
    waitForNpmPublication('@scope/package', '1.2.3', policy, run.dependencies),
  ).rejects.toThrow('HTTP 404');
  expect(run.sleeps).toEqual([10]);
  expect(attempts).toBe(1);
});

test('a retry sleeper overshooting its requested delay cannot extend polling', async () => {
  let attempts = 0;
  const clock = { elapsedMs: 0 };
  const run = fixture(async () => {
    attempts++;
    return new Response('', { status: 404 });
  }, clock);
  run.dependencies.sleep = async (milliseconds) => {
    clock.elapsedMs += milliseconds + 100;
  };
  await expect(
    waitForNpmPublication('@scope/package', '1.2.3', policy, run.dependencies),
  ).rejects.toThrow('HTTP 404');
  expect(attempts).toBe(1);
});

test('wall clock jumps never change the monotonic elapsed budget', async () => {
  const original = Date.now;
  try {
    let wallTime = 10_000;
    Date.now = () => wallTime;
    const clock = { elapsedMs: 0 };
    let attempts = 0;
    const run = fixture(async () => {
      wallTime += ++attempts % 2 ? 1_000_000_000 : -2_000_000_000;
      return new Response('', { status: 404 });
    }, clock);
    await expect(
      waitForNpmPublication('@scope/package', '1.2.3', policy, run.dependencies),
    ).rejects.toThrow('within 100ms');
    expect(attempts).toBe(4);
    expect(clock.elapsedMs).toBe(100);
  } finally {
    Date.now = original;
  }
});

test('a stalled fetch or response body is aborted by the real remaining deadline', async () => {
  for (const stage of ['headers', 'body']) {
    let attempts = 0;
    let aborted = false;
    let bodyCanceled = false;
    const clock = { elapsedMs: 0 };
    const run = fixture(async (_url, { signal }) => {
      attempts++;
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      if (stage === 'headers') return new Promise<Response>(() => undefined);
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => {
              bodyCanceled = true;
              controller.error(signal.reason);
            });
          },
        }),
      );
    }, clock);
    run.dependencies.sleep = async (milliseconds) => {
      clock.elapsedMs += milliseconds;
    };
    // The test clock advances only on retry; the attempt timer must interrupt the stalled operation.
    await expect(
      waitForNpmPublication(
        '@scope/package',
        '1.2.3',
        { timeoutMs: 20, requestTimeoutMs: 5, retryDelayMs: 20 },
        run.dependencies,
      ),
    ).rejects.toThrow('5ms budget');
    expect(attempts).toBe(1);
    expect(aborted).toBe(true);
    if (stage === 'body') expect(bodyCanceled).toBe(true);
  }
});

test('the default 30-minute deadline refuses the old 240-attempt slow-fetch shape', async () => {
  let attempts = 0;
  const clock = { elapsedMs: 0 };
  const run = fixture(async () => {
    clock.elapsedMs += 4_999;
    return ++attempts === 240
      ? exact()
      : Response.json({ name: '@scope/package', version: '0.9.0' });
  }, clock);
  await expect(
    waitForNpmPublication('@scope/package', '1.2.3', {}, run.dependencies),
  ).rejects.toThrow(`within ${30 * 60 * 1000}ms`);
  expect(attempts).toBe(181);
  expect(DEFAULT_NPM_PUBLICATION_TIMEOUT_MS).toBe(1_800_000);
});

test('the actual CLI uses the bounded owner and reports registry confirmation without network access', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'stitchkit-publication-cli-'));
  const preload = join(scratch, 'registry.ts');
  writeFileSync(
    preload,
    `Object.defineProperty(globalThis, 'fetch', { value: async () => Response.json({ name: '@scope/package', version: '1.2.3' }) });\n`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--preload',
        preload,
        `${import.meta.dir}/wait-for-npm-publication.ts`,
        '@scope/package',
        '1.2.3',
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      '@scope/package@1.2.3 is available from the public npm registry',
    );
    const invalid = spawnSync(
      process.execPath,
      ['--preload', preload, `${import.meta.dir}/wait-for-npm-publication.ts`],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain(
      'Usage: bun scripts/wait-for-npm-publication.ts <package> <version>',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a stalled retry sleeper is interrupted at the total deadline with the last registry refusal', async () => {
  let attempts = 0;
  await expect(
    waitForNpmPublication(
      '@scope/package',
      '1.2.3',
      { timeoutMs: 20, requestTimeoutMs: 20, retryDelayMs: 25 },
      {
        fetch: async () => {
          attempts++;
          return new Response('', { status: 503 });
        },
        sleep: () => new Promise<void>(() => undefined),
        onRetry: () => undefined,
      },
    ),
  ).rejects.toThrow('HTTP 503');
  expect(attempts).toBe(1);
}, 1_000);

test('the default clock ignores Date.now even without an injected monotonic clock', async () => {
  const original = Date.now;
  let wallClockCalls = 0;
  let fetches = 0;
  Date.now = () => ++wallClockCalls * 1_000_000_000;
  try {
    const result = await waitForNpmPublication(
      '@scope/package',
      '1.2.3',
      {
        timeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      {
        fetch: async () => {
          fetches++;
          return exact();
        },
        onRetry: () => undefined,
      },
    );
    expect(result.attempts).toBe(1);
    expect(fetches).toBe(1);
    expect(wallClockCalls).toBe(0);
  } finally {
    Date.now = original;
  }
});
