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
  { subpath: '.', source: 'src/entrypoints/index.ts', browser: true },
  { subpath: './live', source: 'src/entrypoints/live.ts', browser: true },
  { subpath: './react', source: 'src/entrypoints/react.ts', browser: true },
  { subpath: './tools', source: 'src/entrypoints/tools.ts', browser: false },
  { subpath: './tools/contract', source: 'src/entrypoints/tools/contract.ts', browser: true },
  { subpath: './tools/invoker', source: 'src/entrypoints/tools/invoker.ts', browser: false },
  {
    subpath: './tools/connections',
    source: 'src/entrypoints/tools/connections.ts',
    browser: false,
  },
  { subpath: './cli', source: 'src/entrypoints/cli.ts', browser: false },
  { subpath: './remote', source: 'src/entrypoints/remote.ts', browser: true },
  { subpath: './contract', source: 'src/entrypoints/contract.ts', browser: true },
  { subpath: './primitives', source: 'src/entrypoints/primitives.ts', browser: true },
  { subpath: './server', source: 'src/entrypoints/server.ts', browser: false },
  { subpath: './observability', source: 'src/entrypoints/observability.ts', browser: false },
  { subpath: './agent-runtime', source: 'src/entrypoints/agent-runtime.ts', browser: false },
  {
    subpath: './agent-runtime/sandbox',
    source: 'src/entrypoints/agent-runtime/sandbox.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/testing',
    source: 'src/entrypoints/agent-runtime/testing.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/harness',
    source: 'src/entrypoints/agent-runtime/harness.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/coding-tools',
    source: 'src/entrypoints/agent-runtime/coding-tools.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/browser',
    source: 'src/entrypoints/agent-runtime/browser.ts',
    browser: true,
  },
  {
    subpath: './agent-runtime/openrouter',
    source: 'src/entrypoints/agent-runtime/openrouter.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/sqlite/bun',
    source: 'src/entrypoints/agent-runtime/sqlite/bun.ts',
    browser: false,
  },
  {
    subpath: './agent-runtime/sqlite/node',
    source: 'src/entrypoints/agent-runtime/sqlite/node.ts',
    browser: false,
  },
  { subpath: './application', source: 'src/entrypoints/application.ts', browser: true },
  {
    subpath: './application/grammy',
    source: 'src/entrypoints/application/grammy.ts',
    browser: false,
  },
  {
    subpath: './application/opentelemetry',
    source: 'src/entrypoints/application/opentelemetry.ts',
    browser: false,
  },
  {
    subpath: './application/directory-inbox',
    source: 'src/entrypoints/application/directory-inbox.ts',
    browser: false,
  },
  {
    subpath: './application/diagnostic-journal',
    source: 'src/entrypoints/application/diagnostic-journal.ts',
    browser: false,
  },
  {
    subpath: './application/schemas',
    source: 'src/entrypoints/application/schemas.ts',
    browser: true,
  },
  { subpath: './testing', source: 'src/entrypoints/testing.ts', browser: false },
  { subpath: './files', source: 'src/entrypoints/files.ts', browser: false },
  { subpath: './telegram', source: 'src/entrypoints/telegram.ts', browser: false },
  { subpath: './tracking', source: 'src/entrypoints/tracking.ts', browser: true },
  { subpath: './release', source: 'src/entrypoints/release.ts', browser: true },
  {
    subpath: './tracking/server',
    source: 'src/entrypoints/tracking/server.ts',
    browser: false,
  },
  { subpath: './geo', source: 'src/entrypoints/geo.ts', browser: false },
  { subpath: './oauth', source: 'src/entrypoints/oauth.ts', browser: true },
  { subpath: './voice', source: 'src/entrypoints/voice.ts', browser: true },
  { subpath: './google', source: 'src/entrypoints/google.ts', browser: false },
  { subpath: './declaration', source: 'src/entrypoints/declaration.ts', browser: true },
  { subpath: './node', source: 'src/entrypoints/node.ts', browser: false },
];

/**
 * Executables the package installs. Not import surfaces: they are absent from
 * `exports` on purpose, so the entry/exports agreement above stays exact — but
 * they are still built, and `bin` must still agree with this list, which is what
 * the manifest gate checks.
 */
export const BINARIES = [{ name: 'stitchkit', source: 'src/entrypoints/bin/upgrade-cli.ts' }];

/** Source files, in declaration order — what `bun build` is handed. */
export const SOURCES = [
  ...ENTRYPOINTS.map((entry) => entry.source),
  ...BINARIES.map((binary) => binary.source),
];

/** The subset the package promises a browser can import. */
export const BROWSER_SOURCES = ENTRYPOINTS.filter((entry) => entry.browser).map(
  (entry) => entry.source,
);

/** `dist` path for an entry source: src/entrypoints/live.ts → entrypoints/live.js. */
export const distOf = (source) => source.replace(/^src\//, '').replace(/\.tsx?$/, '.js');
