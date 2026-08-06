---
title: "Request logging: enrichable fields, a configurable skip, one honest trace header, and a composition seam"
description: The built-in logger prints a hardcoded field set and cannot be extended, its noise filter is a constant in the source, the default CORS expose list advertises a header the server never sends, and the whole observability layer is unreachable from createServer and serveNode.
type: task
status: done
created: 2026-08-06
updated: 2026-08-06
completed: 2026-08-06 09:03 +07:00
---

# Request logging — enrichment, a configurable skip, one honest trace header, and a composition seam

## Guiding principle for this task

Breaking is cheap; legacy is expensive. Where a clean design needs a breaking
change, take the breaking change and write an excellent migration note. No
aliases, no shims, no dual-accepted shapes, nothing "kept for compatibility".
Never break *silently* — that discipline is absolute and is why this task adds a
runtime refusal (item B2) rather than a quiet fallback.

## Where this came from

A consuming project read the source and filed a three-part report: it is using
`stitchkit/observability` only halfway, here is what the framework is missing,
here is what it would change. Their half is theirs. Parts 2–3 are this task —
after verification, which confirmed most of it, corrected five points, and
turned up four bugs neither side had seen.

## Verified against the source

| Claim | Verdict |
|---|---|
| `RequestEvent` carries `userAgent`, `ipAddress`, `userId`, `authMethod`, `clientId`, `serviceName`/`action`, `spanId`/`parentSpanId`, `errorDetail`, `payload`, `resultSize`, `responseBytes` | True — `observability/event.ts` |
| `createAuditHook` normalises HTTP and tool calls into one shape | True — `observability/audit.ts` |
| `logging: true` prints a hardcoded field set | True — `logger.ts:72-88`, plus `ip` only in the production JSON (`logger.ts:168`) |
| A custom logger receives that same fixed set | True — `create.ts:92-105` |
| The noise filter is hardcoded | True — `logger.ts:119`, a module constant |
| The observability guide never mentions correlating with a reverse proxy | True |
| There is no built-in health route | True |

## Corrections to the report

1. **The built-in logger already holds the `Request`** — `logIncoming` /
   `logOutgoing` take it and print nothing from it beyond the method. The narrow
   interface is the *custom* logger's.
2. **"Two disconnected worlds" is overstated.** `create.ts:7` already imports
   `setRequestEndpoint` and calls it at `create.ts:207`; `RequestContext`
   already carries `userAgent`, `ipAddress`, `userId`, `dimensions`, `error`,
   `trace`, `startedAt`. The logger simply never reads it.
3. **Preflights are already filtered** — `logger.ts:122` drops `OPTIONS`
   unconditionally. Health probes are a real argument for a configurable skip;
   preflights are not. The strongest case is neither: Socket.IO mounts at
   `${path}/*` (`socket-io.ts:203`) and `/socket.io/` is not in `SKIP_PREFIXES`,
   so a polling-transport client emits a log line **per poll**.
4. **The audit layer already has `filter`** (`audit.ts:23`).
5. **`X-Trace-Id` is not "already returned".** Expose-listing a header is not
   emitting it — see the bugs below.

## Bugs found while validating (none of them reported)

**G1 — the trace header is a fiction.** `DEFAULT_CORS_EXPOSE_HEADERS`
(`cors.ts:41-42`) advertises `X-Trace-Id`. Nothing in `packages/core/src` ever
sets that response header. What responses carry is `x-request-id`
(`create.ts:316`), and that name is *not* in the expose list. So a browser
client cannot read the trace id of its own request, and the proxy recipe the
report proposes would log an empty value on every line. (`raw.ts:29` is the
`errorResponse` helper, not "raw routes", and inside `dispatch` it is overwritten
by `create.ts:316` anyway.)

**G2 — the documented correlation snippet does not compile.**
`HandlerConfig.traceId?: (req: Request) => string` (`types.ts:227`) versus
`getTraceId(): string | undefined` (`context.ts:66`). Under `strict` the
documented `traceId: getTraceId` is a type error — and it is documented in three
places (`docs/guide/observability.md:142`, the JSDoc at `context.ts:145-146`,
and the generated `llms-full.txt`). The headline instruction for correlating
logs has never worked.

**G3 — a throwing logger takes the request down, after logging twice.** In
`respondError`, `logDone` at `create.ts:130` sits inside the `try` whose bare
`catch {}` at `:133` is meant for a broken `onError`. A throw there is
swallowed, execution falls through to `logDone` at `:139`, which throws again —
now uncaught, escaping `dispatch`. Separately, `logDone(200)` at `create.ts:291`
runs *before* `json()` at `:292`; `json()` throws on `BigInt` or circular data,
so one request emits a `200` line **and** a `500` line.

**G4 — the observability layer is unreachable from the convenience servers.**
The documented composition (`observability.md:98-104`) wraps a handler and hands
it to raw `Bun.serve`. But `createServer` builds `fetch` internally
(`create.ts:327`) and `ServerPassthrough` omits `'fetch'` (`types.ts:244-247`);
`serveNode` does the same (`server/node.ts:25-27`). There is no seam. A
`createServer` user — the README path — cannot establish a `RequestContext` and
cannot wire `createAuditHook` at all. This is the most consequential finding:
the advice "just wire the audit hook on your side" silently requires abandoning
`createServer`.

## Release split

The bug fixes must not be held hostage by the breaking reshape: `^0.27.0` means
`< 0.28.0`, so a consumer cannot take G1–G3 without opting into the `logging`
migration. Two passes, in order.

- **Pass A — patch-safe (targets 0.27.1).** G1, G2, G3, and the dead
  `logDone(204)` at `create.ts:146` (unreachable — `shouldLog` already returned
  `false` for `OPTIONS` at `:73`). No public API changes; `### Fixed`.
- **Pass B — breaking (targets 0.28.0).** The `logging` reshape, `skip`,
  `enrich`, the context read, and the `wrapFetch` seam.

Both land under `[Unreleased]` with the Pass A items grouped under `### Fixed`
and the Pass B items under `### ⚠️ Breaking changes`. Cutting the releases is a
separate `release:` commit and the owner's call — this task does not bump
`package.json`.

---

## Pass A — bug fixes, no API change

### A1. One honest trace header (G1)

Add `X-Request-Id` to `DEFAULT_CORS_EXPOSE_HEADERS`; remove `X-Trace-Id` from
it. `DEFAULT_CORS_ALLOW_HEADERS` is untouched — inbound `X-Trace-Id` is real and
read by `resolveTraceId` (`request.ts:20`).

Do **not** claim "no observable change": `Access-Control-Expose-Headers` governs
headers anyone in the chain sets, so a consumer whose proxy adds `X-Trace-Id`
loses browser access to it. Say what changes.

### A2. Make `traceId: getTraceId` compile (G2)

Widen `HandlerConfig.traceId` to `(req: Request) => string | undefined` and fall
back to `resolveTraceId(req)` when it returns `undefined`. Fixes the snippet in
all three places at once.

### A3. Harden the log path (G3)

- Wrap the whole `logDone` body in try/catch — the audit sink's discipline
  (`audit.ts:66-73` swallows around the *entire* emit, not one sub-step).
- Guard against a second line for one request (a `logged` flag, or move
  `logDone(200)` after `json()`).
- Delete the unreachable `logDone(204)` at `create.ts:146`.

---

## Pass B — the logging surface

### B1. `logging` becomes a configuration object (breaking)

```ts
logging?: boolean | LoggingConfig

interface LoggingConfig {
  logger?: StitchLogger;
  skip?: (req: Request, url: URL) => boolean;
  enrich?: (
    req: Request,
    url: URL,
    outcome: { status: number; durationMs: number; errorCode?: string },
  ) => Record<string, unknown> | undefined;
}
```

**Semantics, stated as a rule and tested:** `true` is shorthand for `{}`. Any
object turns request logging **on**; `logger`, when present, replaces the
built-in sink exactly as an object does today; `skip` and `enrich` apply to
whichever sink is active. Without this rule, `logging: { skip }` yields
`customLogger = null` *and* `useDefaultLog = false` (`create.ts:45-46`) — total
silence for someone who asked for "default logging minus health probes".

`boolean` stays. Dropping it would make `logging: {}` mean "on", which reads as
"configured with nothing", and re-adding `enabled?: boolean` puts the boolean
back inside the object.

Migration:

```ts
// before
createServer({ logging: myLogger })
// after
createServer({ logging: { logger: myLogger } })
```

### B2. Refuse a mis-migrated logger, loudly

`LoggingConfig` is all-optional with zero property overlap with `StitchLogger`,
so TypeScript's weak-type detection rejects `logging: myLogger` for a normally
typed logger — the break is loud, and the CHANGELOG should say so. But a logger
typed `any`, or one carrying an index signature (a wrapped `pino` — the backend
ADR 0012 names), assigns cleanly and then means "a config with no logger": the
app compiles, boots and **silently stops logging**.

So: if the object has none of `logger` / `skip` / `enrich` but does have
`info` / `warn` / `error` / `debug` as functions, **throw** with the migration
line. This is not a shim — it refuses the old shape instead of accepting it.
Narrow with a type guard over `isRecord` (`internal/typed.ts`); no `as`.

### B3. `skip`

Consulted **after** the built-in prefixes and the `OPTIONS` rule, so it can only
silence more. Un-skipping is rejected, and the reason is worth recording:
`/_bun/` assets are served by Bun's native `routes` and largely never reach
`fetch`, so "un-skip" would be a promise the router cannot keep. A throwing
`skip` is swallowed and treated as "do not skip".

### B4. `enrich`

Runs at completion only — not on the incoming `debug` breadcrumb
(`create.ts:81-86`), since it may be expensive. Merged into the structured
output: the production JSON line and the data object handed to a custom logger.
The development pretty line is unchanged — it is a human-readable line, not a
record — and that must be stated loudly in the JSDoc, because dev is exactly
where someone writes `enrich` and then sees nothing.

Constraints to document on the field:

- **Framework fields win.** `traceId`, `method`, `path`, `status`,
  `durationMs`, `errorCode`, `ip` are written last; an `enrich` returning
  `{ status: 'ok' }` cannot corrupt the record.
- **Synchronous, and the body is gone.** It runs after `parseRequestInto`
  (`create.ts:210`) drained the request — `req.bodyUsed` is `true`. Anything
  body-derived belongs in `createAuditHook`, which clones (`audit.ts:78`).
- **Values reach the sink raw.** A consumer echoing an attacker-controlled
  header into a text logger can inject CRLF; `safePath` (`logger.ts:46-62`)
  exists because that class of bug shipped once. Say so in the JSDoc.
- A throw is swallowed.

### B5. The logger reads `RequestContext` when one is active

When `getRequestContext()` returns a context, merge `userId`, `serviceName`,
`action` and `dimensions` into the structured fields — `dimensions` **nested**
as an object, matching `RequestEvent`, not spread. No configuration, and no cost
when observability is not wired (`context.ts:61-63` returns `undefined`).

Ordering is verified: `setRequestEndpoint` (`create.ts:207`) runs before
`parseRequestInto` (`:210`), whose `catch` (`:293`) routes to `respondError` →
`logDone`. A 400 validation failure therefore still carries endpoint identity —
cover that case in a test.

### B6. `wrapFetch` — the composition seam (G4)

Add `wrapFetch?: (fetch: FetchHandler) => FetchHandler` to `BunServerConfig` and
to the Node serve config, applied to the handler `createHandler` builds before
it reaches `Bun.serve` / `srvx`:

```ts
createServer({
  services,
  wrapFetch: (h) => wrapInRequestContext(audit.http(h)),
})
```

One general seam rather than a `requestContext?: boolean` flag, and the reason
is ordering: `wrapInRequestContext` must be **outermost**, with `audit.http`
inside it. A boolean that made `createHandler` establish the context internally
would put any externally composed audit wrapper *outside* the context, breaking
the documented composition. `wrapFetch` keeps the consumer in control of the
order and, unlike the flag, also makes `createAuditHook` reachable — which is
the actual G4 gap.

### B7. `traceId` on tool-call records

`createToolLogger` builds its own `ToolCallRecord` (`tools/tool-logger.ts:22-37`)
with `tool, service, action, ok, code, durationMs, source` and **no `traceId`**.
After this task an HTTP line carries `traceId + userId + dimensions + enrich`
while a tool call made inside that same request carries none of it, so the two
cannot be joined without falling back to `createAuditHook` — the very thing B5
was meant to make unnecessary for simple cases. Add `traceId: getTraceId()` to
`ToolCallRecord`. The rest of the tool surface (`skip`, `enrich`, a shared field
builder) is **explicitly out of scope**; say so in the ADR.

### B8. Documentation

- `docs/guide/observability.md`: a section on correlating with a reverse proxy.
  The framework sets `x-request-id` on **every response the stitchkit handler
  produces** — not literally every response: Bun's native `routes`
  (`types.ts:256`, passed straight to `Bun.serve` at `create.ts:332`) are matched
  before `fetch` and never reach it, a throwing `hooks.onRequest`
  (`create.ts:150`, outside any try) escapes entirely, and immutable response
  headers are skipped by design (`create.ts:315-319`). Give the nginx `map`
  fallback to `$request_id` so the proxy fills those gaps.
- One sentence on the deliberate asymmetry: inbound `X-Trace-Id` is accepted,
  outbound the id is `X-Request-Id`. Without it someone files this report again.
- `docs/guide/server.md:71` (example) and `:91` (options table);
  `docs/guide/testing-and-deployment.md:116-117`; `docs/api/reference.md:165`
  plus a new `LoggingConfig` row — `reference-coverage.test.ts` **fails** if a
  new export from `server/index.ts` has no backticked row there.
  `llms.txt` / `llms-full.txt` are generated by `bun run build`; never hand-edit.
- JSDoc at `context.ts:145-146` — same `traceId: getTraceId` claim, fixed by A2.

### B9. ADR 0039 + a row in `docs/decisions/README.md`

"Request logging reads the request context." Records: two consumers over one
`RequestContext` rather than a logger over `RequestEvent`; `true ≡ {}` and what
it costs (below); `wrapFetch` over a `requestContext` flag, with the ordering
argument; the tool surface left out and why.

Alternatives to record as considered and rejected:

- **Reshaping `StitchLogger` to take one structured event** instead of
  `(msg, data?)`. Rejected on evidence: the interface serves three roles and two
  are not events — the startup shadowed-route warning (`create.ts:62`) and the
  output-strip diagnostic (`create.ts:276`) pass a bare string. A single-event
  interface would force a second interface for those.
- **Moving `warnOnOutputStrip` (`types.ts:226`) into `LoggingConfig`** while
  breaking anyway. Rejected because it collides with `true ≡ {}`: today it works
  with `logging: false`, falling back to `console.warn` (`create.ts:270-277`);
  inside the object, `logging: { warnOnOutputStrip: true }` would also switch
  request logging on, and "silence request logs, keep the migration diagnostic"
  becomes unexpressible.
- **A `fields: ['userAgent']` option, and `userAgent` on by default.** Both
  rejected — see below.
- **Sampling** (log 1-in-N). `skip` is boolean by design; named here so the next
  reader does not re-derive it.
- **Shape-sniffing the `logging` object** (`typeof x.info === 'function'`) to
  avoid the break. Rejected precisely *because* it avoids the break: it keeps two
  accepted shapes alive forever.

---

## Rejected, with reasons

- **The report's proposal A — build the logger on `RequestEvent`.** The audit
  `http` wrapper is composed outside `createHandler` and builds its event after
  the handler returns; the logger runs inside dispatch. Unifying forces event
  construction into the always-on hot path — sanitising the payload, measuring
  `resultSize` and `responseBytes` on every request — for data the logger never
  prints. The same benefit comes from `RequestContext`, which the core already
  writes to. ADR 0022 deferred the same idea for the same reason.
- **The report's proposal E — a built-in health route.** A route in no contract:
  invisible to the typed client and to the MCP and agent surfaces, and the
  framework would have to pick a path that can collide. Contract-first means the
  consumer declares it. The reported symptom — monitoring hitting `/` and
  logging a 404 every cycle — is closed by `skip`.
- **`userAgent` printed by default.** It is a changed default (which
  `AGENTS.md` counts as breaking) riding into an already-breaking release, for
  the fattest field on a request line, that nobody must have. And the argument
  used to reject a `fields` option applies to it: once `enrich` exists,
  `userAgent` is one line of `enrich`. One clean path.
- **A `fields: [...]` option beside `enrich`.** Two mechanisms for one job.

## Out of scope, recorded so it is not re-derived

- **`authMethod` / `clientId` on HTTP.** `RequestEvent` declares both, but
  `RequestContext` has neither (`context.ts:17-51`), so `audit.ts:95-120` never
  populates them for HTTP — only the tool path does. "Which API key made this
  call" stays unavailable on an HTTP log line. Needs a `setRequestAuth`, or
  `dimensions` sanctioned as the workaround; either way, its own task.
- **Response size on the HTTP path** — `audit.ts:114-115` hardcodes
  `resultSize: null, responseBytes: 0`. Unchanged here.

## Acceptance

- [x] A browser client can read the trace id; the default expose list no longer
      advertises a header the server never sends; the change is described, not
      claimed invisible — and, on validator 2's finding, filed under
      `### ⚠️ Breaking changes` rather than `### Fixed`, because it is the one
      change here the compiler cannot catch and the upgrade flow is told to read
      only that heading.
- [x] `traceId: getTraceId` compiles under `strict`, pinned by a test in a
      compiled file (`request-logging.test.ts`) so the regression cannot return
      silently; all three documented occurrences match reality.
- [x] A throwing logger cannot escape `dispatch`, and one request produces at
      most one completion line. **Validator 1 falsified the first half on the
      original implementation** — `customLogger.debug` ran outside any guard.
      Fixed, plus the output-strip diagnostic sink on the success path.
- [x] `logging: {}` / `{ skip }` / `{ enrich }` all log; `{ logger }` replaces
      the built-in sink; a mis-migrated logger object throws with the migration
      line.
- [x] `logging: { skip }` silences a chosen path while built-in noise stays
      filtered; a throwing `skip` or `enrich` cannot fail a request.
- [x] `enrich` cannot overwrite a framework field; `dimensions` is nested.
      Validator findings closed two holes the first pass left: `errorCode` was a
      conditional key (forgeable on a 200) and `ip` was absent from the custom
      sink entirely.
- [x] The structured line carries `userId`, `serviceName`, `action`,
      `dimensions` when a context is active — including on a 400 validation
      failure — and is unchanged when none is.
- [x] `createServer` and `serveNode` users can compose
      `wrapInRequestContext` / `createAuditHook` through `wrapFetch`, verified
      end to end for both (the `serveNode` test was added on validator 1's
      finding — it is the fragile path, since it destructures `wrapFetch`).
- [x] `ToolCallRecord` carries `traceId` — tested in `tool-logger.test.ts`.
- [x] ADR 0039 written and indexed; guide and reference updated;
      `reference-coverage.test.ts` green; CHANGELOG carries both blocks with
      before → after.
- [x] `bun run verify` green (lint, typecheck, **725 tests**, build, Node
      smoke); no fixed ports in new or touched tests, and the two pre-existing
      fixed ports in `error-context.test.ts` were cleaned up while there.

## Known call sites to update

**Tests** — `error-context.test.ts:76`, `:105` (also on fixed ports 9972 / 9973,
clean up while touching) · `output-strip-diagnostics.test.ts:93`, `:107` ·
`raw-response-endpoints.test.ts:388` · `reference-coverage.test.ts` (whole-file
gate on new exports).

**Docs** — `docs/guide/server.md:71`, `:91` ·
`docs/guide/testing-and-deployment.md:116-117` · `docs/api/reference.md:165` ·
`docs/guide/observability.md:142` · JSDoc `observability/context.ts:145-146`.

---

## Validator 1 notes — API design and change policy

Verdict: plan substantially right, five changes needed, nothing violating
`AGENTS.md`. Absorbed above:

- Items changing what `logging: true` emits are **changed defaults**, i.e.
  breaking triggers — either marked or cut. → `userAgent` cut; the context read
  filed under Pass B.
- `logging: {}` / `{ skip }` had no defined meaning. → `true ≡ {}` rule, B1.
- The break is silent for an `any`-typed or index-signature logger. → runtime
  refusal, B2.
- Merge order and key collisions unspecified. → framework fields last,
  `dimensions` nested, B4/B5.
- `skip` / `enrich` signature asymmetry and undefined call sites. →
  both `(req, url, …)`, completion only, B4.
- CORS "no observable change" overstated; `DEFAULT_CORS_EXPOSE_HEADERS` is an
  exported constant quoted verbatim in the 0.27.0 entry. → A1 wording.
- Do not bump `package.json` in the feature pass. → release split section.

Confirmed as correct and kept: the diagnosis and all three corrections to the
original report; the CORS fix; the `logging` reshape with the logger nested;
`skip` AND-only; `enrich` off the dev line; the `RequestContext` read; all three
rejections; one canonical header with no alias; ADR 0039.

Argued against and accepted: dropping the `boolean` form; reshaping
`StitchLogger`; moving `warnOnOutputStrip` inside — all recorded in B9.

## Validator 2 notes — factual correctness and hidden risk

Verdict: claims almost entirely correct; one false, one ambiguity that would
disable logging, one documented snippet that does not compile. Absorbed above:

- **False as written:** "`x-request-id` on every response". Bun native `routes`,
  a throwing `onRequest` and immutable headers all bypass `create.ts:316`; and
  `raw.ts:29` is the `errorResponse` helper, not raw routes. → G1 wording, B8,
  correction 5.
- `logging: { skip }` would log **nothing** under the current
  `create.ts:45-46`. → B1.
- `traceId: getTraceId` does not typecheck. → G2 / A2.
- `logDone` unprotected; double-`logDone` in `respondError`; a `200` line
  followed by a `500` line when `json()` throws. → G3 / A3.
- Item 5 unreachable for `createServer` / `serveNode` users. → G4 / B6.
- Tool surface has a separate record with no `traceId`. → B7.
- `enrich`: body already consumed, sync, no outcome data. → B4 signature and
  documented constraints.
- `userAgent` is attacker-controlled and would reach a custom logger raw. →
  cut by default; CRLF caveat documented on `enrich`.
- Dead `logDone(204)` at `create.ts:146`; `/socket.io/` per-poll logging as the
  real motivation for `skip`. → A3, correction 3.
- Weak-type detection makes the common migration loud. → say so in the
  CHANGELOG, B1.
- Still missing afterwards: `authMethod` / `clientId` on HTTP, response size. →
  "Out of scope" section.

Confirmed as correct: all seven table rows; corrections 1–4; the G1 bug and both
of its consequences; the B5 ordering claim including the 400 case; silent
degradation when unwrapped; ADR 0039 and 0.28.0 as the right numbers; and that
`cors-response-integrity.test.ts`, `middleware.test.ts`, `node.test.ts`,
`raw-helpers.test.ts` all stay green.

## Process — конвейер 2/2

- [x] Plan validated by 2 read-only subagents, different lenses
- [x] Their findings absorbed as "Validator N notes" sections
- [x] Moved to `in-progress/`
- [x] Pass A implemented (bug fixes)
- [x] Pass B implemented (logging surface)
- [x] Gates green (`bun run verify`)
- [x] Implementation validated by 2 read-only subagents (code lens, contract lens)
- [x] Their findings fixed, gates re-run — 725 pass
- [x] Reported to Max

## Deviations from the plan, and why

1. **`wrapFetch` sits on the server configs, not `HandlerConfig`** — as planned,
   but the route there was not straight. It was first put on `HandlerConfig` to
   cover all three entry points with one implementation; that fails to compile,
   because `FetchHandler` must name `BunServer` for the inner handler to be
   assignable under `strictFunctionTypes`, and a `server?: unknown` variant is
   rejected contravariantly. The recorded reason in ADR 0039 was then wrong on a
   second count — validator 1 showed `HandlerConfig` already names `BunServer`
   transitively through `rawRoutes` → `RawRouteContext.server`. The real reason,
   now in the ADR: only `createServer` and `serveNode` own a `fetch` a consumer
   cannot otherwise reach.
2. **`logOutgoing` took an options object** rather than growing to seven
   positional parameters. Internal — not exported from any entrypoint.
3. **`structuredLine` was extracted** so the "an unserialisable `enrich` value
   costs the extra fields, never the line" promise is unit-testable without
   running the suite under `NODE_ENV=production`.
4. **`buildLogFields` now always emits `errorCode`** (`undefined` on success).
   The conditional key was the hole that let `enrich` forge an error code on a
   200; `JSON.stringify` drops the undefined, so the production line is
   unchanged.

## Validator notes — implementation pass

**Code lens.** Confirmed every Pass A / Pass B item landed with nothing unasked
riding along, and that the cost when observability is unwired is one
`AsyncLocalStorage` lookup on a logged request and nothing at all on a skipped
one. Findings, all fixed:

- **HIGH — a throwing logger still escaped `dispatch`.** `customLogger.debug`
  (the incoming breadcrumb) ran outside any guard, falsifying an acceptance
  line, and the throwing-sink test could not catch it because that test set
  `debug` to a no-op. Guarded; `reqLog` is now assigned before the breadcrumb so
  a failed breadcrumb does not also cost the completion line; the test now
  throws from every level.
- **MEDIUM — "framework fields always win" was false** for `errorCode` (a
  conditional key, so forgeable on a 200) and for `ip` in the custom sink (never
  written there at all). Both fixed and tested.
- **MEDIUM — an unserialisable `enrich` return dropped the whole line**, not
  just the extra fields, contradicting the documented promise. Fixed via
  `structuredLine`.
- **MEDIUM — `serveNode` + `wrapFetch` had no test**, and it is the fragile path.
  Added.
- Low: `ToolCallRecord.traceId` untested (added), the `getTraceId` compile site
  unpinned (added), `durationMs` computed twice so `enrich` could see a value
  1 ms off the printed one (now passed through). Noted and accepted as-is: the
  `logged` flag is currently unreachable defence-in-depth, and
  `traceId: () => ''` stamps an empty id (`??` is nullish-only, as specified).

**Contract lens.** Gates green, no `as` casts, no downstream project named,
`llms.txt` / `llms-full.txt` gitignored and generated. Findings, all fixed:

- **MUST — the CORS default change was filed under `### Fixed`**, the section
  `docs/guide/upgrading.md` tells a migrating agent to skip, even though it is
  the only silent break in the release. Moved under the breaking heading with a
  before → after; the 0.27.0 entry that quotes the old list is left as history.
- **MUST — two dead ADR links** (`0013-node-support.md`,
  `0021-audit-dimensions.md`). Corrected to `0013-runtime-agnostic-core.md` and
  ADR 0029, which is where dimensions actually live.
- **MUST — "the log picks the context up on its own" was false in
  development**: the built-in pretty line never carries the extra fields. The
  caveat had been written for `enrich` and not applied to the context read,
  which has the identical mechanism. Stated in the guide, the CHANGELOG and the
  ADR.
- The runtime migration error pointed at "CHANGELOG 0.28.0", a section that does
  not exist yet — version dropped from the string.
- The nginx comment named the wrong bypass (an `onRequest` short-circuit *does*
  carry the header; a **throwing** `onRequest` is the gap), and the snippet
  needed its `http {}` context. Both fixed.
- `stitchkit/node` could not import the new types — re-exported.
- `ToolCallRecord.traceId` existed only in the CHANGELOG — documented in
  `mcp-and-agents.md` and the correlation section.
- Not fixed, recorded instead: the pre-existing `→ ADR 0021` citation for
  dimensions in `observability/context.ts` and `event.ts` (repo precedent; new
  prose cites 0029), and that `createServer` without `websocket` never passes
  Bun's native `routes`, which makes the first-named nginx bypass weaker than it
  reads.

## Что сделано

**Framework — bug fixes (patch-safe)**

- [x] `DEFAULT_CORS_EXPOSE_HEADERS` names `X-Request-Id`, drops the never-sent
      `X-Trace-Id` — `packages/core/src/server/middleware/cors.ts`
- [x] `traceId` may return `undefined`, with a fallback to `resolveTraceId` —
      `packages/core/src/server/types.ts`, `create.ts`
- [x] The whole log step is guarded, on both the completion line and the
      incoming breadcrumb; the output-strip diagnostic sink can no longer turn a
      200 into a 500 — `create.ts`
- [x] One completion line per request; `logDone(200)` moved after `json()`; the
      unreachable preflight `logDone(204)` removed — `create.ts`

**Framework — the logging surface**

- [x] `logging?: boolean | LoggingConfig` with `true ≡ {}`, plus the loud
      refusal of a pre-0.28 bare logger — `packages/core/src/server/logging.ts`
      (new), `types.ts`, `create.ts`
- [x] `skip` and `enrich`, both throw-swallowing, both merged under the
      framework's fields — `logging.ts`, `logger.ts`, `create.ts`
- [x] The completion line reads the active `RequestContext` (`userId`,
      `serviceName`, `action`, nested `dimensions`) — `logging.ts`
- [x] `structuredLine` keeps a record alive when an `enrich` value cannot be
      serialised — `logger.ts`
- [x] `wrapFetch` via a shared `FetchComposition`, applied by `createServer` and
      `serveNode` — `types.ts`, `create.ts`, `node.ts`
- [x] `ToolCallRecord.traceId` — `packages/core/src/tools/tool-logger.ts`
- [x] New exports surfaced from `stitchkit/server` and `stitchkit/node`

**Docs**

- [x] ADR 0039 + index row — `docs/decisions/`
- [x] Reverse-proxy correlation section, the dev-vs-production caveat, the
      `wrapFetch` composition — `docs/guide/observability.md`
- [x] Request-logging section and config table — `docs/guide/server.md`
- [x] Production checklist — `docs/guide/testing-and-deployment.md`
- [x] `traceId` join for tool calls — `docs/guide/mcp-and-agents.md`
- [x] Four new type rows — `docs/api/reference.md`
- [x] CHANGELOG under `[Unreleased]`: three breaking items with before → after,
      plus Added and Fixed

**Tests** — `packages/core/tests/request-logging.test.ts` (new, 25 cases),
additions to `tool-logger.test.ts`, migrations in `error-context.test.ts`,
`output-strip-diagnostics.test.ts`, `raw-response-endpoints.test.ts`.

**Not done, deliberately**

- [x] `userAgent` printed by default — rejected; it is one line of `enrich`
- [x] A built-in health route — rejected; a route in no contract
- [x] The tool surface getting `skip` / `enrich` / a shared field builder —
      out of scope, stated in ADR 0039
- [x] `authMethod` / `clientId` on the HTTP context, and response size on the
      HTTP audit path — recorded in "Out of scope"; each needs its own task
- [x] The version bump — a release is a separate `release:` commit, and the
      release split (a patch for the fixes, then the breaking minor) is the
      owner's call
