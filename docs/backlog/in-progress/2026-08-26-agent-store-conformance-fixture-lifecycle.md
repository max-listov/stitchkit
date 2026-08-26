---
title: Agent-store conformance needs a fixture lifecycle
description: Let a durable store provision and clean up the aggregate parent selected by the black-box conformance scenario.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 07:33 +00:00
---

# Agent-store conformance needs a fixture lifecycle

## Зачем

`runAgentStoreConformance` creates its conversation id internally after calling
`createStore()`. A durable adapter whose runtime rows reference an
application-owned conversation cannot run the kit: the first admission must
reference a parent row, but the adapter is never told which parent to provision.
Running the kit against the memory reference store proves the reducer, not the
external adapter the guide asks a consumer to certify.

The published guide also shows `{ store, conversationId }`, while the released
API accepts only `{ createStore }`. The documented migration check therefore
cannot typecheck against the package it documents.

## Результат

- The conformance scenario exposes its selected `conversationId` before the first
  store mutation.
- An adapter can provision and clean up application-owned fixture state without
  weakening the black-box assertions or leaking rows after a failed scenario.
- Existing zero-argument memory-store factories remain source-compatible.
- The upgrading guide and API reference show the exact released invocation.

## План

- [x] Extend `AgentStoreConformanceConfig` with a fixture lifecycle that receives
      the generated `conversationId`; prefer passing the context into
      `createStore(context)` plus a bounded `cleanup` hook.
- [x] Run cleanup in `finally`, including when conformance fails halfway through.
- [x] Add a foreign-key-backed fixture whose first mutation fails unless setup
      created the parent and whose cleanup is asserted after both green and
      failing scenarios.
- [x] Keep `createMemoryAgentRuntimeStore` and existing zero-argument factories
      valid without wrappers.
- [x] Correct `docs/guide/upgrading.md`, the agent-runtime guide and API reference
      to the actual configuration shape.

## Acceptance

- [x] A store requiring a pre-existing conversation passes the complete public
      conformance kit with no preselected global fixture id.
- [x] Setup and cleanup each run once; cleanup runs after an assertion failure.
- [x] The packed Bun and Node consumer lanes compile the documented example.
- [x] `bun run verify` is green.
- [ ] The fix is available in a published patch release. — **не сделано в этом
      заходе**: команды на релиз не было, а публикация в npm необратима и уходит
      наружу. Всё для неё готово: `[Unreleased]` в changelog без секции
      `### ⚠️ Breaking changes`, значит патч 0.66.1.

## Что сделано

### Решение

Кит выбирал идентичности разговоров **после** того, как `createStore()` вернул
стор, и это ровно то, что закрывало доступ адаптерам, ради которых он
существует: долговечный стор, у которого runtime-строки висят на прикладной
строке разговора, не может обслужить первый admission — ему никто не сказал,
какого родителя завести. Единственным способом «сертифицироваться» оставался
прогон против memory-стора, а он проверяет редьюсер, а не адаптер.

Теперь контекст передаётся **до первой мутации**, и это единственное, что нужно
было изменить: `createStore(context)` получает список всех разговоров, которые
сценарий будет менять, а необязательный `cleanup(context)` их убирает.

`cleanup` выполняется ровно один раз, после сценария, независимо от того, прошёл
он или упал. Кит, который прибирается только на зелёном, оставляет строку на
каждый красный прогон — именно это делает падающий набор неперезапускаемым. И
отказ уборки никогда не подменяет отказ сценария: ответ на «соответствует ли
адаптер» не переписывается ответом на «сработал ли teardown».

Аддитивно: фабрика без аргументов остаётся валидной без обёрток — TS так
устроен, и это проверено тестом, а не рассуждением.

### Core

- [x] `packages/core/src/testing/agent-store-conformance.ts` —
      `AgentStoreConformanceContext`, `cleanup`, сценарий вынесен в
      `conformanceScenario`, три идентичности разговоров генерируются в одном
      месте и передаются вниз (включая ту, что раньше рождалась внутри
      `assertAbsorptionIsAtomic`).
- [x] **Найденный по дороге дефект:** кит проверял отсутствие по литералу
      `'no-such-conversation'`. Такая строка может законно существовать в базе
      потребителя, и тогда соответствующий адаптер падал по причине, не имеющей
      отношения к контракту. Отсутствующая идентичность выводится из
      сгенерированного префикса прогона и намеренно не входит в
      `conversationIds`.
- [x] `packages/core/src/testing.ts` — экспорт `AgentStoreConformanceContext`.

### Tests

- [x] `packages/core/tests/agent-store-conformance-fixture.test.ts` — 6 тестов:
      стор с foreign key проходит весь кит; **тот же стор без provisioning
      падает** (доказательство, что предыдущий тест что-то доказывает); уборка
      после падения; отказ уборки не подменяет отказ сценария; отказ уборки на
      зелёном сценарии виден; фабрика без аргументов работает.
- [x] Фальсификация: уборка только на успехе, пустой контекст, уборка,
      подменяющая ошибку — каждая обрушила тест.

### Consumer lanes

- [x] `packages/core/scripts/consumer-lane/fixtures/full/src/agent-store-conformance.ts`
      и `.../node/src/agent-store-conformance.ts` — ровно та форма вызова, что
      показана в гайде; Bun-фикстура ещё и исполняется и печатает доказательство,
      проверяемое в `run.mjs`.
- [x] **Полоса поймала два моих промаха, и оба стоило поймать.** Сначала я
      положил исполняемую фикстуру в `minimal` — а `minimal` намеренно не ставит
      `ai`, и она упала на импорте. Фикстуры разделены по оси «что потребитель
      обязан был поставить», и агент-рантайм принадлежит `full`.
      Потом `node` перестал проходить typecheck: у него `skipLibCheck: false`, и
      мой импорт впервые протащил туда декларации агент-рантайма — а через них
      `@ai-sdk/provider`, который **зависит** от нетипизированного
      `json-schema`, держа `@types/json-schema` в devDependencies. То есть его
      опубликованные `.d.ts` ссылаются на модуль, типов которого потребитель не
      получает. Это пробел `ai`, не наш, но потребитель-на-Node с
      `skipLibCheck: false` встречает его первым — фикстура теперь ставит типы
      сама, и причина записана в её `comment`, чтобы следующий читатель не искал
      её заново.

### Docs

- [x] `docs/guide/upgrading.md` — вызов исправлен на реальный
      (`{ createStore }`), добавлен пример с provisioning и cleanup.
- [x] `docs/guide/agent-runtime.md`, `docs/api/reference.md`,
      `packages/core/tests/fixtures/public-surface.json`, `CHANGELOG.md`.

### Чего не сделано

- Публикация. См. незакрытый пункт Acceptance выше.
