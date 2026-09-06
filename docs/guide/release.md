# Release

A tab that outlives a release keeps running a bundle the server no longer
serves. `stitchkit/release` makes the page follow the release it was built
for: the server names its current frontend build, the browser compares that
to its own, and reloads under a policy you declare. Both halves are
**evolving**. → ADR 0167

## The server: a marker and two channels

```ts
import { readFileSync } from 'node:fs'
import { createReleaseMarker } from 'stitchkit/release'
import { bindReleaseRefreshSignal, createServer } from 'stitchkit/server'

// Where the *active* release wrote its build id. After a frontend-only
// release the backend may still run from an older root — read the pointer to
// the current one, not the process's own cwd. `null` means "no release": a
// dev server under HMR stays silent.
const release = createReleaseMarker({
  read: () => (env.RELEASE_ROOT ? readFileSync(`${env.RELEASE_ROOT}/current/frontend/.next/BUILD_ID`, 'utf8') : null),
  onError: (error) => logger.warn('release marker', error), // an unreadable file, a value that is not an id, a subscriber that threw
})

const server = createServer({ services, cors, release })

// A deploy that replaced the frontend without restarting the backend sends
// SIGUSR2; the marker re-reads and tells its subscribers.
bindReleaseRefreshSignal(release, { onRefresh: (r) => logger.info('build', r) })
```

With `release` configured, **every** response — success, error, raw route —
carries `X-Build-Id`, and `DEFAULT_CORS_EXPOSE_HEADERS` lets a cross-origin
page read it. That is the universal channel: any application that makes HTTP
requests has it, with no socket and no polling of its own.

Where a Socket.IO server exists, add the fast path:

```ts
import { bindReleaseToSocketServer } from 'stitchkit/release'

bindReleaseToSocketServer(io, release) // event `release` on connection and on change
```

A connection re-reads the file before it is answered, so a deploy signal the
process missed while it was down is repaired by the next client that connects.

Two things to keep straight: a custom `cors.exposeHeaders` **replaces** the
default list, so add `X-Build-Id` to yours or a cross-origin page cannot read
it; and do not list `SIGUSR2` in `bindProcessSignals` as well, or a deploy
would shut the server down.

## The deploy step

The framework binds the signal; **your release sends it**, after the new
frontend is active:

```bash
pm2 sendSignal SIGUSR2 my-backend      # or: kill -USR2 <pid>
```

Name it in the release steps of the project. A backend restart needs no
signal — the marker reads on start, and every reconnecting browser asks.

## The browser: a watcher and its feeds

```ts
import { createHttpClient } from 'stitchkit'
import { createReleaseWatcher, observeReleaseFromSocket } from 'stitchkit/release'

const release = createReleaseWatcher({
  own: env.NEXT_PUBLIC_BUILD_ID ?? 'dev', // what THIS bundle was built with; `dev` never reloads
  policy: 'when-hidden',           // or 'immediate' | 'on-navigation'
  maxDeferMs: 15 * 60 * 1000,
  onStale: () => toast('A new version is ready'),
})

const http = createHttpClient({ baseUrl, release })   // reads X-Build-Id from every response
observeReleaseFromSocket(socket, release)             // and the socket event, where there is one
```

`observe` compares to `own`, never to the first id it happened to hear — a
tab that loaded a cached bundle after the release is exactly the tab that must
reload. An `own` of `dev` (configurable via `ignore`), or no `own` at all,
never reloads, so a development bundle against a production API is not sent
in a loop. And one reload per id: the id a reload was attempted for is kept
in session storage, and if the page comes back and the server still names it,
the server is wrong about what it serves (a marker reading the wrong root, a
cached response) — the page stays, `stale()` is true, `onStale` has fired,
and nothing loops.

| Policy | Reloads |
|--------|---------|
| `immediate` | now — a chat, a dashboard |
| `when-hidden` | when the tab is next hidden, or at `maxDeferMs` — a page with forms |
| `on-navigation` | when you call `release.navigated()` on a route change, or at `maxDeferMs` — an SPA where a full load replaces a transition |

`browserReleaseHost()` is what the watcher reads from a tab; a test passes its
own `host` and drives visibility, the timer and `reload` by hand. Without a
`document` (server-side rendering) the default host is inert: `observe`
records the verdict and reloads nothing.

## Adopting it

1. Bake the build id into the bundle: `NEXT_PUBLIC_BUILD_ID=$(git rev-parse
   --short HEAD)` at build time, or Next's `generateBuildId`. Without it the
   watcher has no `own` and never reloads.
2. Point `read` at the id of the **active** release, not the process's cwd.
3. Add `release: (data: { buildId: string | null }) => void` to your
   `ServerToClientEvents` map where you type your socket, so your own `on`
   knows the event the binding emits.
4. Send `SIGUSR2` from the deploy step that activates a frontend without
   restarting the backend, and name that step in the project's release steps.
