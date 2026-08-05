---
title: "A contract handler cannot set a response header, so every cookie endpoint falls out to rawRoutes"
description: RuntimeContext carries no outbound channel and create.ts always renders json(result), so login / logout / anything setting a cookie must leave the contract and lose the typed client.
type: task
status: icebox
created: 2026-08-05
updated: 2026-08-05
defrost: consuming-project evidence exists — when the in-flight consumer migration reaches its raw-routes phase and the real list of outbound headers is known (cookies only, or more), or a second project needs it. Building a header bag for what may be three `Set-Cookie` calls is over-engineering; both projects already live with the `rawRoutes` workaround.
---

# Transport-neutral response meta (cookies, headers)

Raised as an architecture question by a consuming project (three endpoints: init,
verifyCode, logout). A second project already accepted the workaround and lives
with it — which is why this is worth deciding rather than repeating.

## Facts

`RuntimeContext` (`contract/define.ts:193-214`) carries `req` / `url` / `headers`
— all **inbound**. `afterHandle` returns data, not a `Response`, and
`server/create.ts` always renders `json(result)`. There is no outbound channel, so
an endpoint that must set `Set-Cookie` has to become a raw route and lose the
typed client, the contract, and its place on every other transport.

## Why it is like this (and what must not break)

Deliberate, per ADR 0027: a contract handler is transport-neutral — the same
handler serves HTTP, MCP, agent and CLI, and three of those have no notion of a
header. Letting a handler return a `Response` drags HTTP into the core and
destroys that property (also → ADR 0013, the core stays Web-Fetch-clean).

So the constraint is firm: **whatever we add must be inert on non-HTTP
transports**, and must not let a handler construct a transport object.

## Options

### Option A — status quo, document the boundary

- ✅ Zero risk, zero surface.
- ❌ Cookies at login are not an edge case. Two of two consumers hit it, and the
  prescribed answer ("go to rawRoutes") costs them the typed client on their most
  security-sensitive endpoints — the ones that most want a contract.

### Option B — handler returns a `Response`

- ✅ Maximum power.
- ❌ Kills transport-neutrality outright; a handler returning `Response` is
  meaningless on MCP/CLI. Rejected without further analysis.

### Option C — response meta on `ctx` (recommended shape)

`ctx.setHeader(name, value)` / `ctx.setCookie(name, value, opts)` writing into a
per-call bag the **transport** applies. HTTP applies it at render; MCP / agent /
CLI ignore it (dev-mode warning that the call is a no-op there).

- ✅ Contract stays a description of **data**; the handler never touches a
  `Response`; no HTTP types in the core (a cookie bag is plain data — serialising
  it is the HTTP transport's job).
- ✅ Endpoints keep the contract, the typed client and every other surface.
- ❌ A handler can now behave differently per transport — the very thing
  neutrality was protecting. Mitigated by the no-op being *explicit* and warned,
  but it is a real dent.
- ❌ New public surface on the hottest interface in the framework.

### Option D — declare it in the contract

`cookies: ['session']` on the endpoint; the handler returns values for declared
cookies as part of its output; the transport applies them.

- ✅ Most faithful to the framework's philosophy: it is *declared*, so the
  contract still describes the whole interaction, and a client generator could
  even know about it.
- ✅ Nothing hidden happens inside a handler.
- ❌ Materially more design (schema, typing, interaction with `output`), and it
  forces the shape of an app's auth into the contract vocabulary.
- ❌ Overkill if the answer turns out to be "a header, occasionally".

**No decision yet — this task is the decision.** My leaning is **C** for reach and
cost, with D's declarative idea folded in only if it stays cheap. This needs an
ADR before any code, and the ADR needs one more piece of evidence: what the two
consuming projects actually set (only cookies? any other header? on how many
endpoints?). Building a header bag for what is really three `Set-Cookie` calls
would be over-engineering.

## Plan

- [ ] Gather the evidence first: which endpoints in the two consuming projects need
      an outbound header, and what exactly they set. Ask, do not guess.
- [ ] Write the ADR (options above + the neutrality constraint + the chosen shape).
      No implementation before the ADR is accepted.
- [ ] Then, and only then, split an implementation task out of it.

## Acceptance

- [ ] An ADR exists that states the decision and the reason, and either specifies
      the surface or records that the status quo stands.

## Process (конвейер 2/2)

- [ ] 2 plan validators — on the ADR, not on code
- [ ] ADR written
- [ ] Implementation task split out (or the ADR closes it as "status quo")
