---
title: createErrorHook({ map, render }) — каркас exhaustive error-маппинга
description: Каркас onError-хука в пакете — приложение отдаёт только словарь StitchErrorCode → свой wire-код и рендер envelope. Exhaustive Record даёт compile-time покрытие новых кодов при апгрейде. Три потребителя маппят руками.
type: task
status: inbox
created: 2026-07-09
updated: 2026-07-09
---

# `createErrorHook({ map, render })` — exhaustive error-map каркас

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

## Приоритет

Второй после `createContractFactory` в пачке «дубли по флоту» (2026-07-09).
