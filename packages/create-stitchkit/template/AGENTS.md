# Application agent guide

This repository is a generated Stitchkit application. It is not the Stitchkit
framework source repository.

## Architecture

- `packages/shared` owns named Zod schemas, inferred DTO types, HTTP contracts
  and realtime event definitions. It has no database, server or browser imports.
- `packages/db` owns Prisma schema, migrations and the generated client.
- `packages/backend` implements contracts, composes the registered surface and
  owns application policy. Routes remain thin transport boundaries.
- `packages/frontend` owns Next.js pages, typed clients, query/mutation hooks and
  cache reactions.
- `packages/config/src/variables.ts` is the only declaration of an environment
  variable. `server.ts` and `frontend/src/env.ts` are projections of it, and
  the declaration's `env.variables` is derived from it — never restated.
- `project.json` is the only place this project describes itself. It is written
  by machine — the scaffolder stamps the identity, `bun run gen:declaration`
  derives `env.variables` — so the formatter leaves it alone and
  `scripts/declaration.test.ts` is what checks it.
- Four things are generated from it and must not be hand-edited:
  `ecosystem.config.cjs`, `ecosystem.dev.config.cjs`,
  `packages/config/src/app-identity.generated.ts` and the `env.variables` block
  of `project.json`. Run `bun run gen:declaration` after changing a role. It
  holds nothing that differs between two deployments; those are named there by
  variable and supplied by the place.

Dependencies point inward: frontend/backend → shared; backend → db/config.
Shared never imports an application runtime package.

## Required patterns

- Define each runtime DTO as a named Zod schema in `packages/shared/src/schemas`.
- Reference schemas from a separate contract module; never inline `z.object()`
  inside `defineContract`.
- Implement one service method per contract operation and register the service
  once in `packages/backend/src/surface.ts`.
- Use Stitchkit's typed browser client and react-query-kit hooks; do not rebuild
  endpoint URLs, query keys or error envelopes by hand.
- Use Socket.IO through the shared realtime contract and Stitchkit wrappers.
  Authentication, authorization and room membership remain application policy.
- Drive Prisma only through the root `bun run db:*` scripts; the `prisma` CLI
  invoked directly has no datasource URL. Keep `BIND_HOST` at its loopback
  default unless network exposure is an explicit requirement.
- Extend runtime smoke with an explicit typed probe for operations whose handler
  behavior matters. Generic OpenAPI/MCP discovery checks are already derived.

Do not duplicate DTOs, copy Stitchkit internals, add raw routes for operations a
contract can express, or create compatibility aliases. Fix framework gaps in
Stitchkit rather than copying its implementation into this application.

## Workflow

Follow [`docs/ADDING_A_FEATURE.md`](docs/ADDING_A_FEATURE.md) for the complete
vertical path. Before handing work off, run:

```bash
bun run check
bun run test
bun run build
bun run acceptance:local
```

`acceptance:local` is part of the list because `runtime:smoke` and `e2e` check a
running deployment: it creates one of its own — separate PM2 home, ephemeral
ports, and its own database from `ACCEPTANCE_DATABASE_URL` — runs both against
it, and destroys it. The separate database is not tidiness: the gates write, so
one borrowing `DATABASE_URL` writes rows wherever `.env` points. **Never put
`pm2:prod` in this list.** It applies the declared migrations to *your* database
and reloads the running deployment; deploying is its own command, asked for on
purpose, and no gate performs it.

