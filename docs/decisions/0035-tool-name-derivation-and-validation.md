---
title: "ADR 0035 — Tool names are normalised across the whole character class and asserted at mount"
type: decision
status: accepted
created: 2026-08-05
updated: 2026-08-05
---

# ADR 0035 — Tool names: normalise the class, assert at mount

- **Status:** Accepted — refines the tool pipeline of [ADR 0007](0007-mcp-agent-tools.md).
- **Date:** 2026-08-05

## Context

`toToolName` normalised **only** the hyphen, so every other character rode into
the advertised name: a contract with `prefix: 'admin/analytics'` derived
`overview_admin/analytic`.

**Nothing *stopped* it.** `@modelcontextprotocol/sdk@1.29` does validate — SEP-986,
`validateAndWarnToolName` — but it only **warns** and registers the tool anyway,
against the MCP rule `[A-Za-z0-9._-]{1,128}`. `ai@7` has no name rule at all, and
stitchkit assigned the name without looking at it. So the first *enforcing* check
was the provider's, at the first model call — and the provider rejects **the whole
request**, so one malformed entry takes every tool of that mount down, not just its
own.

stitchkit deliberately validates **more strictly than MCP**: `[a-zA-Z0-9_-]` and 64
characters, i.e. no dot and half the length. That is OpenAI's function-name rule,
the tightest of the surfaces a contract can be advertised on — a name that passes
here is deliverable everywhere. A consumer targeting only MCP or only Anthropic
(both 128) may therefore have to set a shorter explicit `toolName`.

`defineContract` already enforces contract hygiene at declaration time (empty
`desc`, misplaced `toolName`, duplicate `toolName`) — but only the *placement* and
*uniqueness* of an explicit name, never the string, and never a derived one.

Separately, `singularize` compared `SINGULAR_EXCEPTIONS` against the whole
normalised name, so the list only ever matched an unprefixed service:
`bot-status` derived `get_bot_statu`, `chat-analytics` derived
`get_chat_analytic`.

This repo's own fixtures shipped illegal names (`do_thing_/test`, `list_/items`,
`create_/item`) and nobody noticed, because the assertions were `toBeTruthy()`.

## Decision

1. **Normalise, per half, touching nothing that already worked.** The service half
   has always collapsed `-` to `_`, so it keeps doing that and covers the rest of
   the class (`[^a-zA-Z0-9_]` → `_`). The method half was never normalised, and a
   hyphenated key shipped a *legal* name (`get-user_note`) that may be pinned in a
   client config — so it keeps its hyphen and normalises only what no provider
   accepts (`[^a-zA-Z0-9_-]` → `_`). It needs normalising at all because it is a
   `Record` key and a runtime-built contract bypasses the type.
2. **No run-collapsing and no trimming.** They would rename names that are legal
   today (`get__internal`, `list_a__b`, `get_foo_`) for cosmetics alone. Only
   illegal characters are touched, so the legal-name surface is untouched apart
   from point 4.
3. **Assert at mount, and throw.** The repo already splits these two concerns:
   *representability* defects get the `onIncompatibleSchema` policy
   (`'throw' | 'warn' | 'skip'`) because an endpoint can be valid on HTTP while
   its schema is not expressible as JSON Schema; *identity* defects — duplicate
   tool name, extend conflict, the `defineContract` checks — always throw. A name
   outside the provider charset is an identity defect. Of the three policy values
   only `skip` would even be coherent: `'warn'` would register the illegal name
   anyway and poison the whole tool list, which is strictly worse than not
   mounting it.
4. **`singularize` applies to the last `_` segment**, so the exception list works
   behind a prefix.
5. **A prefix with no usable characters is rejected on its own terms.** `'///'`,
   `'_'`, `''` and a fully non-ASCII prefix normalise to separators, and the
   result (`get____`, `get__`, `get_`) *passes* the charset check while being
   meaningless and identical for every such service — so it is caught by an
   explicit "no usable characters" check, not by the regex. An explicit `toolName`
   rescues such a prefix: the prefix never enters the name. This is the one place
   a **provider-legal** name (`get__`) now throws.
6. **The read-only listers opt out** (`collectTools({ assertNames: false })`) —
   `listToolNames` and `summarizeTransports`. `listToolNames` is the documented way
   to *find* an offending name before an upgrade; if it threw, the diagnostic would
   die on the very case it exists for.
7. **The CLI is exempt.** `[a-zA-Z0-9_-]{1,64}` is a *provider* rule; a CLI command
   is typed into a shell and no provider ever sees it. Holding it to the provider
   charset would refuse a command like `поиск` that worked yesterday, for no
   benefit.
8. **Native tools assert too.** `mountWait` / `mountDownload` / `mountUpload` land
   in the same `tools/list` as the contract tools, so one undeliverable name there
   takes the contract tools down as well — the exact argument this ADR rests on.
   `nativeTools?.(server)` is consumer code and out of reach.
9. **No new collision check.** All three mounts already dedupe derived names
   across every service in the mount, and `collectTools` is per-service and could
   not see a cross-service collision anyway. Only a regression test was added, to
   pin that the existing guards fire on newly-merged names.

## Alternatives considered

- **Widen the replace to `[-/]`** (the reporting consumer's proposal). Rejected —
  fixes one symbol and leaves the class: a dot, a space, unicode or a >64-character
  name still fail in production.
- **Normalise without validating.** Rejected — an explicit `toolName` still ships
  illegal, and an all-separator prefix ships as `get_`.
- **An `onIncompatibleSchema`-style policy knob.** Rejected per decision 3. Raw
  mount-time throws are a defect in the *representability* context, which is
  precisely the distinction drawn here.

## Consequences

- **Breaking, two classes.** (a) An illegal name now throws at mount — nothing that
  worked stops working (such a tool was rejected provider-side), but a build that
  mounted yesterday can fail today. (b) `singularize` on the last segment renames
  names that are legal but wrong: `get_bot_statu` → `get_bot_status`,
  `get_user_setting` → `get_user_settings`, `get_chat_analytic` →
  `get_chat_analytics`, `get_site_new` → `get_site_news`. A host config or agent
  prompt pinned to an old name breaks; the migration recipe is a `listToolNames`
  diff, which is what that lister was built for.
- **`implementRemote` inherits the check** — it is a second name producer over
  someone else's contract, the likeliest source of an illegal prefix from outside
  the author's control.
- **`validateMcpSchemas` still walks `'MCP'` only**, so an AGENT-only or CLI-only
  endpoint with a bad name is invisible to the build probe and surfaces at
  `mountAgent` / `createCli` instead. Stated rather than fixed — widening the
  probe's transport set is a separate change.
- **`nativeTools?.(server)` remains out of reach** — it is consumer code
  registering straight on the `McpServer`. The three built-in native tools are
  covered (decision 8).
- **A throw mid-mount leaves an `McpServer` partially registered** when several
  services are mounted in one call. Pre-existing (the duplicate-name and
  extend-conflict throws behave identically); the new assertion widens the window.
