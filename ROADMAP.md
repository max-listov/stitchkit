# Roadmap

Where stitchkit is and where it is going. This is a direction, not a dated
commitment — priorities shift as the framework is proven across more projects.

The *why* behind each item lives in an ADR under
[`docs/DECISIONS.md`](./docs/DECISIONS.md).

## Now — 0.1.x

The core is shipped and stable:

- **Contract** — `defineContract()`, the error model, cursor pagination.
- **HTTP server** — `createServer()` / `createHandler()` on `Bun.serve()`,
  route groups, lifecycle hooks, raw routes, CORS, trace ids.
- **Typed client** — `createClient()` / `createClients()` / `createHttpClient()`.
- **MCP & agents** — `createMcpHandler()` / `mountMcp()`, `mountAgent()`.
- **Realtime** — `createSocketIOClient()` / `createSocketIOServer()`,
  `createCacheBridge()`.
- **React** — `createCursorQuery()`.
- **Primitives** — auth hooks, SSE streaming, multipart, rate limiting, cache,
  event bus.

0.1.x releases are bug fixes and additive, non-breaking changes only.

## Next — toward 1.0

The 1.0 milestone is **API stability**, not new surface. Before it ships:

- **Prove the API across more projects.** Every breaking change between now and
  1.0 must come from real usage, not speculation.
- **OpenAPI 3.1 generation from contracts.** A contract is already a set of Zod
  schemas — an OpenAPI document is almost free. Tracked in
  [`docs/backlog/inbox/2026-05-20-openapi-generation.md`](./docs/backlog/inbox/2026-05-20-openapi-generation.md).
- **More examples.** The bundled `packages/starter` is one app; the goal is a
  small set covering MCP, agents and auth end to end.
- **Documentation.** The guide and API reference under [`docs/`](./docs/README.md)
  grow alongside the code. A rendered documentation site is scoped in
  [`docs/backlog/inbox/2026-05-20-docs-site.md`](./docs/backlog/inbox/2026-05-20-docs-site.md).

When the public API has held steady across several consumers, 1.0 locks it
under semantic versioning — breaking changes only on a major bump.

## Out of scope

Deliberate non-goals — considered and declined, so they are not re-proposed:

- **A fullstack framework.** No file-based routing, no server components, no
  bundler. stitchkit is the contract and transport layer; the UI build belongs
  to the app. → [ADR 0010](./docs/DECISIONS.md#adr-0010)
- **A competing WebSocket or hook engine.** Realtime is a thin Socket.IO
  wrapper; the React data layer is `react-query-kit`. → [ADR 0008](./docs/DECISIONS.md#adr-0008)
- **Node / Deno support.** stitchkit is Bun-only — it builds on `Bun.serve`,
  `bun:test` and Bun APIs with no compatibility shims. → [ADR 0011](./docs/DECISIONS.md#adr-0011)

## Contributing to the roadmap

Ideas start as a file in [`docs/backlog/inbox/`](./docs/backlog/). Open an issue
to discuss anything here — see [CONTRIBUTING.md](./CONTRIBUTING.md).
