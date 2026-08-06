/**
 * No test may bind a fixed port.
 *
 * `net.ipv4.ip_local_port_range` reaches down to 1024 on the machine this repo
 * is developed on, so every number a test could hardcode is inside the ephemeral
 * range and can be held at any moment by an unrelated process's **outgoing**
 * connection. `Bun.serve` then reports "Failed to start server. Is port NNNN in
 * use?", which sends the reader hunting for a stray server that does not exist.
 *
 * The failure is not merely noisy. When the bind happens at module scope the
 * import throws, the whole file drops out of the run, and `bun test` reports the
 * remainder as green — a gate that can pass by not running its tests. That was
 * observed: `697 pass / 0 fail` where 700 were expected.
 *
 * `port: 0` costs nothing: the kernel picks a free one and `server.port` (or
 * `handle.url` on Node) reports it back.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

const ROOTS = [`${import.meta.dir}`, `${import.meta.dir}/../scripts`];

/** `port: 4000` / `const PORT = 4000` / a URL with a literal port. */
const FIXED_PORT =
  /\bport:\s*[1-9]\d{2,4}\b|\bPORT[A-Z_]*\s*=\s*[1-9]\d{2,4}\b|localhost:[1-9]\d{2,4}\b/;

describe('no test binds a fixed port', () => {
  test('every server in tests/ and scripts/ uses port 0', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of new Glob('**/*.{ts,mjs}').scanSync({ cwd: root, absolute: true })) {
        if (file.endsWith('no-fixed-ports.test.ts')) continue;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (FIXED_PORT.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
