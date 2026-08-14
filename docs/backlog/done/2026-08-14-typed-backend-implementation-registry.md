---
title: Типизированный registry backend implementations
description: Связать единый registry контрактов с полным набором backend handlers на compile-time.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 13:47 +00:00
---

# Typed backend implementation registry

## Зачем

`createClients()` уже строит frontend API из единого `name → contract` registry,
но backend по-прежнему вручную составляет массив отдельных `ServiceDef`. TypeScript
не видит registry целиком и не ловит забытый contract или лишнюю implementation.
Runtime parity-test страхует симптом, хотя registry уже содержит всю информацию
для compile-time проверки.

## Результат

Один публичный `implementRegistry()` принимает registry контрактов и exact map
handlers, возвращает готовый `ServiceDef[]` и compile-time запрещает пропуски,
лишние keys и handlers, несовместимые с endpoint schemas. Порядок результата
детерминирован порядком registry.

Целевая эргономика:

```ts
const services = implementRegistry(apiContractRegistry, {
  auth: authHandlers,
  courses: courseHandlers,
  lessons: lessonHandlers,
})
```

Для typed context должен существовать один канонический factory-вариант,
симметричный `createImplement<TContext>()`, а не generic на каждом entry.

## План

- [x] Выведен exact mapped type `registry key → Handlers<contract.endpoints,
  context>` из фактических literal contracts.
- [x] `implementRegistry()` реализован поверх общего binder без второго
  runtime representation.
- [x] Добавлен context-bound factory, сохраняющий один declared `RuntimeContext`
  для всего registry.
- [x] Runtime keys и contract prefixes fail-first проверяются на loose JavaScript
  boundary; nominal identity структурно одинаковых объектов не обещается.
- [x] Composed arrays/namespaces явно запрещены типом и понятной ошибкой;
  молчаливое flattening отсутствует.
- [x] Добавлены compile fixtures на missing key, extra key, missing endpoint,
  extra endpoint, неверные input/output/context types и корректный registry.
- [x] Добавлены runtime tests на порядок services и эквивалентность отдельным
  вызовам `implement()`.
- [x] API экспортирован из server entrypoints; guide, API reference,
  changelog и generated llms docs.

## Не входит

- Номинальное branding контрактов только ради различения двух структурно
  идентичных declarations.
- Автоматическое создание domain services или transport handlers.
- Обязательное применение registry в маленьких приложениях с одним контрактом.

## Acceptance

- [x] Пропущенный или лишний registry key не компилируется.
- [x] Каждый handlers-map строго выводится из соответствующего contract entry.
- [x] Контекст фиксируется один раз и точно доступен всем handlers.
- [x] Runtime возвращает тот же `ServiceDef[]`, который получился бы из
  последовательных `implement()` в registry order.
- [x] Public API не содержит compatibility alias или параллельного service engine.
- [x] Compile fixtures используют реальный public entrypoint packed package.
- [x] Полный `bun run verify` зелёный.

## Что сделано

- [x] **Core:** `packages/core/src/server/implement.ts` содержит
  `implementRegistry()`, `createImplementRegistry()` и exact registry types поверх
  общего `bindContract()`.
- [x] **Runtime guards:** проверяются missing/extra registry entries,
  missing/extra endpoint handlers, duplicate prefixes и неподдерживаемые composed
  values.
- [x] **Exports:** API опубликован через `packages/core/src/server/index.ts` и
  `packages/core/src/node.ts`.
- [x] **Tests:** `packages/core/tests/implementation-registry.test.ts` покрывает
  `binds every contract in deterministic registry order`,
  `fixes one typed context for the whole registry` и
  `fails first for loose callers with missing, extra or duplicate entries`, а
  также compile-negative fixtures.
- [x] **Packed consumer:**
  `packages/core/scripts/consumer-lane/fixtures/minimal/src/app.ts` проверяет
  реальный public entrypoint упакованного пакета.
- [x] **Docs:** обновлены `docs/guide/server.md`, `docs/api/reference.md` и
  `CHANGELOG.md`.
- [x] **Что не делалось:** nominal branding и composed-registry flattening не
  добавлялись; release, commit, push и deploy не выполнялись.
