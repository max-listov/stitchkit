---
title: Sidebar navigation wrapping
description: Keep localized navigation labels inside desktop and mobile sidebar boundaries.
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 08:08 +00:00
---

## Plan

- [x] Remove the unconditional no-wrap rule from expanded sidebar labels.
- [x] Give links and labels the flex boundaries required for wrapping inside the sidebar.
- [x] Preserve the single-line hidden label behaviour of the collapsed desktop sidebar.
- [x] Add a mobile regression using the longest Russian catalogue labels.
- [x] Validate the fix through the canonical template's HMR process.

## Acceptance

- [x] Every expanded navigation label remains inside its link and sidebar.
- [x] Long localized labels wrap onto multiple lines without clipping or truncation.
- [x] Mobile drawer and desktop sidebar keep their existing widths and interaction model.
- [x] The page has no horizontal overflow after opening mobile navigation.

## Что сделано

- [x] **UI:** `packages/create-stitchkit/template/packages/frontend/src/components/ui/sidebar.tsx`
  gives every navigation link and label a bounded flex width and allows expanded labels to wrap.
- [x] **Collapsed state:** the desktop collapsed label remains single-line and visually hidden;
  icon alignment and navigation interaction are unchanged.
- [x] **Regression:** `packages/create-stitchkit/template/e2e/starter.spec.ts` opens the Russian
  mobile drawer and asserts zero drawer, label and document horizontal overflow.
- [x] **Live validation:** at 390 CSS pixels every Russian label has
  `scrollWidth === clientWidth`; the longest labels wrap to two lines and the document overflow
  is zero. The targeted Chromium regression passed.
- [x] **Не делалось:** build, full verify, commit, release and deploy were not run.
