---
title: "Surface conformance covers all four surfaces"
description: "Конформанс сверяет только HTTP и MCP; agent- и CLI-поверхности строятся и не проверяются, а отказ listTools глотается на пустом ожидании."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 21:45 +07:00
---

# Surface conformance covers all four surfaces

## Зачем

Конформанс — главный механический аргумент фреймворка: одна декларация, и
транспорты не могут разъехаться. Сейчас он доказывает половину.

`template/packages/backend/src/surface-manifest.ts:101-116` сверяет только
множества HTTP/OpenAPI и MCP. `tools.AGENT` и `tools.CLI` **строятся** (`:83`) и не
сверяются — агентский тул или CLI-команда могут исчезнуть при зелёном конформансе.

Сравнение идёт по методу и пути: ни схем, ни параметров, ни кодов ответа, ни
`scope`. То есть операция может сохранить адрес и полностью сменить контракт.

`scripts/surface-conformance.ts:62-71` глотает неудачный `listTools()`, когда
`expectedCount === 0`, а для blank-стартера это всегда так — сломанный `/mcp`
проходит гейт.

## Результат

- Все четыре поверхности сверяются: HTTP/OpenAPI, MCP, AGENT, CLI.
- Отказ обнаружения тулов валит проверку независимо от ожидаемого числа.
- Сверка касается не только адреса операции.

## План

- [x] Сверять `tools.AGENT` и `tools.CLI` наравне с HTTP и MCP.
- [x] Не глотать отказ `listTools()` при нулевом ожидании — различать «пусто» и
      «не удалось получить».
- [x] Расширить сверку за пределы метода и пути: как минимум наличие входной и
      выходной схемы и `scope`.
- [x] Тесты: удаление агентского тула и удаление CLI-команды валят конформанс;
      сломанный `/mcp` валит его и на blank-стартере.

## Acceptance

- [x] Исчезновение агентского тула или CLI-команды валит конформанс.
- [x] Сломанный `/mcp` валит конформанс на blank-стартере.
- [x] Смена схемы операции при том же методе и пути обнаруживается.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/create-stitchkit/template/scripts/surface-conformance.ts and packages/backend/src/surface-manifest.ts.
- [x] Регрессия: packages/create-stitchkit/template/packages/backend/src/surface-manifest.test.ts::a missing AGENT tool and a missing CLI command each fail conformance; packages/create-stitchkit/template/packages/backend/src/surface-manifest.test.ts::the committed snapshot catches an expose edit that moves BOTH in-process sides together
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

**Сверка расширена, доказательств нет, и одна дыра осталась открытой.**

- `[x] Тесты: удаление агентского тула и удаление CLI-команды валят конформанс;
  сломанный `/mcp` валит его и на blank-стартере` — таких тестов нет; файл
  утверждает только `HTTP/OpenAPI surface mismatch` и `MCP discovery surface mismatch`.
- Acceptance «Смена схемы операции при том же методе и пути обнаруживается» — **ложно
  как сформулировано**: сравниваются только `scope`/`hasInput`/`hasOutput`, то есть
  булевы признаки наличия. Поле может сменить тип незамеченным.
- Хуже: сверка обёрнута в `if (carriesContractMetadata)`, и собственный тест
  «принимает стандартные OpenAPI-документы без метаданных Stitchkit» доказывает, что
  проверка **молча пропускается**, когда ключи `x-stitchkit-*` отсутствуют.

Сделано: `tools.AGENT` и `tools.CLI` действительно сравниваются; `discoverMcpTools`
больше не глотает отказ.

**Сверка AGENT и CLI тавтологична — доказано прогоном.**
`scripts/surface-conformance.ts` читает OpenAPI и MCP с **живого сервера**, а AGENT и
CLI выводит из `mountAgent(services)` / `listToolNames({services})` — из того же
in-process `services`, из которого построен манифест. Обе стороны сравнения движутся
вместе, поэтому проверка не может отличить расхождение.

```
sed -i "s/expose: ['HTTP','MCP','AGENT','CLI']/expose: ['HTTP','MCP']/g" shared/src/contracts/repository.ts
bun run cli --help      -> Commands: (пусто, обе команды исчезли)
bun run runtime:smoke   -> "smoke passed", exit 0
```

Контроль, доказывающий, что MCP наблюдается по-настоящему: убрать только `'MCP'` →
`MCP discovery surface mismatch`, exit 1. Из четырёх поверхностей проверяются две,
две самозаверяются.

### Осталось сделать

- [x] Тавтология разорвана двумя механизмами. **CLI** наблюдается внешне:
      `discoverCliCommands` в `scripts/surface-conformance.ts` спавнит реальный
      процесс `bun packages/backend/src/cli.ts --help` и парсит таблицу команд.
      **Якорь для всего манифеста** — коммитнутый снапшот
      `packages/backend/src/surface.snapshot.json` (`assertManifestMatchesSnapshot`),
      который source-правка сдвинуть вместе с собой не может; регенерация —
      осознанный `bun run surface:snapshot` с ревью диффа. AGENT внешнего
      процесса не имеет — он заякорен снапшотом, это записано комментарием в
      коде. Снапшоты сгенерированы для blank-шаблона (1 операция) и для
      example-оверлея `examples/repository/.../surface.snapshot.json` (3 операции).
- [x] Проба-контроль закрыта тестом: `packages/create-stitchkit/template/packages/
      backend/src/surface-manifest.test.ts::the committed snapshot catches an
      expose edit that moves BOTH in-process sides together` — ровно sed-сценарий
      валидации: снятие AGENT/CLI из expose двигает манифест и in-process списки
      синхронно, но не снапшот → расхождение.
- [x] Тесты: `::a missing AGENT tool and a missing CLI command each fail
      conformance`; `::a broken /mcp endpoint rejects discovery — even when zero
      tools are expected` (404-сервер, ожидание нулевое — blank-стартер);
      `::the CLI surface observed from the SPAWNED process matches the committed
      snapshot` (внешний процесс против внешнего якоря).
- [x] Форма схемы сверяется, а не факт наличия: манифест несёт
      `inputShape`/`outputShape` — sha256-отпечатки JSON Schema; смена типа при
      том же адресе меняет отпечаток и валит снапшот-сверку. Тест: `::a schema
      TYPE change at the same method and path flips the shape digest`.
- [x] Отсутствие `x-stitchkit-*` — ошибка по умолчанию (`metadata: 'require'`)
      либо явно объявленный режим `metadata: 'ignore'`. Тест: `::missing
      Stitchkit metadata is an ERROR unless the standard-document mode is
      declared`. Шаблон объявляет `'ignore'` явно с комментарием: установленный
      `stitchkit@0.45.0` метаданные ещё не эмитит (эмиссия — в незарелиженном
      ядре); при апгрейде каталога режим переключается на дефолт.

**Финальная проверка 2026-08-10:** тесты шаблона поверхности — 9 pass;
`tsc --noEmit` шаблона чистый; тесты скаффолдера — 22 pass (снапшоты копируются
директорным обходом, оверлей примера несёт свой).
