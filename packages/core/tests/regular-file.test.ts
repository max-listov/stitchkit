import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_JSON_FILE_BYTES,
  fileIdentity,
  parseJsonBytes,
  type RegularFileAccept,
  RegularFileError,
  type RegularFileRefusal,
  readJsonFileSync,
  readRegularFile,
  readRegularFileSync,
} from '../src/entrypoints/files';
import {
  readRegularFileFromOpen,
  readRegularFileWithMetaSync,
} from '../src/files/regular-file';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stitchkit-regular-file-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function expectRegularFileError(
  run: () => unknown,
  reason: RegularFileRefusal,
): RegularFileError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RegularFileError);
    if (error instanceof RegularFileError) {
      expect(error.reason).toBe(reason);
      return error;
    }
  }
  throw new Error(`expected RegularFileError(${reason})`);
}

async function expectRegularFileErrorAsync(
  run: () => Promise<unknown>,
  reason: RegularFileRefusal,
): Promise<RegularFileError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RegularFileError);
    if (error instanceof RegularFileError) {
      expect(error.reason).toBe(reason);
      return error;
    }
  }
  throw new Error(`expected RegularFileError(${reason})`);
}

describe('regular-file primitives', () => {
  test('reads regular files synchronously and asynchronously', async () => {
    expect(Number.isSafeInteger(DEFAULT_JSON_FILE_BYTES)).toBe(true);
    expect(DEFAULT_JSON_FILE_BYTES).toBeGreaterThan(0);

    const file = join(root, 'config.json');
    writeFileSync(file, '{"ok":true}');

    const syncBytes = readRegularFileSync(file);
    const asyncBytes = await readRegularFile(file);
    expect(new TextDecoder().decode(syncBytes)).toBe('{"ok":true}');
    expect(new TextDecoder().decode(asyncBytes)).toBe('{"ok":true}');
  });

  test('refuses FIFO without blocking, directories, and Unix sockets', async () => {
    const dirPath = join(root, 'subdir');
    mkdirSync(dirPath);

    const fifoPath = join(root, 'pipe.fifo');
    const made = spawnSync('mkfifo', [fifoPath]);
    expect(made.status).toBe(0);

    const sockPath = join(root, 'service.sock');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const symlinkToDir = join(root, 'link-dir');
    const symlinkToFifo = join(root, 'link-fifo');
    const danglingSymlink = join(root, 'dangling-link');
    symlinkSync(dirPath, symlinkToDir);
    symlinkSync(fifoPath, symlinkToFifo);
    symlinkSync(join(root, 'nonexistent-target'), danglingSymlink);

    try {
      for (const nonRegular of [
        dirPath,
        fifoPath,
        sockPath,
        '/dev/null',
        symlinkToDir,
        symlinkToFifo,
      ]) {
        expectRegularFileError(() => readRegularFileSync(nonRegular), 'not-regular');
        await expectRegularFileErrorAsync(() => readRegularFile(nonRegular), 'not-regular');
      }

      // Dangling symlink propagates ENOENT rather than RegularFileError
      expect(() => readRegularFileSync(danglingSymlink)).toThrow(/ENOENT/);
      await expect(readRegularFile(danglingSymlink)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('refuses files exceeding limit and invalid limit values', async () => {
    const file = join(root, 'large.txt');
    writeFileSync(file, '0123456789');

    expectRegularFileError(() => readRegularFileSync(file, { limit: 9 }), 'too-large');
    await expectRegularFileErrorAsync(() => readRegularFile(file, { limit: 9 }), 'too-large');

    expect(readRegularFileSync(file, { limit: 10 }).byteLength).toBe(10);
    expect((await readRegularFile(file, { limit: 10 })).byteLength).toBe(10);

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => readRegularFileSync(file, { limit: bad })).toThrow(TypeError);
      await expect(readRegularFile(file, { limit: bad })).rejects.toThrow(TypeError);
    }
  });

  test('propagates ENOENT for missing files instead of RegularFileError', async () => {
    const missing = join(root, 'does-not-exist.json');
    expect(() => readRegularFileSync(missing)).toThrow(/ENOENT/);
    await expect(readRegularFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('accept callback inspects descriptor stats and can reject before read', () => {
    const file = join(root, 'checked.txt');
    writeFileSync(file, 'payload');

    let seenSize = -1;
    const bytes = readRegularFileSync(file, {
      limit: 64,
      accept: (info) => {
        seenSize = info.size;
        return true;
      },
    });
    expect(seenSize).toBe(7);
    expect(new TextDecoder().decode(bytes)).toBe('payload');

    expectRegularFileError(
      () => readRegularFileSync(file, { limit: 64, accept: () => false }),
      'rejected',
    );

    const customError = new Error('mode check failed');
    expect(() =>
      readRegularFileSync(file, {
        limit: 64,
        accept: () => {
          throw customError;
        },
      }),
    ).toThrow(customError);
  });

  test('fileIdentity produces deterministic identity for Stats and BigIntStats', () => {
    const file = join(root, 'identity.txt');
    writeFileSync(file, 'v1');
    const s1 = statSync(file);
    const b1 = statSync(file, { bigint: true });
    expect(fileIdentity(s1)).toBe(fileIdentity(s1));
    expect(fileIdentity(b1)).toBe(fileIdentity(b1));

    writeFileSync(file, 'v2-longer');
    const s2 = statSync(file);
    const b2 = statSync(file, { bigint: true });
    expect(fileIdentity(s2)).not.toBe(fileIdentity(s1));
    expect(fileIdentity(b2)).not.toBe(fileIdentity(b1));
  });

  test('readRegularFileSync retries once on concurrent change and throws changed on second change', () => {
    const file = join(root, 'mutating.txt');
    writeFileSync(file, 'first');

    let attempts = 0;
    const recovered = readRegularFileSync(file, {
      limit: 1024,
      accept: () => {
        attempts += 1;
        if (attempts === 1) {
          writeFileSync(file, 'updated-during-first-attempt');
        }
        return true;
      },
    });
    expect(attempts).toBe(2);
    expect(new TextDecoder().decode(recovered)).toBe('updated-during-first-attempt');

    let failingAttempts = 0;
    expectRegularFileError(
      () =>
        readRegularFileSync(file, {
          limit: 1024,
          accept: () => {
            failingAttempts += 1;
            writeFileSync(
              file,
              `mutated-attempt-${failingAttempts}-${'x'.repeat(failingAttempts)}`,
            );
            return true;
          },
        }),
      'changed',
    );
    expect(failingAttempts).toBe(2);
  });

  test('readRegularFileSync retries once when file mode changes during read and throws changed on persistent mode churn', () => {
    const file = join(root, 'chmod-during-read.txt');
    writeFileSync(file, 'secret-key', { mode: 0o600 });

    let attempts = 0;
    const recovered = readRegularFileSync(file, {
      limit: 1024,
      accept: (info) => {
        attempts += 1;
        if (attempts === 1) {
          expect(info.mode & 0o777).toBe(0o600);
          chmodSync(file, 0o640);
        } else {
          expect(info.mode & 0o777).toBe(0o640);
        }
        return true;
      },
    });
    expect(attempts).toBe(2);
    expect(new TextDecoder().decode(recovered)).toBe('secret-key');

    let churnAttempts = 0;
    expectRegularFileError(
      () =>
        readRegularFileSync(file, {
          limit: 1024,
          accept: () => {
            churnAttempts += 1;
            chmodSync(file, churnAttempts % 2 === 1 ? 0o600 : 0o640);
            return true;
          },
        }),
      'changed',
    );
    expect(churnAttempts).toBe(2);
  });

  test('readRegularFile retries once on concurrent change and throws changed when persistent', async () => {
    const file = join(root, 'async-mutating.txt');
    writeFileSync(file, 'v0');

    let opens = 0;
    let closedCount = 0;
    const recovered = await readRegularFileFromOpen(
      file,
      { limit: 1024 },
      async (target, flags) => {
        opens += 1;
        const attempt = opens;
        const handle = await open(target, flags);
        let statCalls = 0;
        return {
          stat: async () => {
            statCalls += 1;
            if (attempt === 1 && statCalls === 2) {
              writeFileSync(file, 'v1-after-retry');
            }
            return handle.stat();
          },
          read: handle.read.bind(handle),
          close: async () => {
            closedCount += 1;
            await handle.close();
          },
        };
      },
    );
    expect(opens).toBe(2);
    expect(closedCount).toBe(2);
    expect(new TextDecoder().decode(recovered)).toBe('v1-after-retry');

    let persistentOpens = 0;
    let persistentClosed = 0;
    await expectRegularFileErrorAsync(
      () =>
        readRegularFileFromOpen(file, { limit: 1024 }, async (target, flags) => {
          persistentOpens += 1;
          const attempt = persistentOpens;
          const handle = await open(target, flags);
          let statCalls = 0;
          return {
            stat: async () => {
              statCalls += 1;
              if (statCalls === 2) {
                writeFileSync(file, `always-changing-${attempt}-${'y'.repeat(attempt)}`);
              }
              return handle.stat();
            },
            read: handle.read.bind(handle),
            close: async () => {
              persistentClosed += 1;
              await handle.close();
            },
          };
        }),
      'changed',
    );
    expect(persistentOpens).toBe(2);
    expect(persistentClosed).toBe(2);
  });

  test('readRegularFile respects AbortSignal before and during read', async () => {
    const file = join(root, 'abort.txt');
    writeFileSync(file, 'content');

    const preAborted = new AbortController();
    const preReason = new Error('cancelled before start');
    preAborted.abort(preReason);
    await expect(
      readRegularFile(file, { limit: 1024, signal: preAborted.signal }),
    ).rejects.toBe(preReason);

    const midController = new AbortController();
    const midReason = new Error('cancelled mid-read');
    let closed = false;
    await expect(
      readRegularFileFromOpen(
        file,
        { limit: 1024, signal: midController.signal },
        async (target, flags) => {
          const handle = await open(target, flags);
          return {
            stat: async () => {
              midController.abort(midReason);
              return handle.stat();
            },
            read: handle.read.bind(handle),
            close: async () => {
              closed = true;
              await handle.close();
            },
          };
        },
      ),
    ).rejects.toBe(midReason);
    expect(closed).toBe(true);
  });

  test('parseJsonBytes enforces strict UTF-8 and refuses __proto__', () => {
    const plain = new TextEncoder().encode('{"name":"demo","constructor":"kept"}');
    expect(parseJsonBytes(plain)).toEqual({ name: 'demo', constructor: 'kept' });
    const polluted = new TextEncoder().encode('{"name":"demo","__proto__":{"polluted":true}}');
    expectRegularFileError(() => parseJsonBytes(polluted), 'syntax');

    // Invalid UTF-8 bytes inside a JSON string must throw, not decode as replacement char
    const invalidUtf8 = new Uint8Array([
      0x7b, 0x22, 0x6b, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d,
    ]);
    expectRegularFileError(() => parseJsonBytes(invalidUtf8), 'encoding');

    const malformedJson = new TextEncoder().encode('{broken');
    expectRegularFileError(() => parseJsonBytes(malformedJson), 'syntax');
  });

  test('readJsonFileSync validates with Zod schemas and custom safeParse schemas', () => {
    const file = join(root, 'settings.json');
    writeFileSync(file, '{"host":"localhost","timeoutMs":8080}');

    const SettingsSchema = z.strictObject({
      host: z.string(),
      timeoutMs: z.number().int().positive(),
    });
    const parsed = readJsonFileSync(file, SettingsSchema);
    expect(parsed).toEqual({ host: 'localhost', timeoutMs: 8080 });

    const customSchema = {
      safeParse: (input: unknown) =>
        typeof input === 'object' && input !== null && 'host' in input
          ? { success: true as const, data: { ok: true } }
          : { success: false as const, error: 'missing host' },
    };
    expect(readJsonFileSync(file, customSchema)).toEqual({ ok: true });

    writeFileSync(file, '{"host":"localhost","timeoutMs":"bad"}');
    expectRegularFileError(() => readJsonFileSync(file, SettingsSchema), 'schema');

    writeFileSync(file, new Uint8Array([0x22, 0xc3, 0x28, 0x22]));
    expectRegularFileError(() => readJsonFileSync(file, z.string()), 'encoding');
  });
});

describe('noFollow and descriptor accept', () => {
  test('noFollow refuses a symlink at the path, sync and async, and a dangling one too', async () => {
    const target = join(root, 'target.json');
    const link = join(root, 'link.json');
    const dangling = join(root, 'dangling.json');
    writeFileSync(target, '{"ok":true}');
    symlinkSync(target, link);
    symlinkSync(join(root, 'absent.json'), dangling);

    expect(new TextDecoder().decode(readRegularFileSync(link))).toBe('{"ok":true}');
    expect(new TextDecoder().decode(await readRegularFile(link))).toBe('{"ok":true}');
    for (const path of [link, dangling]) {
      const sync = expectRegularFileError(
        () => readRegularFileSync(path, { noFollow: true }),
        'symbolic-link',
      );
      expect(sync.message).toBe(`Symbolic link refused: ${path}`);
      const async = await expectRegularFileErrorAsync(
        () => readRegularFile(path, { noFollow: true }),
        'symbolic-link',
      );
      expect(async.message).toBe(`Symbolic link refused: ${path}`);
    }
    expect(readRegularFileSync(target, { noFollow: true }).byteLength).toBe(11);
    expect((await readRegularFile(target, { noFollow: true })).byteLength).toBe(11);
  });

  test('async accept sees the opened descriptor and a path swap after open retries once to return the current file', async () => {
    const file = join(root, 'decl.json');
    const swap = join(root, 'swap.json');
    writeFileSync(file, 'original');
    writeFileSync(swap, 'replacement-bytes');
    const originalIno = statSync(file).ino;
    const swapIno = statSync(swap).ino;

    const seenInos: number[] = [];
    let opens = 0;
    const bytes = await readRegularFileFromOpen(
      file,
      {
        accept: (info) => {
          seenInos.push(info.ino);
          return true;
        },
      },
      async (target, flags) => {
        opens += 1;
        const handle = await open(target, flags);
        if (opens === 1) renameSync(swap, target);
        return handle;
      },
    );
    expect(seenInos).toEqual([originalIno, swapIno]);
    expect(new TextDecoder().decode(bytes)).toBe('replacement-bytes');

    // When accept refuses the swapped replacement on attempt 2, no replacement bytes are read.
    const file2 = join(root, 'decl2.json');
    const swap2 = join(root, 'swap2.json');
    writeFileSync(file2, 'original');
    writeFileSync(swap2, 'replacement-bytes');
    const original2Ino = statSync(file2).ino;
    let opens2 = 0;
    let attempt2Reads = 0;
    await expectRegularFileErrorAsync(
      () =>
        readRegularFileFromOpen(
          file2,
          { accept: (info) => info.ino === original2Ino },
          async (target, flags) => {
            opens2 += 1;
            const attempt = opens2;
            const handle = await open(target, flags);
            if (attempt === 1) renameSync(swap2, target);
            return {
              stat: () => handle.stat(),
              read: (buffer: Uint8Array, offset: number, length: number) => {
                if (attempt === 2) attempt2Reads += 1;
                return handle.read(buffer, offset, length);
              },
              close: () => handle.close(),
            };
          },
        ),
      'rejected',
    );
    expect(opens2).toBe(2);
    expect(attempt2Reads).toBe(0);
  });

  test('async accept refuses before any byte is read, and runs on each attempt', async () => {
    const file = join(root, 'checked.txt');
    writeFileSync(file, 'payload');
    let reads = 0;
    const counting = async (target: string, flags: number) => {
      const handle = await open(target, flags);
      return {
        stat: () => handle.stat(),
        read: (buffer: Uint8Array, offset: number, length: number) => {
          reads += 1;
          return handle.read(buffer, offset, length);
        },
        close: () => handle.close(),
      };
    };
    await expectRegularFileErrorAsync(
      () => readRegularFileFromOpen(file, { accept: () => false }, counting),
      'rejected',
    );
    expect(reads).toBe(0);

    let attempts = 0;
    const bytes = await readRegularFileFromOpen(
      file,
      {
        accept: () => {
          attempts += 1;
          if (attempts === 1) writeFileSync(file, 'payload-changed');
          return true;
        },
      },
      counting,
    );
    expect(attempts).toBe(2);
    expect(new TextDecoder().decode(bytes)).toBe('payload-changed');

    const custom = new Error('owner check failed');
    await expect(
      readRegularFile(file, {
        accept: () => {
          throw custom;
        },
      }),
    ).rejects.toBe(custom);
  });

  test('an accept that does not answer true refuses the file, sync and async', async () => {
    const file = join(root, 'owned.txt');
    writeFileSync(file, 'payload');
    // A JavaScript caller can forget the `return`; the type stops a TypeScript one.
    // @ts-expect-error the check answers undefined
    const silent: RegularFileAccept = () => undefined;
    expectRegularFileError(() => readRegularFileSync(file, { accept: silent }), 'rejected');
    await expectRegularFileErrorAsync(
      () => readRegularFile(file, { accept: silent }),
      'rejected',
    );
  });

  test('sync accept sees the opened descriptor and a path swap after open retries once to return the current file', () => {
    const file = join(root, 'decl.json');
    const swap = join(root, 'swap.json');
    writeFileSync(file, 'original');
    writeFileSync(swap, 'replacement-bytes');
    const originalIno = statSync(file).ino;
    const swapIno = statSync(swap).ino;
    const seenInos: number[] = [];
    let opens = 0;
    const { bytes } = readRegularFileWithMetaSync(
      file,
      {
        accept: (info) => {
          seenInos.push(info.ino);
          return true;
        },
      },
      (target, flags) => {
        opens += 1;
        const fd = openSync(target, flags);
        if (opens === 1) renameSync(swap, target);
        return fd;
      },
    );
    expect(seenInos).toEqual([originalIno, swapIno]);
    expect(new TextDecoder().decode(bytes)).toBe('replacement-bytes');

    // Refusing the swapped replacement on retry fails as rejected.
    const file2 = join(root, 'decl2.json');
    const swap2 = join(root, 'swap2.json');
    writeFileSync(file2, 'original');
    writeFileSync(swap2, 'replacement-bytes');
    const original2Ino = statSync(file2).ino;
    let opens2 = 0;
    expectRegularFileError(
      () =>
        readRegularFileWithMetaSync(
          file2,
          { accept: (info) => info.ino === original2Ino },
          (target, flags) => {
            opens2 += 1;
            const fd = openSync(target, flags);
            if (opens2 === 1) renameSync(swap2, target);
            return fd;
          },
        ),
      'rejected',
    );
    expect(opens2).toBe(2);
  });
});

describe('a file that is not the expected value', () => {
  const Strict = z.strictObject({ a: z.string() });

  test('broken JSON, malformed UTF-8, a schema mismatch and __proto__ are RegularFileError with reason and cause', () => {
    const cases: Array<[string, string | Uint8Array, RegularFileRefusal, unknown]> = [
      ['syntax', '{"a":', 'syntax', SyntaxError],
      [
        'utf8',
        new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
        'encoding',
        TypeError,
      ],
      ['schema', '{"a":1}', 'schema', z.ZodError],
      ['proto', '{"a":"x","__proto__":{"polluted":true}}', 'syntax', undefined],
      ['nested-proto', '{"a":"x","b":[{"__proto__":{}}]}', 'syntax', undefined],
    ];
    for (const [name, body, reason, causeType] of cases) {
      const file = join(root, `${name}.json`);
      writeFileSync(file, body);
      const refused = expectRegularFileError(() => readJsonFileSync(file, Strict), reason);
      expect(refused.message).toContain(file);
      if (causeType !== undefined) expect(refused.cause).toBeInstanceOf(causeType);
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      if (reason !== 'schema') expectRegularFileError(() => parseJsonBytes(bytes), reason);
    }
  });

  test('a schema that throws is a schema refusal; a custom failure keeps its value as cause', () => {
    const file = join(root, 'value.json');
    writeFileSync(file, '{"a":"x"}');
    const throwing = z.strictObject({ a: z.string() }).transform(() => {
      throw new Error('transform failed');
    });
    const thrown = expectRegularFileError(() => readJsonFileSync(file, throwing), 'schema');
    expect(thrown.cause).toBeInstanceOf(Error);
    const custom = expectRegularFileError(
      () => readJsonFileSync(file, { safeParse: () => ({ success: false, error: 'nope' }) }),
      'schema',
    );
    expect(custom.cause).toBe('nope');
  });

  test('a refusal of the operating system is not a RegularFileError', () => {
    const missing = join(root, 'absent.json');
    try {
      readJsonFileSync(missing, Strict);
      throw new Error('expected a failure');
    } catch (error) {
      expect(error).not.toBeInstanceOf(RegularFileError);
      expect(error).toMatchObject({ code: 'ENOENT' });
    }
  });
});
