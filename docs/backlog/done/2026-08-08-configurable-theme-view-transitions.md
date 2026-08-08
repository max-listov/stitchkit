---
title: Configurable theme View Transitions in the official starter
description: Restore smooth theme switching with the native View Transition API while keeping @wrksz/themes as the single theme state owner
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 05:25 +00:00
---

# Configurable theme View Transitions in the official starter

## Context

`@wrksz/themes@1.1.0` manages theme state, persistence and prepaint SSR correctly, but does not wrap theme changes in `document.startViewTransition()`. The starter also configured `disableTransitionOnChange` for color properties, making every interactive switch intentionally immediate. Restore the native snapshot transition without introducing a second theme state or a compatibility wrapper.

## Plan

- [x] Add one typed transition runner with a smooth crossfade default, an optional radial reveal, configurable duration/easing and click-origin support.
- [x] Fall back to an immediate theme update when View Transitions are unavailable or reduced motion is requested.
- [x] Remove `disableTransitionOnChange` from the theme provider configuration and suppress component-level CSS transitions only while native snapshots are captured.
- [x] Route every global theme control through the same runner.
- [x] Add interactive effect and duration controls to the theme catalogue so consumers can compare configurations on the real page.
- [x] Document the boundary: `@wrksz/themes` owns state; the starter transition runner owns presentation only.
- [x] Add scaffold and browser regression coverage for native View Transition invocation, cleanup, fallback and persisted theme behavior.
- [x] Run the direct template and packed-consumer gates.

## Acceptance

- [x] Theme changes are visibly smooth in a supporting browser and never double-animate component CSS.
- [x] The catalogue can switch between crossfade and radial reveal and choose transition speed.
- [x] Reduced-motion and unsupported browsers update immediately and safely.
- [x] Light, Dark and System selection, hybrid persistence and cross-tab synchronization remain intact.
- [x] No parallel theme provider, local theme state or type assertion is introduced.

## Non-goals

- Do not patch or fork `@wrksz/themes`; its public API already provides the state update primitive needed by the presentation layer.
- Do not animate scoped forced-theme examples, because those are static demonstrations rather than user-triggered global changes.

## Что сделано

- [x] **Transition runner:** `packages/create-stitchkit/template/packages/frontend/src/theme/transition.ts` owns typed crossfade/radial presentation config, origin coordinates, native API invocation and deterministic cleanup.
- [x] **Theme boundary:** `src/theme/config.ts` no longer suppresses theme colors; `@wrksz/themes` remains the only state, SSR and persistence owner.
- [x] **Global controls:** `src/components/presentation/system-controls.tsx` uses the shared 250 ms crossfade default.
- [x] **Catalogue:** `src/components/catalogue/theme-story-client.tsx` exposes Crossfade/Radial reveal and 150/250/400 ms controls, with radial origin taken from the clicked theme button.
- [x] **CSS:** `src/app/globals.css` defines snapshot layering, crossfade/radial keyframes, component-transition suppression during capture and reduced-motion behavior.
- [x] **Documentation:** the generated README and `docs/guide/frontend-integrations.md` describe the state/presentation boundary and configuration surface.
- [x] **Verification:** scaffold guards pass; packed production starter and runtime lanes pass; Playwright reports 15/15 across Chromium, mobile Chromium and WebKit, including reduced-motion fallback.
- [x] **Verification:** the canonical template and packed generated application were validated through their normal development and release lanes.
- [x] **Не делалось:** `@wrksz/themes` was not forked, and no duplicate provider, compatibility path or database-backed preference was added.
