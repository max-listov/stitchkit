/**
 * Guard: every entrypoint promised browser-safe must actually *initialise* in a
 * browser.
 *
 * `check-browser-clean.mjs` reads the built files and looks for `node:`. That is
 * a proxy for the real question, and proxies miss things: six entrypoints passed
 * every static check we had while `new AsyncLocalStorage()` and
 * `constants.O_NOFOLLOW` — evaluated at module scope, in a graph the regex had
 * no reason to flag — killed the page on import. A bundler does not omit a Node
 * built-in, it substitutes a stub, so the failure is not a missing import: it is
 * a constructor that is `undefined` and a property read on nothing, thrown while
 * the module is loading, before any route renders.
 *
 * So this asks the question directly. Bundle each entry for the browser, run it,
 * and require the promised ones to come up. It is slower than a regex and it is
 * the only check that cannot be fooled by the shape of the code.
 *
 * A server entry is expected NOT to survive here — that is not a failure, it is
 * the difference between the two lanes. What would be a failure is a server
 * entry quietly surviving while the guide sells it as browser-safe, which is why
 * the lane, not the outcome, decides.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const lane = pkg.scripts['build:browser'] ?? '';
const promised = new Set(
  [...lane.matchAll(/(?:^|\s)\.?\/?(src\/[\w./-]+\.tsx?)/g)].map(
    (match) => `./dist/${match[1].replace(/^src\//, '').replace(/\.tsx?$/, '.js')}`,
  ),
);
if (promised.size === 0) {
  console.error('[check-browser-executes] could not read any entry out of `build:browser`');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'stitchkit-browser-exec-'));
const offenders = [];
let checked = 0;

try {
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    if (!value?.import || !promised.has(value.import)) continue;
    const name = key === '.' ? 'stitchkit' : `stitchkit/${key.slice(2)}`;
    checked += 1;

    const entry = join(work, `${key.replace(/[^\w]/g, '_')}.ts`);
    // Bound to a global so nothing can be shaken away: an entry whose exports
    // are all dropped would "initialise" without ever running its modules, and
    // that is precisely the code whose top level we are here to execute.
    writeFileSync(
      entry,
      `import * as entry from ${JSON.stringify(join(ROOT, value.import.slice(2)))};\nglobalThis.__stitchkitEntry = entry;\n`,
    );

    const bundle = `${entry}.js`;
    const built = spawnSync(
      'bun',
      ['build', entry, '--target=browser', '--format=iife', '--outfile', bundle],
      { encoding: 'utf8' },
    );
    if (built.status !== 0) {
      offenders.push(
        `${name}: promised browser-safe, but does not bundle for the browser\n    ${(built.stderr || '').trim().split('\n').slice(0, 3).join('\n    ')}`,
      );
      continue;
    }

    const ran = spawnSync('bun', ['-e', `await import(${JSON.stringify(bundle)});`], {
      encoding: 'utf8',
    });
    if (ran.status !== 0) {
      const output = (ran.stderr || ran.stdout || '').trim();
      const why =
        output
          .split('\n')
          .map((line) => line.trim())
          .find((line) => /^(?:[A-Za-z]*Error|error)\b/.test(line)) ??
        output.split('\n').pop() ??
        'no output';
      offenders.push(`${name}: promised browser-safe, but throws while initialising — ${why}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (offenders.length > 0) {
  console.error(
    `[check-browser-executes] ${offenders.length} promised entries do not come up:\n${offenders.join('\n')}`,
  );
  process.exit(1);
}
console.log(`[check-browser-executes] ${checked} browser-safe entries initialise`);
