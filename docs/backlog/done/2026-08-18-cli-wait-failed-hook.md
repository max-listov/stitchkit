---
title: "CliWaitConfig.failed — терминальный FAILED в --wait не должен давать exit 0"
description: Запрос потребителя (CLI поверх implementRemote): --wait на терминальном FAILED-статусе завершается exit 0 — агент принимает провал за успех. Нужен хук failed?(result) или эквивалент.
type: task
status: done
created: 2026-08-18
updated: 2026-08-20
completed: 2026-08-20 13:57 +00:00
---

# `CliWaitConfig.failed?(result)`

## Зачем

Потребительский CLI с `--wait`: терминальный `FAILED` результата ожидания
сегодня неотличим от успеха — exit 0, агент-вызыватель принимает провал за
успех. Запрошен хук вида `failed?(result)` в `CliWaitConfig`, чтобы CLI мог
маппить терминальный провал в ненулевой exit.

## Результат

- `CliWaitConfig.failed?(result)` классифицирует успешный transport-result как
  терминально провалившуюся operation; такой результат становится
  `ToolResult` с кодом `WAIT_FAILED`, исходным terminal payload в details и
  обычным ненулевым CLI exit.
- `failed` проверяется и для initial result, и для каждого poll-result; он
  имеет приоритет над `done`, поэтому противоречивые predicates fail closed.
- Transport/tool errors и timeout сохраняют существующие коды и поведение.

## План

- [x] Добавить additive `failed?: (result: unknown) => boolean` в
      `CliWaitConfig` и одну internal terminal-classification функцию без
      дублирования initial/poll веток.
- [x] Остановить polling по `failed` или `done`; failed terminal payload
      вернуть как caller-safe `WAIT_FAILED`, не перепутывая его с polling
      transport error или timeout.
- [x] Покрыть initial FAILED, polled FAILED, приоритет failed над done и
      unchanged COMPLETED/transport-error paths unit + CLI regressions.
- [x] Обновить CLI guide, API reference и Unreleased changelog.
- [x] Прогнать полный `bun run verify`; релиз не входит.

## Acceptance

- [x] `--wait` на terminal domain failure завершается ненулевым exit и печатает
      structured `WAIT_FAILED` в stderr.
- [x] Исходный terminal payload доступен в error details для automation.
- [x] Success, timeout и failed tool-call semantics не меняются.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Core: `packages/core/src/tools/cli-wait.ts` классифицирует initial и
      polled terminal failures в `WAIT_FAILED`; `packages/core/src/tools/cli-format.ts`
      фиксирует default exit `1`.
- [x] Docs: `docs/guide/cli.md`, `docs/api/reference.md`, `CHANGELOG.md` и
      generated `packages/core/llms*.txt` описывают predicates, payload и codes.
- [x] Регрессия: packages/core/tests/cli.test.ts::terminal domain failure becomes WAIT_FAILED with a non-zero exit; packages/core/tests/cli.test.ts::failed is checked on the initial result and takes priority over done; packages/core/tests/cli.test.ts::a failed poll call keeps its transport error instead of becoming WAIT_FAILED
