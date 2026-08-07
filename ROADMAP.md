# Roadmap

Where stitchkit is and where it is going. This is a direction, not a dated
commitment — priorities shift as the framework is proven across more projects.

The *why* behind each item lives in an ADR under
[`docs/decisions/`](./docs/decisions/).

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
  stateless and stateful HTTP modes, stdio, MCP Apps resources, portable-schema
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
  [packed minimal/full/Node consumer lanes](./docs/backlog/done/2026-08-06-the-published-package-is-tested-as-a-consumer-uses-it.md).

Until 1.0, a minor release may intentionally break a public API. Every break is
called out first in the changelog with a before → after migration; no shim or
silent compatibility path is retained.

## Next — toward 1.0

The 1.0 milestone is **API stability**, not new surface. Before it ships:

- **Prove the API across more projects.** Every breaking change between now and
  1.0 must come from real usage, not speculation.
- **More examples.** The bundled `packages/starter` is one app; the goal is a
  small set covering already-shipped MCP, agents and auth flows end to end.
- **Documentation quality.** Keep the guide, API reference, upgrade path and
  generated LLM docs synchronized. A rendered documentation site remains a
  separately scoped idea in
  [`docs/backlog/inbox/2026-05-20-docs-site.md`](./docs/backlog/inbox/2026-05-20-docs-site.md).

When the public API has held steady across several consumers, 1.0 locks it
under semantic versioning — breaking changes only on a major bump.

## Out of scope

Deliberate non-goals — considered and declined, so they are not re-proposed:

- **A fullstack framework.** No file-based routing, no server components, no
  bundler. stitchkit is the contract and transport layer; the UI build belongs
  to the app. → [ADR 0010](./docs/decisions/0010-fullstack-rejected.md)
- **A competing WebSocket or hook engine.** Realtime is a thin Socket.IO
  wrapper; the React data layer is `react-query-kit`. → [ADR 0008](./docs/decisions/0008-thin-wrappers.md)
- **A Deno/Cloudflare runtime.** Bun is first-class, Node ≥ 22 is supported
  via `stitchkit/node`. → [ADR 0013](./docs/decisions/0013-runtime-agnostic-core.md)

## Contributing to the roadmap

Ideas start as a file in [`docs/backlog/inbox/`](./docs/backlog/). Open an issue
to discuss anything here — see [CONTRIBUTING.md](./CONTRIBUTING.md).
