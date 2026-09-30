import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type DiagnosticJournalAnomaly,
  DiagnosticJournalAnomalySchema,
} from '../src/entrypoints/application';
import { readDiagnosticJournal } from '../src/entrypoints/application/diagnostic-journal';

const eventSchema = z.object({ message: z.string() }).strict();
const epoch = '00000000-0000-4000-8000-000000000001';
const frame = (message: unknown) =>
  `${JSON.stringify({ schemaVersion: 1, epoch, sequence: 1, event: { message } })}\n`;

async function fixture(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sk-journal-reader-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function collect(paths: readonly string[], maxLineBytes = 1024) {
  return Array.fromAsync(readDiagnosticJournal({ paths, eventSchema, maxLineBytes }));
}

test('retained NUL tails and interior damage preserve every valid frame with exact locations', async () => {
  await fixture(async (root) => {
    const path = join(root, 'audit.jsonl');
    for (const [index, message] of [
      [7, 'old7'],
      [1, 'old1'],
    ] satisfies [number, string][]) {
      await writeFile(
        `${path}.${index}`,
        Buffer.concat([Buffer.from(frame(message)), Buffer.alloc(839)]),
      );
    }
    await writeFile(path, `${frame('now1')}bad\n${frame('now2')}`);
    const results = await collect([`${path}.7`, `${path}.1`, path]);
    const frames = results.filter((result) => result.type === 'frame');
    expect(frames.map((result) => result.frame.event.message)).toEqual([
      'old7',
      'old1',
      'now1',
      'now2',
    ]);
    const anomalies = results
      .filter((result) => result.type === 'anomaly')
      .map((result) => result.anomaly);
    expect(anomalies).toEqual([
      {
        file: `${path}.7`,
        offset: Buffer.byteLength(frame('old7')),
        line: 2,
        reason: 'nul-byte',
        position: 'tail',
        terminated: false,
        skippedBytes: 839,
      },
      {
        file: `${path}.1`,
        offset: Buffer.byteLength(frame('old1')),
        line: 2,
        reason: 'nul-byte',
        position: 'tail',
        terminated: false,
        skippedBytes: 839,
      },
      {
        file: path,
        offset: Buffer.byteLength(frame('now1')),
        line: 2,
        reason: 'invalid-json',
        position: 'interior',
        terminated: true,
        skippedBytes: 4,
      },
    ]);
    expect(frames.at(-1)).toMatchObject({
      line: 3,
      offset: Buffer.byteLength(frame('now1')) + 4,
    });
  });
});

test('UTF-8, JSON, frame and event refusals are distinct from an intact frame without LF', async () => {
  await fixture(async (root) => {
    const cases = [
      { name: 'utf8', bytes: Buffer.from([0xe2, 0x82]), reason: 'invalid-utf8' },
      { name: 'torn', bytes: Buffer.from('{"schemaVersion":1'), reason: 'unterminated-line' },
      { name: 'json', bytes: Buffer.from('bad\n'), reason: 'invalid-json' },
      { name: 'frame', bytes: Buffer.from('{}\n'), reason: 'invalid-frame' },
      { name: 'event', bytes: Buffer.from(frame(42)), reason: 'invalid-event' },
      { name: 'blank', bytes: Buffer.from('\n'), reason: 'invalid-json' },
      { name: 'nul', bytes: Buffer.from('a\0b\n'), reason: 'nul-byte' },
    ] satisfies { name: string; bytes: Buffer; reason: DiagnosticJournalAnomaly['reason'] }[];
    for (const { name, bytes, reason } of cases) {
      const path = join(root, name);
      await writeFile(path, bytes);
      expect(await collect([path])).toEqual([
        {
          type: 'anomaly',
          anomaly: {
            file: path,
            offset: 0,
            line: 1,
            reason,
            position: 'tail',
            terminated: bytes.at(-1) === 10,
            skippedBytes: bytes.length,
          },
        },
      ]);
    }
    const path = join(root, 'intact');
    await writeFile(path, frame('no-LF').trimEnd());
    const intact = await collect([path]);
    expect(intact[0]).toMatchObject({
      type: 'anomaly',
      anomaly: { reason: 'unterminated-line', skippedBytes: 0 },
    });
    expect(intact[1]).toMatchObject({ type: 'frame', frame: { event: { message: 'no-LF' } } });
    await writeFile(path, frame('CRLF').replace('\n', '\r\n'));
    expect(await collect([path])).toHaveLength(1);
    const transformed = await Array.fromAsync(
      readDiagnosticJournal({
        paths: [path],
        maxLineBytes: 1024,
        eventSchema: z.object({ message: z.string().transform((value) => value.length) }),
      }),
    );
    for (const result of transformed) {
      if (result.type !== 'frame') throw new Error('expected the typed frame');
      const length: number = result.frame.event.message;
      expect(length).toBe(4);
    }
  });
});

test('oversized rows spanning chunks do not enter the line buffer or hide the next frame', async () => {
  await fixture(async (root) => {
    const path = join(root, 'large');
    const largeBytes = 8 * 1024 * 1024;
    await writeFile(
      path,
      Buffer.concat([Buffer.alloc(largeBytes, 97), Buffer.from(`\n${frame('after')}`)]),
    );
    const concat = spyOn(Buffer, 'concat');
    try {
      const results = await collect([path], 128);
      expect(results[0]).toMatchObject({
        type: 'anomaly',
        anomaly: {
          reason: 'oversized-line',
          position: 'interior',
          skippedBytes: largeBytes + 1,
        },
      });
      expect(results[1]).toMatchObject({
        type: 'frame',
        line: 2,
        offset: largeBytes + 1,
        frame: { event: { message: 'after' } },
      });
      for (const call of concat.mock.calls) expect(call[1]).toBeLessThanOrEqual(128);
    } finally {
      concat.mockRestore();
    }
    await writeFile(path, Buffer.alloc(largeBytes, 97));
    expect(await collect([path], 128)).toMatchObject([
      {
        type: 'anomaly',
        anomaly: {
          reason: 'oversized-line',
          position: 'tail',
          terminated: false,
          skippedBytes: largeBytes,
        },
      },
    ]);
  });
});

test('missing files, symlinks and non-regular paths throw rather than become row anomalies', async () => {
  await fixture(async (root) => {
    const path = join(root, 'valid');
    await writeFile(path, frame('valid'));
    await symlink(path, join(root, 'link'));
    await mkdir(join(root, 'directory'));
    await expect(collect([join(root, 'missing')])).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(collect([join(root, 'link')])).rejects.toThrow('regular file');
    await expect(collect([join(root, 'directory')])).rejects.toThrow('regular file');
    await expect(collect(['relative'])).rejects.toThrow('normalized and absolute');
    await expect(collect([])).rejects.toThrow('at least one path');
    await expect(collect([path], 0)).rejects.toThrow();
    await expect(collect([path], Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow();
    const location = {
      file: path,
      offset: Number.MAX_SAFE_INTEGER,
      line: 1,
      reason: 'invalid-json',
      position: 'tail',
      terminated: true,
      skippedBytes: 1,
    };
    expect(DiagnosticJournalAnomalySchema.safeParse(location).success).toBe(true);
    expect(
      DiagnosticJournalAnomalySchema.safeParse({
        ...location,
        offset: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect((await collect([path]))[0]).toMatchObject({ type: 'frame' });
  });
});

test('a mid-read truncation is an I/O failure; cancellation and early return close the handle', async () => {
  await fixture(async (root) => {
    const path = join(root, 'changed');
    await writeFile(
      path,
      Buffer.concat([Buffer.from(frame('first')), Buffer.alloc(128 * 1024, 97)]),
    );
    const reader = readDiagnosticJournal({ paths: [path], eventSchema, maxLineBytes: 1024 });
    expect((await reader.next()).value).toMatchObject({ type: 'frame' });
    await writeFile(path, '');
    await expect(reader.next()).rejects.toThrow('truncated during read');
    await writeFile(path, `${frame('first')}${frame('second')}`);
    const signal = new AbortController();
    const cancelled = readDiagnosticJournal({
      paths: [path],
      eventSchema,
      maxLineBytes: 1024,
      signal: signal.signal,
    });
    await cancelled.next();
    signal.abort(new Error('cancelled read'));
    await expect(cancelled.next()).rejects.toThrow('cancelled read');
    const early = readDiagnosticJournal({ paths: [path], eventSchema, maxLineBytes: 1024 });
    await early.next();
    await early.return();
    if (process.platform === 'linux') {
      const targets = await Promise.all(
        (await readdir('/proc/self/fd')).map(async (fd) => {
          try {
            return await readlink(`/proc/self/fd/${fd}`);
          } catch {
            return '';
          }
        }),
      );
      expect(targets.filter((target) => target === path)).toEqual([]);
    }
  });
});

test('actual permission denial remains EACCES, with a readable positive control in Node', async () => {
  await fixture(async (root) => {
    await chmod(root, 0o755);
    const path = join(root, 'private');
    await writeFile(path, frame('readable'), { mode: 0o644 });
    const source = join(root, 'probe.ts');
    await writeFile(
      source,
      `
      import { readDiagnosticJournal } from ${JSON.stringify(new URL('../src/application/diagnostic-journal-reader.ts', import.meta.url).pathname)};
      import { z } from ${JSON.stringify(fileURLToPath(import.meta.resolve('zod')))};
      try {
        let count = 0;
        for await (const row of readDiagnosticJournal({ paths: [process.argv[2]], eventSchema: z.json(), maxLineBytes: 1024 })) {
          if (row.type === 'frame') count++;
        }
        console.log('frames:' + count);
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unexpected';
        console.log(code);
        process.exit(code === 'EACCES' ? 13 : 14);
      }
    `,
    );
    const built = await Bun.build({
      entrypoints: [source],
      outdir: root,
      target: 'node',
      format: 'esm',
    });
    expect(built.success).toBe(true);
    const probe = built.outputs[0];
    if (!probe) throw new Error('expected the Node probe');
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required to verify journal permission handling');
    const privilege = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
    const run = () =>
      spawnSync(node, [probe.path, path], { encoding: 'utf8', timeout: 10000, ...privilege });
    const allowed = run();
    expect({ code: allowed.status, out: allowed.stdout.trim(), err: allowed.stderr }).toEqual({
      code: 0,
      out: 'frames:1',
      err: '',
    });
    await chmod(path, 0);
    const denied = run();
    expect({ code: denied.status, out: denied.stdout.trim(), err: denied.stderr }).toEqual({
      code: 13,
      out: 'EACCES',
      err: '',
    });
  });
});
