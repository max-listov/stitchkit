---
title: Catalogue explorer shell
description: Replace the catalogue card-and-back flow with persistent responsive navigation around every UI story.
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 06:18 +00:00
---

# Catalogue explorer shell

## Goal

Make the UI system fast and enjoyable to inspect: all story sections remain one
tap away while the selected story occupies the main content surface.

## Plan

1. Move the shared catalogue chrome into the `/ui` route layout so navigation
   persists while story routes change.
2. Use the existing responsive Sidebar primitive for labelled desktop
   navigation and a drawer on mobile, with the active story derived from the URL.
3. Redirect `/ui` to the first real story instead of showing an intermediate
   card index; keep every `/ui/:story` URL directly addressable and prefetchable.
4. Keep the content region independently scrollable inside a fixed app shell and
   preserve accessible headings, landmarks, focus targets and mobile viewport fit.
5. Add responsive E2E coverage for opening the navigator, switching sections and
   retaining the canonical URL, then run the affected gates.

## Acceptance

- [x] Desktop shows a persistent labelled story sidebar beside the content.
- [x] Mobile exposes the same story list through a compact drawer trigger.
- [x] Selecting a story changes only the content surface and highlights its nav item.
- [x] `/ui` resolves directly to a real story; all story deep links remain valid.
- [x] The shell itself stays fixed while long story content scrolls independently.
- [x] Chromium, WebKit, mobile, accessibility, lint and typecheck gates are green.

## Что сделано

- [x] Route-level catalogue chrome now lives in
  `packages/create-stitchkit/template/packages/frontend/src/app/[locale]/ui/layout.tsx`, with
  the responsive navigation in
  `packages/create-stitchkit/template/packages/frontend/src/components/catalogue/catalogue-navigation.tsx`.
- [x] `/ui` redirects locale-safely to `/ui/primitives`; story routes retain direct,
  prefetchable URLs and render only their story surface.
- [x] `packages/create-stitchkit/template/packages/frontend/src/components/catalogue/catalogue-shell.tsx`
  provides the fixed shell, independent content scroll and compact mobile header.
- [x] `packages/create-stitchkit/template/packages/frontend/src/components/ui/sidebar.tsx` now
  keeps its runtime media query and Tailwind breakpoint in sync and exposes the active
  destination with `aria-current`.
- [x] `packages/create-stitchkit/template/e2e/starter.spec.ts` covers redirect,
  desktop/mobile switching, active state, independent scrolling and accessibility.
- [x] Local preview scaffolding now excludes dependency/build artifacts in
  `packages/create-stitchkit/src/scaffold.ts`; the regression is covered by
  `packages/create-stitchkit/tests/scaffold.test.ts`.
- [x] Packed consumer lane passed against published `stitchkit@0.42.0`: DB, HTTP,
  OpenAPI, Socket.IO, MCP, CLI, build, typecheck, lint and 18 Chromium/WebKit/mobile E2E.
- [x] The canonical template and packed consumer lane were validated; no package
  release or consumer migration was performed.
