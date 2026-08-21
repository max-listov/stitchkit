---
title: "Transport- and role-projected surface manifests"
description: Сделать manifest правдивым для разных HTTP, MCP, Agent и CLI selections, finite role surfaces и tool extend schemas.
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
related: docs/decisions/0093-transport-projected-and-realtime-conformance.md
---

# Transport- и role-projected surface manifests

## Зачем

`buildSurfaceManifest` сейчас объединяет `services` и `groups` в одну таблицу
operations, а затем выводит MCP/Agent/CLI доступность из всего объединения.
Реальный runtime часто монтирует полный HTTP registry, отдельный MCP surface,
сокращённый Agent surface и explicit CLI subset. Manifest в таком случае
заявляет tools, которых transport фактически не монтирует.

MCP уже поддерживает конечный `surfaces` registry с role-selected ключом, а
tool mounts поддерживают `extend`; conformance manifest не умеет выразить ни
то, ни другое и поэтому не может быть source of truth для discovery.

## Результат

- Manifest получает явную transport topology: HTTP groups/services и отдельные
  MCP/Agent/CLI `ToolSurfaceDefinition` selections.
- Finite named MCP surfaces snapshot'ятся детерминированно и проверяются по
  выбранному ключу без auth values в manifest. Agent и CLI получают explicit
  static projections; новый runtime role-selector им не приписывается.
- `ToolExtend`, `flattenUnionInput` и MCP schema-validation exclusion
  учитываются через ту же presentation/preparation machinery, что и
  реальный mount; digest меняется при изменении применённого extend и не меняется
  для отфильтрованной операции.
- Общая поверхность остаётся удобным осознанным shorthand, но explicit
  transport selection заменяет, а не неявно дополняет её.
- Невозможные/дублирующиеся topology claims падают при build, а не создают
  правдоподобный ложный snapshot.

## План

- [x] Сверить source of truth с `collectToolSurface`, MCP finite surfaces,
      Agent mount, CLI selection и HTTP groups.
- [x] Определить `manifestVersion: 2`: canonical operations отдельно от
      `toolSurfaces[]` rows с transport, optional key, tool name и advertised
      presentation digest; `digestVersion` не менять без смены canonicalizer.
- [x] Строить tool names и schema digests через canonical mounted presentation,
      включая `extend`/filter и runtime tools.
- [x] Расширить discovery assertion выбранным named surface и точной
      transport-specific topology.
- [x] Покрыть полный HTTP + сокращённые MCP/Agent + CLI-only, две role surfaces,
      extend applied/skipped (runtime tools не расширяются), flattening,
      schema-policy exclusion, collision, sorted determinism и snapshot drift.
- [x] Обновить ADR/reference/testing guide/generated docs/changelog и packed
      public surface.

## Acceptance

- [x] Один manifest не заявляет MCP/Agent/CLI operation только потому, что она
      смонтирована по HTTP.
- [x] Role-selected MCP surface сравнивается с фактическим discovery по тому же
      declared key.
- [x] Extend schema digest совпадает с реально advertised tool schema.
- [x] Existing shared-surface case остаётся коротким и однозначным.
- [x] Manifest bytes детерминированы независимо от object insertion order.
- [x] Multi-mount одной operation по разным HTTP paths допустим; две разные
      definitions под одной identity отвергаются.
- [x] Изменение shape оформлено как breaking manifest-v1→v2 migration.
- [x] `bun run verify` зелёный.

## Конвейер 2/2

- [x] Plan validator 1/2 — уточнены v2 projection rows и реальные runtime selectors.
- [x] Plan validator 2/2 — добавлены prepare policy и полная сортировка.
- [x] Implementation validator 1/2 — PASS: public projection types описывают
      только реально mountable topology и не тянут optional peers.
- [x] Implementation validator 2/2 — PASS: shared canonical projector,
      HTTP-only groups, semantic collision guard и consumer lane проверены.

## Что сделано

- [x] Core: manifest v2 разделяет canonical operations, HTTP mounts и точные
      MCP/Agent/CLI projections; named MCP surfaces используют одну global
      preparation policy, а HTTP `groups` не расширяют tool surfaces.
- [x] Architecture: runtime mounts и manifest используют один peer-free
      projector; `ToolExtend`/manifest extension имеют одну executable shape с
      обязательным resolver; distinct definitions не сливаются как multi-mount.
- [x] Регрессии:
      `packages/core/tests/surface-conformance-kit.test.ts::projects named MCP selections through one reachable global preparation policy`;
      `packages/core/tests/surface-conformance-kit.test.ts::rejects semantic identity drift while allowing one service at multiple HTTP mounts`;
      `packages/core/tests/surface-conformance-kit.test.ts::requires every projected tool extension to be executable by a real mount`;
      `packages/core/tests/surface-conformance-kit.test.ts::manifests contract, runtime and CLI-only surfaces with actual topology`.
