# Architecture Decisions

This directory records the **why** behind stitchkit — the decisions that shaped
the framework, including the ones that were tried and reversed.

Each entry is an ADR (Architecture Decision Record): one decision, its context,
the alternatives weighed against it, and the consequences. ADRs are immutable —
when a decision changes, a new ADR supersedes the old one; the old one stays,
marked `Superseded`, so the reasoning is never lost.

These records were consolidated from the project's internal design notes on
2026-05-20; the dates on each ADR are when the decision was effectively made.

## What earns an ADR

An architectural choice between alternatives, with lasting consequences — and
also **a practice or an incident whose lesson outlives the change that taught
it**. This repository keeps no task tracker, so an ADR is the only place a
reader can find out why a rule exists rather than merely that it does. A record
kept for history is not edited when it stops being current; it is superseded by
a later ADR that says so.

A bug fix or a small addition earns a changelog line, not an ADR.

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
| [0070](0070-scaffold-identity-is-derived.md) | Scaffold identity is derived from one config | Accepted — supersedes the identity clause of 0066; the file it names became the project declaration in 0104 |
| [0071](0071-streaming-multipart-uses-a-fetch-clean-parser.md) | Streaming multipart uses a Fetch-clean sequential parser | Accepted — bounded direct-to-receiver delivery without runtime-specific streams |
| [0072](0072-http-authorization-precedes-payload-parsing.md) | HTTP authorization precedes payload parsing | Accepted — supersedes 0004 while retaining flat lifecycle hooks |
| [0073](0073-client-request-options-are-not-callback-context.md) | Client request options are not callback context | Accepted — extends 0005, 0008 and 0025 |
| [0074](0074-server-owned-managed-shutdown.md) | Server-owned managed shutdown | Accepted — extends 0008, 0013 and 0020; its signal clause superseded by 0076 |
| [0075](0075-per-scope-handler-context.md) | Per-scope handler context (`createScopedImplement`) | Accepted — supersedes the deferred scope→context clause of 0024 |
| [0076](0076-explicit-process-signal-binding.md) | Explicit process-signal binding (`bindProcessSignals`) | Accepted — supersedes the signal clause of 0074 |
| [0077](0077-error-definition-carries-its-message.md) | An error definition carries its default message | Accepted — extends 0058 |
| [0078](0078-scope-map-derived-from-the-auth-hook.md) | The scope map is derived from the auth hook | Accepted — extends 0075 |
| [0079](0079-typed-handshake-identity-gate.md) | Typed handshake identity gate | Accepted |
| [0080](0080-mcp-call-metadata-is-typed-context.md) | MCP call metadata is typed context | Accepted — extends 0003, 0045 and 0068 |
| [0081](0081-generic-native-operations-use-managed-definitions.md) | Generic native operations use managed definitions | Accepted — extends 0019, 0055 and 0057 |
| [0082](0082-view-file-has-one-managed-batch-operation.md) | `view_file` has one managed batch operation | Accepted — supersedes the raw-only view-file clause of 0081 |
| [0083](0083-cli-composes-managed-and-native-commands.md) | CLI composes managed and native commands | Accepted — extends 0016 and supersedes the CLI exclusion in 0059 |
| [0084](0084-stdio-signals-are-close-only.md) | Stdio process signals are close-only | Accepted — extends 0076 without fake force semantics |
| [0085](0085-auth-rules-may-contribute-context.md) | Auth rules may contribute typed context | Accepted — extends 0078 |
| [0086](0086-lifecycle-composition-is-explicit.md) | Lifecycle composition is explicit and ordered | Accepted — refines 0072 |
| [0087](0087-surface-conformance-is-a-manifest-plus-probes.md) | Surface conformance is a manifest plus explicit probes | Accepted — extends 0059 |
| [0088](0088-managed-files-bind-one-root.md) | Managed files bind one application-owned root | Accepted — supersedes file-path mechanics of 0019/0081/0082 |
| [0089](0089-async-operations-describe-transport-not-jobs.md) | Async operations describe transport, not jobs | Accepted — extends 0081 |
| [0090](0090-remote-implementation-has-a-peer-free-entrypoint.md) | Remote implementation has a peer-free entrypoint | Accepted — narrows optional-peer ownership |
| [0091](0091-realtime-request-is-a-typed-native-ack.md) | Realtime request is a typed native acknowledgement | Accepted — extends 0008 and 0069 |
| [0092](0092-existing-realtime-transport-binding.md) | Realtime contracts may bind an existing transport | Accepted — extends 0008, 0069 and 0091 |
| [0093](0093-transport-projected-and-realtime-conformance.md) | Surface manifests are transport projections and include realtime | Accepted — extends 0059, 0069 and 0087 |
| [0094](0094-auth-hook-composition-is-owned-and-atomic.md) | Auth hook composition is owned and atomic | Accepted — extends 0085 and 0086 |
| [0095](0095-async-operation-contract-factory-and-adapters.md) | Async-operation contracts have one factory and typed adapters | Accepted — extends 0089 |
| [0096](0096-managed-file-boundary-owns-safe-read-semantics.md) | Managed file boundaries own safe read semantics | Accepted — extends 0088 |
| [0097](0097-request-cancellation-is-an-opt-in-observability-outcome.md) | Request cancellation is an opt-in observability outcome | Accepted — extends 0063 and 0043 |
| [0098](0098-optional-agent-application-runtime.md) | Agent conversations have one optional application runtime | Accepted — extends 0007, 0012, 0013, 0086, 0087 and narrows 0089 |
| [0099](0099-starter-head-skips-require-versioned-review.md) | Starter HEAD skips require an exact-version deferred review | Accepted — refines 0061 |
| [0100](0100-agent-store-reducer-owns-transitions.md) | The agent store reducer owns runtime transitions | Accepted — refines the persistence boundary of 0098 |
| [0101](0101-normalized-agent-runtime-persistence.md) | Agent runtime persistence is bounded and normalized | Accepted — replaces the aggregate storage shape of 0100 while retaining reducer ownership |
| [0102](0102-managed-application-kernel.md) | Application composition is process-local and provider-neutral | Accepted — extends 0008, 0012, 0013, 0076, 0089 and 0098 |
| [0103](0103-entrypoints-declare-their-maturity.md) | Every entrypoint declares how settled it is | Accepted — scopes 0098 and 0102 |
| [0104](0104-the-project-declaration-ships-from-the-framework.md) | The project declaration ships from the framework | Accepted — extends 0002 and 0103, and replaces the `app.config.json` of 0070 |
| [0105](0105-the-error-code-map-is-partial-and-the-registry-is-complete.md) | The error-code map is partial, and the registry is complete | Accepted — supersedes the exhaustiveness clause of 0026 |
| [0106](0106-a-refused-frame-answers-its-sender.md) | A refused realtime frame answers its sender | Accepted — refines the realtime rejection surface of 0008 and keeps identity out of the core per 0002 |
| [0107](0107-a-rollback-spends-a-declared-budget.md) | A rollback spends a declared budget, and the budget is a bound | Accepted — completes the deadline model of 0102 for the rollback path |
| [0108](0108-what-a-stopped-run-said-is-a-declared-policy.md) | What a stopped run already said is a declared policy, not a default | Accepted — the runtime cannot observe delivery, so the application declares it |
| [0109](0109-a-spend-figure-never-claims-a-provenance-it-does-not-have.md) | A spend figure never claims a provenance it does not have | Accepted — keeps billing out of the core per 0002 while making what the core reports true |
| [0110](0110-a-reconciled-cost-belongs-to-the-application.md) | A reconciled cost belongs to the application, not to the core | Accepted — applies 0002 to the ledger question 0109 left open |
| [0111](0111-the-driver-is-the-extension-point-and-the-runtime-is-not-stable-yet.md) | The driver is the extension point, and the agent runtime is not stable yet | Accepted — settles the promotion question 0103 opened, with named conditions |
| [0112](0112-a-run-is-read-without-its-conversation.md) | A run is read without its conversation, and history stays whole | Accepted — applies the bounded-read reasoning of 0101 to the conversation, and names the limit it does not lift |
| [0113](0113-an-absorbed-input-is-committed-with-the-answer.md) | An absorbed input is committed with the answer, never before it | Accepted — reinstates the `inject` policy withdrawn in 0.65.0, with the ordering that made it wrong corrected |
| [0114](0114-the-graph-carries-values-not-only-order.md) | The resource graph carries values, not only order | Accepted — `dependsOn` expressed half the dependency; the other half lived in a module-local with an unreachable guard |
| [0115](0115-a-managed-server-resource-owns-when-the-server-exists.md) | A managed server resource owns when the server exists | Accepted — a thunk is created in `start`, because calling it on the way down produced a healthy application with nothing listening |
| [0116](0116-a-selected-unix-transport-never-becomes-tcp.md) | A selected Unix transport never becomes TCP | Accepted — explicit owned Bun/Node transport with bounded work and delivery state |
| [0117](0117-contract-streams-own-validation-and-wire-termination.md) | Contract streams own validation and wire termination | Accepted — schema-derived bounded frames and explicit completion on the existing HTTP stream path |
| [0118](0118-operation-capacity-belongs-to-the-underlying-work.md) | Operation capacity belongs to the underlying work | Accepted — caller deadlines cannot release capacity still consumed by non-cooperative work |
| [0119](0119-delivery-policy-is-ordered-or-replaceable.md) | Delivery policy is ordered or replaceable | Accepted — finite ordered retention and explicit latest-value coalescing are different contracts |
| [0120](0120-published-declarations-follow-esm-resolution.md) | Published declarations follow ESM resolution | Accepted — explicit JavaScript targets and a peer-free packed NodeNext root |
| [0121](0121-managed-server-factories-receive-resource-context.md) | Managed server factories receive resource context | Accepted — declared values and the startup signal reach server construction without an outer handoff |
| [0122](0122-optional-peer-surfaces-are-proven-from-artifacts.md) | Optional-peer surfaces are proven from artifacts | Accepted — peer-free invocation and warning-free injected Socket.IO loading are packed-consumer guarantees |
| [0123](0123-agent-terminal-output-and-tool-rounds.md) | Terminal output is accepted before commit and tool rounds keep causal order | Accepted — protocol policy owns completion validity; projection owns persisted execution order |
| [0124](0124-entity-cache-membership-and-total-policy.md) | Entity cache membership and total deltas are declared per query | Accepted — filtered membership and pagination evidence are explicit without a consumer mutation engine |
| [0125](0125-streaming-bodies-bound-retained-bytes-not-lifetime-traffic.md) | Streaming bodies bound retained bytes, not lifetime traffic | Accepted — unary totals remain finite while an explicit pull-driven stream has no cumulative lifetime cap |
| [0126](0126-schema-owned-stream-frames-end-at-the-terminal-item.md) | Schema-owned stream frames end at the terminal item | Accepted — opt-in unwrapped NDJSON retains bounded parsing and completion proof without a second envelope |
| [0127](0127-interrupt-priority-is-durable-execution-order.md) | Interrupt priority is durable execution order | Accepted — urgent input runs next without deleting ordinary queued work, and recovery preserves the same order |
| [0128](0128-sqlite-runtime-store-is-a-leaf-adapter.md) | SQLite runtime storage is a leaf adapter | Accepted — one normalized mapping behind isolated Bun and Node built-in bindings |
| [0129](0129-deferred-agent-tools-are-durable-direct-activation.md) | Deferred Agent tools are durable direct activation | Accepted — bounded search receipts activate real mounted tools per durable run without a gateway |
| [0130](0130-headless-harness-composes-the-agent-runtime.md) | A headless harness composes the Agent runtime | Accepted — publishes resource-aware composition and isolated direct coding tools without owning supervision or a second loop |
| [0131](0131-harness-leaves-preserve-canonical-agent-identity.md) | Harness leaves preserve canonical Agent identity | Accepted — lazy resources, signed approval continuations, reconnectable views and coding artifacts retain direct operations and one history |
| [0132](0132-agent-tui-is-an-explicit-starter-profile.md) | Agent TUI is an explicit starter profile | Superseded by 0133 — the explicit profile remains, but its reusable product mechanics moved out of copied starter source |
| [0133](0133-agent-tui-is-an-optional-package-over-one-controller.md) | Agent TUI is an optional package over one controller | Accepted — reusable terminal mechanics stay outside core and local attachment enters the host's only controller |
| [0134](0134-diagnostic-journal-is-bounded-local-evidence.md) | Diagnostic journal is bounded local evidence | Accepted — one finite FIFO local writer without durable-delivery claims or a second observability framework |
| [0135](0135-contained-files-use-native-darwin-capabilities.md) | Contained files use native Darwin directory capabilities | Accepted — packaged openat leaf, one JS policy and real macOS artifact proof |
| [0136](0136-one-exact-tree-drives-a-package-aware-release-train.md) | One exact tree drives a package-aware release train | Accepted — one manifest, one exact-SHA CI and target-aware evidence lanes for every selected package |
| [0137](0137-live-state-opens-one-continuous-source-generation.md) | Live state opens one continuous source generation | Accepted — browser-safe bounded snapshot/event synchronization without owning transport retry, cursors or storage |
| [0138](0138-conversation-purge-reserves-identity-atomically.md) | Conversation purge reserves identity atomically | Accepted — optional atomic payload deletion with active-run refusal and permanent ID fencing |
| [0139](0139-a-coding-tool-refusal-is-something-a-model-can-act-on.md) | A coding-tool refusal is something a model can act on | Accepted — ordinary outcomes become typed; host causes stay scrubbed, and `edit_file` replaces `apply_patch` |
| [0140](0140-the-runtime-tells-a-step-how-full-the-context-is.md) | The runtime tells a step how full the context is | Accepted — the last step's prompt size with provenance, never the cumulative total |
| [0141](0141-a-provider-refusal-is-classified-not-phrased.md) | A provider refusal is classified, not phrased | Accepted — the core names the failure and its evidence; the wording stays with the application |
| [0142](0142-a-primitive-leaves-the-runtime-when-nothing-in-it-needs-the-runtime.md) | A primitive leaves the runtime when nothing in it needs the runtime | Accepted — three conditions decide what is published, and two named refusals prove they can fail |
| [0143](0143-telegram-platform-primitives-need-no-bot-library.md) | Telegram platform primitives need no bot library | Accepted — `stitchkit/telegram` holds Mini App verification and Bot API failure classification, peer-free and server-only |
| [0144](0144-generic-application-primitives-declare-facts-not-infrastructure.md) | Generic application primitives declare facts, not infrastructure | Accepted — one browser-safe declaration leaf with application-owned persistence and execution |
| [0145](0145-a-reclaimed-lock-is-proven-never-assumed.md) | A reclaimed lock is proven, never assumed | Accepted — liveness proof reclaims an abandoned journal lock; no age or heartbeat variant is offered |
| [0146](0146-a-scanning-gate-asserts-what-it-scanned.md) | A scanning gate asserts what it scanned | Accepted — a test that discovers its inputs states the size of the set before calling it clean |
| [0147](0147-machine-identity-not-host-name-decides-whose-pid-this-is.md) | Machine identity, not host name, decides whose pid this is | Accepted — refines 0145: a renamed machine reclaims its own lock, and a refusal says which refusal it is |
| [0148](0148-a-refusal-that-never-left-the-process-is-a-validation-error.md) | A refusal that never left the process is a `VALIDATION_ERROR` with status 0 | Accepted — one shape and one timing for every local refusal, and argument validation stays on the server |

**Statuses:** _Accepted_ / _Active_ — in effect (the two are the same thing;
`active` is what the later files happened to use) · _Superseded_ — replaced by a
later ADR, kept for history · _Rejected_ — considered, deliberately not done.
