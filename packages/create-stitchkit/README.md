# create-stitchkit

Create the canonical Stitchkit application:

```bash
bun create stitchkit my-app
cd my-app
# Point DATABASE_URL in .env at your PostgreSQL database.
bun run dev
```

The generated Bun workspace contains a Next.js frontend, a separate Stitchkit
API, Prisma/PostgreSQL, typed shared contracts, Socket.IO, MCP, CLI tools and a
complete production UI system.

To start from a terminal coding agent instead:

```bash
bun create stitchkit my-agent --template agent
cd my-agent
cp .env.example .env
# Set OPENROUTER_API_KEY, then choose a live model in the terminal.
bun run dev
```

This opt-in profile is deliberately smaller. It composes the published headless
harness, Bun SQLite store, OpenRouter adapter, lazy filesystem skills and direct
coding tools behind an OpenTUI shell. Reads/search run directly; writes, edits,
patches and shell calls require a signed durable `Y`/`N` approval. `bun --watch`
restarts source while the ignored `.stitchkit/` directory retains conversation
and recovery state. The bounded startup picker reads current tool-capable models and their context
windows from OpenRouter instead of duplicating provider metadata in environment variables. The
workspace path is a containment boundary, not an OS sandbox.

It uses one conventional `packages/*` namespace: `backend`, `frontend`,
`config`, `db` and `shared`. The destination name becomes the generated slug;
`--display-name` sets the human title. Both are recorded once in
`project.json` — the generated project's **declaration**, the single
machine-readable statement it makes about itself — and drive package, process,
transport, UI and SEO identity.

The default scaffold is domain-free. To add the runnable repository example:

```bash
bun create stitchkit my-app --example repository
```

The optional example uses one configurable GitHub repository persisted through a
server-side PostgreSQL cache, including a Prisma-backed
visibility enum that flows through the shared schema and typed client. `/en/ui`
presents every reusable primitive and composition. Every public page ships with
localized metadata, canonical and language alternatives, sitemap coverage and a
generated Open Graph card.

The included PM2 configs launch Bun and Next entrypoints directly, so package
script wrappers do not hide the supervised processes or distort their metrics.
PostgreSQL is supplied by the application environment through `DATABASE_URL`;
the generated project does not package or start a database runtime.

The generated workspace uses the Stitchkit range declared once in the template
catalog and ships with the exact lockfile validated by this package. Framework
and scaffolder releases are independent: a new Stitchkit version does not move
the starter until that target is deliberately updated and revalidated.
