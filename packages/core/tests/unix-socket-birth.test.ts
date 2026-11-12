/**
 * A socket that is the credential is private from the moment it exists.
 *
 * The end state proves nothing here: a socket bound under the process umask and narrowed by
 * `chmod` right after ends with the right mode too, and between the two a process watching the
 * path sees the umask rights. So every birth test runs an observer in a separate process that
 * reports the rights of the first thing to appear at the path, and the control shows the observer
 * does see umask rights when nothing narrows them.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNodeServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxBroker } from '../src/agent-runtime/sandbox-broker';
import { bindUnixSocket } from '../src/entrypoints/files';
import { createServer } from '../src/entrypoints/server';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const OBSERVER = join(import.meta.dir, 'fixtures', 'socket-birth-observer.ts');
// A fixed umask makes the control deterministic: unnarrowed, a socket is born 0o755.
const UMASK = 0o022;
let previousUmask = 0;
let root = '';
let counter = 0;

beforeAll(() => {
  previousUmask = process.umask(UMASK);
  // sun_path is ~104-108 bytes — keep the directory and the names short.
  root = mkdtempSync(join(tmpdir(), 'skb-'));
});
afterAll(() => {
  process.umask(previousUmask);
  rmSync(root, { recursive: true, force: true });
});

function socketPath(): string {
  counter += 1;
  return join(root, `${counter}.sock`);
}

type Stop = () => Promise<void> | void;

/** Bind once while the observer watches; answers the rights the socket was born with, in octal. */
async function birthOf(
  path: string,
  bind: (path: string) => Promise<Stop> | Stop,
): Promise<string> {
  const child = Bun.spawn([process.execPath, OBSERVER, path], { stdout: 'pipe' });
  trackProcess(child.pid);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const nextLine = async (index: number): Promise<string> => {
    while (text.split('\n').length <= index + 1) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    return text.split('\n')[index] ?? '';
  };
  expect(await nextLine(0)).toBe('ready');
  const stop = await bind(path);
  try {
    const line = await nextLine(1);
    expect(line).toMatch(/^[0-7]{3}$/);
    return line;
  } finally {
    await child.exited;
    await stop();
  }
}

async function series(runs: number, bind: (path: string) => Promise<Stop> | Stop) {
  const births: string[] = [];
  for (let run = 0; run < runs; run += 1) births.push(await birthOf(socketPath(), bind));
  return births;
}

const bunListen = (path: string) => Bun.serve({ unix: path, fetch: () => new Response('ok') });

describe('a unix socket is private from birth', () => {
  test('the observer sees umask rights on a socket bound without narrowing', async () => {
    const births = await series(5, (path) => {
      const server = bunListen(path);
      return () => server.stop(true);
    });
    expect(births).toEqual(Array(5).fill('755'));
  });

  test('createServer with unix.mode: the socket is born with that mode in every run', async () => {
    const births = await series(20, (path) => {
      const server = createServer({ unix: { path, mode: 0o600 }, services: [] });
      return () => server.shutdown({ gracePeriodMs: 0 }).then(() => undefined);
    });
    expect(births).toEqual(Array(20).fill('600'));
  });

  test('a unix socket bound through bindUnixSocket is born with exactly its mode', async () => {
    for (const mode of [0o600, 0o640]) {
      const births = await series(10, (path) => {
        const server = bindUnixSocket({ path, mode }, bunListen);
        return () => server.stop(true);
      });
      expect(births).toEqual(Array(10).fill(mode.toString(8)));
    }
  });

  test('bindUnixSocket gives a node:http listen the same birth', async () => {
    const births = await series(10, async (path) => {
      const server = createNodeServer((_request, response) => response.end('ok'));
      const listening = new Promise((resolve) => server.once('listening', resolve));
      bindUnixSocket({ path, mode: 0o600 }, (bound) => server.listen(bound));
      await listening;
      return () => new Promise<void>((resolve) => server.close(() => resolve()));
    });
    expect(births).toEqual(Array(10).fill('600'));
  });

  test('the sandbox gateway socket is born owner-only', async () => {
    const births = await series(10, async (path) => {
      const broker = await createSandboxBroker(
        path,
        () => 'deny-all',
        () => undefined,
      );
      return () => broker.close();
    });
    expect(births).toEqual(Array(10).fill('600'));
  });
});

describe('bindUnixSocket refuses what it cannot guarantee', () => {
  test('a mode outside the permission bits is refused before anything binds', () => {
    for (const mode of [0o1000, 0o4600, -1, 1.5, Number.NaN]) {
      let called = false;
      expect(() =>
        bindUnixSocket({ path: socketPath(), mode }, () => {
          called = true;
        }),
      ).toThrow('`mode` must be permission bits 0o000–0o777');
      expect(called).toBe(false);
    }
  });

  test('bindUnixSocket binds the path it is given and refuses one that is taken', () => {
    const path = socketPath();
    let bound = '';
    const server = bindUnixSocket({ path, mode: 0o600 }, (target) => {
      bound = target;
      return bunListen(target);
    });
    void server.stop(true);
    expect(bound).toBe(path);

    const taken = socketPath();
    writeFileSync(taken, 'not yours');
    let called = false;
    expect(() =>
      bindUnixSocket({ path: taken, mode: 0o600 }, () => {
        called = true;
      }),
    ).toThrow('already exists');
    expect(called).toBe(false);
    expect(existsSync(taken)).toBe(true);
    expect(() => bindUnixSocket({ path: '', mode: 0o600 }, () => undefined)).toThrow(
      'non-empty socket path',
    );
  });

  test('a bind that leaves no socket at the path is refused', () => {
    expect(() => bindUnixSocket({ path: socketPath(), mode: 0o600 }, () => undefined)).toThrow(
      'no socket at',
    );
    const file = socketPath();
    expect(() =>
      bindUnixSocket({ path: file, mode: 0o600 }, (path) => writeFileSync(path, '')),
    ).toThrow('is not a socket after bind');
  });

  test('a socket born with other rights is removed and refused', () => {
    const path = socketPath();
    let server: ReturnType<typeof bunListen> | undefined;
    // Stands in for a directory whose default ACL, not the umask, decides the rights.
    expect(() =>
      bindUnixSocket({ path, mode: 0o600 }, (target) => {
        server = bunListen(target);
        chmodSync(target, 0o755);
      }),
    ).toThrow('was born 0o755 instead of 0o600');
    void server?.stop(true);
    expect(existsSync(path)).toBe(false);
  });

  test('the umask is restored after the bind, and after a bind that throws', () => {
    const server = bindUnixSocket({ path: socketPath(), mode: 0o600 }, bunListen);
    void server.stop(true);
    expect(process.umask()).toBe(UMASK);
    expect(() =>
      bindUnixSocket({ path: socketPath(), mode: 0o600 }, () => {
        throw new Error('bind failed');
      }),
    ).toThrow('bind failed');
    expect(process.umask()).toBe(UMASK);
  });

  test('createServer refuses a socket born wider than its mode and leaves none behind', () => {
    const path = socketPath();
    // A umask that cannot be narrowed: the socket is born 0o755 whatever the mode asks.
    const umask = spyOn(process, 'umask').mockImplementation(() => UMASK);
    try {
      expect(() => createServer({ unix: { path, mode: 0o600 }, services: [] })).toThrow(
        'was born 0o755 instead of 0o600',
      );
    } finally {
      umask.mockRestore();
    }
    expect(existsSync(path)).toBe(false);
  });
});
