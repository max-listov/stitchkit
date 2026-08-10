---
title: Clarify dual-era MCP output semantics
description: Make modern exact JSON roots and official legacy result wrapping unambiguous during consumer upgrades.
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 04:10 +00:00
---

## Зачем

The 0.44.0 changelog correctly assigns legacy adaptation to the official SDK,
but a consumer can still read the non-object output change as applying equally
to every negotiated protocol era. The upgrade guide should state the two wire
shapes explicitly so migration tests do not replace a correct legacy expectation
with the modern one.

## Результат

- The 0.44.0 changelog names both modern and legacy non-object output shapes.
- The upgrade guide includes a minimal dual-era consumer regression example.
- No runtime behavior, dependency policy or advertised capability changes.

## План

- [x] Clarified the released changelog entry without changing its semantics.
- [x] Added an explicit output compatibility table and consumer-test example.
- [x] Verified the documentation against the existing modern and legacy regression tests.

## Acceptance

- [x] Modern `2026-07-28` output is documented as the exact schema-valid JSON root.
- [x] Supported legacy output is documented as official SDK adaptation of non-object values to `{ result: value }`.
- [x] Empty-server capabilities and the ext-apps transitive peer remain unchanged.

## Что сделано

- [x] Documentation — [CHANGELOG.md](../../../CHANGELOG.md) now shows both negotiated wire shapes directly.
- [x] Migration guide — [upgrading.md](../../guide/upgrading.md) contains the compatibility table and a pinned dual-era consumer E2E pattern.
- [x] Generated consumer context — `bun run gen:llms` regenerated the ignored package artifacts from the canonical guide.
- [x] Validation — the focused modern and legacy MCP suites pass: 34 tests, 0 failures.
- [x] Runtime and dependencies — intentionally unchanged; empty tool capability negotiation and the ext-apps peer remain SDK-owned.
