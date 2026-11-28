import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { agentExecutorPeerCases } from './optional-peer-matrix-agent-executor.mjs';
import { agentRuntimePeerCases } from './optional-peer-matrix-agent-runtime.mjs';

const FIXTURE_PEERS = {
  minimal: [],
  'mcp-only': ['@modelcontextprotocol/server'],
  full: [
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/ext-apps',
    '@modelcontextprotocol/server',
    '@tanstack/react-query',
    'ai',
    'react',
    'react-query-kit',
  ],
  grammy: ['grammy'],
  geo: ['maxmind'],
  vitals: ['web-vitals'],
  google: ['google-auth-library'],
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
    id: 'explicit-realtime-client',
    subpath: './realtime',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/realtime', 'createRealtimeClient'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'device-relay-browser',
    subpath: './device-relay',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: `import { createDeviceRelayAgent, createDeviceRelayHub, createMemoryRelayBroker, deviceRelayRealtimeContract } from 'stitchkit/device-relay';
const broker = createMemoryRelayBroker();
const hub = createDeviceRelayHub({ broker, authenticateDevice: () => null });
if (typeof createDeviceRelayAgent !== 'function' || !deviceRelayRealtimeContract.clientToServer['stitchkit.relay.hello']) {
  throw new Error('device-relay browser surface incomplete');
}
await hub.close();
console.log('device-relay browser: ok');`,
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'http-client',
    subpath: './http',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/http', 'createHttpClient'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'handler-browser',
    subpath: './handler',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: `import { defineContract } from 'stitchkit/contract';
import { createHandler, implement, serveBridge } from 'stitchkit/handler';
import { z } from 'zod';
const contract = defineContract({ prefix: 'ping' }, {
  ok: { method: 'GET', path: '/ok', desc: 'Ping', output: z.object({ ok: z.boolean() }) },
});
const handler = createHandler({ services: [implement(contract, { ok: () => ({ ok: true }) })] });
const res = await handler(new Request('http://bridge.invalid/ping/ok'));
if (res.status !== 200 || (await res.json()).ok !== true || typeof serveBridge !== 'function') {
  throw new Error('handler browser execution failed');
}
console.log('handler browser: ok');`,
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'native-packaging',
    subpath: './files/packaging',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'node',
    source: featureSource('stitchkit/files/packaging', 'createNativePackaging'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
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
    id: 'react-keyboard',
    subpath: './react/keyboard',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'browser',
    source: featureSource('stitchkit/react/keyboard', 'useNavZone'),
    runtimePeers: ['react'],
    declarationPeers: ['react'],
    execute: false,
  },
  {
    // The fakes and the two engines read a few members of an element and a key
    // and import no React: a consumer tests its layers with nothing installed.
    id: 'react-keyboard-testing',
    subpath: './react/keyboard/testing',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/react/keyboard/testing', 'createKeyboardTestBed'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'tools-contract',
    subpath: './tools/contract',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    // Browser, because that is the whole point: a client calling an async
    // operation could not import its schema without dragging in the runtime.
    target: 'browser',
    source: featureSource('stitchkit/tools/contract', 'createAsyncOperationSnapshotSchema'),
    runtimePeers: [],
    declarationPeers: [],
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
    id: 'cli-command-feature',
    subpath: './cli',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/cli', 'defineCliCommand'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'cli-publish-leaf',
    subpath: './cli/publish',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/cli/publish', 'publishCli'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'mcp-only-leaf',
    subpath: './tools/mcp',
    fixture: 'mcp-only',
    installedPeers: FIXTURE_PEERS['mcp-only'],
    target: 'bun',
    source: featureSource('stitchkit/tools/mcp', 'createMcpHandler'),
    runtimePeers: ['@modelcontextprotocol/server'],
    declarationPeers: ['@modelcontextprotocol/server'],
    execute: true,
    missingPeer: {
      fixture: 'minimal',
      command: ['node', 'src/missing-mcp-leaf-peer.mjs'],
      expected: ['Cannot find package'],
      expectedAny: ["'@modelcontextprotocol/server'"],
    },
  },
  {
    // An application exposing its operations over HTTP and CLI lists its tool
    // names with neither MCP nor the AI SDK installed. → ADR 0284.
    id: 'tools-neutral',
    subpath: './tools',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/tools', 'listToolNames'),
    runtimePeers: [],
    declarationPeers: ['@modelcontextprotocol/server'],
    execute: true,
  },
  {
    id: 'tools-agent',
    subpath: './tools/agent',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'bun',
    source: featureSource('stitchkit/tools/agent', 'mountAgent'),
    runtimePeers: ['ai'],
    declarationPeers: ['ai'],
    execute: true,
    missingPeer: {
      fixture: 'minimal',
      command: ['node', 'src/missing-ai-peer.mjs'],
      expected: ['Cannot find package'],
      expectedAny: ["'ai'"],
    },
  },
  {
    id: 'tools-toolkit',
    subpath: './tools/toolkit',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'bun',
    source: featureSource('stitchkit/tools/toolkit', 'createToolkit'),
    runtimePeers: ['@modelcontextprotocol/server', 'ai'],
    declarationPeers: ['@modelcontextprotocol/server', 'ai'],
    execute: true,
    missingPeer: {
      fixture: 'minimal',
      command: ['node', 'src/missing-toolkit-peer.mjs'],
      expected: ['Cannot find package'],
      expectedAny: ["'ai'", "'@modelcontextprotocol/server'"],
    },
  },
  {
    id: 'tools-connections',
    subpath: './tools/connections',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/tools/connections', 'mountConnections'),
    runtimePeers: [],
    // RuntimeToolDefinition exposes the canonical MCP presenter types;
    // mounting connections itself still executes without optional peers.
    declarationPeers: ['@modelcontextprotocol/server'],
    execute: true,
  },
  {
    id: 'cli',
    subpath: './cli',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/cli', 'parseCliArgs'),
    runtimePeers: [],
    declarationPeers: [],
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
    // The browser half of the promise the guide makes for this entry. It was
    // missing for as long as the promise existed: the entry sat in the server
    // build lane, so nothing bundled it for a browser and nothing noticed.
    id: 'remote-browser',
    subpath: './remote',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/remote', 'implementRemote'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
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
    id: 'tracking-browser',
    subpath: './tracking',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/tracking', 'createTrackingClient'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'release-browser',
    subpath: './release',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/release', 'createReleaseWatcher'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'release-marker',
    subpath: './release',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/release', 'createReleaseMarker'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'tracking-server',
    subpath: './tracking/server',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/tracking/server', 'dispositionTrackingBatch'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'geo-maxmind',
    subpath: './geo',
    fixture: 'geo',
    installedPeers: FIXTURE_PEERS.geo,
    target: 'bun',
    source: featureSource('stitchkit/geo', 'createMaxMindGeoIpLoader'),
    runtimePeers: ['maxmind'],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'geo-contract',
    subpath: './geo/contract',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/geo/contract', 'GeoAttributionSchema'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'oauth-browser',
    subpath: './oauth',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/oauth', 'createAuthorizationCodeClient'),
    runtimePeers: [],
    declarationPeers: ['zod'],
    execute: false,
  },
  {
    id: 'voice-browser',
    subpath: './voice',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/voice', 'SpeechQueue'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'voice-bun',
    subpath: './voice',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/voice', 'SentenceCutter'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'google-oidc',
    subpath: './google',
    fixture: 'google',
    installedPeers: FIXTURE_PEERS.google,
    target: 'node',
    source: featureSource('stitchkit/google', 'createGoogleOidcClient'),
    runtimePeers: ['google-auth-library'],
    declarationPeers: [],
    execute: true,
    missingPeer: {
      fixture: 'minimal',
      command: ['node', 'src/missing-google-peer.mjs'],
      expected: ['Cannot find package', "'google-auth-library'"],
    },
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
    id: 'agent-runtime-react',
    subpath: './agent-runtime/react',
    fixture: 'full',
    installedPeers: FIXTURE_PEERS.full,
    target: 'browser',
    source: featureSource('stitchkit/agent-runtime/react', 'useAgent'),
    runtimePeers: ['react'],
    declarationPeers: ['react'],
    execute: false,
  },
  ...agentRuntimePeerCases({
    featureSource,
    minimalPeers: FIXTURE_PEERS.minimal,
    fullPeers: FIXTURE_PEERS.full,
    nodePeers: FIXTURE_PEERS.node,
  }),
  ...agentExecutorPeerCases({ featureSource, minimalPeers: FIXTURE_PEERS.minimal }),
  {
    id: 'spend',
    subpath: './spend',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'node',
    source: featureSource('stitchkit/spend', 'createSpendGateway'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'spend-testing',
    subpath: './spend/testing',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'node',
    source: featureSource('stitchkit/spend/testing', 'assertSpendCoverage'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'application',
    subpath: './application',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    // Browser now: the diagnostic journal was the single import that made this
    // barrel unusable in a client bundle, and it has its own entry.
    target: 'browser',
    source: `import { ApplicationSnapshotSchema, createApplication } from 'stitchkit/application';
if (typeof createApplication === 'undefined') throw new Error('createApplication is unavailable');
if (typeof ApplicationSnapshotSchema === 'undefined') throw new Error('ApplicationSnapshotSchema is unavailable');
console.log('application: ok');
`,
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
    id: 'application-diagnostic-journal',
    subpath: './application/diagnostic-journal',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    // Node, deliberately: this entry exists BECAUSE it reaches the machine, and
    // isolating it is what lets everything else in the barrel reach a browser.
    target: 'node',
    source: featureSource(
      'stitchkit/application/diagnostic-journal',
      'createDiagnosticJournal',
    ),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'application-directory-inbox',
    subpath: './application/directory-inbox',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    // Node, deliberately: it reads and moves files, which is why it is not in
    // the browser-safe './application' barrel.
    target: 'node',
    source: featureSource('stitchkit/application/directory-inbox', 'createDirectoryInbox'),
    runtimePeers: [],
    declarationPeers: [],
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
    id: 'canonical-json',
    subpath: './primitives',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: `import { canonicalJson } from 'stitchkit/primitives';
const value = {'2':2,'10':10,'':'bmp','𐀀':'pair', optional:undefined,nested:[true,null]};
if (canonicalJson(value) !== '{"10":10,"2":2,"nested":[true,null],"𐀀":"pair","":"bmp"}') throw new Error('canonical JSON bytes');
let refused=false;try {canonicalJson([undefined]);}catch(error){refused=error instanceof TypeError;}
if(!refused) throw new Error('canonical JSON refusal');
console.log('canonical JSON browser: ok');`,
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'tracking-contract',
    subpath: './tracking/contract',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/tracking/contract', 'createTrackingContract'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'tracking-performance',
    subpath: './tracking/performance',
    fixture: 'vitals',
    installedPeers: FIXTURE_PEERS.vitals,
    target: 'browser',
    source: featureSource('stitchkit/tracking/performance', 'createPerformanceCollector'),
    runtimePeers: ['web-vitals'],
    declarationPeers: [],
    execute: false,
  },
  {
    id: 'xlsx',
    subpath: './xlsx',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: `import { renderXlsx } from 'stitchkit/xlsx';
const bytes = await renderXlsx({ sheets: [{ name: 'S', columns: [{ key: 't', header: 'T', type: 'text' }], rows: [{ t: '=1' }] }] });
if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('xlsx container');
console.log('xlsx browser: ok');`,
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'sync-browser',
    subpath: './sync',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: `import { createSyncSession, decideOutboxBatch } from 'stitchkit/sync';
const sent = [];
const saved = [];
const session = createSyncSession({
  isConnected: () => true,
  readCursor: () => 5,
  beginFullSync: () => {},
  send: (request) => sent.push(request),
  apply: () => {},
  saveCursor: (version) => saved.push(version),
  log: { info() {}, warn() {}, error() {} },
  newId: () => 'id-' + Math.random(),
  schedule: () => () => {},
});
session.requestSync();
session.handleResponse({ sessionId: sent[0].sessionId, requestId: sent[0].requestId, hasMore: false, latestVersion: 9 });
if (sent[0]?.after !== 5 || saved[0] !== 9) throw new Error('sync session');
const batch = decideOutboxBatch([{ id: 'a', entity: 'task', entityId: 'a', payloadJson: '{}', status: 'pending', sentAt: null, attempts: 0 }], { now: 0, policy: { toChange: (row) => ({ id: row.id }), emptyEnvelopeBytes: 2, maxBytes: 1024, maxChanges: 10, retryAfterMs: 1000 } });
if (batch.send.length !== 1) throw new Error('sync outbox');
console.log('sync browser: ok');`,
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'sync-postgres',
    subpath: './sync/postgres',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: `import { checkSyncStore, memorySyncStore } from 'stitchkit/sync/postgres';
const failures = await checkSyncStore(() => memorySyncStore());
if (failures.length > 0) throw new Error(failures.join('; '));
console.log('sync server store: ok');`,
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'process',
    subpath: './process',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/process', 'runNativeCommand'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'process-bootstrap',
    subpath: './process/bootstrap',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'bun',
    source: featureSource('stitchkit/process/bootstrap', 'bootstrapPackageProcess'),
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
    id: 'service-host',
    subpath: './service-host',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'node',
    source: `import { renderSystemdServiceUnit, renderLaunchdPlist, parseProcNetUnixListeningSockets } from 'stitchkit/service-host';
const unit = renderSystemdServiceUnit({ description: 'Demo', execStart: ['/usr/bin/env', 'demo'] });
const plist = renderLaunchdPlist({ label: 'example.demo', programArguments: ['/usr/bin/env', 'demo'] });
if (!unit.includes('ExecStart=') || !plist.includes('<key>Label</key>') || parseProcNetUnixListeningSockets('').length !== 0) {
  throw new Error('service-host execution failed');
}
console.log('service-host: ok');`,
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'service-host-macos',
    subpath: './service-host/macos',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'node',
    source: `import { renderMacosLauncherSource, parseCodesignDetails, parseLsregisterDump } from 'stitchkit/service-host/macos';
const src = renderMacosLauncherSource({ targetExecutable: '/usr/bin/true' });
if (!src.includes('posix_spawn') || parseCodesignDetails('').authorities.length !== 0 || parseLsregisterDump('').length !== 0) {
  throw new Error('service-host/macos execution failed');
}
console.log('service-host/macos: ok');`,
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    id: 'service-host-work',
    subpath: './service-host/work',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'node',
    source: `import { WorkOwnerSchema, readWorkOrigin, workUnitName } from 'stitchkit/service-host/work';
const owner = WorkOwnerSchema.parse({ launcher: 'demo', id: 'run-1', label: 'Demo', project: null, agent: null, parent: null });
if (workUnitName(owner) !== 'demo-run-1.scope' || readWorkOrigin({}) !== null) {
  throw new Error('service-host/work execution failed');
}
console.log('service-host/work: ok');`,
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
    // Markup is parsed without a DOM so a browser preview and a server send
    // share one parser: the browser row is the claim, not symmetry.
    id: 'telegram-html',
    subpath: './telegram/html',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: `import { checkTelegramHtml, markdownToTelegramHtml, splitTelegramHtml, splitTelegramMarkdown } from 'stitchkit/telegram/html';
const html = markdownToTelegramHtml('**hi** _there_ \`x\` [docs](https://example.com)');
const chunks = splitTelegramMarkdown('a\\nb', { limit: 10 });
if (
  checkTelegramHtml(html).problem !== undefined ||
  !html.includes('<a href="https://example.com">docs</a>') ||
  splitTelegramHtml(html).length !== 1 ||
  chunks.length !== 1
) {
  throw new Error('telegram/html browser execution failed');
}
console.log('telegram-html: ok');
`,
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    // A voice waveform is packed on the server and drawn in the page from one
    // format: the browser row is the claim.
    id: 'telegram-voice',
    subpath: './telegram/voice',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/telegram/voice', 'unpackTelegramVoiceWaveform'),
    runtimePeers: [],
    declarationPeers: [],
    execute: true,
  },
  {
    // The budget transformer is typed by grammY's `Transformer` and never
    // imports grammY at run time, so the bundle stays free of it.
    id: 'telegram-grammy',
    subpath: './telegram/grammy',
    fixture: 'grammy',
    installedPeers: FIXTURE_PEERS.grammy,
    target: 'bun',
    source: featureSource('stitchkit/telegram/grammy', 'telegramBudgetTransformer'),
    runtimePeers: [],
    declarationPeers: ['grammy'],
    execute: true,
  },
  {
    id: 'telegram-grammy-node',
    subpath: './telegram/grammy',
    fixture: 'node',
    installedPeers: FIXTURE_PEERS.node,
    target: 'node',
    source: featureSource('stitchkit/telegram/grammy', 'telegramBudgetTransformer'),
    runtimePeers: [],
    declarationPeers: ['grammy'],
    execute: true,
  },
  {
    // The widget methods reach grammY only through the client they are given
    // (`api.raw`), so this bundle, too, must stay free of it.
    id: 'telegram-grammy-widget-api',
    subpath: './telegram/grammy',
    fixture: 'grammy',
    installedPeers: FIXTURE_PEERS.grammy,
    target: 'bun',
    source: featureSource('stitchkit/telegram/grammy', 'telegramWidgetApi'),
    runtimePeers: [],
    declarationPeers: ['grammy'],
    execute: true,
  },
  {
    id: 'telegram-grammy-widget-api-node',
    subpath: './telegram/grammy',
    fixture: 'node',
    installedPeers: FIXTURE_PEERS.node,
    target: 'node',
    source: featureSource('stitchkit/telegram/grammy', 'telegramWidgetApi'),
    runtimePeers: [],
    declarationPeers: ['grammy'],
    execute: true,
  },
  {
    // Screens are middleware over the bot's own `ctx.api` and grammY's
    // `StorageAdapter`: grammY is named in the declarations and never imported
    // at run time, so the bundle stays free of it on either runtime.
    id: 'telegram-screens',
    subpath: './telegram/screens',
    fixture: 'grammy',
    installedPeers: FIXTURE_PEERS.grammy,
    target: 'bun',
    source: featureSource('stitchkit/telegram/screens', 'telegramScreens'),
    runtimePeers: [],
    declarationPeers: ['grammy'],
    execute: true,
  },
  {
    id: 'telegram-screens-node',
    subpath: './telegram/screens',
    fixture: 'node',
    installedPeers: FIXTURE_PEERS.node,
    target: 'node',
    source: featureSource('stitchkit/telegram/screens', 'createScreenTestChat'),
    runtimePeers: [],
    declarationPeers: ['grammy'],
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
    id: 'declaration-browser',
    subpath: './declaration',
    fixture: 'minimal',
    installedPeers: FIXTURE_PEERS.minimal,
    target: 'browser',
    source: featureSource('stitchkit/declaration', 'ProjectDeclarationSchema'),
    runtimePeers: [],
    declarationPeers: [],
    execute: false,
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
        `--outdir=${directory}`,
        `--entry-naming=matrix-${entry.id}.js`,
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
