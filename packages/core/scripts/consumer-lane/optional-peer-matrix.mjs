import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const FIXTURE_PEERS = {
  minimal: [],
  full: [
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/ext-apps',
    '@modelcontextprotocol/server',
    '@openrouter/ai-sdk-provider',
    '@tanstack/react-query',
    'ai',
    'react',
    'react-query-kit',
  ],
  grammy: ['grammy'],
  node: [
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/server',
    'ai',
    'socket.io',
    'srvx',
  ],
};

function featureSource(subpath, name) {
  return `import { ${name} } from '${subpath}';\nif (typeof ${name} === 'undefined') throw new Error('${name} is unavailable');\nconsole.log('${name}: ok');\n`;
}

/**
 * The one release inventory for public entrypoint peer budgets. Multiple rows for
 * a mixed barrel prove that a neutral feature remains tree-shakeable beside an
 * explicitly peer-backed feature.
 */
export const OPTIONAL_PEER_MATRIX = [
  {
    id: 'root-client',
    subpath: '.',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit', 'createClient'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'root-live-state',
    subpath: '.',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit', 'createLiveStateController'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'react-query',
    subpath: './react',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'browser',
    source: featureSource('stitchkit/react', 'createCursorQuery'),
    runtimePeers: ['@tanstack/react-query', 'react', 'react-query-kit'],
    declarationPeers: ['@tanstack/react-query', 'react', 'react-query-kit'],
    execute: false,
  },
  {
    id: 'tool-invoker',
    subpath: './tools/invoker',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/tools/invoker', 'createToolInvoker'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'tools-cli-feature',
    subpath: './tools',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'bun',
    source: featureSource('stitchkit/tools', 'defineCliCommand'),
    runtimePeers: ['@modelcontextprotocol/server'],
    declarationPeers: ['@modelcontextprotocol/ext-apps', '@modelcontextprotocol/server', 'ai'],
    execute: true,
  },
  {
    id: 'tools-mcp-feature',
    subpath: './tools',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'bun',
    source: featureSource('stitchkit/tools', 'createMcpHandler'),
    runtimePeers: ['@modelcontextprotocol/server', 'ai'],
    declarationPeers: ['@modelcontextprotocol/ext-apps', '@modelcontextprotocol/server', 'ai'],
    execute: true,
    missingPeer: {
      fixture: 'minimal',
      command: ['node', 'src/missing-mcp-peer.mjs'],
      expected: ['Cannot find package'],
      expectedAny: ["'ai'", "'@modelcontextprotocol/server'"],
    },
  },
  {
    id: 'cli',
    subpath: './cli',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/cli', 'parseCliArgs'),
    runtimePeers: [],
    declarationPeers: ['@modelcontextprotocol/server', 'ai'],
    execute: true,
  },
  {
    id: 'remote',
    subpath: './remote',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/remote', 'implementRemote'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'contract',
    subpath: './contract',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/contract', 'defineContract'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'live',
    subpath: './live',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/live', 'defineEvents'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'primitives',
    subpath: './primitives',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/primitives', 'defineLifecycle'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'server-signals',
    subpath: './server',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/server', 'bindProcessSignals'),
    runtimePeers: [],
    declarationPeers: ['@socket.io/bun-engine', '@socket.io/component-emitter', 'socket.io'],
    execute: true,
  },
  {
    id: 'server-socket-io',
    subpath: './server',
    fixture: 'node',
    installedPeers: FIXTURE_PEERS.node,
    target: 'node',
    source: featureSource('stitchkit/server', 'createSocketIOServer'),
    runtimePeers: ['socket.io'],
    declarationPeers: ['@socket.io/bun-engine', '@socket.io/component-emitter', 'socket.io'],
    execute: true,
    missingPeer: {
      fixture: 'minimal',
      command: ['node', 'src/missing-socket-peer.mjs'],
      expected: ['createSocketIOServer', 'socket.io'],
    },
  },
  {
    id: 'observability',
    subpath: './observability',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/observability', 'createTraceContext'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'agent-runtime',
    subpath: './agent-runtime',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'bun',
    source: featureSource('stitchkit/agent-runtime', 'defineModelRegistry'),
    runtimePeers: ['ai'],
    declarationPeers: ['ai'],
    execute: true,
  },
  {
    id: 'agent-runtime-harness',
    subpath: './agent-runtime/harness',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'bun',
    source: featureSource('stitchkit/agent-runtime/harness', 'createHeadlessAgentHarness'),
    runtimePeers: ['ai'],
    declarationPeers: ['ai'],
    execute: true,
  },
  {
    id: 'agent-runtime-coding-tools',
    subpath: './agent-runtime/coding-tools',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'node',
    source: featureSource('stitchkit/agent-runtime/coding-tools', 'createAgentCodingTools'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'agent-runtime-browser',
    subpath: './agent-runtime/browser',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/agent-runtime/browser', 'AgentRunStateSchema'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'agent-runtime-openrouter',
    subpath: './agent-runtime/openrouter',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'bun',
    source: featureSource('stitchkit/agent-runtime/openrouter', 'openRouterProvider'),
    runtimePeers: ['@openrouter/ai-sdk-provider', 'ai'],
    declarationPeers: ['@openrouter/ai-sdk-provider', 'ai'],
    execute: true,
  },
  {
    id: 'agent-runtime-sqlite-bun',
    subpath: './agent-runtime/sqlite/bun',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource(
      'stitchkit/agent-runtime/sqlite/bun',
      'createBunSqliteAgentRuntimeStore',
    ),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'agent-runtime-sqlite-node',
    subpath: './agent-runtime/sqlite/node',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'node',
    source: featureSource(
      'stitchkit/agent-runtime/sqlite/node',
      'createNodeSqliteAgentRuntimeStore',
    ),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'application',
    subpath: './application',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/application', 'createApplication'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'application-grammy',
    subpath: './application/grammy',
    fixture: 'grammy',
    installedPeers: FIXTURE_PEERS.grammy,
    target: 'bun',
    source: featureSource('stitchkit/application/grammy', 'createGrammyWebhookResource'),
    runtimePeers: ['grammy'],
    declarationPeers: ['grammy'],
    execute: true,
    missingPeer: {
      fixture: 'minimal',
      command: ['node', 'src/missing-grammy-peer.mjs'],
      expected: ['grammy'],
    },
  },
  {
    id: 'application-opentelemetry',
    subpath: './application/opentelemetry',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'node',
    source: featureSource(
      'stitchkit/application/opentelemetry',
      'createApplicationOpenTelemetry',
    ),
    runtimePeers: [],
    declarationPeers: ['@opentelemetry/api'],
    execute: true,
  },
  {
    id: 'testing',
    subpath: './testing',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/testing', 'buildSurfaceManifest'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'files',
    subpath: './files',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/files', 'ManagedFilePathSchema'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'telegram',
    subpath: './telegram',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/telegram', 'verifyTelegramInitData'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    // Verification runs on Web Crypto, which is the one global whose presence
    // differs between the two runtimes we publish for. Proving it on Node is
    // the point of the second row, not symmetry.
    id: 'telegram-node',
    subpath: './telegram',
    fixture: 'node',
    installedPeers: FIXTURE_PEERS.node,
    target: 'node',
    source: featureSource('stitchkit/telegram', 'classifyTelegramSendFailure'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'declaration',
    subpath: './declaration',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/declaration', 'ProjectDeclarationSchema'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'node-signals',
    subpath: './node',
    fixture: 'node',
    installedPeers: FIXTURE_PEERS.node,
    target: 'node',
    source: featureSource('stitchkit/node', 'bindProcessSignals'),
    runtimePeers: [],
    declarationPeers: ['@socket.io/component-emitter', 'socket.io', 'srvx'],
    execute: true,
  },
  {
    id: 'node-server',
    subpath: './node',
    fixture: 'node',
    installedPeers: FIXTURE_PEERS.node,
    target: 'node',
    source: featureSource('stitchkit/node', 'serveNode'),
    runtimePeers: ['srvx'],
    declarationPeers: ['@socket.io/component-emitter', 'socket.io', 'srvx'],
    execute: true,
  },
];

function packageNameFromPath(input) {
  const normalized = input.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const at = normalized.lastIndexOf(marker);
  if (at < 0) return undefined;
  const parts = normalized.slice(at + marker.length).split('/');
  if (!parts[0]) return undefined;
  return parts[0].startsWith('@') && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

export function assertAllowedOptionalPackages({ caseName, kind, observed, allowed }) {
  const budget = new Set(allowed);
  const forbidden = [...new Set(observed)].filter((name) => !budget.has(name)).sort();
  if (forbidden.length > 0) {
    throw new Error(
      `[optional-peer-matrix] ${caseName}: forbidden ${kind} package ${forbidden.join(', ')}`,
    );
  }
}

export function assertExportCoverage(exportsMap, cases = OPTIONAL_PEER_MATRIX) {
  const covered = new Set(cases.map((entry) => entry.subpath));
  const missing = Object.keys(exportsMap).filter((subpath) => !covered.has(subpath));
  const unknown = [...covered].filter((subpath) => !(subpath in exportsMap));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `[optional-peer-matrix] export coverage mismatch; missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}`,
    );
  }
}

function resolveDeclaration(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.d.ts`,
    base.endsWith('.js') ? `${base.slice(0, -3)}.d.ts` : undefined,
    join(base, 'index.d.ts'),
  ];
  return candidates.find(
    (candidate) => candidate && existsSync(candidate) && statSync(candidate).isFile(),
  );
}

/**
 * Strip comments before looking for imports.
 *
 * The scanner reads raw `.d.ts` text, so a JSDoc example showing
 * `import('@socket.io/bun-engine')` was counted as a real dependency of a
 * declaration that must stay Bun-free — a false positive that pressures the
 * author to document the API worse. Only unambiguous comment forms are
 * removed: block comments, which is what JSDoc always is, and line comments
 * that begin a line. Neither can swallow an import statement.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function declarationPackages(entryFile) {
  const packages = new Set();
  const visited = new Set();
  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = withoutComments(readFileSync(file, 'utf8'));
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const specifier = match[1];
      if (!specifier) continue;
      if (specifier.startsWith('.')) {
        const next = resolveDeclaration(file, specifier);
        if (next) visit(next);
        continue;
      }
      if (specifier.startsWith('node:')) continue;
      const parts = specifier.split('/');
      const packageName = specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
      if (packageName) packages.add(packageName);
    }
  };
  visit(entryFile);
  return [...packages];
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runExpectFailure(command, args, cwd) {
  try {
    run(command, args, cwd);
    return { failed: false, output: '' };
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

export function assertMissingPeerDiagnostic({ caseName, result, expected, expectedAny = [] }) {
  const missesRequiredText = expected.some((text) => !result.output.includes(text));
  const missesEveryAlternative =
    expectedAny.length > 0 && expectedAny.every((text) => !result.output.includes(text));
  if (!result.failed || missesRequiredText || missesEveryAlternative) {
    throw new Error(
      `[optional-peer-matrix] ${caseName}: missing-peer diagnostic mismatch\n${result.output}`,
    );
  }
}

export function runOptionalPeerMatrix({ fixtureDirectories }) {
  const minimalDir = fixtureDirectories.minimal;
  const installedManifest = JSON.parse(
    readFileSync(join(minimalDir, 'node_modules', 'stitchkit', 'package.json'), 'utf8'),
  );
  const optionalPeers = new Set(
    Object.entries(installedManifest.peerDependenciesMeta ?? {})
      .filter(([, metadata]) => metadata?.optional === true)
      .map(([name]) => name),
  );
  assertExportCoverage(installedManifest.exports);

  for (const entry of OPTIONAL_PEER_MATRIX) {
    const directory = fixtureDirectories[entry.fixture];
    if (!directory) throw new Error(`[optional-peer-matrix] ${entry.id}: missing fixture`);
    const fixtureManifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const installed = new Set(Object.keys(fixtureManifest.dependencies ?? {}));
    const expectedInstalled = new Set(entry.installedPeers);
    for (const peer of entry.installedPeers) {
      if (!installed.has(peer)) {
        throw new Error(
          `[optional-peer-matrix] ${entry.id}: fixture lacks installed peer ${peer}`,
        );
      }
    }
    const accidentalPeers = [...installed]
      .filter((name) => optionalPeers.has(name) && !expectedInstalled.has(name))
      .sort();
    if (accidentalPeers.length > 0) {
      throw new Error(
        `[optional-peer-matrix] ${entry.id}: fixture installs undeclared optional peer ${accidentalPeers.join(', ')}`,
      );
    }

    const sourceFile = join(directory, `matrix-${entry.id}.ts`);
    const outputFile = join(directory, `matrix-${entry.id}.js`);
    const metafile = join(directory, `matrix-${entry.id}.meta.json`);
    writeFileSync(sourceFile, entry.source);
    run(
      'bun',
      [
        'build',
        sourceFile,
        `--target=${entry.target}`,
        '--packages=bundle',
        `--outfile=${outputFile}`,
        `--metafile=${metafile}`,
      ],
      directory,
    );
    const inputs = Object.keys(JSON.parse(readFileSync(metafile, 'utf8')).inputs);
    const runtimeObserved = inputs
      .map(packageNameFromPath)
      .filter((name) => name && optionalPeers.has(name));
    assertAllowedOptionalPackages({
      caseName: entry.id,
      kind: 'runtime',
      observed: runtimeObserved,
      allowed: entry.runtimePeers,
    });

    const exportRecord = installedManifest.exports[entry.subpath];
    const typePath = typeof exportRecord === 'string' ? exportRecord : exportRecord?.types;
    if (!typePath) {
      throw new Error(`[optional-peer-matrix] ${entry.id}: export has no declaration target`);
    }
    const declarationObserved = declarationPackages(
      join(minimalDir, 'node_modules', 'stitchkit', typePath),
    ).filter((name) => optionalPeers.has(name));
    assertAllowedOptionalPackages({
      caseName: entry.id,
      kind: 'declaration',
      observed: declarationObserved,
      allowed: entry.declarationPeers,
    });

    if (entry.execute) run(entry.target === 'node' ? 'node' : 'bun', [outputFile], directory);
  }

  for (const entry of OPTIONAL_PEER_MATRIX.filter((candidate) => candidate.missingPeer)) {
    const missingPeer = entry.missingPeer;
    const directory = fixtureDirectories[missingPeer.fixture];
    const [command, ...args] = missingPeer.command;
    const result = runExpectFailure(command, args, directory);
    assertMissingPeerDiagnostic({ caseName: entry.id, result, ...missingPeer });
  }
}
