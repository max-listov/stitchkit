---
title: "The agent store contract stops demanding a dead unbounded scan"
description: "AgentRuntimeStore требует обязательный неограниченный scanRecoverable, который рантайм не зовёт никогда, и делает опциональным scanRecoverablePage, без которого recover() бросает на старте."
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 13:20 +0000
related:
  - docs/decisions/0101-normalized-agent-runtime-persistence.md
---

# The agent store contract stops demanding a dead unbounded scan

## Зачем

Публичный интерфейс `AgentRuntimeStore` вывернут наизнанку:

- `packages/core/src/agent-runtime/store.ts:106` — `scanRecoverable():
  Promise<readonly AgentSnapshot[]>` объявлен **обязательным**. Это ровно та
  неограниченная форма — полный снапшот на каждую восстановимую беседу, — от
  которой уходил breaking-релиз 0.59.0 и ADR 0101 «persistence is bounded».
- `store.ts:107-110` — `scanRecoverablePage?` объявлен **опциональным**.
- `packages/core/src/agent-runtime/runtime.ts:1302` — `recover()` зовёт только
  `scanRecoverablePage` и без него бросает
  `'The configured agent store does not support bounded recovery scans'`.

Потребитель, реализующий интерфейс буквально — а именно это делает всякий, кто
пишет свой адаптер, — обязан написать дорогой метод, который не вызывается
никогда, и при этом получает исключение на старте, потому что не реализовал
метод, помеченный необязательным.

Дополнительно путается имя: на уровне драйвера
(`store-driver.ts:144`) `scanRecoverable(input: { cursor, limit })` —
**ограниченный** метод с другой сигнатурой. Одно имя означает две разные вещи на
двух уровнях одного слоя.

Документация усугубляет: `docs/guide/agent-runtime.md:229` говорит, что адаптер
реализует «not these **eight** transitions», и приводит список из **девяти**
имён, в котором `scanRecoverablePage` отсутствует. Читатель, собравший store по
этому списку, получит исключение при первом `recover()`.

## Результат

- Обязательным является ровно то, без чего рантайм не работает; опциональным —
  то, что действительно необязательно.
- Неограниченная форма скана либо удалена из публичного контракта, либо явно
  объявлена устаревшей и не обязательной.
- Имя `scanRecoverable` не означает две разные сигнатуры на двух уровнях.
- Список методов в гайде совпадает с интерфейсом по составу и по числу.
- Реализация контракта «по документации» приводит к работающему store, и это
  проверяется исполняемым conformance-китом, а не чтением.

## План

- [x] Определить окончательную форму `AgentRuntimeStore`: какие методы
      обязательны, какие нет, и что происходит со старым неограниченным
      сканом.
- [x] Устранить перегрузку имени между уровнем store и уровнем driver.
- [x] Привести `docs/guide/agent-runtime.md:229-239` в соответствие: состав,
      число, и явное указание, какой метод нужен для `recover()`.
- [x] Проверить, покрывает ли `runAgentStoreConformance` из `stitchkit/testing`
      факт «store, реализованный по интерфейсу, переживает `recover()`»; если
      нет — добавить сценарий.
- [x] Внести breaking-запись в `CHANGELOG.md` под `[Unreleased]` с
      before → after и раздел в `docs/guide/upgrading.md`.

## Acceptance

- [x] Store, реализующий все обязательные члены `AgentRuntimeStore` и ни одного
      опционального, успешно проходит `recover()`; это доказано тестом, а не
      рассуждением.
- [x] Ни один обязательный член интерфейса не остаётся невызываемым рантаймом.
- [x] `docs/guide/agent-runtime.md` перечисляет ровно те же методы, что и
      интерфейс, и число в тексте совпадает с длиной списка.
- [x] `runAgentStoreConformance` покрывает путь восстановления.
- [x] `CHANGELOG.md` несёт `### ⚠️ Breaking changes`, релиз двигает минор.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] `packages/core/src/agent-runtime/store.ts`: два скана сведены к одному
      обязательному `scanRecoverable(input: { cursor?, limit })`, возвращающему
      ограниченную страницу. Неограниченная форма удалена целиком, а не помечена
      устаревшей: загрузка всех восстановимых бесед на старте — ровно та форма,
      от которой уходил 0.59.0.
- [x] Перегрузка имени снята: у store и у driver теперь одно имя и одна
      сигнатура, поэтому адаптер реализует это один раз на своём уровне.
- [x] `runtime.recover()` больше не бросает `'does not support bounded recovery
      scans'` — метод всегда присутствует, проверка удалена вместе с причиной.
- [x] `createAgentRuntimeStore` потерял внутреннюю неограниченную реализацию
      (постраничный обход с накоплением всех снапшотов в массиве).
- [x] Регрессия: packages/core/tests/agent-runtime-store-driver.test.ts::a store implementing exactly the declared interface survives recover()
- [x] Существующий тест постраничности переписан так, чтобы доказывать
      ограниченность обхода, а не пользоваться удалённой неограниченной формой.
- [x] `docs/guide/agent-runtime.md`: список приведён к девяти членам, число в
      тексте совпадает с длиной списка, и у `scanRecoverable` сказано, что это
      единственное, что зовёт `recover()`.
- [x] `CHANGELOG.md` несёт `### ⚠️ Breaking changes` с before → after; раздел
      `## Unreleased migration: one bounded recoverable scan` написан.
