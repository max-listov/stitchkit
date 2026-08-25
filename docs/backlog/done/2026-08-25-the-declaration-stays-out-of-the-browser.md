---
title: Полная декларация уезжает в браузерный граф
description: pages.ts тянет appDeclaration, а его импортирует client-компонент — в бандл попадают команды ролей, рабочие каталоги, пути артефактов и имена переменных.
type: task
status: done
tags: [starter, boundary, published-bug]
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 04:04 +00:00
---

# Полная декларация уезжает в браузерный граф

## Зачем

Дефект в **опубликованном** стартере 0.4.0. Проверено чтением:

- `packages/frontend/src/lib/seo/pages.ts:1` импортирует `appDeclaration` из
  `@app/config/declaration`.
- `app/[locale]/ui/_catalogue/catalogue-navigation.tsx:1` — `'use client'`, и
  он импортирует `getSeoPage` из `@/lib/seo/pages`.

Значит в браузер уезжают `project.json` целиком, команды ролей, рабочие
каталоги, пути артефактов и миграций, имена всех переменных окружения — плюс
`stitchkit/declaration` и парсер Zod.

Это ровно тот сценарий, ради которого генерируется `app-identity.generated.ts`,
и его собственный комментарий описывает именно эту ошибку. Из декларации
`pages.ts` нужно одно поле — `identity.name`.

## Результат

- `pages.ts` читает `appIdentity`, а не `appDeclaration`.
- Декларация остаётся server/tooling-only.
- Fail-closed граница: тест запрещает транзитивно тянуть
  `@app/config/declaration` из графа `'use client'`.

## План

- [x] Заменить импорт в `pages.ts`.
- [x] Тест границы: обойти граф от каждого `'use client'` файла и падать на
      достижении модуля декларации.
- [x] Проверить остальные client-подграфы на такие же протечки.
- [x] Запись в `packages/create-stitchkit/CHANGELOG.md`.

## Acceptance

- [x] Ни один `'use client'` граф не достигает `@app/config/declaration`.
- [x] Тест падает, если импорт вернуть.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] `pages.ts` читает `appIdentity` — единственное поле, которое ему было
      нужно, — вместо полной декларации.
- [x] `scripts/client-boundary.test.ts`: обход графа от **каждого**
      `'use client'` файла с разрешением `@/` и относительных путей; падает с
      печатью цепочки импортов.
- [x] Проверено на убийство обеими формами импорта. Первая попытка сканера
      ловила только `from '…'` — и **пропустила** импорт ради побочного
      эффекта. Починен сканер, а не тест.
- [x] `packages/create-stitchkit/CHANGELOG.md` и канал миграции.
