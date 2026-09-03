---
title: A gate that does not run the code is measuring a proxy for the thing it cares about
description: Six entrypoints killed the page on import while passing every static check the package had; the browser gate now bundles each promised entry and executes it.
type: decision
status: active
created: 2026-09-03
updated: 2026-09-03
---

# 0158 — A gate that does not run the code is measuring a proxy

## Decision

`check-browser-executes.mjs` bundles every entrypoint the `build:browser` lane
promises, **runs it**, and requires it to initialise. It runs in `build`,
alongside the static scan rather than instead of it.

## Why the static scan was not enough

`check-browser-clean.mjs` walks the built output looking for `node:`. That is a
proxy for the question that matters — *will this page come up* — and this proxy
missed six entrypoints at once.

`stitchkit/observability`, `/server`, `/cli`, `/tools/invoker`, `/agent-runtime`
and `/files` each evaluated a Node construction at module scope:
`new AsyncLocalStorage<RequestContext>()` and `constants.O_NOFOLLOW ?? 0`. A
bundler does not omit a Node built-in, it substitutes a stub — so the constructor
is `undefined` and the property read is on nothing, and both throw while the
module is *loading*. Not on the route that wanted them. On import, so no route
renders.

Every check the package had was happy, because from the outside that code looks
exactly like code that works. `?? 0` even reads as defensive — it defends against
a platform without the constant, which is not the situation.

Running it costs seconds and cannot be fooled by the shape of the code.

## The lane decides, not the outcome

A server entrypoint failing here is not a failure — that is what the two lanes
mean. The gate checks only what `build:browser` promises.

That is also why `stitchkit/remote` moved into the browser lane in the same
change: the guide had been selling it as "browser and server, stable" while it
sat in the server lane, so nothing checked the promise. It happened to be clean.
A promise nothing checks is a promise that is true until the day it is not.

## The other half: a derived list must be checked, not merely non-empty

The entry list is derived from the `build:browser` script so it cannot drift from
the build. The first guard on that derivation asked whether it had read
*anything* — and that is the same silently-narrowing filter the derivation exists
to prevent. One entry written `./src/x.ts` rather than `src/x.ts` dropped out of
the list, the guard stayed happy, and that entry was scanned by nothing.

The count is now compared against the file-shaped tokens in the lane. "Did I read
everything" is the question; "did I read anything" was never a useful answer.
