# Changelog

All notable changes to **create-stitchkit** are documented here. The scaffolder
has its own version and release line; the Stitchkit range tested by its template
is declared in the template root catalog.

## [Unreleased]

### ⚠️ Breaking changes

- **Starter-owned LAN HTTPS is removed.** Generated applications no longer ship
  `dev:lan`, certificate generation, onboarding routes or `DEV_HTTPS_*` settings.
  Applications that need a trusted device-testing origin should own certificate
  creation and pass TLS files through Stitchkit's documented `bun.tls` boundary.

### Changed

- **Scaffold identity is rendered from one config.** The generated
  `app.config.json` drives runtime identity and database naming; only the root
  package manifest is structurally projected, with no global text search or
  inert lockfile rewrite.
- **Development is explicit and portable.** `bun run dev` validates PM2 and
  external PostgreSQL requirements before side effects. The removed LAN HTTPS
  mode is documented as application-owned framework configuration instead of a
  starter subsystem.

### Fixed

- **Fresh clones bootstrap in the right order.** The starter materializes its
  local environment before Prisma/type gates and reports a missing or placeholder
  `DATABASE_URL` directly.
- **Every executable source is checked.** Root TypeScript coverage includes
  scripts and browser E2E; the authored-source guard scans CJS and reports the
  real offending line.
- **Runtime and browser gates prove the backend.** Surface conformance compares
  HTTP/OpenAPI, MCP, Agent and CLI identities and schemas; browser E2E performs
  a contract call and realtime cache update.
- **Repository example uses the canonical realtime contract.** Shared Zod event
  definitions drive backend emission, browser subscriptions and cache bridging
  without handwritten event maps.

### Removed

- **Starter-owned LAN HTTPS.** `dev:lan`, certificate generation, onboarding
  transport and `DEV_HTTPS_*` settings are gone; trusted local TLS remains an
  application-owned adapter choice documented by Stitchkit.

## [0.2.0] — 2026-08-10

### ⚠️ Breaking changes

- **The default scaffold is now domain-free.** The repository example is explicit
  so a new product does not need to dismantle demo code.
  `bun create stitchkit my-app` now creates the blank base; use
  `bun create stitchkit my-app --example repository` for the previous runnable example.

### Added

- **One generated application identity.** A validated `app.config.json` now drives
  package, PM2, MCP, OpenAPI, CLI, SEO and theme identity from one edit point.
- **Contract-derived surface conformance.** Generated runtime smoke compares the
  registered HTTP and tool manifest with live OpenAPI and MCP discovery, while
  explicit typed probes remain application-owned.
- **Optional trusted LAN HTTPS.** `bun run dev:lan` uses mkcert, exact-origin CORS
  and a development-only onboarding route for secure-context testing on physical
  devices without changing ordinary development or production behavior.
- **Agent-first extension guide.** Generated applications include an application-
  scoped `AGENTS.md` and a complete schema-to-runtime feature workflow in
  `docs/ADDING_A_FEATURE.md`.

## [0.1.1] — 2026-08-10

### Changed

- **Starter MCP uses Stitchkit 0.44 and the split MCP TypeScript SDK v2.** The
  generated backend mounts the framework-owned HTTP route, closes its handler
  during graceful shutdown and validates the modern protocol with the v2 client.

## [0.1.0] — 2026-08-08

### Added

- **Production-shaped official starter.** `bun create stitchkit my-app`
  generates a Bun workspace with a separate Next.js frontend and Stitchkit API,
  Prisma/PostgreSQL, shared contracts, typed HTTP and React Query clients,
  Socket.IO cache updates, OpenAPI, MCP, CLI, a production-shaped reference app and a
  complete `/ui` component catalogue.
- **Complete starter SEO surface.** A typed locale-aware page registry now drives
  unique page metadata, canonical and language alternatives, Open Graph and
  Twitter cards, sitemap entries and visible catalogue headings.
- **Direct PM2 entrypoints.** Development and production configs supervise Bun
  and Next entrypoints without package-script wrappers.
- **External PostgreSQL boundary.** Generated applications own Prisma schemas
  and migrations but connect to environment-provided PostgreSQL exclusively
  through `DATABASE_URL`; they do not package or start a database runtime.
- **One runnable canonical template.** Starter development now runs directly
  from `packages/create-stitchkit/template` with Bun/Next HMR; generated
  consumers exist only as ephemeral release-lane fixtures.
- **Fleet-shaped workspace layout.** Backend, frontend, config, database and
  shared code live together under one `packages/*` namespace.
- **Self-contained consumer gates.** A fresh scaffold generates its Prisma
  client before typechecking, remains lint-clean after a Next build and excludes
  runtime test artifacts from the published tarball.
- **Canonical status palette.** Success and destructive states use the source
  UI system hues in both themes with accessible foreground contrast.
- **Compact reference surface.** The starter home now fits one desktop viewport
  and demonstrates one PostgreSQL-backed repository query, one refresh mutation,
  cache invalidation and realtime propagation without shipping a demo CRUD domain.
- **Removable component catalogue.** Every catalogue-only screen and composition
  lives under the `/ui` route directory, while reusable primitives stay in
  `components/ui`; its desktop navigation is a compact floating palette.
- **Generated Next.js declarations stay generated.** `next-env.d.ts` is ignored
  and `next typegen` runs before standalone TypeScript checks, preventing dev/build churn.
- **Independent compatibility target.** The committed template catalog and
  lockfile keep generated projects on the last explicitly validated Stitchkit
  range until a separate starter release advances it.
