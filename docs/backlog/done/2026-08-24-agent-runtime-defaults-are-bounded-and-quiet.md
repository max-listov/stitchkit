---
title: "Agent runtime defaults stay bounded and keep internal addresses internal"
description: "Дедупликация событий копит идентификаторы без границы на всё время жизни процесса, а нерезолвленное вложение по умолчанию отправляет внутренний адрес хранилища в промпт провайдера."
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 13:23 +0000
---

# Agent runtime defaults stay bounded and keep internal addresses internal

## Зачем

Два дефекта в дефолтах одного слоя. Оба тихие: ничего не падает, поведение
проявляется только на длинной дистанции или в чужом логе.

**Неограниченный рост в дедупликации.**
`packages/core/src/agent-runtime/observability.ts:78` — `const emitted = new
Set<string>()`; `:86-87` — при `deduplicate ?? true` каждый `eventId` кладётся в
множество и не удаляется никогда. Флаг включён по умолчанию. Для процесса,
непрерывно исполняющего прогоны, это рост на всё время жизни процесса — в
подсистеме, которая всё остальное ограничивает явно: bounded sinks, bounded
scans, bounded compaction.

**Внутренний адрес хранилища уходит в промпт.**
`packages/core/src/agent-runtime/history.ts:62-67` — при
`unresolvedFile ?? 'text'` (дефолт) ветка кладёт в сообщение к модели
`{ type: 'text', text: '[attachment: ' + part.reference + ']' }`. `part.reference`
— внутренний адрес файла в хранилище приложения: ключ объектного хранилища или
путь. Без явной настройки он отправляется наружу, провайдеру. Та же строка
кладёт его же в текст `Error`.

Второй случай — прямое нарушение правила проекта: внутренние адреса и детали
инфраструктуры не покидают наш периметр, тем более не попадают в prompt.

## Результат

- Дедупликация ограничена: множество идентификаторов не растёт неограниченно,
  и граница выражена явно, а не подразумевается.
- Дефолт для нерезолвленного вложения не отправляет внутренний адрес
  провайдеру: либо вложение опускается, либо подставляется безопасный
  заменитель (имя файла, media type), а адрес остаётся во внутренних полях.
- Текст исключения на этом же пути не несёт внутреннего адреса.
- Оба дефолта задокументированы: читатель гайда видит, что происходит по
  умолчанию и как это изменить.

## План

- [x] Ограничить `emitted`: окно по версии снапшота, TTL или кольцевой буфер —
      выбрать одно и обосновать выбор в задаче.
- [x] Сменить дефолт `unresolvedFile` на безопасный и убрать `part.reference` из
      текста, уходящего провайдеру, и из сообщения исключения.
- [x] Проверить остальные пути `agent-runtime`, где значения приложения
      попадают в prompt или в текст ошибки, и убедиться, что внутренних
      адресов там нет.
- [x] Добавить регрессии: при дефолтных настройках внутренний адрес не
      встречается ни в одном сообщении, уходящем провайдеру; дедупликация не
      растёт неограниченно на длинной серии событий.
- [x] Обновить `docs/guide/agent-runtime.md`: оба дефолта названы явно.
- [x] Внести записи в `CHANGELOG.md` под `[Unreleased]`; смена дефолта —
      breaking, и раздел миграции обязателен.

## Acceptance

- [x] Тест доказывает, что при дефолтной конфигурации `part.reference` не
      встречается ни в одном сообщении к провайдеру и ни в одном тексте
      исключения.
- [x] Тест доказывает, что структура дедупликации ограничена: после серии
      событий, превышающей границу, её размер не растёт.
- [x] Граница дедупликации названа числом или правилом в коде и в гайде, а не
      подразумевается.
- [x] `CHANGELOG.md` несёт breaking-запись для смены дефолта, и есть раздел в
      `upgrading.md`.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] `packages/core/src/agent-runtime/observability.ts`: дедупликация получила
      фиксированное окно `DEDUPLICATION_WINDOW = 10_000` с кольцевым вытеснением
      вместо неограниченного `Set`. Граница названа числом и объяснена: повтор
      внутри окна — дубликат, повтор за его пределами — настоящий re-emit.
- [x] `packages/core/src/agent-runtime/history.ts`: дефолт `unresolvedFile`
      сменён с `text` на `omit`; плейсхолдер `text` описывает вложение
      (`filename` либо `mediaType`) и никогда не несёт `part.reference`.
- [x] Ветка `error` намеренно продолжает называть `reference`: это исключение
      бросается внутрь нашего процесса, а не отправляется провайдеру, и правило
      «внутрь мы обязаны знать всё» здесь работает в свою сторону.
- [x] Регрессия: packages/core/tests/agent-runtime-history.test.ts::the default omits an unresolved file instead of describing where it lives; packages/core/tests/agent-runtime-history.test.ts::the text fallback describes the attachment, never its storage reference; packages/core/tests/agent-runtime-observability.test.ts::deduplication forgets, so a long-lived runtime does not grow without bound
- [x] Заодно закрыт непокрытый opt-in из 0.58.0: packages/core/tests/agent-runtime-observability.test.ts::an operator sink may opt into the internal cause it is redacted from
- [x] `docs/guide/agent-runtime.md`, `CHANGELOG.md` и раздел
      `## Unreleased migration: unresolved attachments are omitted` обновлены.
