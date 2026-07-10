---
title: Доменные ошибки — createErrorHook (сервер) + defineErrors (типобезопасный code на клиенте)
description: Два конца одной проблемы. Сервер — каркас onError с exhaustive StitchErrorCode→wire-код. Клиент — объявить набор доменных кодов так, чтобы ApiError.code матчился типобезопасно (union + автокомплит), а не по строке message. Оба прокидываются одинаково в HTTP-envelope и MCP-ответ.
type: task
status: done
created: 2026-07-09
updated: 2026-07-10
completed: 2026-07-10 04:35 +08:00
---

# `createErrorHook` (сервер) + `defineErrors` (клиент) — доменные ошибки от и до

## Зачем (два конца одной проблемы)

Два независимых источника (мой аудит + агент на живой миграции, 2026-07-09)
пришли к одной теме с разных сторон:

**Серверный конец** — каждый потребитель пишет один и тот же `onError`: маппинг
`StitchErrorCode → свой wire-код` + сборка envelope. Минимум три реализации по
флоту. При апгрейде стича с новым кодом в реестре (ADR 0026) рукописный маппинг
молча пропускает код — дыра.

**Клиентский конец** — `ApiError.code` на клиенте сейчас просто `string`. Нет
способа ОБЪЯВИТЬ проектный набор доменных кодов так, чтобы фронт матчил
`err.code === 'SESSION_NOT_FOUND'` типобезопасно (union + автокомплит). Фронт
вынужден читать `data.error?.message` по строке. **Реальный ожог (агент):**
`[object Object]` там, где код ждал строку `message`, а прилетел объект. Матч по
`message` — хрупкий костыль, нужен типизированный `code`.

## Идея

### `createErrorHook({ map, render })` — exhaustive error-map каркас (сервер)

## Зачем

Каждый потребитель пишет один и тот же `onError`: маппинг
`StitchErrorCode → свой wire-код` + сборка своего envelope. Уже минимум три
реализации по флоту. При апгрейде стича с новым кодом в реестре
(ADR 0026) рукописный маппинг молча пропускает код — дыра.

## Идея

```ts
const errorHook = createErrorHook({
  // exhaustive: новый StitchErrorCode в апгрейде = ошибка компиляции здесь
  map: {
    VALIDATION_ERROR: 'BAD_REQUEST',
    UNAUTHORIZED: 'AUTH_REQUIRED',
    …
  } satisfies Record<StitchErrorCode, AppCode>,
  render: (appCode, error) => ({ error: { code: appCode, message: error.message } }),
});

createServer({ …, hooks: { onError: errorHook } });
```

- Envelope остаётся app-owned (`render`) — generic-принцип (ADR 0002) соблюдён.
- Ядро уже владеет реестром (`STITCH_ERROR_STATUS` / `StitchErrorCode`,
  ADR 0026) — каркас лишь замыкает его на потребителя типом.

### `defineErrors({...})` — типизированные throwers + узкий `code` (клиент↔сервер)

```ts
export const { errors, AppErrorCode } = defineErrors({
  SESSION_NOT_FOUND: 404,
  QUOTA_EXCEEDED: 429,
});
// сервер: throw errors.SESSION_NOT_FOUND('...')  — типизированный thrower
// клиент: if (err.code === 'SESSION_NOT_FOUND') { … }  — union + автокомплит, без магических строк
```

- Стич прокидывает `code` одинаково в HTTP-envelope (`{ error: { code, message } }`)
  и в MCP-ответ (flat `{ error: <code> }`) — один union кодов на обоих транспортах.
- `ApiError.code` на клиенте параметризуется union'ом приложения (сейчас `string`).
- **Развилка дизайна:** отдельный `defineErrors` vs расширение `AppError`
  дженериком кода. Решить перед реализацией (пачкой, см. workflow §14).

## Приоритет

Второй после `createContractFactory` в пачке «дубли по флоту» (2026-07-09).
Клиентский конец (`defineErrors`) поднят по приоритету — на нём реальный ожог
`[object Object]`, а не только эргономика.


## Реализовано (0.19.0)

Вышло в релизе 0.19.0. Код + тесты + доки + reference. Файл перенесён в done/.
