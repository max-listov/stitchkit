/**
 * An interrupted update continues where it stopped, and a kept part is never trusted.
 *
 * The consumer behind this: a 42 MB build over a 40–60 KB/s link never finished inside the old
 * 120-second deadline, and every attempt started from zero; it was installed by hand with
 * `curl -C -` and a manual sha256 check. Here a real socket serves the build with `ETag` and
 * `Range` support, cuts transfers, stalls them and throttles them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { currentCliBuildTarget } from '../src/tools/cli/manifest';
import { applyCliUpdate } from '../src/tools/cli/update';
import { expectTimerRejection } from './support/timer-refusal';

const BINARY = randomBytes(150 * 1024); // random: gzip keeps it about this size
const DIGEST = createHash('sha256').update(BINARY).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Served {
  url: string;
  requests: Array<{
    range: string | null;
    ifRange: string | null;
    status: number;
    sent: number;
  }>;
  /** What the server holds and its `ETag`; replaceable mid-test. */
  file: { bytes: Uint8Array; etag: string };
  /** Cut the next transfer after this many bytes (once). */
  cutAfter?: number;
  /** Stall the next transfer after this many bytes (once), for `stallMs`. */
  stallAfter?: number;
  stallMs?: number;
  /** Send 5 KB per this many milliseconds. */
  chunkEveryMs: number;
  /** Answer every request whole, as a server without range support does. */
  ignoreRange?: boolean;
  /** Answer a range from this offset instead of the one asked for. */
  wrongStart?: number;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stitchkit-resume-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function serve(bytes: Uint8Array = gzipSync(BINARY)): Served {
  const served: Served = {
    url: '',
    requests: [],
    file: { bytes, etag: '"build-1"' },
    chunkEveryMs: 0,
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: (request) => {
      const { bytes: file, etag } = served.file;
      const range = request.headers.get('range');
      const ifRange = request.headers.get('if-range');
      const match = range ? /^bytes=(\d+)-$/.exec(range) : null;
      const honoured =
        !served.ignoreRange && match !== null && (ifRange === null || ifRange === etag);
      const start = honoured && match ? (served.wrongStart ?? Number(match[1])) : 0;
      if (honoured && start >= file.length) {
        served.requests.push({ range, ifRange, status: 416, sent: 0 });
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${file.length}` },
        });
      }
      const body = file.subarray(start);
      const record = { range, ifRange, status: honoured ? 206 : 200, sent: 0 };
      served.requests.push(record);
      const cutAfter = served.cutAfter;
      const stallAfter = served.stallAfter;
      served.cutAfter = undefined;
      served.stallAfter = undefined;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (cutAfter !== undefined && record.sent >= cutAfter) {
            controller.error(new Error('link dropped'));
            return;
          }
          if (stallAfter !== undefined && record.sent >= stallAfter && served.stallMs) {
            const wait = served.stallMs;
            served.stallMs = undefined;
            await sleep(wait);
          }
          if (record.sent >= body.length) {
            controller.close();
            return;
          }
          const chunk = body.subarray(record.sent, record.sent + 5 * 1024);
          record.sent += chunk.length;
          controller.enqueue(chunk);
          if (served.chunkEveryMs) await sleep(served.chunkEveryMs);
        },
      });
      return new Response(stream, {
        status: honoured ? 206 : 200,
        headers: {
          etag,
          'content-length': String(body.length),
          ...(honoured && {
            'content-range': `bytes ${start}-${file.length - 1}/${file.length}`,
          }),
        },
      });
    },
  });
  cleanups.push(() => void server.stop(true));
  served.url = `http://127.0.0.1:${server.port}/app.gz`;
  return served;
}

function update(
  served: Served,
  dir: string,
  extra: {
    idleTimeoutMs?: number;
    timeoutMs?: number;
    verifyTimeoutMs?: number;
    compression?: 'gzip' | 'none';
  } = {},
) {
  return applyCliUpdate({
    asset: {
      ...currentCliBuildTarget(),
      url: served.url,
      compression: extra.compression ?? 'gzip',
      size: BINARY.length,
      sha256: DIGEST,
    },
    targetPath: join(dir, 'app'),
    partialPath: join(dir, 'state', 'update.part'),
    allowPrivateHosts: true,
    ...(extra.idleTimeoutMs !== undefined && { idleTimeoutMs: extra.idleTimeoutMs }),
    ...(extra.timeoutMs !== undefined && { timeoutMs: extra.timeoutMs }),
    ...(extra.verifyTimeoutMs !== undefined && {
      verify: () => undefined,
      verifyTimeoutMs: extra.verifyTimeoutMs,
    }),
  });
}

function prepareState(dir: string): void {
  // The application owns its state directory; the update writes into it.
  mkdirSync(join(dir, 'state'));
}

describe('an interrupted update continues from where it stopped', () => {
  test('a deadline past the timer range is refused before anything is downloaded', async () => {
    // 2 ** 31 ms is past the timer ceiling: such a timer fires at once, so the download or the
    // verification would end the moment it began — after the bytes were already fetched.
    for (const option of ['timeoutMs', 'idleTimeoutMs', 'verifyTimeoutMs'] as const) {
      const served = serve();
      const dir = scratch();
      prepareState(dir);
      await expectTimerRejection(
        update(served, dir, { [option]: 2 ** 31 }),
        `[stitchkit] update: ${option}`,
        2 ** 31,
      );
      expect(served.requests).toEqual([]);
      expect(existsSync(join(dir, 'state', 'update.part'))).toBe(false);
    }
  });

  test('the second attempt asks for the rest and receives only the rest', async () => {
    const served = serve();
    const dir = scratch();
    prepareState(dir);
    const part = join(dir, 'state', 'update.part');
    served.cutAfter = 60 * 1024;
    served.chunkEveryMs = 5;
    await expect(update(served, dir)).rejects.toThrow(/kept in .*update\.part/);
    const kept = statSync(part).size;
    expect(kept).toBeGreaterThan(0);
    expect(statSync(part).mode & 0o777).toBe(0o600);

    const applied = await update(served, dir);
    expect(applied.sha256).toBe(DIGEST);
    expect(readFileSync(join(dir, 'app')).equals(BINARY)).toBe(true);
    const resumed = served.requests[1];
    expect(resumed?.range).toBe(`bytes=${kept}-`);
    expect(resumed?.ifRange).toBe('"build-1"');
    expect(resumed?.status).toBe(206);
    expect(resumed?.sent).toBe(served.file.bytes.length - kept);
    // Installed: neither the part nor its record stays behind.
    expect(existsSync(part)).toBe(false);
    expect(existsSync(`${part}.json`)).toBe(false);
  });

  test('a corrupt part is thrown away and the build downloaded once more from zero', async () => {
    const served = serve();
    const dir = scratch();
    prepareState(dir);
    const part = join(dir, 'state', 'update.part');
    served.cutAfter = 60 * 1024;
    served.chunkEveryMs = 5;
    await expect(update(served, dir)).rejects.toThrow(/kept in/);
    const bytes = readFileSync(part);
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
    writeFileSync(part, bytes);

    const applied = await update(served, dir);
    expect(applied.sha256).toBe(DIGEST);
    expect(served.requests.map((request) => request.range === null)).toEqual([
      true,
      false,
      true,
    ]);
    expect(existsSync(part)).toBe(false);
  });

  test('a build replaced on the server is downloaded whole, not spliced', async () => {
    const served = serve();
    const dir = scratch();
    prepareState(dir);
    served.cutAfter = 60 * 1024;
    served.chunkEveryMs = 5;
    await expect(update(served, dir)).rejects.toThrow(/kept in/);
    // Same build, re-uploaded: a new tag, so the server answers the whole file.
    served.file = { bytes: served.file.bytes, etag: '"build-2"' };
    const applied = await update(served, dir);
    expect(applied.sha256).toBe(DIGEST);
    expect(served.requests[1]?.status).toBe(200);
  });

  test('a server that ignores the range answers whole, and the part starts over', async () => {
    const served = serve();
    const dir = scratch();
    prepareState(dir);
    served.cutAfter = 60 * 1024;
    served.chunkEveryMs = 5;
    await expect(update(served, dir)).rejects.toThrow(/kept in/);
    served.ignoreRange = true;
    expect((await update(served, dir)).sha256).toBe(DIGEST);
    expect(served.requests[1]?.range).not.toBeNull();
    expect(served.requests[1]?.status).toBe(200);
  });

  test('a range answered from another offset is not appended', async () => {
    const served = serve();
    const dir = scratch();
    prepareState(dir);
    served.cutAfter = 60 * 1024;
    served.chunkEveryMs = 5;
    await expect(update(served, dir)).rejects.toThrow(/kept in/);
    served.wrongStart = 1024;
    const applied = update(served, dir);
    await expect(applied).resolves.toMatchObject({ sha256: DIGEST });
    // The misplaced range was dropped and the build fetched whole from zero.
    expect(served.requests.slice(1).map((request) => request.range === null)).toEqual([
      false,
      true,
    ]);
  });

  test('an uncompressed part with one wrong byte is caught by its digest and fetched again', async () => {
    const served = serve(BINARY);
    const dir = scratch();
    prepareState(dir);
    const part = join(dir, 'state', 'update.part');
    served.cutAfter = 60 * 1024;
    served.chunkEveryMs = 5;
    await expect(update(served, dir, { compression: 'none' })).rejects.toThrow(/kept in/);
    const bytes = readFileSync(part);
    bytes[10] = (bytes[10] ?? 0) ^ 0xff;
    writeFileSync(part, bytes);
    const applied = await update(served, dir, { compression: 'none' });
    expect(applied.sha256).toBe(DIGEST);
    expect(served.requests.map((request) => request.range === null)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test('a part that is already whole is installed without a transfer', async () => {
    const served = serve();
    const dir = scratch();
    prepareState(dir);
    const part = join(dir, 'state', 'update.part');
    writeFileSync(part, served.file.bytes, { mode: 0o600 });
    writeFileSync(
      `${part}.json`,
      JSON.stringify({ url: served.url, sha256: DIGEST, validator: '"build-1"' }),
    );
    expect((await update(served, dir)).sha256).toBe(DIGEST);
    expect(served.requests.map((request) => request.status)).toEqual([416]);
  });

  test('a fresh download that is not the build is refused and leaves nothing', async () => {
    const served = serve(gzipSync(randomBytes(BINARY.length)));
    const dir = scratch();
    prepareState(dir);
    await expect(update(served, dir)).rejects.toThrow(/digest|checksum/);
    expect(served.requests).toHaveLength(1);
    expect(existsSync(join(dir, 'state', 'update.part'))).toBe(false);
    expect(existsSync(join(dir, 'app'))).toBe(false);
  });

  test('a second update into the same part is refused while the first downloads', async () => {
    const served = serve();
    served.chunkEveryMs = 20;
    const dir = scratch();
    prepareState(dir);
    const first = update(served, dir);
    await sleep(100);
    await expect(update(served, dir)).rejects.toThrow(/already downloading/);
    expect((await first).sha256).toBe(DIGEST);
  }, 20_000);
});

describe('a slow link is not a dead one', () => {
  test('a 50 KB/s download finishes under the defaults', async () => {
    const served = serve();
    served.chunkEveryMs = 100;
    const dir = scratch();
    prepareState(dir);
    expect((await update(served, dir)).sha256).toBe(DIGEST);
  }, 20_000);

  test('negative control: the same link under a one-second total deadline fails', async () => {
    const served = serve();
    served.chunkEveryMs = 100;
    const dir = scratch();
    prepareState(dir);
    await expect(update(served, dir, { timeoutMs: 1_000 })).rejects.toThrow(/within 1000ms/);
  }, 20_000);

  test('a declared total deadline keeps its meaning: no idle deadline unless declared too', async () => {
    const served = serve();
    served.stallAfter = 40 * 1024;
    served.stallMs = 1_000;
    const dir = scratch();
    prepareState(dir);
    expect((await update(served, dir, { timeoutMs: 10_000 })).sha256).toBe(DIGEST);
  }, 20_000);

  test('a silent link fails on the idle deadline and keeps what arrived', async () => {
    const served = serve();
    served.stallAfter = 40 * 1024;
    served.stallMs = 3_000;
    const dir = scratch();
    prepareState(dir);
    await expect(update(served, dir, { idleTimeoutMs: 300 })).rejects.toThrow(
      /received nothing for 300ms/,
    );
    expect(statSync(join(dir, 'state', 'update.part')).size).toBeGreaterThanOrEqual(40 * 1024);
  }, 20_000);
});

describe('the bounds a resumed download keeps', () => {
  test('the size ceiling counts the kept part too, and a crossed one leaves nothing', async () => {
    const served = serve();
    const dir = scratch();
    prepareState(dir);
    served.cutAfter = 60 * 1024;
    served.chunkEveryMs = 5;
    await expect(update(served, dir)).rejects.toThrow(/kept in/);
    // The rest alone fits under the ceiling; the part and the rest together do not.
    await expect(
      applyCliUpdate({
        asset: {
          ...currentCliBuildTarget(),
          url: served.url,
          compression: 'gzip',
          size: 1024,
          sha256: DIGEST,
        },
        targetPath: join(dir, 'app'),
        partialPath: join(dir, 'state', 'update.part'),
        allowPrivateHosts: true,
        maxBytes: served.file.bytes.length - 1,
      }),
    ).rejects.toThrow(/size ceiling/);
    expect(existsSync(join(dir, 'state', 'update.part'))).toBe(false);
  });

  test('a private address is refused before anything is transferred', async () => {
    const served = serve();
    const dir = scratch();
    prepareState(dir);
    await expect(
      applyCliUpdate({
        asset: {
          ...currentCliBuildTarget(),
          url: served.url,
          compression: 'gzip',
          size: BINARY.length,
          sha256: DIGEST,
        },
        targetPath: join(dir, 'app'),
        partialPath: join(dir, 'state', 'update.part'),
      }),
    ).rejects.toThrow(/private address/);
    expect(served.requests).toHaveLength(0);
  });
});
