# Architecture Decisions

This directory records the **why** behind stitchkit — the decisions that shaped
the framework, including the ones that were tried and reversed.

Each entry is an ADR (Architecture Decision Record): one decision, its context,
the alternatives weighed against it, and the consequences. ADRs are immutable —
when a decision changes, a new ADR supersedes the old one; the old one stays,
marked `Superseded`, so the reasoning is never lost.

These records were consolidated from the project's internal design notes on
2026-05-20; the dates on each ADR are when the decision was effectively made.

## Index

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-bun-serve-no-framework.md) | Build on `Bun.serve()`, no HTTP framework | Accepted |
| [0002](0002-generic-core.md) | A generic core — the framework carries no domain model | Accepted |
| [0003](0003-two-context-types.md) | Two context types: `RuntimeContext` and `HandlerContext` | Accepted |
| [0004](0004-lifecycle-hooks.md) | Four lifecycle hooks instead of a middleware chain | Superseded by 0072 |
| [0005](0005-typed-client.md) | The typed client is inferred from the contract | Accepted |
| [0006](0006-route-groups-query-params.md) | Route groups and GET/DELETE query params | Accepted |
| [0007](0007-mcp-agent-tools.md) | MCP and agent tools from one shared pipeline | Accepted |
| [0008](0008-thin-wrappers.md) | Thin wrappers over the stack you already use | Accepted |
| [0009](0009-hand-rolled-websocket.md) | A hand-rolled WebSocket transport | Superseded by 0008 |
| [0010](0010-fullstack-rejected.md) | Grow stitchkit into a fullstack framework | Rejected |
| [0011](0011-bun-only-one-package.md) | Bun-only, published as one small package | Accepted |
| [0012](0012-observability-module.md) | A built-in observability module | Accepted |
| [0013](0013-runtime-agnostic-core.md) | Runtime-agnostic core, Bun as first-class adapter | Accepted — supersedes Bun-only clause of 0011 |
| [0014](0014-tool-http-parity.md) | The tool surface carries the same contract guarantees as HTTP | Accepted — refines 0007 |
| [0015](0015-oauth-resource-server.md) | OAuth 2.1 resource-server toolkit for MCP | Superseded by 0068 |
| [0016](0016-cli-transport.md) | CLI as the fourth transport | Accepted — extends 0007 |
| [0017](0017-typed-tool-context.md) | Typed tool-path context via `createToolkit` | Accepted — extends 0003 |
| [0018](0018-openapi-generation.md) | OpenAPI generated from the contract | Accepted |
| [0019](0019-generic-native-tools.md) | Generic native MCP tools (wait / download / upload) | Accepted — extends 0007 |
| [0020](0020-raw-websocket-lane.md) | A raw WebSocket lane composed beside Socket.IO | Accepted — upholds 0008 |
| [0021](0021-endpoint-meta-passthrough.md) | Endpoint meta passthrough (opaque per-endpoint metadata) | Accepted — extends 0002 |
| [0022](0022-endpoint-identity.md) | Stable (service, action) identity on MethodDef | Accepted — extends 0002, 0021 |
| [0023](0023-range-file-serving.md) | Range-capable file serving (`serveFile`) | Accepted — extends 0013 |
| [0024](0024-scope-driven-mounting.md) | Scope-driven mounting (`scopePrefixes`) | Accepted — extends 0002; the deferred scope→context clause superseded by 0075 |
| [0025](0025-typed-scoped-client.md) | Typed scoped client (consumed keys as args) | Accepted — extends 0005 |
| [0026](0026-stitch-error-code-registry.md) | Published stitch error-code registry | Accepted — extends 0002 |
| [0027](0027-transport-neutral-contract-execution.md) | Transport-neutral contract execution (BYO transport) | Accepted — dispatcher portion superseded by 0028 |
| [0028](0028-revert-contract-dispatcher.md) | Revert `createContractDispatcher` (no adopting consumer) | Accepted — supersedes the dispatcher part of 0027 |
| [0029](0029-audit-endpoint-identity-and-dimensions.md) | Endpoint identity + domain dimensions on the audit event | Accepted — extends 0012, 0021, 0022 |
| [0030](0030-audit-verb-and-json-error-details.md) | Audit verb, sanitised error details, complete error-code logging | Accepted — extends 0029, 0026, 0022 |
| [0031](0031-deep-union-flatten.md) | Deep discriminated-union flattening for tool schemas | Accepted — completes `flattenUnionInput`; refines 0007, 0014 |
| [0032](0032-apperror-brand-identity.md) | Brand-based `AppError` identification (not `instanceof`) | Accepted — fixes 0026; consequence of 0011/0013 |
| [0033](0033-sound-flatten-collisions.md) | Sound flatten: collision widening, discriminator support, probe parity | Accepted — completes/repairs 0031; "advertised-only" premise superseded by 0034 |
| [0034](0034-advertised-schema-key-policy.md) | The advertised tool schema carries each object's key policy | Superseded by 0050 |
| [0035](0035-tool-name-derivation-and-validation.md) | Tool names: normalise the whole character class, assert at mount | Accepted — refines the tool pipeline of 0007 |
| [0036](0036-contract-level-meta.md) | `meta` cascades from the contract; `expose` deliberately does not | Accepted — extends 0021 |
| [0037](0037-output-strip-diagnostics.md) | The output strip stays, and becomes visible on demand | Accepted — extends 0014 |
| [0038](0038-raw-response-endpoints.md) | Raw-response endpoints — the handler owns the `Response` | Accepted — documented HTTP-only exception to 0027 |
| [0039](0039-request-logging-reads-the-request-context.md) | Request logging reads the request context; `logging` becomes a config object | Accepted — connects 0012's logger to its context; upholds 0013, 0021 |
| [0040](0040-the-log-format-is-chosen-not-guessed.md) | The log format is chosen (`logging.format`), not guessed from `NODE_ENV` | Accepted — repairs the delivery of 0039; upholds 0013 |
| [0041](0041-tool-error-cause-is-observable.md) | The cause of a failed tool call is observable (`onToolError`) | Accepted — closes an HTTP/tool asymmetry in 0007/0014; extends 0012 |
| [0042](0042-the-audit-row-may-name-the-cause.md) | The audit row may name the cause, the caller may not | Accepted — completes 0041; makes 0030 true on the tool path |
| [0043](0043-the-framework-records-the-failure.md) | The framework records the failure; the project overrides it | Accepted — applies 0042's rule to the HTTP path; extends 0012 |
| [0044](0044-a-collided-field-keeps-its-type.md) | A collided field keeps its type (never `unknown` where a type is provable) | Accepted — narrows 0033's collision rule, keeps its invariant |
| [0045](0045-a-tool-call-runs-in-its-own-context.md) | A tool call runs in its own request context | Accepted — scopes 0012's context; makes 0029's dimensions hold under concurrency |
| [0046](0046-tool-hooks-take-options-objects.md) | Tool hooks take one options object | Accepted — makes future hook fields additive; refines 0041/0042 |
| [0047](0047-one-mcp-schema-validation-profile.md) | One MCP schema validation profile | Accepted — validation and the advertised surface cannot drift |
| [0048](0048-framework-owned-native-mcp-registration.md) | Framework-owned native MCP registration | Superseded by 0057 |
| [0049](0049-stateless-mcp-http-is-the-default.md) | Stateless MCP HTTP is the default | Superseded by 0068 |
| [0050](0050-presentation-schema-is-not-a-parser.md) | The tool presentation schema is not a parser | Accepted — supersedes the executable-schema mechanism of 0031/0033/0034/0044 |
| [0051](0051-signed-webhooks-retain-raw-json.md) | Signed HTTP webhooks retain raw JSON text on demand | Accepted — validated contracts no longer lose HMAC input |
| [0052](0052-typed-json-response-metadata.md) | Typed JSON response metadata | Accepted — HTTP-only dynamic headers plus a declared success status without transferring `Response` ownership |
| [0053](0053-explicit-contract-head.md) | HEAD is an explicit contract operation | Accepted — extends 0038 and 0023 |
| [0054](0054-in-process-tool-invocation.md) | In-process tool calls use the canonical runner | Accepted — extends 0014 and 0045 |
| [0055](0055-runtime-tools-share-one-neutral-operation.md) | Runtime tools share one neutral operation | Accepted — extends 0014, 0045 and 0048 |
| [0056](0056-entity-cache-shapes-are-declared.md) | Entity cache shapes are declared | Accepted — keeps the cache bridge generic and explicit |
| [0057](0057-finite-prepared-mcp-surfaces.md) | Finite prepared MCP surfaces | Accepted — bounded descriptor preparation with fresh request state |
| [0058](0058-zod-first-domain-error-definitions.md) | Zod-first domain error definitions | Extended by 0077 — Accepted — immutable status/schema registry and typed constructors |
| [0059](0059-unified-tool-surface-introspection.md) | Unified tool-surface introspection | Accepted — one mixed contract/runtime collector for mounts and diagnostics |
| [0060](0060-official-starter-composes-next-and-stitchkit.md) | Official starter composes Next.js with a separate Stitchkit backend | Accepted — one production-shaped scaffold without framework-owned frontend infrastructure |
| [0061](0061-independent-starter-release-line.md) | Official starter advances independently from framework HEAD | Accepted — explicit catalog target, lockfile and separate release tags |
| [0062](0062-explicit-tool-exposure-is-a-factory-policy.md) | Explicit tool exposure is an opt-in factory policy | Accepted — refines 0036 without contract-level inheritance |
| [0063](0063-one-http-completion-many-observability-projections.md) | One HTTP completion feeds every observability projection | Accepted — supersedes the HTTP wrapper in 0012; refines 0039 |
| [0064](0064-runtime-tool-factories-validate-context-at-execution.md) | Runtime-tool factories validate context at execution | Accepted — extends 0055 without a parallel runner |
| [0065](0065-flat-collisions-preserve-every-known-kind.md) | Flat collisions preserve every known JSON kind | Accepted — extends 0044 while preserving 0050's presentation boundary |
| [0066](0066-the-starter-template-is-the-development-workspace.md) | The starter template is the development workspace | Accepted — identity clause superseded by 0070 |
| [0067](0067-the-starter-connects-to-external-postgresql.md) | The starter connects to external PostgreSQL | Accepted — one `DATABASE_URL`; infrastructure stays outside generated applications |
| [0068](0068-mcp-v2-is-one-stateless-hard-cut.md) | MCP SDK v2 is one stateless hard cut | Accepted — supersedes 0049; one v2 API and explicit modern policies |
| [0069](0069-realtime-contracts-validate-without-owning-delivery.md) | Realtime contracts validate without owning delivery | Accepted — extends 0008; 0020 remains orthogonal |
| [0070](0070-scaffold-identity-is-derived.md) | Scaffold identity is derived from one config | Accepted — supersedes the identity clause of 0066 |
| [0071](0071-streaming-multipart-uses-a-fetch-clean-parser.md) | Streaming multipart uses a Fetch-clean sequential parser | Accepted — bounded direct-to-receiver delivery without runtime-specific streams |
| [0072](0072-http-authorization-precedes-payload-parsing.md) | HTTP authorization precedes payload parsing | Accepted — supersedes 0004 while retaining flat lifecycle hooks |
| [0073](0073-client-request-options-are-not-callback-context.md) | Client request options are not callback context | Accepted — extends 0005, 0008 and 0025 |
| [0074](0074-server-owned-managed-shutdown.md) | Server-owned managed shutdown | Accepted — extends 0008, 0013 and 0020; its signal clause superseded by 0076 |
| [0075](0075-per-scope-handler-context.md) | Per-scope handler context (`createScopedImplement`) | Accepted — supersedes the deferred scope→context clause of 0024 |
| [0076](0076-explicit-process-signal-binding.md) | Explicit process-signal binding (`bindProcessSignals`) | Accepted — supersedes the signal clause of 0074 |
| [0077](0077-error-definition-carries-its-message.md) | An error definition carries its default message | Accepted — extends 0058 |

**Statuses:** _Accepted_ — in effect · _Superseded_ — replaced by a later ADR,
kept for history · _Rejected_ — considered, deliberately not done.
