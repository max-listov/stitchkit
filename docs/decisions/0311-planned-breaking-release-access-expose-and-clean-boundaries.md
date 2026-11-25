---
title: "ADR 0311: Planned breaking release — mandatory tool access, expose, commandSettings, structuredContent and clean boundaries"
description: "Consolidates the breaking interface cleanups of 0.127.0 into one coordinated release: mandatory mount-time access ({ gate } | { open }), transports-to-expose renaming, CliConfig.commandSettings, AppError status derivation without appError, removal of stitchkit/application/schemas and sandbox-probe relocation, store driver contract steps 1 and 2 with async listSchedules, discovered MCP structuredContent validation, and starter code-copy removal."
type: decision
status: accepted
amends: ["0014", "0026", "0055", "0061", "0081", "0111", "0156", "0289"]
created: 2026-11-23
updated: 2026-11-23
---

# ADR 0311: Planned breaking release — mandatory tool access, expose, commandSettings, structuredContent and clean boundaries

Serves **I1**, **I2**, **I3**, **I7**, **I8**, **I9**, **I12**, **I14** and **I15**. Amends [ADR 0014](0014-tool-http-parity.md), [ADR 0026](0026-stitch-error-code-registry.md), [ADR 0055](0055-runtime-tools-share-one-neutral-operation.md), [ADR 0061](0061-independent-starter-release-line.md), [ADR 0081](0081-generic-native-operations-use-managed-definitions.md), [ADR 0111](0111-the-driver-is-the-extension-point-and-the-runtime-is-not-stable-yet.md), [ADR 0156](0156-a-schema-a-browser-cannot-import-is-not-a-contract.md) and [ADR 0289](0289-a-managed-command-owns-its-terminal-result-and-a-stream-is-a-command.md).

## Context

An audit after `0.126.0` identified several silent footguns and historical duplications accumulated across stable and evolving surfaces:

- Omitting `lifecycle` on tool mounts (`mountAgent`, `mountMcp`, `createMcpHandler`, `createCli`, `createToolInvoker`) silently mounted scoped operations unguarded, and `ToolLifecycle` allowed `{}` with no `beforeHandle`.
- The single concept of "which transports expose an operation" was named `expose` on contract endpoints and `transports` on runtime tools, native tools, connections and `ToolNameEntry`.
- `CliConfig` scattered five per-command maps across top-level keys (`optionAliases`, `positionals`, `results`, `passthrough`, `wait`), two of which were never checked for unknown command names, while CLI success printing used raw `JSON.stringify`.
- `appError()` duplicated `new AppError()` only because `new AppError(code)` defaulted to HTTP `500` instead of consulting `STITCH_ERROR_STATUS`.
- `stitchkit/application/schemas` survived as a redundant entrypoint after `stitchkit/application` itself became browser-clean (ADR 0157), and seven process-sandbox probe exports remained in `stitchkit/agent-runtime` instead of `stitchkit/agent-runtime/sandbox`.
- Optional driver hooks (`history.hasMessage`, `events.find`) kept fallback loops alive and caused silent driver divergence, while `AgentScheduleService.listSchedules` remained synchronous.
- Discovered MCP tools ignored server-advertised `outputSchema` and dropped `structuredContent` validation.
- The official starter carried local copies of `surface-manifest.ts` and `surface-conformance.ts` instead of importing them from `stitchkit/testing`, and recorded no starter version in `ProjectDeclarationSchema`.

Shipping these cleanups in one planned minor avoids repeated consumer migrations and respects the stable-surface breaking-change cadence (ADR 0198).

## Decision

### 1. Mandatory mount-time tool access (amends ADR 0014)

Replace optional `lifecycle` on all tool mount entrypoints with required `access: ToolAccess`:

- `ToolAccess = { gate: ToolGate } | { open: ToolOpenReason; afterHandle?: ToolLifecycle['afterHandle'] }`, where `ToolGate` is `ToolLifecycle` with a **required** `beforeHandle`, and `ToolOpenReason = 'public' | 'local-operator' | 'remote'`.
- Required at compile time **and** at runtime before the first call (via one shared `resolveToolAccess` throwing `TypeError` naming the entrypoint, including on legacy `lifecycle` keys, `{}` or `{ gate: {} }`) on: `mountAgent`, `mountMcp`, `mountPreparedMcp`, `buildMcpServer`, `buildMcpServerFromPrepared`, `createMcpHandler`, `createStdioMcpServer`, `createToolInvoker` (moved from per-call `ToolInvocationOptions` into `ToolInvokerConfig`), `createDeferredAgentToolSurface().mount(runContext, config)`, `createToolkit().mountMcp/mountAgent`, and CLI entrypoints (`createCli`, `createCliInvoker`, `buildCliSurface`, `createCliSession`) whenever `services` or `runtimeTools` are present. Native-only CLIs (`commands` only) have no managed tool lifecycle and therefore take no `access`.
- `composeToolLifecycle(gate: ToolGate, ...rest: readonly ToolLifecycle[]): ToolGate` rejects `undefined` and requires a `ToolGate` first.
- **Deliberate HTTP asymmetry:** `createServer.hooks.beforeHandle` remains optional. On HTTP, authorization belongs in `hooks.authorize` (typically via `createAuthHook` reading the HTTP `Request` before body parsing); tool transports have no HTTP `Request` and enforce their gate in `beforeHandle`.

### 2. One name `expose` for tool visibility (amends ADR 0055, ADR 0081)

Rename `transports` to `expose` across all tool visibility declarations and resolved entries, with a runtime `TypeError` refusing any leftover `transports` key (so spread objects and JS callers cannot silently widen visibility):

| Surface | Renamed (`transports` → `expose`) | Deliberately untouched |
|---------|------------------------------------|------------------------|
| Tool & connection definitions | `RuntimeToolDefinitionBase`, `ManagedNativeToolConfig`, `McpClientConnectionConfig`, `OpenApiConnectionConfig`, transfer/wait factories, async-operation capability map, built-in `agent-runtime` tools | — |
| Surface introspection | `ToolNameEntry.expose` | `summarizeTransports` / `TransportSummary` (per-transport counts) |
| Testing & transport layers | — | `SurfaceProbe.transports` (channels to probe), Socket.IO (`SocketIOServerConfig.transports`), `primitives/delivery` |

- **Deliberate casing pair:** `expose: ['CLI']` (uppercase transport enum) alongside `ctx.source === 'cli'` (lowercase runtime source string) is preserved intentionally; `ctx.source` is unchanged (ADR 0002's generic-core contract is unaffected and mentioned only here to record that no casing normalization was introduced).

### 3. Unified `CliConfig.commandSettings` and safe CLI JSON projection (amends ADR 0289)

- Replace top-level `optionAliases`, `positionals`, `results`, `passthrough`, `wait` and duplicate `lifecycle` on `CliConfig` / `CliInvokerConfig` with one typed map `commandSettings?: { [name in CliCommandName<TServices, TRuntime>]?: CliCommandSettings }` holding `{ aliases?, positionals?, result?, passthrough?, wait? }`.
- `CliCommandName` resolves to a literal command union for static surfaces and widens to `string` for factory/dynamic surfaces; `assertCliPoliciesResolved` checks every key across all five settings, and legacy top-level keys throw a `TypeError` naming `commandSettings`.
- CLI success serialization shares the internal safe JSON projection used by MCP (`bigint` and circular references never crash `JSON.stringify`); `--json` error output format is unchanged.

### 4. Remove `appError` and derive status in `AppError` (amends ADR 0026)

- When `new AppError(code, options?)` receives no explicit `status` and `code` is in `STITCH_ERROR_STATUS`, the constructor derives the HTTP status from `STITCH_ERROR_STATUS[code]`, falling back to `500` for unknown codes (an explicit `status` always wins).
- Remove `appError` from all five entrypoints (`stitchkit`, `stitchkit/contract`, `stitchkit/handler`, `stitchkit/server`, `stitchkit/node`).

### 5. Remove `stitchkit/application/schemas`, rename DDL/schema factories, relocate sandbox probes (amends ADR 0156)

- Delete the redundant `stitchkit/application/schemas` entrypoint (all canonical schemas remain exported from browser-clean `stitchkit/application`), and tighten `public-surface-budget.test.ts` to refuse `limits` or `overlaps` referencing nonexistent entrypoints.
- Rename `notificationOutboxStateSchema` → `createNotificationOutboxStateSchema` and `postgresTelegramUpdateStoreSchema` → `postgresTelegramUpdateStoreDdl`.
- Move the seven process-sandbox probe exports (`AgentSandboxGradeSchema`, `AgentSandboxGrade`, `AgentSandboxRestrictionSchema`, `AgentSandboxRestriction`, `probeAgentProcessSandbox`, `missingSandboxRestrictions`, `recordAgentSandboxProbe`) from `stitchkit/agent-runtime` to `stitchkit/agent-runtime/sandbox`.

### 6. Agent store driver contract steps 1 and 2 and async `listSchedules` (amends ADR 0111)

- Make `history.hasMessage` and `events.find` required on the store driver contract and delete the silent fallback scans in `store-mutate.ts` and `store-event-once.ts`.
- Require explicit `capabilities: { branch, planBranch }` and `commitConflict: { arm() } | { impossible: 'single-writer' }` in `AgentStoreConformanceConfig`, adding `event-once` and post-compaction `seed` conformance scenarios.
- Make `AgentScheduleService.listSchedules(conversationId)` async (`Promise<readonly AgentSchedule[]>`) so out-of-process schedule stores can adopt `createAgentScheduleTools`.
- Step 2 in the same release: the optional driver members `archive` and `history.restore` become declared capabilities. `createAgentRuntimeStore` reports them on a frozen `store.capabilities` and refuses a half-implemented `archive`; an import or a branch source that needs a missing member is refused with `AgentStoreUnsupportedCapabilityError` (`.capability`) before anything is written, where it used to drop spills and companion projections or revive compacted rows as active history; `planConversationBranch` refuses what `branchConversation` would. `AgentStoreConformanceConfig.capabilities` adds `archive` and `historyRestore`, checked against `store.capabilities` and proven by a round trip, by a compacted baseline that a fresh seed key cannot revive, and by an empty store after the refusal.

### 7. Discovered MCP `outputSchema` and `structuredContent`

- `readDiscoveredTools` reads each tool's advertised `outputSchema`, accounts for its bytes inside `maxSchemaBytes`, preserves it in the catalog cache, and validates `result.structuredContent` across MCP, Agent and CLI mounts using the shared `zodOutputFromJsonSchema` builder (supporting objects, records, `minProperties`, `allOf` and `patternProperties`).
- If an upstream server advertises `outputSchema` but omits `structuredContent` on a non-error response, fail loudly with `MCP_STRUCTURED_CONTENT_MISSING` (`502`); `isError: true` continues relaying the upstream error.

### 8. Starter without core copies and `starter.version` (amends ADR 0061)

- Delete `template/packages/backend/src/surface-manifest.ts` (+ `.test.ts`) and `template/scripts/surface-conformance.ts` in `packages/create-stitchkit`, importing `buildSurfaceManifest`, `assertSurfaceManifestSnapshot`, `assertSurfaceDiscovery` and `runSurfaceProbes` from `stitchkit/testing`.
- Add optional `starter: { version }` to `ProjectDeclarationSchema` (`stitchkit/declaration`) and write the scaffolder package version during `create-stitchkit` scaffolding (optional because non-starter repositories legitimately omit it).

## Consequences

- Every tool mount states its security posture explicitly (`{ gate }` or `{ open }`) and cannot silently bypass authorization.
- Consumers upgrade once through one consolidated `docs/guide/upgrading.md` release section covering every breaking change in `0.127.0`.
- Core, tests, consumer-lane fixtures and the official starter share one surface-manifest/conformance implementation and one tool visibility vocabulary.
