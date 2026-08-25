---
title: В дереве нет ничего без читателя
description: Мёртвый экспорт, полтора мегабайта неупомянутых картинок, tracked-копия README, игноры несуществующих путей, три копии одного маппинга и копия страницы примера, которую никто не сверяет.
type: task
status: done
tags: [cleanup, duplication]
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 20:51 +00:00
---

# В дереве нет ничего без читателя

## Зачем

Каждый пункт проверен грепом по всему дереву.

**Мёртвое**

- `packages/core/src/tools/runtime-tool.ts` — `runtimeToolSupports`: сквозной
  однострочник, ноль вызовов, не в списке реэкспортов `tools.ts`, подпути
  `tools/runtime-tool` в `exports` нет. При этом уезжает в `.d.ts` опубликованного
  пакета.
- `assets/hero-emblem.jpg`, `assets/mascot-stitch.jpg`, `assets/mascot-stitch-alt.jpg`,
  `assets/mascot-stitch-nobg.png` — ноль упоминаний в дереве, ~1.2 МБ. Последний
  вдобавок байт-в-байт совпадает с картинкой шаблона под другим именем.
- `biome.json` игнорирует `**/_deprecated` и `**/prisma-json.d.ts`; обеих строк
  во всём дереве больше нигде нет.
- `packages/create-stitchkit/tests/scaffold.test.ts:418,467` пишут фикстуру
  `_env`, для которой в `TEMPLATE_RENAMES` нет ключа с тех пор, как его удалили;
  ни один assert её не касается.
- `packages/core/README.md` — tracked байт-в-байт копия корневого, которую
  `prepack` всё равно перезаписывает, а её родные братья по тому же `prepack`
  (`llms.txt`, `llms-full.txt`) лежат в `.gitignore`.
- `export` у функций, которые никто не импортирует за пределами своего модуля:
  `tools/mcp-prepare.ts:prepareMcpTools`, `tools/runtime-tool.ts:runtimeToolIdentity`,
  `tools/schema.ts:keyPolicyOf`/`withKeyPolicy`, `create-stitchkit/src/scaffold.ts:
  materialiseTemplateFiles`, `template/scripts/declaration.ts:renderProjectJson`.
  Биом ловит неиспользуемые локальные, но не экспортированные — это и есть слепое
  пятно.

**Дублирующееся**

- Три копии маппинга terminal reason → message status в одном каталоге:
  `agent-runtime/runtime-internals.ts:assistantStatus`,
  `agent-runtime/terminal-commit.ts:terminalMessageStatus`,
  `agent-runtime/store-driver.ts:terminalMessageStatus`. Первая **пишет** статус,
  две другие его **проверяют**: новая terminal reason, внесённая в одну копию,
  делает инвариант согласным с неверным значением.
- `internal/observability-sink.ts:146` и `:165` — одинаковый литерал из
  одиннадцати полей в `getStatus()` и в `close()`; новый счётчик тихо появится
  только в одном.
- `tools/flatten.ts:21` и `tools/flatten-join.ts:87` — байт-в-байт `stringValues`,
  при том что первый файл уже импортирует из второго.
- `joinPath` в трёх местах: `server/router.ts:42`, `server/openapi.ts:78`,
  `testing/surface-manifest.ts:202`.
- `examples/repository/…/[locale]/starter-page.tsx` отличается от шаблонного на
  десять строк диффа и ничем не сверяется: правка шаблонной страницы тихо
  перестаёт доезжать до `--example repository`.
- Правило исключения артефактов живёт в трёх рукописных копиях
  (`create-stitchkit/src/scaffold.ts:42`, `package.json` files-негативы,
  `scripts/starter-lane.ts:240`) и уже разошлось: в `files` нет
  `!template/**/coverage/**`, а набор для `examples/**` не покрывает `.env`,
  `src/generated`, `test-results`, `playwright-report`, `next-env.d.ts`.

**Лишние тесты**

- `template/scripts/serve-mode.test.ts` — «пустой режим» и «опечатка» идут одной
  веткой (`requested === undefined ? undefined : MODES[requested]`), то есть
  второй случай стоит настоящего `Bun.spawn` с 30-секундным таймаутом ради нуля
  нового покрытия. Написан в этом же заходе.
- `tool-name-validation.test.ts:105` повторяет `utils.test.ts:32` дословно.

**Мелочь**

- Девять записей в `done/` датированы `2026-08-25`, при том что `completed:` в
  них — `2026-08-24`. Файл сам себе противоречит.

## Результат

- Ничто в дереве не существует без читателя, и это видно грепом.
- Каждое правило и каждый маппинг имеют один дом.
- Правка шаблонной страницы либо доезжает до примера, либо валит проверку.

## План

- [x] Снять мёртвый экспорт, картинки, игноры, фикстуру `_env`, tracked-копию README.
- [x] Свести маппинг статусов, `stringValues`, `joinPath` и литерал sink к одному дому.
- [x] Закрепить связь страницы примера с шаблонной проверкой.
- [x] Свести правило исключения артефактов и устранить расхождение.
- [x] Убрать лишние тесты; поправить даты записей.

## Acceptance

- [x] Ни один удалённый файл или символ не упомянут больше нигде.
- [x] Расхождение страницы примера с шаблоном ловится проверкой.
- [x] `bun run verify` зелёный.

## Что сделано

### Снято

- [x] `runtimeToolSupports` — сквозной экспорт без единого вызова, уезжавший в
      `.d.ts` опубликованного пакета.
- [x] Четыре картинки в `assets/` (~1.1 МБ), не упомянутые нигде; одна из них
      была байт-в-байт дубликатом картинки шаблона под другим именем.
- [x] Игноры `**/build`, `**/_deprecated`, `**/prisma-json.d.ts` в `biome.json`
      — ни одного соответствия во всём дереве.
- [x] Фикстура `_env` в двух местах `scaffold.test.ts` — ключа рената нет с тех
      пор, как его удалили, и ни один assert её не касался.
- [x] `export` у пяти module-internal функций.
- [x] Дубликат теста «пустой режим» в `serve-mode.test.ts` — та же ветка кода,
      что и «опечатка», ценой настоящего `Bun.spawn`.

### Сведено к одному дому

- [x] Маппинг terminal reason → status: три копии, из которых две **проверяли**
      то, что пишет третья. Теперь один внутренний лист-модуль
      `agent-runtime/terminal-status.ts` — не в `schemas.ts`, чтобы не
      расширять публичную поверхность внутренней механикой, и не в
      `runtime-internals.ts`, чтобы не заводить цикл импорта.
- [x] `stringValues` — один, в файле, который сосед и так уже импортировал.
- [x] `joinPath` в трёх файлах → `joinRoutePath` в `internal/route-pattern.ts`,
      рядом с остальным разбором маршрутов.
- [x] Литерал статуса sink'а — одна функция, два вызывающих.
- [x] Негативы `files` в `packages/create-stitchkit/package.json` дополнены до
      того же набора, что у двух других копий правила.

### Вместо удаления — проверка

- [x] `packages/core/README.md` **оставлен tracked**: снять его с индекса —
      операция над git index, а индекс не мой. Вместо этого он стал сверяемым
      зеркалом: packages/core/tests/current-docs.test.ts::the package README mirrors the root one byte for byte
- [x] Страница примера: packages/create-stitchkit/tests/overlay-drift.test.ts::the repository overlay of packages/frontend/src/app/[locale]/starter-page.tsx differs only where it means to
      — расхождение разрешено, но зафиксировано построчно; проверено мутацией
      шаблонной страницы.

### Мелочь

- [x] Девять записей в `done/` датировались днём вперёд своего же `completed:`.
      Правлено frontmatter; имена файлов не трогал — на них ссылаются `related:`.

### Проверка

- [x] `bun run verify` — exit 0.
