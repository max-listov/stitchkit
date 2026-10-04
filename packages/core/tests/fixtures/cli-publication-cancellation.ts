import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as nativeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2];
assert.ok(mode === 'pointer' || mode === 'admission');
const realFs = { ...nativeFs };
type Boundary = {
  root: string;
  promote: boolean;
  cancel: boolean;
  controller: AbortController;
  reason: Error;
  fired: boolean;
};
let active: Boundary | undefined;

function boundary(state: Boundary) {
  if (state.fired) return;
  state.fired = true;
  if (state.cancel) state.controller.abort(state.reason);
}

// Only the native handle's final close is instrumented, in an isolated process.
mock.module('node:fs/promises', () => ({
  ...realFs,
  async open(path: string, flags: unknown, ...args: unknown[]) {
    const handle: Awaited<ReturnType<typeof realFs.open>> = await Reflect.apply(
      realFs.open,
      realFs,
      [path, flags, ...args],
    );
    const state = active;
    if (
      mode === 'admission' &&
      state &&
      !state.fired &&
      flags !== 'wx' &&
      path === join(state.root, '.publication.lock')
    ) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        try {
          await close();
        } finally {
          boundary(state);
        }
      };
    }
    return handle;
  },
  async opendir(path: string, ...args: unknown[]) {
    const directory: Awaited<ReturnType<typeof realFs.opendir>> = await Reflect.apply(
      realFs.opendir,
      realFs,
      [path, ...args],
    );
    const state = active;
    if (mode === 'pointer' && state?.promote && path === state.root) {
      const close = directory.close.bind(directory);
      directory.close = async () => {
        try {
          await close();
        } finally {
          boundary(state);
        }
      };
    }
    return directory;
  },
}));

const { publishCli } = await import('../../src/entrypoints/cli');

for (const cancel of [false, true]) {
  const root = await realFs.mkdtemp(join(tmpdir(), 'stitchkit-publication-cancel-'));
  const storageRoot = join(root, 'published');
  const controller = new AbortController();
  const reason: Error = new Error(`caller cancelled at ${mode} boundary`);
  const state: Boundary = {
    root: storageRoot,
    promote: false,
    cancel,
    controller,
    reason,
    fired: false,
  };
  active = state;
  const admissions: string[] = [];
  const unhandled: unknown[] = [];
  let builds = 0;
  const onUnhandled = (cause: unknown) => {
    unhandled.push(cause);
  };
  process.on('unhandledRejection', onUnhandled);
  const options = {
    name: 'app',
    version: '1.0.0',
    commit: 'a'.repeat(40),
    storageRoot,
    baseUrl: 'https://distribution.invalid/cli/',
    targets: [{ platform: 'linux' as const, arch: 'x64' as const }],
    signal: controller.signal,
    admit({ phase, signal }: { phase: string; signal: AbortSignal }) {
      admissions.push(phase);
      signal.throwIfAborted();
      if (phase === 'promote') state.promote = true;
    },
    build() {
      builds++;
      return new Uint8Array([1, 2, 3]);
    },
  };
  try {
    let error: unknown;
    try {
      await publishCli(options);
    } catch (cause) {
      error = cause;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(state.fired, true, 'control did not reach the actual native close');
    assert.equal(unhandled.length, 0, 'publication leaked an admission rejection');
    const pointer = await realFs
      .readFile(join(storageRoot, 'manifest.json'), 'utf8')
      .catch((cause: unknown) => {
        if (cause instanceof Error && Reflect.get(cause, 'code') === 'ENOENT')
          return undefined;
        throw cause;
      });
    if (!cancel) {
      assert.equal(error, undefined);
      assert.ok(pointer);
      assert.equal(JSON.parse(pointer).version, '1.0.0');
      assert.deepEqual(admissions, ['prepare', 'build', 'commit', 'promote']);
      assert.equal(builds, 1);
    } else {
      assert.ok(error instanceof Error);
      assert.equal(pointer, undefined, 'cancelled publication changed the public pointer');
      if (mode === 'admission') {
        assert.equal(error, reason);
        assert.deepEqual(admissions, []);
        assert.equal(builds, 0);
      } else {
        assert.equal(error.cause, reason);
        assert.equal(builds, 1);
      }
      active = undefined;
      builds = 0;
      const resumed = await publishCli({ ...options, signal: undefined });
      assert.equal(resumed.outcome, 'published');
      assert.equal(builds, mode === 'pointer' ? 0 : 1);
      assert.equal(
        JSON.parse(await realFs.readFile(join(storageRoot, 'manifest.json'), 'utf8')).version,
        '1.0.0',
      );
    }
    console.log(JSON.stringify({ mode, cancel, boundary: true, unhandled: 0, passed: true }));
  } finally {
    active = undefined;
    process.off('unhandledRejection', onUnhandled);
    await realFs.rm(root, { recursive: true, force: true });
  }
}
