---
title: A page follows the release it was built for
description: A tab that outlives a release keeps talking to a server that no longer serves its bundle. One consuming application solved it in three places of its own code with four defects; another tolerates stale tabs with a compatibility layer in its contract. The comparison and the channels belong in the framework, once; the build-id source and the deploy signal stay with the application.
type: decision
status: active
created: 2026-09-06
updated: 2026-09-06
---

# 0167 — A page follows the release it was built for

## Decision

`stitchkit/release` (evolving, browser + server) owns three things: a server
**marker** of the current frontend build, built on a `read` the application
supplies; the **channels** by which a browser learns it — the `X-Build-Id`
header on every response of a handler configured with the marker, and a
socket event on connection and on change; and the browser **watcher** that
compares what it heard to the id its own bundle was built with and reloads
under a declared policy. `stitchkit/server` adds the binding from a deploy
signal to `marker.refresh()`.

What it does not own: where the build id comes from (a file the release
wrote, an environment variable), who sends the deploy signal (a release step
of the application), and what to do instead of reloading (`onStale` is there
for an application that prefers to show "a new version is ready").

## The evidence

One consuming application had this working, in three places of its own code:
a resolver for the active release's `BUILD_ID` file; a socket service that
sent the id on every authenticated connection (re-reading the file each
time) and, on `SIGUSR2`, re-read and broadcast it; and a client that remembered the first
id it heard and reloaded on any other. It worked — and it had four defects
that a second copy would have inherited:

1. **The baseline was the first id heard, not the bundle's own.** A tab that
   loaded a cached bundle after the release and then connected would adopt
   the new id as its own and never reload. The bundle knows what it was
   built with; that is the only correct baseline.
2. **The reload was immediate.** In a chat that is fine; in a form it loses
   the form.
3. **Nothing sent the signal.** The comment named a deploy script that exists
   in no repository. A contract held by memory is not a contract.
4. **Only a socket carried it.** An application on polling — the second
   consumer in line — had no channel at all.

A second application solved the same problem by tolerating it: a generation
id on telemetry, rejections for samples from old bundles, and a compatibility
layer in a contract so that an old tab would not enter an auth-recovery loop.
That layer exists because the tab was never told to reload.

## Why the header, and why still the socket

The header is the universal channel: every application already makes HTTP
requests, so every application already has a stream of moments at which the
server can name its build. It costs one header on responses the server was
sending anyway, beside `X-Request-Id`, and the client already has an
`afterResponse` hook to read it. It needs no socket, no polling of its own
and no new endpoint. Its latency is the application's own request cadence —
which is the right latency for a reload the user will notice.

The socket channel is the fast path where a socket exists: a tab that is
idle on a live feed hears the release the moment it happens. Its shape keeps
the original's one good idea — a connection re-reads the file before it
answers — so a deploy signal the process missed while it was down is repaired
by the next client that connects.

## Why the watcher compares to `own`

Because the bundle can know: a build id baked in at build time
(`NEXT_PUBLIC_BUILD_ID=$(git rev-parse --short HEAD)`), which two of the
three consumers already do for telemetry and the third adds as one line of
its build. A baseline learned from the server can only ever say "the server
changed since I first asked", which is a different and weaker fact than "I
am not what the server serves". The
watcher also ignores an own id that means "not a release" (`dev`), so a
development bundle talking to a production API is not sent in a loop.

## Why a policy with a cap

`immediate` is right for some pages and wrong for a page with a half-filled
form. `when-hidden` waits for the tab to be hidden — the user is not looking,
the reload costs nothing they can see — and `on-navigation` waits for the
application's next route change, where a full load replaces a client-side
transition. Both are bounded by `maxDeferMs`: a deferred reload that never
happens is the stale tab all over again, with a policy as its excuse.

## Why the signal is a documented release step, not a framework action

The framework cannot know that a deploy happened; the deploy does. The
binding is one function so that a project's deploy script can send
`SIGUSR2` and be done — but the sending is the project's, named in its
release steps, where a reader of the repository finds it. The original's
missing sender is the argument: the binding was in the code, the sender was
in nobody's.

## Consequence

- `createReleaseMarker`, `createReleaseWatcher`, `browserReleaseHost`,
  `bindReleaseToSocketServer`, `observeReleaseFromSocket`, `RELEASE_HEADER`
  in `stitchkit/release`; `bindReleaseRefreshSignal` in `stitchkit/server`.
- `HandlerConfig.release` sets `X-Build-Id`; `DEFAULT_CORS_EXPOSE_HEADERS`
  includes it; `HttpClientConfig.release` reads it.
- The consumer that wrote the original replaces three files with two calls
  and gains the bundle-own baseline and a policy; the consumer with the
  compatibility layer can retire it; the consumer on polling gets the feature
  for the first time.

## Related

- ADR 0166 — the other mechanics moved out of consumers this week, and the
  same boundary: mechanics in, storage and deploy out.
- ADR 0013 — the Web Fetch-clean core the header rides on.
