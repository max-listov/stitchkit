---
title: "The template violates its own policies"
description: "CORS_ORIGIN падает открыто, единственный defineContract инлайнит схему вопреки AGENTS.md шаблона, а два пакета зависят от @app/db вопреки собственному гейту."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:16 +07:00
---

# The template violates its own policies

## Зачем

Шаблон — это витрина: агент и разработчик копируют то, что в нём видят. Сейчас он
демонстрирует три вещи, которые сам же запрещает.

**Безопасность падает открыто.** `packages/config/src/server.ts:19` —
`CORS_ORIGIN: z.string().min(1).default('*')`. Настройка, влияющая на безопасность,
при отсутствии переменной берёт максимально разрешительное значение вместо отказа.
`_env` и `_env.example` побайтово идентичны и оба несут `CORS_ORIGIN=*` вместе с
`NODE_ENV=development` — то есть пример конфигурации и рабочая конфигурация
неразличимы.

**Единственный `defineContract` в базовом шаблоне инлайнит схему.**
`packages/backend/src/surface-manifest.test.ts:15-16` пишет `z.object({...})` прямо
в определении контракта, что `template/AGENTS.md:24-25` явно запрещает. Поскольку
это единственный вызов `defineContract` в базовом шаблоне, агент, ориентирующийся
на существующий код, скопирует именно антипаттерн.

**Два пакета зависят от того, что им запрещено импортировать.**
`packages/frontend/package.json:16` и `packages/shared/package.json:15` объявляют
зависимость `@app/db`, которую `check-authored.ts:40` этим же пакетам импортировать
не разрешает.

## Результат

- Ни одна настройка безопасности не имеет разрешительного значения по умолчанию.
- Единственный пример контракта в шаблоне соответствует правилу «схема отдельно,
  контракт отдельно».
- Объявленные зависимости не противоречат собственному гейту.

## План

- [x] `CORS_ORIGIN` сделать обязательной переменной либо дать безопасное значение
      по умолчанию; развести `_env` и `_env.example` по смыслу.
- [x] Вынести схему из `surface-manifest.test.ts` в отдельный модуль и
      импортировать — базовый шаблон обязан показывать канон.
- [x] Убрать `@app/db` из зависимостей `frontend` и `shared`.
- [x] Проверить остальной шаблон на расхождения с `template/AGENTS.md`.

## Acceptance

- [x] Отсутствующий `CORS_ORIGIN` не приводит к `*`.
- [x] `grep -rn "z.object({" packages/create-stitchkit/template --include=*.ts`
      не находит инлайновых схем внутри `defineContract`.
- [x] `check-authored` зелёный без исключений для `frontend` и `shared`.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/create-stitchkit/template/packages/shared/src/contracts/system.ts and packages/backend/src/transport/system-service.ts.
- [x] Регрессия: packages/create-stitchkit/template/packages/backend/src/surface-manifest.test.ts::derives matching HTTP and MCP discovery identities without calling handlers; packages/create-stitchkit/tests/scaffold.test.ts::ships one neutral domain-free packages-only application
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

**Два пункта закрыты, но не сделаны — проверено.**

- `[x] развести `_env` и `_env.example` по смыслу` — файлы **побайтово идентичны**
  (`diff` пуст). Это ровно тот дефект, которым таска открывается.
- `[x] Вынести схему из `surface-manifest.test.ts` в отдельный модуль` — схемы
  по-прежнему объявлены инлайн в теле теста, то есть единственный `defineContract`
  базового шаблона продолжает демонстрировать запрещённый шаблоном паттерн.
- `Регрессия: surface-manifest.test.ts — explicit exposure and contract-first system
  endpoint policies` — в этом файле нет ни того, ни другого.

Сделано: `CORS_ORIGIN` больше не имеет разрешительного дефолта; `@app/db` убран из
`frontend` и `shared`.

### Осталось сделать

- [x] `_env` и `_env.example` разведены в корне: `_env` удалён из шаблона совсем
      (вместе с `_env.append` примера) — рабочий `.env` больше не поставляется,
      его рендерит `scripts/local-env.ts` из `.env.example` с identity-производным
      именем БД (см. задачи scaffold-identity и fresh-scaffold этого захода).
      Байт-в-байт дубликат перестал существовать вместе с причиной.
- [x] Схемы теста вынесены именованными констанами на уровень модуля
      (`NoteParamsSchema`/`NoteSchema`/`RetypedNoteSchema`) — в `defineContract`
      инлайн-схем не осталось; последний инлайн (`z.object({id: z.number()})` в
      снапшот-тесте) поднят в `RetypedNoteSchema` с комментарием о политике.
- [x] `Регрессия:` приведена к фактическим кейсам (форма `файл::кейс`
      проверяется механическим гейтом docs-hygiene).

**Финальная проверка 2026-08-10:** тесты поверхности шаблона — 9 pass.
