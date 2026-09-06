/**
 * Every published entrypoint, once.
 *
 * Which entries exist, where their source is, and whether the package promises
 * each one works in a browser. Six places used to answer that last question
 * independently — two build scripts, the `exports` map, the maturity table in
 * the guide, the consumer-lane matrix and the reference-coverage walk — and they
 * drifted, in both directions:
 *
 *   - `stitchkit/remote` was sold by the guide as "browser and server, stable"
 *     while it sat in the server lane, so no gate ever checked the promise. Moving
 *     it reached the lane and the guide and still missed the matrix.
 *   - `stitchkit/declaration` is built for the browser and exercised for Bun.
 *
 * Both were found by a reviewer, not by a gate, because there was nothing for a
 * gate to compare against. This is that thing.
 */
export const ENTRYPOINTS = [
  { subpath: '.', source: 'src/index.ts', browser: true },
  { subpath: './live', source: 'src/live.ts', browser: true },
  { subpath: './react', source: 'src/react.ts', browser: true },
  { subpath: './tools', source: 'src/tools.ts', browser: false },
  { subpath: './tools/contract', source: 'src/tools-contract.ts', browser: true },
  { subpath: './tools/invoker', source: 'src/tool-invoker.ts', browser: false },
  { subpath: './cli', source: 'src/cli.ts', browser: false },
  { subpath: './remote', source: 'src/remote.ts', browser: true },
  { subpath: './contract', source: 'src/contract/index.ts', browser: true },
  { subpath: './primitives', source: 'src/primitives.ts', browser: true },
  { subpath: './server', source: 'src/server/index.ts', browser: false },
  { subpath: './observability', source: 'src/observability/index.ts', browser: false },
  { subpath: './agent-runtime', source: 'src/agent-runtime.ts', browser: false },
  {
    subpath: './agent-runtime/harness',
    source: 'src/agent-runtime-harness.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/coding-tools',
    source: 'src/agent-runtime-coding-tools.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/browser',
    source: 'src/agent-runtime-browser.ts',
    browser: true,
  },
  {
    subpath: './agent-runtime/openrouter',
    source: 'src/agent-runtime-openrouter.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/sqlite/bun',
    source: 'src/agent-runtime-sqlite-bun.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/sqlite/node',
    source: 'src/agent-runtime-sqlite-node.ts',
    browser: false,
  },
  { subpath: './application', source: 'src/application.ts', browser: true },
  { subpath: './application/grammy', source: 'src/application-grammy.ts', browser: false },
  {
    subpath: './application/opentelemetry',
    source: 'src/application-opentelemetry.ts',
    browser: false,
  },
  {
    subpath: './application/diagnostic-journal',
    source: 'src/application-diagnostic-journal.ts',
    browser: false,
  },
  { subpath: './application/schemas', source: 'src/application-schemas.ts', browser: true },
  { subpath: './testing', source: 'src/testing.ts', browser: false },
  { subpath: './files', source: 'src/files.ts', browser: false },
  { subpath: './telegram', source: 'src/telegram.ts', browser: false },
  { subpath: './tracking', source: 'src/tracking.ts', browser: true },
  { subpath: './release', source: 'src/release.ts', browser: true },
  { subpath: './tracking/server', source: 'src/tracking-server.ts', browser: false },
  { subpath: './geo', source: 'src/geo.ts', browser: false },
  { subpath: './declaration', source: 'src/declaration.ts', browser: true },
  { subpath: './node', source: 'src/node.ts', browser: false },
];

/**
 * Executables the package installs. Not import surfaces: they are absent from
 * `exports` on purpose, so the entry/exports agreement above stays exact — but
 * they are still built, and `bin` must still agree with this list, which is what
 * the manifest gate checks.
 */
export const BINARIES = [{ name: 'stitchkit', source: 'src/upgrade-cli.ts' }];

/** Source files, in declaration order — what `bun build` is handed. */
export const SOURCES = [
  ...ENTRYPOINTS.map((entry) => entry.source),
  ...BINARIES.map((binary) => binary.source),
];

/** The subset the package promises a browser can import. */
export const BROWSER_SOURCES = ENTRYPOINTS.filter((entry) => entry.browser).map(
  (entry) => entry.source,
);

/** `dist` path for an entry source: src/live.ts → live.js, src/contract/index.ts → contract/index.js. */
export const distOf = (source) => source.replace(/^src\//, '').replace(/\.tsx?$/, '.js');
