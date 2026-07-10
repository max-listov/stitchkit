---
title: createContractFactory<Scope> — defineContract с обязательным типизированным scope
description: Фабрика, возвращающая defineContract с обязательным scope из словаря приложения — fail-closed вместо молчаливого 'public'. Сработало правило трёх — минимум три потребителя пишут/планируют одну и ту же обёртку.
type: task
status: done
created: 2026-07-09
updated: 2026-07-10
completed: 2026-07-10 04:35 +08:00
---

# `createContractFactory<Scope>()` — обязательный типизированный scope

## Зачем

`defineContract` без `scope` молча даёт `'public'` (overload в
`contract/define.ts`). Для проекта, где каждый эндпоинт обязан быть явно
заскоуплен, это дыра fail-open: забыл `scope` — эндпоинт публичный. Потребители
решают это одинаковой обёрткой на 30–50 строк (один написал, второй держит в
TODO «как у первого», третий собирался писать при миграции) — правило трёх
сработало.

## Идея

```ts
// app: один раз
const defineAppContract = createContractFactory<'public' | 'user' | 'admin'>();

// дальше scope ОБЯЗАТЕЛЕН и типизирован словарём приложения —
// забытый scope = ошибка компиляции, не молчаливый public
const users = defineAppContract({ prefix: 'users', scope: 'user' }, { … });
```

- Не нарушает ADR 0002 (generic core): словарь скоупов приносит приложение,
  ядро доменной модели не получает.
- Дизайн-вопрос: требовать ли scope и на endpoint-уровне (сейчас
  `EndpointDefBase.scope?: string`) или только contract-level default —
  посмотреть на живые обёртки потребителей перед выбором.
- Дополняет существующий паттерн `satisfies Record<MyScope, AuthRule>` у
  `createAuthHook`.

## Приоритет

Самый сильный из кандидатов «дубли по флоту» (2026-07-09): дешёвая реализация,
закрывает fail-open по умолчанию.

**Подтверждено вторым независимым источником (2026-07-09):** агент, мигрировавший
a consuming project на 0.18, прислал ровно это предложение — у него отдельный
файл `shared/src/contract.ts` (реэкспорт стича + `type Scope = 'public'|'user'`
+ обёртка `defineContract` с REQUIRED scope). Итого три подтверждённых
потребителя пишут одну и ту же обёртку → правило трёх сработало железно.


## Реализовано (0.19.0)

Вышло в релизе 0.19.0. Код + тесты + доки + reference. Файл перенесён в done/.
