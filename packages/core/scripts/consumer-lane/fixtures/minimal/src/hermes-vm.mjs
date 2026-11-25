/**
 * The real Hermes V1 toolchain of a phone app, shared by the packed Hermes proofs:
 * the pinned `hermesc` from `hermes-compiler`, the pinned Hermes V1 VM binary
 * (`bun scripts/ensure-hermes-vm.ts`), and the React Native 0.88 globals prelude a
 * bundle runs under in that VM (`whatwg-fetch@3.6.20`, RN URL model,
 * `AbortController`, `crypto.getRandomValues`, no `DOMException`/`Buffer`/`node:*`).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const compilerRoot = dirname(require.resolve('hermes-compiler/package.json'));
const compilerVersion = JSON.parse(
  readFileSync(join(compilerRoot, 'package.json'), 'utf8'),
).version;
const platform = process.platform === 'darwin' ? 'osx-bin' : 'linux64-bin';
export const hermesCompiler = join(compilerRoot, 'hermesc', platform, 'hermesc');

/**
 * The Hermes V1 VM binary, or `null` locally when it is not installed. With
 * `STITCHKIT_REQUIRE_HERMES_VM=1` or `STITCHKIT_HERMES_VM` set, a missing binary
 * fails the proof loudly.
 */
export function resolveHermesVmBinary() {
  const configured = process.env.STITCHKIT_HERMES_VM || '';
  const required = process.env.STITCHKIT_REQUIRE_HERMES_VM === '1' || Boolean(configured);
  const binaryName = process.platform === 'win32' ? 'hermes.exe' : 'hermes';
  const candidate =
    configured ||
    join(
      homedir(),
      '.cache',
      'stitchkit',
      'hermes-vm',
      `hermes-v${compilerVersion}-${process.platform}-${process.arch}`,
      binaryName,
    );
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return { path: candidate, required };
  }
  if (required) {
    assert.fail(
      `Hermes V1 VM binary not found at ${candidate}. Run "bun scripts/ensure-hermes-vm.ts" or set STITCHKIT_HERMES_VM.`,
    );
  }
  return { path: null, required: false };
}

/** The React Native 0.88 host globals, prepended to a bundle before `hermesc`. */
export function rnPreludeSource() {
  const rnGlobals = readFileSync(
    fileURLToPath(new URL('./handler-hermes-rn-globals.js', import.meta.url)),
    'utf8',
  );
  const rnAbort = readFileSync(
    fileURLToPath(new URL('./handler-hermes-rn-abort.js', import.meta.url)),
    'utf8',
  );
  const rnUrl = readFileSync(
    fileURLToPath(new URL('./handler-hermes-rn-url.js', import.meta.url)),
    'utf8',
  );
  const whatwgFetch = readFileSync(require.resolve('whatwg-fetch/dist/fetch.umd.js'), 'utf8');
  const bindFetch = `
(function (g) {
  g.fetch = g.WHATWGFetch.fetch;
  g.Headers = g.WHATWGFetch.Headers;
  g.Request = g.WHATWGFetch.Request;
  g.Response = g.WHATWGFetch.Response;
})(globalThis);
`;
  return `${rnGlobals}\n${rnAbort}\n${rnUrl}\n${whatwgFetch}\n${bindFetch}\n`;
}
