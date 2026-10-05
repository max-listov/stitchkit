# Roadmap

Where stitchkit is and where it is going. This is a direction, not a dated
commitment — priorities shift as the framework is proven across more projects.

The *why* behind each item lives in an ADR under
[`docs/decisions/`](./docs/decisions/); the invariants every item answers to and
what stitchkit declines are on one page, [`docs/PRINCIPLES.md`](./docs/PRINCIPLES.md).

## Now — pre-1.0

The core is shipped and hardened through real consumers:

- **Contract** — `defineContract()`, the error model, cursor pagination.
- **HTTP server** — `createServer()` on Bun, `serveNode()` on Node ≥ 22 and the
  Fetch-clean `createHandler()` core; route groups, lifecycle hooks, raw and
  contract-owned binary responses, CORS, trace ids and structured logging.
- **Typed client** — `createClient()` / `createClients()` / `createHttpClient()`.
- **Schemas and discovery** — input/output validation,
  [OpenAPI 3.1 generation](./docs/guide/server.md#openapi) and a typed client
  derived from the same contracts.
- **MCP & agents** — contract tools, framework-owned multimodal native tools,
  stateless HTTP, stdio, MCP Apps resources, portable-schema
  validation and `mountAgent()`.
- **CLI** — contract operations exposed as typed commands, including file and
  wait helpers.
- **Realtime** — `createSocketIOClient()` / `createSocketIOServer()`,
  `createCacheBridge()`.
- **React** — `createCursorQuery()`.
- **Observability** — isolated request/tool contexts, lifecycle and tool hooks,
  audit events, request logging and error attribution.
- **Primitives** — auth hooks, SSE streaming, multipart, rate limiting, cache,
  event bus.
- **Release verification** — lint, types, tests, builds, Node HTTP/Socket.IO
  smoke tests and
  packed minimal/full/Node consumer lanes.

Shipped and **evolving** — released, used, and still finding its shape. Each may
be redefined in a minor, always with a marked breaking change and a migration
section (see [Entrypoints](./docs/guide/getting-started.md#entrypoints)):

- **Agent runtime** — `stitchkit/agent-runtime`: durable run admission with
  idempotency and coalescing, normalized persistence behind one CAS boundary,
  provider-valid history and compaction, prompt and model registries, the
  stream loop, managed-tool fencing, recovery and run observability. The
  isolated OpenRouter adapter lives at `stitchkit/agent-runtime/openrouter`.
- **Application kernel** — `stitchkit/application`: see the section below.
- **Native process and files** — `stitchkit/process` (finite native commands,
  bounded capture, process-group cancellation, process-owner evidence) and
  `stitchkit/files/packaging` (the build-time plugin that carries the native
  addon into a bundle). Both are evolving leaves; see
  [Native IO](./docs/guide/native-io.md).
- **MCP server leaf** — `stitchkit/tools/mcp`: the canonical MCP HTTP and stdio
  server with only Zod and the MCP server SDK as peers.
- **Agent control surfaces** — `stitchkit/agent-runtime/react` and
  `stitchkit/agent-runtime/realtime`: a React subscription to an
  application-owned agent controller and authorized agent control over the
  existing Socket.IO server. Both are experimental, with no committed consumer.
- **Project declaration** — `stitchkit/declaration`: one versioned schema for
  what a repository says about itself — identity, roles, build (including any
  declared data inputs), runtime requirements, release steps and the names of
  the variables a deployment supplies. Its boundary is enforced by shape: there
  is nowhere in it to put a port, a host, an address, a machine path or a
  supervision policy. **Declaring is optional** — a project with no
  `project.json` is complete, and nothing else in the framework reads one.

Until 1.0, a minor release may intentionally break a public API. Every break is
called out first in the changelog with a before → after migration; no shim or
silent compatibility path is retained.

## Shipped and evolving — managed application composition

The additive `stitchkit/application` surface composes process-local resources
without changing the contract and transport core:

- dependency-validated startup, attempted-start rollback and separate
  readiness/health truth;
- admission, drain and reverse-order close under two shared absolute deadlines;
- post-readiness fixed-rate schedules with explicit overlap policy;
- bounded latest-value operational snapshots and anonymous activity projection;
  and
- provider-neutral core plus isolated optional provider adapters, beginning
  with `stitchkit/application/grammy`.

The proof is the deletion of application-owned signal, timer, in-flight-counter
and close-fan-out glue.

Durable mechanics exist where one owner keeps them small, and they stay
mechanics, not a job system (I11):

- **In:** the process lifecycle ledger, the directory inbox
  (`stitchkit/application/directory-inbox`: entries another program drops into
  a directory, delivered at least once), and effect reconciliation in
  `stitchkit/tools` (record the intent before an effect in another system, settle
  an unfinished one only by the recipient's own record, never retry an
  `uncertain` one).
- **Out:** durable job queues and claims, retry and recovery policy,
  cron/timezone policy, provider protocols, process restart, supervision and
  deployment control. The application owns the business transaction and the
  decision to retry.

## Next — toward 1.0

The 1.0 milestone is **API stability**, not new surface. Before it ships:

- **Prove the API across more projects.** Every breaking change between now and
  1.0 must come from real usage, not speculation.
- **Prove the official starter.** Keep the single packed `create-stitchkit`
  application aligned with the already-shipped HTTP, MCP, CLI, realtime and
  React surfaces.
- **Documentation quality.** Keep the guide, API reference, upgrade path and
  generated LLM docs synchronized. A rendered documentation site remains a
  separately scoped idea in
  an open idea, not a commitment.

When the public API has held steady across several consumers, 1.0 locks it
under semantic versioning — breaking changes only on a major bump.

## Out of scope

Deliberate non-goals — considered and declined, so they are not re-proposed. The
standing rules for new work are the *Not in stitchkit* list in
[`PRINCIPLES.md`](./docs/PRINCIPLES.md#not-in-stitchkit):

- **A fullstack framework.** No file-based routing, no server components, no
  bundler. stitchkit is the contract and transport layer; the UI build belongs
  to the app. → [ADR 0010](./docs/decisions/0010-fullstack-rejected.md)
- **A competing WebSocket or hook engine.** Realtime is a thin Socket.IO
  wrapper; the React data layer is `react-query-kit`. → [ADR 0008](./docs/decisions/0008-thin-wrappers.md)
- **A Deno/Cloudflare runtime.** Bun is first-class, Node ≥ 22 is supported
  via `stitchkit/node`. → [ADR 0013](./docs/decisions/0013-runtime-agnostic-core.md)
- **A distributed job or deployment framework.** The application kernel owns
  only one process lifetime. Durable queues, cross-process scheduling, provider
  workflows and supervisor/process placement remain application or deployment
  concerns. → [ADR 0102](./docs/decisions/0102-managed-application-kernel.md)

## Contributing to the roadmap

Open an issue to discuss anything here — see [CONTRIBUTING.md](./CONTRIBUTING.md).
An idea that changes the design ends up as an ADR in
[`docs/decisions/`](./docs/decisions/), which is where this project keeps its
reasoning.
