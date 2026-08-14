---
title: "Deterministic starter SEO transport probe"
description: Separate browser metadata assertions from the single transport-level OG and sitemap reachability proof.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 23:43 +07:00
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
- [x] Push and require a full green final-SHA CI below three minutes — run
  [`31820477967`](https://github.com/max-listov/stitchkit/actions/runs/31820477967)
  passed in `2:20` for exact SHA `bf63c508601ab47521a5adf4024d9c6ac5537802`.

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
- [x] The final exact-SHA GitHub run is green below `3:00` — `2:20` wall-clock.
- [x] Package versions, release notes, tags and npm publications remain unchanged.

## Что сделано

- [x] **Shared starter smoke:**
  `packages/create-stitchkit/template/scripts/web-surface-smoke.ts` проверяет
  реальными HTTP-запросами `200`, `image/png`, непустой OG body и локализованный
  URL в sitemap без retry, sleep или расширения timeout.
- [x] **Blank composition:**
  `packages/create-stitchkit/template/scripts/runtime-smoke.ts` выполняет общий
  web-surface probe до Playwright.
- [x] **Repository composition:**
  `packages/create-stitchkit/examples/repository/scripts/runtime-smoke.ts`
  выполняет тот же общий web-surface probe до Playwright.
- [x] **Browser surface:** test `publishes complete page metadata` в
  `packages/create-stitchkit/template/e2e/starter.spec.ts` сохраняет проверки
  title, canonical, description и точного OG URL для Chromium, mobile Chromium
  и WebKit, не дублируя transport fetch между workers.
- [x] **Scaffold regression:** test
  `probes SEO transport once before browser-specific metadata checks` в
  `packages/create-stitchkit/tests/scaffold.test.ts` фиксирует обе runtime
  compositions, общий probe и отсутствие browser-owned `request.get`.
- [x] **Verification:** `bun --filter create-stitchkit test`, точный
  `head/repository/chromium` lane и полный `bun run verify` прошли локально;
  GitHub run `31820477967` прошёл целиком за `2:20`, сохранив все 150
  release-blocking browser cases.
- [x] **Что не делалось:** package versions, changelogs, release tags, npm
  publications и release workflow не изменялись.
