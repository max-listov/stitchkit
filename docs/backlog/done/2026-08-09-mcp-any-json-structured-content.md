---
title: MCP 2026 direct any-JSON structuredContent
description: Удалить legacy-обёртку non-object outputs и публиковать точную output schema и значение на modern MCP wire.
type: task
status: done
created: 2026-08-09
updated: 2026-08-09
completed: 2026-08-09 17:02 +00:00
related: docs/backlog/done/2026-08-09-mcp-2026-v2-release.md
---

# MCP 2026 direct any-JSON structuredContent

## Зачем

Спецификация MCP `2026-07-28` разрешает `outputSchema` с любым корневым JSON
типом и `structuredContent` с любым JSON-значением. Stitchkit всё ещё сохраняет
старое ограничение object-only: массив, scalar или `null` публикуются как
`{ result: value }`. Из-за этого modern consumer видит не контрактный output, а
искусственную framework-обёртку.

Framework должен передавать объявленную Zod output schema и успешно
провалидированное значение без изменения формы. Wire-адаптация разных protocol
eras является ответственностью официального MCP SDK, а не Stitchkit.

## Результат

- Любой JSON output публикуется в MCP ровно в форме контракта.
- `structuredContent` для object, array, string, number, boolean и `null`
  совпадает с результатом handler.
- Endpoint без output-контракта не получает выдуманный structured payload.
- Text content остаётся читаемым для модели и не расходится со structured value.

## План

- [x] Упростить `StructuredMode`: удалить режим `wrapped` и всю ветку
      `{ result: ... }` из canonical MCP formatter.
- [x] Передавать исходную `outputSchema` в SDK без object-only преобразования;
      продолжать fail-first schema conversion и portable-format validation на
      фактической схеме.
- [x] Формировать `structuredContent` по признаку объявленного output-контракта,
      а не по runtime truthiness или object shape; сохранить legal значения
      `null`, `false`, `0` и пустую строку.
- [x] Зафиксировать отдельную семантику endpoint без output: нет
      `structuredContent`, а content не содержит невалидный text block с
      `undefined`.
- [x] Провести одинаковую форму через contract tools, runtime tools и
      framework-owned native MCP presentation path.
- [x] Не менять raw multimodal presenter: его content blocks остаются
      consumer-owned, а framework добавляет только валидированный declared
      structured output.
- [x] Обновить API/reference, MCP guide, architecture, migration notes и
      `[Unreleased]` changelog с before → after примером массива/scalar.

## Acceptance

- [x] `output: z.array(z.string())` возвращает прямой массив в
      `structuredContent`, без `{ result }`.
- [x] String, number, boolean и nullable outputs сохраняют точное значение,
      включая `''`, `0`, `false` и `null`.
- [x] Object output остаётся прямым объектом без изменения поведения.
- [x] Объявленная output schema в `tools/list` совпадает с контрактной JSON
      Schema и не содержит искусственного свойства `result`.
- [x] Endpoint без output возвращает корректный content и не публикует
      `structuredContent`/`outputSchema`.
- [x] Output validation по-прежнему выполняется до MCP serialization;
      несовпадение остаётся contract violation, а не ослаблением схемы.
- [x] Modern HTTP и stdio transport round-trips подтверждают точную wire-форму.
- [x] Agent и CLI presentation не меняются случайно; изменение ограничено MCP
      semantics и общими явно используемыми formatter paths.

## Не входит

- Compatibility wrapper для старой `{ result }` формы.
- Consumer-specific output adapters.
- Ослабление runtime output validation.

## Источники

- <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- <https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2>

## Что сделано

- [x] **MCP formatter:** `packages/core/src/tools/mcp.ts` публикует точную
      контрактную JSON Schema и прямое validated значение для любого JSON root;
      endpoint без output не получает выдуманный payload.
- [x] **Contract/runtime/native paths:** общий formatter используется всеми
      framework-owned MCP registrations; raw multimodal presenter не менялся.
- [x] **Tests:** `packages/core/tests/mcp-v2-modern.test.ts`,
      `packages/core/tests/mcp-stdio-v2.test.ts`,
      `packages/core/tests/tools.test.ts` и stdio fixture покрывают object,
      array, scalars, null, no-output и официальный legacy codec.
- [x] **Docs:** `CHANGELOG.md`, `docs/guide/mcp-and-agents.md`,
      `docs/architecture/mcp-semantics.md` и `docs/api/reference.md` описывают
      прямую modern wire-форму.
- [x] **Что не делалось:** compatibility wrapper `{ result }`, consumer-specific
      adapters и ослабление output validation не добавлялись.
- [x] **Гейты:** targeted MCP matrix — 50/50; полный `bun run verify` зелёный,
      включая 985 core tests, Node smoke, packed consumer lane и starter E2E.
