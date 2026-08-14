---
title: "Deterministic starter SEO transport probe"
description: Separate browser metadata assertions from the single transport-level OG and sitemap reachability proof.
type: task
status: in-progress
created: 2026-08-14
updated: 2026-08-14
related: docs/backlog/done/2026-08-14-ci-release-critical-path.md
---

# Deterministic starter SEO transport probe

## Зачем

Final CI run `31819559914` kept the optimized graph below three minutes but one
HEAD repository Chromium cell failed when the mobile worker received
`ECONNRESET` while requesting the dynamic Open Graph image. The Next.js process
remained live and served the other worker. The browser metadata test currently
mixes two responsibilities: browser-specific DOM metadata and browser-agnostic
HTTP reachability, so Chromium and mobile Chromium generate the same dynamic
image concurrently against one disposable server.

Retrying the request would hide the race. The transport proof belongs in the
already sequential runtime smoke; browser projects should prove only the
metadata rendered for their browser surface.

## Результат

- Every generated application proves its OG image and sitemap over real HTTP
  exactly once before browser execution.
- Chromium, mobile Chromium and WebKit still verify complete page metadata.
- The browser matrix retains all 150 required cases without concurrent duplicate
  image generation or retry configuration.

## План

- [x] Add one reusable web transport probe to the neutral template.
- [x] Call it from both neutral and repository runtime-smoke compositions.
- [x] Keep canonical, title, description and exact OG URL assertions in the
  browser test; remove only browser-agnostic HTTP fetches.
- [x] Add a scaffold-level guard that both runtime compositions call the shared
  probe and the browser test no longer fetches the image.
- [x] Run the complete local verification gate — `bun run verify` passed.
- [ ] Push and require a full green final-SHA CI below three minutes.

## Acceptance

- [x] The runtime smoke requires the OG route to return `200`, `image/png` and a
  non-empty body.
- [x] The runtime smoke requires the sitemap to return `200` and contain the
  localized theme-system URL.
- [x] Browser tests still verify the exact metadata URL in Chromium, mobile
  Chromium and WebKit.
- [x] No retry, sleep, timeout increase or reduced test matrix is introduced.
- [x] The complete CI remains 33 blank plus 42 repository cases in both target
  and HEAD modes: 150 release-blocking browser cases.
- [ ] The final exact-SHA GitHub run is green below `3:00`.
- [x] Package versions, release notes, tags and npm publications remain unchanged.
