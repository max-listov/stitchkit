---
title: Frontend integrations
description: Compose Stitchkit with Next.js, React Router or a separate Vite development server
type: architecture
status: active
created: 2026-08-08
updated: 2026-08-08
---

# Frontend integrations

The official `bun create stitchkit` application uses Next.js with a separate
Bun API. Stitchkit remains a Fetch-native backend and does not own frontend
routing, SSR or HMR.

## Theme boundary in the official starter

The generated Next.js application uses `@wrksz/themes`, not a Stitchkit-owned
theme abstraction. Its root `ThemeProvider` comes from `@wrksz/themes/next` and
lives directly in the server layout so Next 16 can inject the first-paint script
through `useServerInsertedHTML`. The default `hybrid` storage reads a cookie
during SSR and mirrors changes to localStorage for cross-tab synchronization.

Client components import typed hooks from the fine-grained
`@wrksz/themes/client/*` entrypoints. Nested visual examples use
`ClientThemeProvider` with a scoped target and `storage="none"`; they never
become a second global provider. Applications may add account-backed theme
preferences, CSP nonces or consent-aware storage, but those policies remain
application concerns.

Theme state and theme animation are intentionally separate. `@wrksz/themes`
owns selection, resolution, SSR prepaint and persistence. The generated app's
`theme/transition.ts` wraps an interactive `setTheme` call with the native View
Transition API and exposes typed style, duration, easing and origin settings.
The default 250 ms crossfade matches the starter's visual language; the
catalogue also demonstrates a radial reveal. The runner bypasses animation when
the browser lacks the API or `prefers-reduced-motion: reduce` is active.

## React Router

Mount a `createHandler()` result in a catch-all resource route and pass the
incoming `Request` through unchanged. Mount MCP as a second resource route. An
SSR request creates its own typed client using that request's origin and auth;
do not share request identity in a module singleton.

```ts
export async function loader({ request }: LoaderFunctionArgs) {
  return apiHandler(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return apiHandler(request);
}
```

## Vite

Run Vite and the Stitchkit API as separate development processes. Declare one
proxy for `/api`, `/mcp` and `/socket.io`; browser code still calls the typed
client with same-origin paths. Production serves the static Vite output from a
static host or reverse proxy and routes those backend paths to Stitchkit.

Do not duplicate DTOs or handwritten API wrappers in either integration. The
shared contract remains the only transport schema source.
