/**
 * Guard: a declared option has to be load-bearing.
 *
 * Six shipped defects share one shape — an option is accepted, typed and
 * documented, and on some path simply not honoured. `transports:
 * ['websocket']` did not refuse polling; a route group's `onError` was never
 * dispatched; `managedServerResource` never started the server it was handed a
 * thunk for; `bindProcessSignals` substituted schema defaults over the
 * application's declared budget. Every one of them typechecked.
 *
 * Types cannot catch this class by construction: a type proves an option can be
 * PASSED and says nothing about whether passing it changes anything. So the
 * check is coverage, mechanically enumerated from the real types the way
 * `reference-coverage.test.ts` enumerates exports.
 *
 * What it proves is deliberately narrow: that a NAMED test claims this option.
 * Not that the test is good — the same contract `reference-coverage` has, and
 * still the whole distance between six silent defects and a red gate.
 *
 * The covered surfaces are chosen by failure mode, not by importance. A wrong
 * `port` fails loudly on the first request; an unenforced allowlist, a
 * never-dispatched hook and an unapplied grace period all look exactly like
 * success.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from '@typescript/typescript6';
import { z } from 'zod';

const SRC = `${import.meta.dir}/../src`;
const TESTS = import.meta.dir;
const REGISTRY = `${TESTS}/fixtures/option-effects.json`;

/** Where each covered configuration type is exported from. */
const COVERED: Record<string, string> = {
  AgentCodingSearchLimits: 'agent-runtime/coding-search-limits.ts',
  ContractFactoryConfig: 'entrypoints/contract.ts',
  ContractFactoryToolExposure: 'entrypoints/contract.ts',
  ResolveAttributionInput: 'entrypoints/tracking.ts',
  ResolveTrackedClickOptions: 'entrypoints/tracking.ts',
  SessionCredentialsConfig: 'entrypoints/index.ts',
  SessionRefreshAhead: 'entrypoints/index.ts',
  ClientRequestOptions: 'entrypoints/contract.ts',
  ChunkedUploadConfig: 'entrypoints/index.ts',
  ChunkSpoolConfig: 'entrypoints/files.ts',
  AgentStepBarriers: 'entrypoints/agent-runtime.ts',
  OpenRouterProviderAccess: 'entrypoints/agent-runtime/openrouter.ts',
  OpenRouterSnapshotOptions: 'entrypoints/agent-runtime/openrouter.ts',
  SpendGatewayConfig: 'entrypoints/spend.ts',
  SpooledSpendStoreConfig: 'entrypoints/spend.ts',
  ReconcilePendingSpendOptions: 'entrypoints/spend.ts',
  AgentStoreConformanceCapabilities: 'entrypoints/agent-runtime/testing.ts',
  RegularFileReadOptions: 'entrypoints/files.ts',
  RegularFileAsyncReadOptions: 'entrypoints/files.ts',
  PolledJsonOptions: 'entrypoints/files.ts',
  WaitForDirectoryOptions: 'entrypoints/files.ts',
  ChangeSubscriptionConfig: 'entrypoints/application.ts',
  NotificationDeliveryConfig: 'entrypoints/application.ts',
  CacheBridgeConfig: 'entrypoints/react.ts',
  ModelInvocationConfig: 'entrypoints/agent-runtime.ts',
  StaticRouteOptions: 'entrypoints/server.ts',
  ShutdownOptions: 'entrypoints/server.ts',
  ProcessSignalsOptions: 'entrypoints/server.ts',
  SocketIOServerConfig: 'entrypoints/server.ts',
  RouteGroup: 'entrypoints/server.ts',
  LifecycleHooks: 'entrypoints/server.ts',
  TrustFenceConfig: 'entrypoints/server.ts',
  ProxyOriginConfig: 'entrypoints/server.ts',
  EventBusOptions: 'entrypoints/server.ts',
  ManagedServerResourceConfig: 'entrypoints/application.ts',
  DiagnosticJournalConfig: 'entrypoints/application.ts',
  DiagnosticJournalReaderConfig: 'entrypoints/application/diagnostic-journal.ts',
  CreditAcquireWaitOptions: 'entrypoints/application.ts',
  RevisionSignalConfig: 'entrypoints/application.ts',
  RevisionSignalWaitOptions: 'entrypoints/application.ts',
  BoundedAdmissionPerKeyLimits: 'entrypoints/application.ts',
  KeyspaceResourceConfig: 'entrypoints/application.ts',
  SqliteKeyspaceBackendConfig: 'entrypoints/application.ts',
  WatchHubConfig: 'entrypoints/application.ts',
  DirectoryInboxConfig: 'entrypoints/application.ts',
  CliPublicationOptions: 'entrypoints/cli/publish.ts',
  CliInvocationScanOptions: 'entrypoints/cli.ts',
  CliUpdateApplyConfig: 'entrypoints/cli.ts',
  McpClientConnectionConfig: 'entrypoints/tools/connections.ts',
  McpConnectionLimits: 'entrypoints/tools/connections.ts',
  ConnectionOperationLimits: 'entrypoints/tools/connections.ts',
  NormalizeErrorOptions: 'contract/normalize.ts',
  ResumableIteratorConfig: 'entrypoints/index.ts',
  EventTopicDeclaration: 'entrypoints/live.ts',
  WatchClientConfig: 'entrypoints/live.ts',
  VerifyTelegramInitDataOptions: 'entrypoints/telegram.ts',
  TelegramBroadcastConfig: 'entrypoints/telegram.ts',
  TelegramOutboundBudgetConfig: 'entrypoints/telegram.ts',
  PerformanceCollectorConfig: 'entrypoints/tracking/performance.ts',
  TelegramOperatorChannelConfig: 'entrypoints/telegram.ts',
  TelegramLocalFilesConfig: 'entrypoints/telegram.ts',
  ReadTelegramVoiceWaveformOptions: 'entrypoints/telegram.ts',
  TelegramOperatorDedupe: 'entrypoints/telegram.ts',
  ClaimTelegramWebhookConfig: 'entrypoints/telegram.ts',
  TelegramUpdateAttemptIntakeConfig: 'entrypoints/telegram.ts',
  TelegramUpdateIntakeConfig: 'entrypoints/telegram.ts',
  SqliteTelegramUpdateStoreConfig: 'entrypoints/telegram.ts',
  PostgresTelegramUpdateStoreConfig: 'entrypoints/telegram.ts',
  TelegramHtmlTruncateOptions: 'entrypoints/telegram/html.ts',
  TelegramWidgetCallOptions: 'entrypoints/telegram/grammy.ts',
  GrammyBotResourcesConfig: 'entrypoints/application/grammy.ts',
  TelegramScreensConfig: 'entrypoints/telegram/screens.ts',
  OpenOptions: 'entrypoints/telegram/screens.ts',
  ScreenInputOptions: 'entrypoints/telegram/screens.ts',
  NoticeOptions: 'entrypoints/telegram/screens.ts',
  ScreenOptions: 'entrypoints/telegram/screens.ts',
  ScopeOptions: 'entrypoints/telegram/screens.ts',
  TestChatOptions: 'entrypoints/telegram/screens.ts',
  JsonLoggerOptions: 'entrypoints/observability.ts',
  SecretValuesOptions: 'entrypoints/observability.ts',
  ApiErrorRetryConfig: 'entrypoints/react.ts',
  QueryClientFactoryConfig: 'entrypoints/react.ts',
  KeyLayerOptions: 'entrypoints/react/keyboard.ts',
  EscapeLayerOptions: 'entrypoints/react/keyboard.ts',
  NavZoneOptions: 'entrypoints/react/keyboard.ts',
  FocusZoneOptions: 'entrypoints/react/keyboard.ts',
  EndpointToolView: 'entrypoints/contract.ts',
  EndpointToolOptions: 'entrypoints/contract.ts',
  ToolInputProjection: 'tools/internal/surface-projector.ts',
  ExclusiveLockOptions: 'entrypoints/files.ts',
  WriteFileAtomicOptions: 'entrypoints/files.ts',
  UnixSocketBinding: 'entrypoints/files.ts',
  SweepAtomicStagingOptions: 'entrypoints/files.ts',
  ManagedFileReadOptions: 'entrypoints/files.ts',
  CanonicalJsonOptions: 'entrypoints/primitives.ts',
  NativeCommandOptions: 'entrypoints/process.ts',
  OperationProcessesConfig: 'entrypoints/process.ts',
  OperationProcessIo: 'entrypoints/process.ts',
  ClientArtifactOptions: 'entrypoints/files/packaging.ts',
  NativePackagingOptions: 'entrypoints/files/packaging.ts',
  EffectRunOptions: 'entrypoints/tools.ts',
  AgentControllerConfig: 'entrypoints/agent-runtime/browser.ts',
  AgentHarnessRealtimeConfig: 'entrypoints/agent-runtime/realtime.ts',
  BranchAgentConversationInput: 'entrypoints/agent-runtime.ts',
  AgentChildManagerConfig: 'entrypoints/agent-runtime.ts',
  DeferredAgentToolCommonConfig: 'entrypoints/agent-runtime.ts',
  AgentScheduleServiceConfig: 'entrypoints/agent-runtime.ts',
  AgentChildToolsConfig: 'entrypoints/agent-runtime.ts',
  AgentScheduleToolsConfig: 'entrypoints/agent-runtime.ts',
  AgentStateToolsConfig: 'entrypoints/agent-runtime.ts',
  AgentEventSearchToolsConfig: 'entrypoints/agent-runtime.ts',
  LocalHostGuardConfig: 'entrypoints/server.ts',
  ClientConfig: 'entrypoints/index.ts',
  SyncSessionPorts: 'entrypoints/sync.ts',
  OutboxPolicy: 'entrypoints/sync.ts',
  OverlaySpec: 'entrypoints/sync.ts',
  SyncResultReading: 'entrypoints/sync.ts',
  OutboxPage: 'entrypoints/sync.ts',
  SyncPushLimits: 'entrypoints/sync.ts',
  MemorySyncStoreConfig: 'entrypoints/sync/postgres.ts',
  PostgresSyncStoreConfig: 'entrypoints/sync/postgres.ts',
  PostgresAgentRuntimeStoreConfig: 'entrypoints/agent-runtime/postgres.ts',
  PostgresAgentEventSearchConfig: 'entrypoints/agent-runtime.ts',
  ClaudeCliDriverConfig: 'entrypoints/agent-executor/claude.ts',
  CodexDriverConfig: 'entrypoints/agent-executor/codex.ts',
  ClaudeSdkDriverConfig: 'entrypoints/agent-executor/claude-sdk.ts',
  AcpDriverConfig: 'entrypoints/agent-executor/acp.ts',
  SqliteMigrationRun: 'entrypoints/application.ts',
  SignLinkOptions: 'entrypoints/server.ts',
  VerifySignedLinkOptions: 'entrypoints/server.ts',
  BridgeHostConfig: 'entrypoints/handler.ts',
  BridgeFetchOptions: 'entrypoints/http.ts',
  RepeatLimitOptions: 'entrypoints/observability.ts',
  VerifyArtifactOptions: 'entrypoints/service-host.ts',
  ActivateVersionedArtifactOptions: 'entrypoints/service-host.ts',
  RollbackVersionedArtifactOptions: 'entrypoints/service-host.ts',
  SystemdServiceUnitConfig: 'entrypoints/service-host.ts',
  SystemdTimerUnitConfig: 'entrypoints/service-host.ts',
  CheckSystemdTimerPairOptions: 'entrypoints/service-host.ts',
  InstallSystemdTimerPairOptions: 'entrypoints/service-host.ts',
  CheckSystemdUnitOptions: 'entrypoints/service-host.ts',
  ApplySystemdUnitOptions: 'entrypoints/service-host.ts',
  UnixClientTransportConfig: 'entrypoints/server.ts',
  PurgeInvocationPayloadsInput: 'entrypoints/agent-runtime.ts',
  LaunchdPlistConfig: 'entrypoints/service-host.ts',
  ReloadLaunchdJobOptions: 'entrypoints/service-host.ts',
  VerifySupervisedProcessOptions: 'entrypoints/service-host.ts',
  ConfigReloaderOptions: 'entrypoints/service-host.ts',
  PolledJsonConfigSourceOptions: 'entrypoints/service-host.ts',
  ConfigReloaderShutdownOptions: 'entrypoints/service-host.ts',
  EventLoopDelayMonitorOptions: 'entrypoints/observability.ts',
  VerifySignedBundleOptions: 'entrypoints/service-host/macos.ts',
  MacosLauncherConfig: 'entrypoints/service-host/macos.ts',
  GenerateAppIconIcnsOptions: 'entrypoints/service-host/macos.ts',
  EnsureSignedBundleOptions: 'entrypoints/service-host/macos.ts',
  ForgetStaleRegistrationsOptions: 'entrypoints/service-host/macos.ts',
  ForgetBuildTreeOptions: 'entrypoints/service-host/macos.ts',
  InspectResponsibleProcessOptions: 'entrypoints/service-host/macos.ts',
  VerifyProcessSubtreeResponsibilityOptions: 'entrypoints/service-host/macos.ts',
  TelegramMarkdownSplitOptions: 'entrypoints/telegram/html.ts',
  CliCommandSettings: 'entrypoints/cli.ts',
  SessionRefreshOptions: 'entrypoints/index.ts',
  SpendCoveragePolicy: 'entrypoints/spend/testing.ts',
  OpenRouterAdmissionPolicy: 'entrypoints/agent-runtime/openrouter.ts',
  OpenRouterRequestPolicy: 'entrypoints/agent-runtime/openrouter.ts',
  JsonRpcPeerConfig: 'entrypoints/agent-executor.ts',
  ExecutorProfileConfig: 'entrypoints/agent-executor.ts',
  AgentEngineConformanceConfig: 'entrypoints/agent-executor/testing.ts',
  BootoutLaunchdJobOptions: 'entrypoints/service-host.ts',
  InspectLaunchdJobOptions: 'entrypoints/service-host.ts',
  LintLaunchdPlistOptions: 'entrypoints/service-host.ts',
  ReadLaunchdPlistOptions: 'entrypoints/service-host.ts',
  SystemdUnitQueryOptions: 'entrypoints/service-host.ts',
  MacosBundleInfoPlistConfig: 'entrypoints/service-host/macos.ts',
  FindDeveloperIdsOptions: 'entrypoints/service-host/macos.ts',
  ResolveSigningIdentityOptions: 'entrypoints/service-host/macos.ts',
  SignBundleOptions: 'entrypoints/service-host/macos.ts',
  RenderAppleSquircleSvgOptions: 'entrypoints/service-host/macos.ts',
  LaunchServicesBundleOptions: 'entrypoints/service-host/macos.ts',
  ScanLsregisterDumpOptions: 'entrypoints/service-host/macos.ts',
  CompileMacosLauncherOptions: 'entrypoints/service-host/macos.ts',
  MacosCommandOptions: 'entrypoints/service-host/macos.ts',
};

const EntrySchema = z.union([
  z.object({ test: z.string().min(1) }),
  z.object({ exempt: z.string().min(20) }),
]);
const RegistrySchema = z.record(z.string(), z.record(z.string(), EntrySchema));

const program = ts.createProgram(
  [...new Set(Object.values(COVERED))].map((file) => join(SRC, file)),
  {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  },
);
const checker = program.getTypeChecker();

/** The declared members of one exported configuration type. */
function membersOf(typeName: string, file: string): string[] {
  const source = program.getSourceFile(join(SRC, file));
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`cannot resolve entrypoint ${file}`);
  const symbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((exported) => exported.getName() === typeName);
  if (!symbol) throw new Error(`${typeName} is not exported from ${file}`);
  const declared = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol));
  if (declared.length > 0) return declared.map((property) => property.getName()).sort();
  // A `z.input<typeof Schema>` alias has no declared type of its own; the type
  // at its declaration is the inferred object.
  const declaration = symbol.declarations?.[0];
  if (!declaration) throw new Error(`${typeName} has no declaration`);
  return checker
    .getPropertiesOfType(checker.getTypeAtLocation(declaration))
    .map((property) => property.getName())
    .sort();
}

/** Collect titles declared via `test.each(...)('…', fn)` using the TypeScript AST. */
function collectTestEachNames(path: string, source: string, names: Set<string>): void {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'each'
    ) {
      const target = node.expression.expression.expression;
      const isActiveTestEach =
        (ts.isIdentifier(target) && target.text === 'test') ||
        (ts.isPropertyAccessExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === 'test' &&
          target.name.text !== 'skip' &&
          target.name.text !== 'todo');
      const firstArg = node.arguments[0];
      if (
        isActiveTestEach &&
        firstArg &&
        (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) &&
        firstArg.text.length > 0
      ) {
        names.add(firstArg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

/** Every `test('…')` and `test.each(…)('…')` name defined anywhere in this suite. */
function definedTestNames(): Set<string> {
  const names = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'fixtures' && entry.name !== 'node_modules') walk(path);
        continue;
      }
      if (!entry.name.endsWith('.test.ts')) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(
        /\btest(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g,
      )) {
        if (match[2]) names.add(match[2]);
      }
      if (source.includes('.each(')) collectTestEachNames(path, source, names);
    }
  };
  walk(TESTS);
  return names;
}

describe('a declared option is load-bearing', () => {
  const registry = RegistrySchema.parse(JSON.parse(readFileSync(REGISTRY, 'utf8')));
  const defined = definedTestNames();

  test('the registry can find the tests it names', () => {
    // Proves the walker works before anything is judged by it: a registry that
    // named nothing findable would otherwise look exactly like a clean sweep.
    expect(defined.size).toBeGreaterThan(500);
    expect(defined.has('the registry can find the tests it names')).toBe(true);
    expect(defined.has('finds %s')).toBe(true);
  });

  for (const [typeName, file] of Object.entries(COVERED)) {
    test(`every option of ${typeName} names a test that exercises it`, () => {
      const members = membersOf(typeName, file);
      const entries = registry[typeName] ?? {};
      expect(members.filter((member) => !(member in entries))).toEqual([]);
      // The registry may not outlive the type: a stale entry is a claim about
      // an option that no longer exists.
      expect(
        Object.keys(entries)
          .filter((name) => !members.includes(name))
          .sort(),
      ).toEqual([]);
    });

    test(`every test ${typeName} names is a real test`, () => {
      const entries = registry[typeName] ?? {};
      const missing = Object.entries(entries)
        .filter(([, entry]) => 'test' in entry && !defined.has(entry.test))
        .map(
          ([option, entry]) => `${typeName}.${option} → ${'test' in entry ? entry.test : ''}`,
        );
      expect(missing).toEqual([]);
    });
  }

  test('the registry covers exactly the types this gate claims to cover', () => {
    expect(Object.keys(registry).sort()).toEqual(Object.keys(COVERED).sort());
  });
});
