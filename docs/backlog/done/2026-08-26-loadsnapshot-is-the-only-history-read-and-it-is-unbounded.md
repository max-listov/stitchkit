---
title: loadSnapshot is the only history read, and it is unbounded
description: The single way to read a conversation returns every message and every run, so paged history cannot be added without breaking the store contract.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 03:30 +00:00
---

## Зачем

`AgentRuntimeStore.loadSnapshot(conversationId)` returns **all** messages and
**all** runs, and the driver member behind it — `history.load(tx, conversationId)`
— takes no cursor and no limit. It is called on every run, and again in the
executor's catch path.

The irony is written into the codebase already. `scanRecoverable`'s own doc says
*"recovery must not depend on loading every recoverable conversation into memory
to start"*, and that reasoning was never applied to the conversation itself. A
long-running assistant conversation is exactly the thing that grows without
bound, and compaction reduces it only when an application has configured
compaction.

**Why this matters now rather than later:** the next obvious capabilities —
paged history, "the last N turns", a read of one run by id — cannot be added
without either changing `loadSnapshot`'s contract or adding a required driver
member. Both are breaking, and the driver is where ADR 0111 just moved the
stability promise. A surface that cannot grow additively in the direction it
obviously must grow is not ready to be declared stable.

Related and smaller, from the same read: there is **no per-run read at all**.
`submit().admission` hands back a `runId`, and the only way to resolve it is to
load the whole conversation and search.

## Результат

- A conversation can be read in bounded pieces, and a run can be read by id,
  without a future breaking change to do it.

## План

- [x] Decide the read shape before anything else: a cursor on `history.load`, a
      separate paged member, or a projection the runtime asks for by intent
      ("what I need to build a prompt") rather than by range.
- [x] Decide whether the driver gains an optional member — the driver has **no
      optional members today**, so "additive growth" has no mechanism there and
      that is its own decision.
- [x] Add a per-run read, or state why `loadSnapshot` is the only supported way
      to resolve a `runId` and make the guide say it.
- [x] Whatever is decided must be reflected in the conformance kit, or adapters
      will implement it three different ways.

## Acceptance

- [x] A conversation of ten thousand messages can be run against without loading
      all of them, or the guide states the limit and the mitigation plainly.
      — **вторая ветка**: гайд называет предел и смягчение (компакцию); ADR 0112
      записывает, почему постраничная история — отдельное решение.
- [x] A `runId` resolves through a supported call.
- [x] The conformance kit covers whatever member is added.

## Что сделано

### Решение (ADR 0112)

Считать вызовы оказалось важнее, чем проектировать курсор: из восьми
`loadSnapshot` в рантайме **семь никогда не касались ни одного сообщения**, и
один из них — проверка fencing — выполняется **перед каждым вызовом
инструмента**. Двадцать инструментов в разговоре на пять тысяч сообщений читали
сто тысяч сообщений, чтобы сравнить два числа.

Поэтому: не курсор, а два чтения по намерению. И **драйверу не понадобилось
ничего нового** — `runs.load`, `runs.listActive` и `head.load` уже были, их
просто никто не спрашивал.

История осталась целой сознательно: снапшот — это то, против чего редьюсер
проверяет свои инварианты (позиции прогонов, непрерывность диапазона компакции,
зарезервированные идентичности), и окно превратило бы каждый из них в
утверждение об окне. Это отдельная переработка, а не увеличенная версия этой.

### Core

- [x] `packages/core/src/agent-runtime/store.ts` — `AgentRunViewSchema`,
      `loadRun`, `listActiveRuns`; у `loadSnapshot` теперь написано, чего он
      стоит.
- [x] `packages/core/src/agent-runtime/store-driver.ts` — реализация обоих,
      только через `runs.*` и `head.load`.
- [x] Семь мест переведены на них: вход `executeRun`, `assertCurrent`, ветка
      `catch` исполнителя (`run-execution.ts`), конфликтный путь
      `commitAgentRunTerminal` (`terminal-commit.ts`), `resume`, `interrupt`,
      `recover` (`runtime.ts`).
- [x] `AgentTerminalCommitResolution` носит `snapshotVersion` вместо целого
      `AgentSnapshot`, из которого читалось одно поле; `run-execution.ts` ведёт
      `observedVersion` отдельно от `snapshot`, который остался тем, чем и был —
      историей, из которой собран prompt.
- [x] **Найденный по дороге дефект:** цикл повтора терминального CAS был
      неограниченным. Стор, который конфликтует вечно, продолжая сообщать
      прогон, который этот исполнитель ещё вправе закоммитить, превращал его в
      горячий цикл, который никогда не возвращается и ничего не сообщает — на
      пути, который сохраняет ответ прогона. Теперь 32 попытки и обычный отказ.

### Tests

- [x] `packages/core/tests/agent-runtime-bounded-reads.test.ts` — 6 тестов:
      считающий стор доказывает, что целый ход не читает разговор; `interrupt`
      читает прогон; `loadRun` резолвит `runId` из `admission` и несёт ответ;
      границы разговора; `listActiveRuns` пустеет; ограниченный цикл повтора.
- [x] `packages/core/src/testing/agent-store-conformance.ts` — оба члена,
      включая «живой прогон не отдаёт терминальный ответ» и «завершённый уходит
      из активных».
- [x] `packages/core/tests/agent-runtime-terminal.test.ts` — фикстура дрейфа
      владельца теперь дрейфует оба чтения. Именно она поймала, что подмена
      только `loadSnapshot` оставляет бесконечный цикл — так и нашёлся дефект
      выше.
- [x] Фальсификация: откат `interrupt`-чтения и откат границы цикла — оба
      обрушили тест.

### Docs

- [x] `docs/decisions/0112-a-run-is-read-without-its-conversation.md` + строка в
      `docs/decisions/README.md`.
- [x] `docs/guide/agent-runtime.md` — раздел *Reading a conversation*.
- [x] `docs/api/reference.md`, `CHANGELOG.md`,
      `docs/guide/upgrading.md`, `packages/core/tests/fixtures/public-surface.json`.

### Чего не сделано

- **Постраничная история не сделана**, и это записанное решение, а не пропуск:
  ADR 0112 объясняет, почему она меняет то, чем является снапшот, и что
  сегодняшний ответ — компакция. Предел назван в гайде.
