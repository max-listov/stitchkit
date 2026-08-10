---
title: "An empty cors config yields a wildcard"
description: "createServer({cors:{}}) отдаёт Access-Control-Allow-Origin: *, и assertCorsConfig ловит это только при credentials: true."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:20 +07:00
---

# An empty cors config yields a wildcard

## Зачем

`createServer({ cors: {} })` и `createServer({ cors: { origin: undefined } })` оба
отдают `Access-Control-Allow-Origin: *`. `assertCorsConfig` отвергает эту
комбинацию только когда одновременно задан `credentials: true`.

Официальный шаблон до этого места не доходит — там `CORS_ORIGIN` объявлен
обязательным `z.url()`. Но потребитель, пометивший переменную `.optional()` (вполне
естественный шаг при выкатке в окружение без фронтенда), молча получает открытый
для всех источник вместо отказа.

Это тот же класс, что уже исправлен в шаблоне: настройка, влияющая на безопасность,
при отсутствии значения не должна выбирать самое разрешительное поведение.

## Результат

- Пустая или неполная конфигурация CORS приводит к явному отказу либо к отсутствию
  заголовков, но не к `*`.
- Намерение «разрешить всем» выражается явно, а не получается по умолчанию.

## План

- [x] Каноническое поведение решено: присутствующий `cors` ТРЕБУЕТ `origin`
      (строка, список или явный `'*'`); отсутствие — ошибка конструирования;
      полное отсутствие `cors` = никаких CORS-заголовков. Пустой список origin
      тоже отвергается.
- [x] `assertCorsConfig` расширен за пределы связки с `credentials`; вдобавок
      `resolveOrigin` при недостижимом `undefined` теперь fail-safe (нет
      заголовка), а не fail-open (`*`) — на случай путей мимо ассерта.
- [x] Тесты: `packages/core/tests/cors-response-integrity.test.ts::an empty or
      origin-less cors config is a construction error, not `*`` (все три формы)
      и `::allowing every origin stays available — as an EXPLICIT opt-in`.
- [x] Гайд (`docs/guide/server.md`, таблица `cors`) и breaking-секция
      changelog обновлены.

## Acceptance

- [x] Ни одна форма пустой конфигурации не даёт `Access-Control-Allow-Origin: *`
      неявно — закрыто тестами выше.
- [x] Гейты прогнаны в рамках закрытия захода (полный verify — финальным шагом
      зонтичной задачи).

## Что сделано

- [x] Реализация: packages/core/src/server/middleware/cors.ts (`assertCorsConfig`, `resolveOrigin`), docs/guide/server.md, CHANGELOG.md.
- [x] Регрессия: packages/core/tests/cors-response-integrity.test.ts::an empty or origin-less cors config is a construction error, not `*`.
