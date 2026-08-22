---
title: "Agent runtime entrypoints, docs and release proof"
description: "Поставить coherent optional runtime surface с isolated peers, packed fixtures и upgrade-grade docs."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-runtime-product-contract.md
---

# Agent runtime entrypoints, docs and release proof

## Зачем

Engine уменьшит consumer code только как цельный importable surface. При этом base Stitchkit не
должен резолвить AI/provider packages. Consumer migrations принадлежат backlog каждого consumer и
создаются с отдельной authority после опубликованной версии; публичная Stitchkit task ими не владеет.

## Результат

- Server-only `stitchkit/agent-runtime` exports coherent neutral API with optional `ai` peer;
  browser-safe root его не реэкспортирует.
- `stitchkit/agent-runtime/openrouter` isolates provider dependency.
- Testing support remains internal until external use justifies `stitchkit/testing` export.
- Packed Bun/Node fixture demonstrates protocol/store/models/prompt/tools/runs/events/observability.
- Guide, API reference, architecture/ADR links, generated llms sources and changelog synchronized.
- Release classification follows actual compatibility: additive API is patch; changed existing
  public behavior/signature is breaking minor pre-1.0 with exact migration.

## План

- [x] Define exports, optional peers and build graph.
- [x] Build starter-quality packed Bun/Node fixture using only public API.
- [x] Write minimal-to-production guide and API reference.
- [x] Verify generated llms sources and package contents.
- [x] Record greenfield wiring/deletion measurement method without private identities.
- [x] Prepare changelog according to accepted API; release task waits for green gates.
- [ ] Через local packed package предложить pilot и structurally different migration tasks в
  consumer-owned backlogs только с отдельной authority; gaps возвращаются к framework owner.

## Acceptance

- [x] Base Stitchkit and neutral runtime imports do not resolve provider module.
- [x] No partial public module ships before its dependent invariants are coherent.
- [ ] Packed package passes Bun/Node conformance/race lane.
- [x] Fixture wiring contains no copied engine internals.
- [x] Public artifacts contain no private consumer identity.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: package ergonomics, docs journey and integration usefulness.
- [x] Plan validator 2: dependency isolation, release classification and proof strategy.
- [ ] Implementation validator 1: packed package/API/docs/generated sources.
- [ ] Implementation validator 2: Bun/Node, optional peers and compatibility gates.

## Проверено

- `bun run verify` builds generated `llms.txt`/`llms-full.txt`, checks public types, packs the package,
  imports every Node entrypoint and runs minimal/full/Node consumers from the tarball.
- `packages/core/scripts/consumer-lane/fixtures/full/src/agent-runtime-neutral.ts` bundles and executes
  without resolving the isolated provider package.
- Полный packed conformance/race manifest и consumer-owned migrations остаются открытыми.
