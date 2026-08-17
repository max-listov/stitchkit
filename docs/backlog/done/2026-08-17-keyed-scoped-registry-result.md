---
title: createScopedImplementRegistry возвращает keyed-результат
description: Реестр принимает record контрактов, а возвращает плоский массив — ключи, несущие смысл у потребителя, теряются на выходе и ломают фильтрацию тул-поверхности молча.
type: task
status: done
created: 2026-08-17
updated: 2026-08-17
completed: 2026-08-17 14:56 +00:00
related: docs/decisions/0075-per-scope-handler-context.md
---

# Keyed-результат у `createScopedImplementRegistry`

## Зачем

`createScopedImplementRegistry` (и `implementRegistry` до него) принимает
`Record<K, ContractDef>`, а возвращает `ServiceDef[]` — ключи есть на входе и
выброшены на выходе.

У крупнейшего потребителя (38 контрактов, 191 MCP-тул) ключи реестра —
**несущие**: по ним фильтруется тул-поверхность агента для урезанных ботов.
Миграция на наш реестр по нашей же инструкции молча сломала бы фильтр — урезанные
боты получили бы полный набор тулов. Это тихий дефект прав доступа, и потребитель
из-за него на реестр осознанно не перешёл. Блокер маленький, но реальный.

## Результат

- Реестр возвращает и keyed-форму `Record<K, ServiceDef>`, и порядок для
  монтирования. Форма — решить при реализации: `Record<K, ServiceDef>` +
  `Object.values` у потребителя, либо пара `{ services: ServiceDef[]; byKey:
  Record<K, ServiceDef> }`. Второе честнее: порядок реестра — часть контракта
  `implementRegistry`, и терять его в record нельзя.
- `createScopedImplementRegistry` опубликован меньше суток назад и не имеет ни
  одного потребителя (единственный кандидат отказался именно из-за этого) —
  смена его возврата допустима, но по нашему правилу это **breaking** (changed
  return shape): пункт в `### ⚠️ Breaking changes` с before → after, минорный
  бамп. Для симметрии решить и про старый `implementRegistry`: менять оба или
  дать keyed-форму только scoped-варианту (несимметричность хуже — склоняться к
  обоим, отдельным пунктом).

## План

- [x] Выбрать форму возврата, зафиксировать коротким дополнением к ADR 0075 или
      отдельным ADR (меняется публичная форма двух функций).
- [x] Реализация: `bindRegistry` уже итерирует по ключам — сохранить их,
      собрать record рядом с массивом без второго прохода.
- [x] Type-тест: литеральные ключи выживают в `byKey`; рантайм-тест: порядок
      `services` следует порядку реестра, `byKey[k]` === соответствующий элемент.
- [x] CHANGELOG (`### ⚠️ Breaking changes`), `upgrading.md`, reference,
      `public-surface.json` при новых типах.

## Acceptance

- [x] Фильтрация «этим ботам — только сервисы X, Y» выражается по ключам
      результата реестра без ручного сопоставления по `prefix`.
- [x] Порядок монтирования не изменился (существующие тесты реестра зелёные с
      правкой только формы доступа).
- [x] `bun run verify` зелёный.

## Что сделано

- [x] **Отклонение от плана — в лучшую сторону.** Вместо смены формы возврата
      (breaking) взят обогащённый массив: `KeyedServices<TContracts> =
      ServiceDef[] & { byKey }`. Порядок монтирования — по-прежнему сам массив,
      ключи — `.byKey` с литеральной типизацией, существующие вызовы не ломаются
      вовсе. Пункт `### ⚠️ Breaking changes` не понадобился — запись ушла в
      `### Added`.
- [x] Симметрия соблюдена: `implementRegistry`, `createImplementRegistry` и
      `createScopedImplementRegistry` возвращают одну форму
      (`packages/core/src/server/implement.ts`).
- [x] Дженерик-сужение `Record<string, ServiceDef>` → мапа по
      `keyof TContracts` проведено через документированный boundary
      `transportResult` (`internal/typed.ts`) с обоснованием на месте — ключи
      `byKey` в рантайме и есть ключи `contracts`.
- [x] Тесты: `packages/core/tests/scoped-implement-registry.test.ts::keyed registry results > byKey addresses the same service objects the array mounts`
      и `…::keyed registry results > implementRegistry carries the same keyed shape`;
      старые реестровые тесты зелёные без правок.
- [x] `docs/guide/server.md` (раздел implementRegistry, сниппет фильтрации),
      `docs/api/reference.md`, `public-surface.json`, CHANGELOG `### Added`.
