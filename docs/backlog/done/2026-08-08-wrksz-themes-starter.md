---
title: Adopt @wrksz/themes across the official starter
description: Replace next-themes with the Next 16 server-first theme system and expose its production capabilities through the generated app
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 05:13 +00:00
---

# Adopt @wrksz/themes across the official starter

## Context

The official starter currently mounts `next-themes` inside the client provider tree and maintains a separate theme-aware image component plus unused View Transitions CSS. Replace that split implementation with one `@wrksz/themes` integration. The current stable package version verified from npm is `1.1.0`.

## Decisions

- Use `ThemeProvider` from `@wrksz/themes/next` directly in the server layout so Next 16 injects the anti-flash script through `useServerInsertedHTML`.
- Persist the global selection with `storage='hybrid'`: cookie-backed SSR state plus `localStorage` cross-tab synchronization.
- Keep the canonical application themes to `light` and `dark`; expose `system` as a selection without inventing an additional palette.
- Keep Tailwind's class-driven dark variant and semantic CSS tokens as the rendering source of truth.
- Use fine-grained client imports and an explicit `AppTheme` union for typed `useTheme` calls.
- Use property-scoped transition suppression so theme changes do not animate colors while opacity and scale interactions remain intact.
- Use the library's `ThemedImage` directly. Do not retain a local compatibility component or parallel image-switching path.
- Demonstrate nested/scoped and forced themes only inside the UI catalogue; the application shell keeps one global theme state.

## Plan

### Dependency and root composition

- [x] Replace `next-themes` with latest stable `@wrksz/themes` in the generated web package; generated apps create their Bun lockfile during installation, so the template has no parallel lockfile to refresh.
- [x] Move theme ownership out of the client `Providers` component and into `[locale]/layout.tsx` using `@wrksz/themes/next`.
- [x] Add one server-safe theme configuration module containing the theme union, theme list, storage key, per-theme browser colors and transition policy.
- [x] Configure hybrid persistence, system selection, native `color-scheme`, `themeColor` and targeted transition suppression from that shared configuration.

### Typed client consumption

- [x] Replace every `next-themes` hook import with fine-grained `@wrksz/themes/client` subpaths.
- [x] Make the theme controls hydration-safe with `useHydrated`; preserve stable dimensions and accessible labels before hydration.
- [x] Expose explicit Light, Dark and System choices rather than only a binary toggle, while retaining the compact header control.
- [x] Use `useThemeValue` where the UI maps resolved theme to labels or third-party component configuration.
- [x] Use `useThemeEffect` only in the catalogue's observable theme demo, not for duplicate application state.

### Theme-aware media and catalogue

- [x] Delete the custom `ui/themed-image.tsx` implementation and update all call sites to the library's typed `ThemedImage` API.
- [x] Add a dedicated theme-system catalogue surface showing selected, resolved and operating-system themes.
- [x] Demonstrate `ClientThemeProvider` with independent forced light and dark scoped targets using `storage='none'`.
- [x] Demonstrate the server-readable cookie theme with `getTheme` in a Server Component without making it a second source of truth.
- [x] Document why `followSystem`, custom theme names, server-side account persistence and CSP nonce wiring remain opt-in application decisions rather than starter defaults.

### Cleanup and documentation

- [x] Remove dead manual View Transitions theme CSS and all remaining `next-themes` references.
- [x] Update the generated starter README and frontend integration guide with the chosen storage and server/client import boundaries.
- [x] Add authored-source guards that fail if `next-themes` or the removed local theme provider returns.

### Verification

- [x] Add focused tests for dependency/config scaffolding and the absence of the previous theme path.
- [x] Extend Playwright coverage across Chromium, mobile Chromium and WebKit for hydration, Light/Dark/System switching, persistence, cross-tab synchronization, scoped themes, theme-aware media and browser theme color.
- [x] Verify no hydration or React 19 inline-script warnings appear in browser console or server logs.
- [x] Run the full `bun run verify` packed-consumer gate.
- [x] Validate both the directly runnable canonical template and an actual packed generated application.

## Acceptance

- [x] `next-themes` is absent from dependencies, source, lockfiles and generated output.
- [x] The root theme provider is server-first and no client wrapper owns global theme state.
- [x] A stored theme reaches the server/prepaint path without a visible production flash, and changes synchronize across tabs.
- [x] Theme names and mappings are checked by TypeScript without type assertions.
- [x] The UI catalogue teaches global, system, server-readable, forced and scoped theme use through real components.
- [x] There is one theme implementation, one configuration source and no compatibility wrapper.
- [x] The packed generated app builds and all browser/runtime gates are green.

## Non-goals

- Do not add invented palettes solely to showcase arbitrary custom theme names.
- Do not persist theme preferences in the application database; hybrid browser storage is the starter default.
- Do not introduce theme analytics, consent rules or CSP nonce generation without an application requirement.

## Что сделано

- [x] **Dependency / root:** `packages/create-stitchkit/template/packages/frontend/package.json`, `src/app/[locale]/layout.tsx` and `src/theme/config.ts` now provide one stable `@wrksz/themes@1.1.0` server-first integration with hybrid persistence.
- [x] **Client:** `src/components/app-shell/system-controls.tsx` and `src/components/ui/toaster.tsx` use fine-grained typed hooks with hydration-safe Light, Dark and System controls.
- [x] **Media / catalogue:** direct library `ThemedImage` usage replaced the local wrapper; `src/components/catalogue/theme-story.tsx` and `theme-story-client.tsx` demonstrate global, server-readable, forced and scoped themes.
- [x] **Styling / cleanup:** `src/app/globals.css` keeps semantic tokens and class-scoped themes while the previous client provider, custom image wrapper and dead transition CSS were removed.
- [x] **Documentation / guards:** the starter README, `docs/guide/frontend-integrations.md`, authored-source checker and scaffold tests describe and enforce the single supported path.
- [x] **Verification:** `bun run verify` passed completely, including the packed starter, production builds, Node smoke, consumer lane and 12 Playwright tests across Chromium, mobile Chromium and WebKit.
- [x] **Runtime:** the canonical template and a fresh generated application expose the dedicated `/en/ui/themes` surface with clean runtime logs.
- [x] **Не делалось:** no extra palettes, database persistence, analytics, compatibility wrappers or application-specific CSP policy were introduced.
