---
title: "Remove the LAN HTTPS mode from the starter"
description: "Сложный автоматизированный режим уходит из шаблона; проверенный рецепт bun tls остаётся в гайде фреймворка."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
related:
  - docs/backlog/done/2026-08-10-starter-lan-https-development.md
  - docs/backlog/planned/2026-08-10-starter-dev-requires-pm2-silently.md
---

# Remove the LAN HTTPS mode from the starter

## Зачем

**Решение владельца принято: сложный автоматизированный режим удаляется из
стартера, знание сохраняется рецептом в гайде фреймворка.**

Обоснование замерами. VISION разрешает растить стартер «only where it clarifies
already-shipped capabilities **without moving frontend infrastructure into the
framework**» — конъюнкция, и вторая половина провалена. Из ~320 строк режима на
прояснение возможности Stitchkit приходится ~8: passthrough `bun: { tls }`,
задокументированный одной строкой таблицы в `docs/guide/server.md:98` и не имеющий
ни одного рабочего примера. Остальное — инфраструктура приложения и устройства:
перечисление интерфейсов и классификация RFC1918, жизненный цикл CA у mkcert,
интроспекция таблицы процессов pm2, проброс экспериментального флага Next
(`--experimental-https` — нестабильный upstream-контракт в поставляемом коде),
HTML-страница с инструкциями по доверию CA для iOS и Android.

Решающее — фича **вне гейта**. По ADR 0060 смысл стартера в том, что он
проверяется как упакованный внешний потребитель на каждом релизе; обе полосы гоняют
`NODE_ENV=production` и спавнят `start:api`/`start:web` напрямую, без pm2, без
dev-режима, без mkcert. Покрытие `dev:lan` — три ассерта над двумя чистыми
функциями; вызов mkcert, разбор `pm2 jlist`, проба порта, флаги Next и ветка TLS
структурно непокрываемы на линукс-раннере без доверенного стора и телефона.

За сутки после выката режим накопил девять дефектов — среди них недостижимый
`--host=<addr>`, докерные мосты в качестве LAN-кандидатов, сертификат без
перевыпуска по истечении и проба порта без таймаута. Чинить их имело бы смысл
только при наличии гейта, которого нет и который стоил бы отдельной полосы CI.

Рецепт в гайде проходит тест VISION буквально, стоит нулю в CI, не тащит внешние
бинари и экспериментальный флаг в поставляемый код и **попадает в `llms.txt`** —
то есть агент, адаптирующий фреймворк, найдёт его лучше, чем скрипт внутри чужого
сгенерированного приложения. Отдельный `--example lan-https` отвергнут: по ADR 0060
третий вариант требует полноценной собственной полосы, а негейтируемый пример хуже
документации.

## Результат

- Сгенерированное приложение не содержит команды `dev:lan`, работы с
  сертификатами, маршрута LAN-онбординга и переменных `DEV_HTTPS_*`.
- `docs/guide/server.md` описывает доверенный HTTPS в разработке через
  `bun: { tls }`, называя mkcert внешним шагом пользователя, а https-флаг Next —
  зоной ответственности потребителя.
- Стартер не зависит от экспериментального флага Next.
- Знание не потеряно и доезжает до агентов через `llms.txt`.

## План

- [x] Удалить `template/scripts/dev-lan.ts`, `dev-lan.test.ts` и команду `dev:lan`
      из манифеста шаблона.
- [x] Удалить `template/packages/backend/src/transport/lan-onboarding.ts` и его
      вызов в `backend/src/index.ts`.
- [x] Удалить ветку `bun.tls` из сервера стартера, переменные `DEV_HTTPS_*` из
      `packages/config/src/server.ts`, https-ветку из `ecosystem.dev.config.cjs` и
      блок очистки в `scripts/dev.ts`.
- [x] Удалить `template/docs/LAN_HTTPS.md` и соответствующий раздел README; убрать
      ассерт `DEV_HTTPS_CERT` из `packages/create-stitchkit/tests/scaffold.test.ts`.
- [x] Добавить в `docs/guide/server.md` раздел «Trusted HTTPS in development» с
      `bun: { tls }` на файловом сертификате; mkcert — внешний шаг.
- [x] Внести удаление в `packages/create-stitchkit/CHANGELOG.md` под
      `### ⚠️ Breaking changes` со ссылкой на раздел гайда.

## Acceptance

- [x] `grep -r "DEV_HTTPS\|dev:lan\|mkcert" packages/create-stitchkit` возвращает
      только историю в CHANGELOG.
- [x] `bun run gen:llms` содержит руководство по доверенному HTTPS, то есть
      адаптирующий агент восстанавливает режим по документации фреймворка.
- [x] Стартер не ссылается на экспериментальный флаг Next.
- [x] `bun run verify` зелёный, обе полосы пройдены без изменений.

## Не входит

- Проверка наличия pm2 — отдельная задача `starter-dev-requires-pm2-silently`:
  обычный `bun run dev` уже использует pm2, поэтому она нужна независимо от
  судьбы LAN-режима.

## Что сделано

- [x] Реализация: packages/create-stitchkit/template/scripts/dev.ts and packages/create-stitchkit/template/_env.example.
- [x] Регрессия: не требуется — режим удалён вместе с файлами шаблона; в template не осталось Caddy/сертификатных путей (проверено grep), исполняемого поведения для теста нет.
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
