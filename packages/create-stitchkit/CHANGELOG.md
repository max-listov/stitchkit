# Changelog

All notable changes to **create-stitchkit** are documented here. The scaffolder
has its own version and release line; the Stitchkit range tested by its template
is declared in the template root catalog.

A release that changes the generated project in a way an existing project must
follow leads its entry with a **`### ⚠️ Breaking changes`** section. What else
has to happen — including the steps that touch a running machine — is in
[`UPGRADING.md`](./UPGRADING.md), because a changelog entry carrying an operator
step is overwritten by the next release.

## [Unreleased]

### Added

- **An explicit Agent template opens a durable OpenRouter coding session in the terminal.**
  `bun create stitchkit my-agent --template agent` generates an OpenTUI host over the published
  headless harness, Bun SQLite storage, lazy skills, direct coding tools, signed approvals and
  recovery. The default production application and its repository overlay are unchanged. The
  Agent development source follows framework HEAD locally, while generated projects receive the
  application starter's one canonical Stitchkit catalog target. Startup requires only an API key:
  a bounded picker reads the current popular tool-capable models and their provider-owned context
  windows directly from OpenRouter. → ADR 0132.
- **The Agent template now composes the official terminal package instead of copying a product
  shell.** `stitchkit.agent.ts` is the editable typed entrypoint; `/model`, durable sessions,
  approvals, scrolling and local `send`/`interrupt` attachment come from `stitchkit-tui`. The
  generated manifest receives portable catalog dependencies while the repository fixture tests
  both packages from source. → ADR 0133.

## [0.4.3] — 2026-08-28

### Fixed

- **Fresh projects use the current published Stitchkit line.** The template's
  single catalog target is `^0.68.6`, and its frozen lockfile resolves exactly
  `0.68.6`. A generated project therefore receives the current contract,
  application and agent-runtime compatibility line instead of remaining below
  `0.61.0` under pre-1.0 caret semantics.
- **The repository variant carries its optional realtime client into browser
  bundles.** Its `createRealtimeClient` composition supplies a literal
  `socket.io-client` loader while preserving the framework target as the
  template's single source of truth, so a packed scaffold resolves the optional
  peer without adding a second framework range.

## [0.4.2] — 2026-08-25

### Fixed

- **A freshly scaffolded project resolves the framework release that exists.**
  The template ships a lockfile so a scaffold is reproducible, and that lockfile
  still pinned the previous Stitchkit patch — so `create-stitchkit` published
  minutes after a framework release produced a project on the older one, inside
  a range that already allowed the newer. The range and the lock move together
  now: `catalog.stitchkit` targets `^0.60.1` and the lockfile resolves it, which
  is also what the packed target lane then tests against.

## [0.4.1] — 2026-08-25

### Fixed

- **The `Gates` list can be run top to bottom, and it never deploys.** It
  presented five commands in a row, two of which check a *running* deployment —
  with nothing in the list that starts one, so on a fresh project `bun run
  runtime:smoke` failed with a connection reset from inside a check. The answer
  is not a deploy command: `bun run pm2:prod` applies the declared migrations
  and reloads the PM2 daemon the developer is running, so a gate list carrying
  it quietly means "deploy". The runtime gates now run under `bun run
  acceptance:local`, which creates a deployment of its own — separate
  `PM2_HOME`, ephemeral ports, its own public-host allowlist, its own
  database — and destroys it by naming the declared roles. Neither guide says
  `pm2 delete all` any more: it empties whichever daemon it is pointed at,
  including applications that have nothing to do with the project.
- **The acceptance gate writes only to a database of its own.** It inherited
  `DATABASE_URL`, and the runtime gates write — the repository example's smoke
  posts `/api/repository/refresh` twice, which upserts. So a command a developer
  is told to run before handing work off wrote rows into whatever `.env` named.
  It runs against `ACCEPTANCE_DATABASE_URL`, applies the declared migrations
  there, and refuses to start when that variable is unset or reuses the
  deployment's database **name** — with the line to paste in the refusal. The
  name alone decides, because a hostname is not proof of a different server:
  `localhost` and `127.0.0.1` are one, and so are two DNS names for the same
  PostgreSQL. The deployment's URL is not in the harness's child environment at
  all.
- **A release will not start an artifact that is not this source's.**
  `assertBuildArtifacts()` checked that the declared paths exist, and existence
  is not freshness: `pm2:prod` run without a build applied this source's
  migrations and started the previous source's `dist` and `.next`, moving the
  schema ahead of the code in the one direction a code rollback does not undo.
  `bun run build` now leaves a digest of the source it read, and the release
  refuses when the tree no longer hashes to it — a digest rather than a
  timestamp, because a checkout rewrites every mtime and a formatter rewrites
  some for no change at all. Everything is source unless something names it
  otherwise, and the something is the **declaration**: the digest skips
  `build.artifacts`, `node_modules`/`.git`, and runtime state. It no longer
  skips by kind — every `.md`, every test file, every directory called
  `generated` — because a project that imports MDX or keeps checked-in source in
  a directory of that name would have changed its content, kept its digest, and
  been told a stale artifact was current. `.env` stays out on purpose: a binding
  is not an input to this build, and hashing it would refuse a correct artifact
  whenever a deployment edited its own environment.
- **The shutdown budget is an upper bound again.** `terminationBudgetMs` adds a
  fixed cleanup allowance to the drain floor and refuses a supervision policy
  that allows less — but the closes that run after the drain (the MCP session,
  the database pool) had no deadline of their own, so a hung close ran past the
  very kill timeout the budget had approved and turned an orderly shutdown into
  the SIGKILL that runs no cleanup at all. The role's cleanup now shares one
  bounded budget with the generator, from one constant both read, and names
  whatever it stopped waiting for — and then **ends the process**. Setting
  `process.exitCode` only decides the code a process reports when it exits, and
  a step that ran out of time is usually still holding the handle that stops it
  from exiting; a close that *threw* is reported with its cause and is no longer
  counted as a clean shutdown. The shared deadline is measured with
  `performance.now()` and the clock can no longer be injected: a wall clock
  stepped backwards widens the very upper bound the supervisor's kill timeout
  was derived from, and a frozen injected clock hands every step a full budget.
- **The project declaration stays out of the browser bundle.**
  `lib/seo/pages.ts` imported `appDeclaration` for one field, and a client
  component imports that module — so role commands, working directories,
  artifact and migration paths and every environment variable name travelled
  into the client graph along with the Zod parser. It reads `appIdentity` now,
  and a test walks every `'use client'` graph and fails if one reaches the
  declaration — by resolving each specifier to a file rather than matching a
  string, so a barrel re-export, a relative path into the config package and a
  double-quoted import are all caught.
- **A duplicated host is one address.** The portability check counted the
  entries of `PUBLIC_WEB_HOSTS` without deduplicating them, so the same host
  written twice passed as two addresses and the proof compared the deployment
  with itself.
- **Every dial in the runtime smoke is bounded.** An endpoint that accepts the
  connection and never answers used to hang the gate with no output and no
  deadline instead of failing it.
- **A build output cannot be published inside the template.** What the scaffolder
  copies and what npm publishes were two lists that had to agree, and only one of
  them was consulted when a name was excluded. The exclusions are data now, and a
  test fails until the package manifest carries the same negation.
- **A role bound to an IPv6 address gets a readiness URL that parses.**
  `BIND_HOST=::1` produced `http://::1:3211/health`, which is not an address
  with a port and which `fetch` refuses — so the wait failed on the spelling
  rather than on the role. The literal is bracketed.
- **`bun run dev` and `bun run pm2:prod` report the roles as running only once
  they answer.** A supervisor returns at the spawn, seconds before a role
  listens, so both printed their address at a moment when nothing was there and
  every command after them raced the application they had just started. Both now
  wait on each role's declared `readinessPath`.
- **`runtime:smoke` asks the deployment on the addresses it claims.** The
  portability check carried two fixture hosts of its own, so it only ever passed
  where somebody had put those exact names into `PUBLIC_WEB_HOSTS` — which only
  the packed lane had. Everyone else got a bare 500 from a policy working as
  designed. It now reads `PUBLIC_WEB_HOSTS`, and a deployment with too few
  addresses to compare is told which line to add instead of being refused a
  request.
- **A closed deployment is diagnosed, not reset.** `runtime:smoke` says what is
  not listening and which command starts it, before the first check runs.
- **The theme value the toaster reads narrows again.** `@wrksz/themes` 1.2
  changed `useThemeValue`'s type parameter to describe the map rather than the
  value, and it now infers `const` — so naming the value union at the call site
  widened the result to every member of `string` and the generated project
  stopped type-checking. The call site lets inference do it.
- **A green `runtime:smoke` prints one line.** The MCP surface check asked the
  server to list tools even when it advertised no tool capability, which made
  the vendor client log a debug warning on every successful run. It reads the
  advertised capability instead.

### Changed

- **Every dependency of the generated project is on its latest release.**
  Next 16.3.2, `next-intl` 4.13.7, `@tanstack/react-query` 5.102.3,
  `@tanstack/react-table` 9.1.2, `framer-motion` 13.1.1, `@wrksz/themes` 1.2.0,
  `shiki` 4.4.3, `sonner` 2.0.8, `ai` 7.0.78, `pg` 8.23.0, Playwright 1.62.1,
  Biome 2.5.10 and the `@types/*` that go with them. No major crossed; the
  Stitchkit range is unchanged and still declared once, in the catalog.
- **The generated project imports the declaration schema instead of mirroring
  it.** `packages/config/src/declaration.ts` now reads
  `parseProjectDeclaration` from `stitchkit/declaration`, and the 611-line
  generated copy — `packages/config/src/project-declaration.generated.ts` — is
  gone with the script that maintained it. The copy existed only because the
  entrypoint was not on npm yet; the template's catalog targets `^0.60.0`,
  which publishes it, so "one schema, three readers" is now literally true.
  Adopting it is one import and one deletion — see
  [`UPGRADING.md`](./UPGRADING.md).
- **`scripts/local-env.ts` reads the identity module, not the declaration.** It
  needs one slug, and a project scaffolded with `--no-install` renders its
  `.env` before anything is installed — a script that reaches for the
  framework's schema to read a name cannot run in that window.

## [0.4.0] — 2026-08-25

### ⚠️ Breaking changes

- **The repository example's browser talks to its OWN origin by default.** The
  example is what gets copied, and it was demonstrating the hard case: the
  browser dialled the API role directly, so the address had to arrive from the
  server at runtime, the API client could not exist until it did, and every call
  site paid for that with a lazy accessor — `repositoryApi().read()` — plus a
  runtime error when something rendered outside `<Providers>`. Somebody copying
  it inherited that whether or not they were cross-origin at all. The body of
  the example is now the default shape: a same-origin `/api/…` path forwarded by
  the web role, and a client that is a module constant.
  `// before: repositoryApi().read()` → `// after: repositoryApi.read()`
  The cross-origin form is not lost — it moved to a named file,
  `packages/frontend/src/lib/api/cross-origin.ts`, with what it costs written
  next to it, and switching to it is one import in `queries.ts`.
- **`PUBLIC_REALTIME_ORIGIN` — the socket's address has a name of its own.**
  `PUBLIC_API_ORIGIN` used to carry both questions and answer only one: it read
  as a mode switch while in fact nothing but the realtime socket looked at it.
  The two are genuinely different — HTTP can be forwarded by the web role, and a
  WebSocket upgrade cannot survive a route handler — so a deployment can be
  same-origin for HTTP and still have to name the socket's origin. Both are
  optional; a deployment behind one routing layer sets neither.
  `// before: PUBLIC_API_ORIGIN=https://api.example  # …which only the socket read` →
  `// after:  PUBLIC_REALTIME_ORIGIN=https://api.example`
- **`app.config.json` is now `project.json` — the project *declaration*.** It no
  longer describes only identity: it states what this repository is, the roles it
  runs, what it builds, what it needs before it starts, the release steps that
  must happen once, and the environment variables a deployment must supply.
  Identity moved under an `identity` key and the file gained a `schemaVersion`,
  so a reader that does not understand the format refuses the project instead of
  interpreting it partially.
  `// before: import { appIdentity } from '@app/config/identity'; appIdentity.name` →
  `// after:  import { appDeclaration } from '@app/config/declaration'; appDeclaration.identity.name`

  A client component imports `@app/config/app-identity` instead — a generated
  module carrying identity alone. Importing the whole declaration from the
  browser would ship role commands, working directories, build artifact paths and
  the migration lockfile in the bundle.
  `// before: import { appIdentity } from '@app/config/identity'  // in a 'use client' file` →
  `// after:  import { appIdentity } from '@app/config/app-identity'`

  The rule the file exists to hold: **it must be complete with no machine in
  existence.** Ports, hosts, addresses, machine paths, routing shape and
  supervision policy are named there by variable and never by value — and the
  schema refuses them by shape rather than by review.

- **The SEO helpers are async, and `siteOrigin` is gone.** They read the public
  origin from the request instead of a build-time constant, so they cannot be
  constants themselves. A page that calls them must await them — and TypeScript
  will *not* catch it inside an inferred object literal, where a `Promise`
  silently serialises as `{}`.
  `// before: const url = absoluteSiteUrl('/en'); export const siteOrigin` →
  `// after:  const url = await absoluteSiteUrl('/en')  // and the component becomes async`
  `// before: createPageMetadata('home', locale)` →
  `// after:  await createPageMetadata('home', locale)`

- **A forwarded host must be claimed before it is believed.** The public origin
  comes from the request, which makes one artifact serve many addresses — and
  would let any caller choose the canonical URL, the sitemap and the OG metadata
  if it were trusted blindly. Set `PUBLIC_WEB_ORIGIN` for a single address, or
  `PUBLIC_WEB_HOSTS` for several; a host outside them is refused. `x-forwarded-proto`
  is narrowed to `http` or `https`.
  `// before: (nothing — any x-forwarded-host was honoured)` →
  `// after:  PUBLIC_WEB_HOSTS=app.example,www.app.example`

- **Environment variables are declared once, and the declaration lists them as
  `env.variables`.** The server schema, the frontend schema and the tooling
  schema were three overlapping copies that had already diverged.
  `packages/config/src/variables.ts` is now the single declaration; `server.ts`
  and `frontend/src/env.ts` are projections of it, and the declaration's list is
  *derived* from it rather than restated. An overlay may now **tighten** a
  variable, not only add one — the repository example requires `INTERNAL_API_URL`,
  `PUBLIC_API_ORIGIN` and `CORS_ORIGIN` because its frontend dereferences them on
  every render.
  `// before: z.url() repeated in three files; env.required with required:false entries` →
  `// after:  applicationVariables.INTERNAL_API_URL, referenced; env.variables`

- **`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WEB_URL` are gone.** Anything prefixed
  `NEXT_PUBLIC_` is substituted at BUILD time, so declaring one froze a value of
  the place into the artifact: the built `robots.txt` and `sitemap.xml` carried
  one origin inside their bytes, and the server chunk carried
  `NEXT_PUBLIC_API_URL:"http://…"` as a literal. One build could not serve a
  second address.
  `// before: NEXT_PUBLIC_WEB_URL=https://app.example  → baked at build` →
  `// after:  no variable; the origin is read from the request`
  **Cost, stated plainly:** `/robots.txt`, `/sitemap.xml` and — because the root
  layout's `generateMetadata` reads the request — the whole `[locale]` segment
  are no longer prerendered as static content. Setting `PUBLIC_WEB_ORIGIN`
  short-circuits the request read and restores static rendering for a deployment
  that serves exactly one address. Answers are built once per address, not once
  per request: `cacheByOrigin` memoises them behind a bounded LRU so a forged
  `Host` cannot grow the cache.

- **`CORS_ORIGIN` is optional.** A frontend that reaches the API through its own
  routing layer makes same-origin requests, and requiring an origin there was
  requiring knowledge of the place. Set it only for a genuinely cross-origin
  browser.
  `// before: CORS_ORIGIN=https://app.example  # required` →
  `// after:  unset unless the browser genuinely lives elsewhere`

- **The smoke and e2e addresses are `SMOKE_API_ORIGIN` and `SMOKE_WEB_ORIGIN`.**
  They are legitimately bound to a place — they name the deployment a check dials —
  but must not carry a prefix that makes the build substitute them.
  `// before: NEXT_PUBLIC_API_URL=http://127.0.0.1:3211` →
  `// after:  SMOKE_API_ORIGIN=http://127.0.0.1:3211`

- **Each role is started by its own PROCESS, in its own directory, and PM2
  process names follow the declared role names.** A role's command is `executable`
  plus `args` in the declaration — argv, never a shell string — and the
  supervision files are rendered from it.
  `// before: <slug>-backend, <slug>-frontend` → `// after: <slug>-api, <slug>-web`
  **Before your first `pm2:prod` on the new files**, remove the old processes, or
  `startOrReload` will start the new pair beside them and both will fight for the
  same ports under `autorestart`:
  ```bash
  pm2 delete <slug>-backend <slug>-frontend <slug>-backend-dev <slug>-frontend-dev
  ```

- **The web role reads its bindings itself.** The supervisor no longer builds an
  argv for it; injecting `WEB_PORT` is now sufficient, where before a deployment
  that set it and stopped there got a web role on the wrong port, silently. There
  is no default port in the repository any more — a missing variable fails by
  name.
  `// before: "start": "next start --port ${WEB_PORT:-3210}"` →
  `// after:  "start": "bun scripts/serve.ts production"`

### Fixed

- **A supervised backend now actually drains.** The supervision files started the
  role through a script runner, so the stop signal arrived twice — once from PM2,
  once forwarded by the launcher — and a shutdown chain treats the second signal
  as "force it now". Measured on a real PM2 stop: a declared 15 s grace period
  ended after **1.3 ms** with `outcome: "forced"`, `reason: "signal"`, and the
  only visible trace was a non-zero exit code. The supervisor now execs the role
  itself, and the same stop reports `outcome: "clean"` with exit 0.
  `// before: script: 'bun', args: ['run', 'start']  // an intermediate shape, never released` →
  `// after:  script: 'bun', args: ['dist/index.js']`
  A generated project at the previous release ran `script: 'dist/index.js'` with
  `interpreter: 'bun'`, which had the same property; the defect it *did* ship is
  the timeout mismatch below.
- **Supervision no longer kills the backend mid-shutdown.** The application asked
  for a 30 s drain while PM2 sent `SIGKILL` after `kill_timeout: 15000` in
  production and 10000 in development — so a drain longer than the supervisor's
  patience never finished, every time. The check now covers the **whole**
  termination budget rather than the drain alone: drain floor, plus the force
  window that follows it, plus cleanup. Comparing against the floor alone let
  15 s + 5 s meet a 20 s kill timeout exactly, with no margin at all.
- **The backend says how its shutdown ended.** `onComplete` logs the outcome, the
  reason, the duration and how many requests completed or were aborted. Without
  it an operator saw a process that vanished and an exit code, and could not tell
  a clean drain from one that was cut short — which is exactly how the defect
  above stayed invisible.
- **A requested stop of the web role reports success.** Next exits `130` on
  `SIGINT`; the role passed that upward, so every ordinary supervised stop looked
  like a failure. A stop the role was asked to perform now exits `0`, while a code
  from any other cause is still passed on unchanged.
- **A deployment's environment is no longer overruled by a file.** The production
  supervision file loaded `.env` with `override: true`, so a value injected into
  the process lost to a value in the repository. Bindings come from the place; the
  file fills gaps.
- **Release steps come from the declaration.** `pm2:prod` hand-carried
  `db:deploy` and a build preflight as a shell string beside the declaration that
  already stated them. It now runs `scripts/release.ts`, which checks every
  artifact `build.artifacts` declares and applies migrations for the engine
  `release.migrations` declares — refusing an engine it has no command for rather
  than skipping the step, because silently not migrating is what leaves a machine
  running against the wrong schema. Both declared migration paths are checked,
  the lockfile included. Development runs the same step.
- **`bun run test` passes on a fresh scaffold.** A test read `.env` at module
  load, before `env:ensure` had created it, so the second gate the README tells a
  new user to run died with `ENOENT` before a single test executed. Both CI paths
  write `.env` first, so nothing saw it.

### Changed

- **The generated build declares whether it reads data, and CI proves it does
  not.** Data read while building is a third kind of input — neither code nor a
  binding — and a build that reads it undeclared is a function of whichever
  machine had the database. The template answers it the default way: no route
  can reach a data source at all (`check-authored` refuses the import and now
  says why), so the build is a function of the source alone. The packed lane
  builds against a database address that accepts nothing, which is the only
  check that covers every transitive path at once. A project that genuinely
  needs data at build time declares a frozen export in `build.inputs` and
  `bun scripts/build-inputs.ts` refuses it the moment its digest drifts.
- **One artifact is now provably portable in CI, within a stated policy.**
  `runtime:smoke` asks the running web role for `/sitemap.xml` and `/robots.txt`
  under two different external addresses and requires two different answers —
  and requires a *third*, unclaimed host to be refused. The first half catches a
  build-time address creeping back in; the second catches the portability
  mechanism turning into an open redirect for metadata.
- **The drain floor has one home.** The backend passed a literal grace period
  while the declaration stated another — the same two-numbers-in-two-files shape
  that let a 30 s floor meet a 15 s kill timeout. It now reads
  `apiRole.drainFloorMs`, the number a supervisor reads too.
- **Three files are generated from the declaration** — both supervision files and
  the client-safe identity module — plus the `env.variables` block of the
  declaration itself. `bun run gen:declaration` renders them and the test suite
  refuses a stale copy. The example's declaration is generated from the
  template's in the same way.
- **The generated application targets Stitchkit `^0.59.0`.** The template's
  catalog pointed at `^0.52.0`, so a project scaffolded today started seven
  minors behind the framework — without neutral client-disconnect handling,
  managed files, composed auth, async operation contracts or the CLI presentation
  policy. Both the packed target lane and the packed HEAD lane pass on the new
  target.
- **The scaffolder prints the addresses the generated project will actually
  use**, read back from its declaration and example environment rather than
  restated as constants.

## [0.3.3] — 2026-08-18

### Changed

- **Generated applications bind loopback by default.** Both processes listen on
  `BIND_HOST` (default `127.0.0.1`) instead of a hardcoded `0.0.0.0` in the
  backend server and both PM2 configs. Exposing the app to the network is now a
  single conscious opt-in (`BIND_HOST=0.0.0.0` in `.env`) rather than the state
  a forgotten edit leaves behind. Reported from a production deployment of a
  generated app.
- **The template targets Stitchkit `^0.52.0`** — new applications get
  `implement.declare`, keyed registries and hook-derived scope maps out of the
  box. Purely additive relative to 0.50.
- **`bun run dev` reports honest URLs and fails fast on occupied ports.** The
  final `Web:`/`API:` lines are rendered from the validated environment instead
  of hardcoded ports, and before starting fresh PM2 processes the script probes
  `API_PORT`/`WEB_PORT` and names the offending variable when a foreign process
  holds one. Reloads of the app's own processes are unaffected.
- **`start` without a build says what to do.** A missing `dist/index.js` now
  fails with “run `bun run build` first” (also preflighted in `pm2:prod`)
  instead of a bare module-resolution error.
- **README and AGENTS.md pin the Prisma entry point.** Database commands go
  through the root `bun run db:*` scripts; the `prisma` CLI invoked directly has
  no datasource URL by design.

## [0.3.2] — 2026-08-17

### Changed

- **The template targets Stitchkit 0.50.0 and binds process signals through the
  framework.** Generated backends replace the hand-written shutdown coordinator
  with `bindProcessSignals(server, …)`: MCP and Prisma close in `onComplete`, the
  exit code is set there, and failures are reported by phase. The manual version
  the template used to ship reported a failing `mcp.close()` as a failed
  shutdown, did nothing on a third signal, and collapsed the grace period when a
  supervisor delivered two signals at once.
- **The repository example declares its domain error message once.**
  `GITHUB_UNAVAILABLE` carries its text in the `defineErrors` definition instead
  of repeating it at the throw site.

## [0.3.1] — 2026-08-15

### Changed

- **The template targets Stitchkit 0.49.2 and owns one managed server lifecycle.**
  Generated backends pass the full Socket.IO handle to `createServer()`, close
  through `server.shutdown()`, and use a repeated process signal to force the
  same shutdown chain instead of creating a competing close path.

### Fixed

- **Repository refresh and realtime verification are deterministic.** A successful
  refresh updates the initiating browser from its typed mutation result, remote
  browsers still update through the Socket.IO cache bridge, and the release lane
  exercises the complete backend path against a local GitHub-compatible upstream
  instead of depending on public API availability.

## [0.3.0] — 2026-08-10

### ⚠️ Breaking changes

- **Generated projects ship no `.env`.** The single environment source is
  `.env.example`; `bun run env:ensure` (and every tooling entry point,
  self-healing before validation) renders `.env` with the application-derived
  database name. A clone and a post-generation rename now produce the same
  database, and the second-developer path (`runtime:smoke`, `e2e`) works
  unaided.
  `// before: scaffold writes .env with a neutral database name` →
  `// after:  .env is rendered on first run from .env.example`

- **Starter-owned LAN HTTPS is removed.** Generated applications no longer ship
  `dev:lan`, certificate generation, onboarding routes or `DEV_HTTPS_*` settings.
  Applications that need a trusted device-testing origin should own certificate
  creation and pass TLS files through Stitchkit's documented `bun.tls` boundary.

### Changed

- **Surface conformance is anchored and total.** The declared surface is
  compared against a committed `surface.snapshot.json` (with schema-shape
  digests, regenerated deliberately via `bun run surface:snapshot`), the CLI is
  observed by spawning the real process, missing `x-stitchkit-*` metadata is an
  error unless a standard-document mode is declared explicitly, and the starter
  lane sweeps generated trees for neutral-identity leaks against a committed
  allowlist.
- **The template targets Stitchkit 0.46.** The error-code map covers
  `REALTIME_CONTRACT_VIOLATION` and conformance validates the operation
  metadata 0.46 emits.
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
