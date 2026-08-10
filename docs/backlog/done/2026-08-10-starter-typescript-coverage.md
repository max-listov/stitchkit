---
title: "Starter typecheck covers every executable file"
description: "bun run check выходит с нулём при ошибках типов в scripts, e2e и конфигах — их не покрывает ни один tsconfig."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:10 +07:00
---

# Starter typecheck covers every executable file

## Зачем

Ни один tsconfig не покрывает `scripts/`, `e2e/`, `playwright.config.ts` и
`packages/frontend/next.config.ts`, а `bun run --filter '*'` исключает корневой
пакет. Проверено внесением трёх однозначных ошибок типизации в настоящий скаффолд —
`bun run check` всё равно вышел с нулём. Около одиннадцати исполняемых TS-файлов
едут без compile-time гейта.

У сопутствующей проверки то же слепое пятно: `scripts/check-authored.ts:5,65` берёт
`roots = ['packages','scripts']` и только `.ts/.tsx`, поэтому `e2e/`,
`playwright.config.ts` и `.cjs`-конфиги ecosystem, читающие `process.env` напрямую,
недостижимы для гейта, который ровно это и запрещает. Репортер вдобавок всегда
печатает строку 1 — `node.loc` в этой версии oxc-parser не заполняется.

## Результат

- Ошибка типов в любом исполняемом файле сгенерированного проекта валит
  `bun run check`.
- `check-authored` видит все каталоги и расширения, которые обязан видеть, и
  называет настоящую строку.

## План

- [x] Завести tsconfig, покрывающий `scripts/`, `e2e/`, `playwright.config.ts`,
      `next.config.ts`; включить корневой пакет в `check`.
- [x] Расширить `check-authored.ts` на те же корни и на `.cjs`.
- [x] Починить репортер, чтобы он указывал фактическую позицию.
- [x] Тест: внесённая в `scripts/` и в `e2e/` ошибка типов валит `check`.

## Acceptance

- [x] Ошибка типов в `scripts/` или `e2e/` валит `bun run check`.
- [x] Прямой `process.env` в `.cjs`-конфиге обнаруживается `check-authored`.
- [x] Сообщение о нарушении указывает настоящую строку.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/create-stitchkit/template/tsconfig.json and package.json.
- [x] Регрессия: packages/create-stitchkit/tests/scaffold.test.ts::every executable template TypeScript file is covered by its package tsconfig
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача закрыта преждевременно. Галки выше — запись на момент закрытия; истина ниже.

`scripts/`, `e2e/` и `playwright.config.ts` действительно покрыты — прогон с
внесённой ошибкой типа краснеет в каждом. Но **`next.config.ts` не покрыт ни одним
tsconfig**: корневой включает только `scripts/**`, `e2e/**`, `playwright.config.ts`,
а фронтовый — `next-env.d.ts`, `src/**`, `.next/types/**`.

```
sed -i 's/reactStrictMode: true,/reactStrictMode: "yes-please",/' packages/frontend/next.config.ts
bun run check                                          -> exit 0
tsc --noEmit -p packages/frontend/tsconfig.json | grep -c next.config -> 0
```

Заведомо неверное значение `NextConfig` уезжает зелёным. (`prisma.config.ts` при этом
покрыт — та же проба краснеет.)

### Осталось сделать

- [x] `next.config.ts` включён в `packages/frontend/tsconfig.json` `include`.
      Живая проба: `reactStrictMode: "yes-please"` теперь даёт ошибку tsc,
      называющую `next.config.ts` (проверено внесением и откатом).
- [x] Постоянный механический гейт вместо разовой пробы:
      `packages/create-stitchkit/tests/scaffold.test.ts::every executable
      template TypeScript file is covered by its package tsconfig` — обходит
      РЕАЛЬНЫЙ шаблон, сверяет каждый исполняемый `.ts`/`.tsx` с include-глобами
      tsconfig своего пакета; до включения `next.config.ts` этот тест краснел
      (и попутно доказал матчер на 17 файлах пяти пакетов).

**Финальная проверка 2026-08-10:** тесты скаффолдера — 23 pass; tsc фронтенда
шаблона чистый.
