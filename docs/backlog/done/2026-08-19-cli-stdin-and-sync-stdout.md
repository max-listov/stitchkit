---
title: "CLI: stdin только под обязательное поле; синхронный stdout перед exit"
description: Два consumer-бага createCli — зависание на открытом stdin-пайпе агента при необязательных полях и обрезка вывода на 65536 байт из-за async stdout + мгновенного process.exit.
type: task
status: done
created: 2026-08-19
updated: 2026-08-19
completed: 2026-08-19 09:20 +07:00
---

# CLI: stdin-заполнение и синхронный stdout

## Зачем

Bug report потребителя (CLI поверх stitchkit), оба подтверждены по source:

1. `tools/cli.ts:413` — piped stdin заполняет **первое незаполненное**
   non-boolean поле без проверки required. В агентском Bash stdin — открытый
   пайп без EOF → команда с необязательным незаполненным полем
   (`app list_models --json > file`) висит бесконечно на `for await stdin`.
2. `tools/cli.ts:306` — дефолтный stdout это async `process.stdout.write`, а
   выход — мгновенный `process.exit` → payload больше пайп-буфера обрезается
   ровно на 65536 байт (у потребителя воспроизведено: 70 КБ JSON → 65536).

Потребитель закрыл оба своими обходами — по протоколу owned-библиотеки обход
не является завершением: чиним корень и даём patch.

## Результат

- stdin читается **только** когда есть незаполненное **обязательное**
  non-boolean поле; команды с одними необязательными аргументами stdin не
  трогают вообще.
- Дефолтные stdout/stderr пишут синхронно (`writeSync` в fd, fallback на
  async при ошибке) — вывод любого размера доживает до exit.
- Patch-релиз 0.53.2; потребитель убирает оба обхода.

## План

- [x] `tools/cli.ts`: `f.required` в предикат `firstUnset` + комментарий про
      агентский открытый пайп.
- [x] `tools/cli.ts`: дефолтные writers через `writeSync(1|2)` с fallback.
- [x] Тесты: spy-stdin НЕ вызывается для команды с одними необязательными
      полями (и вызывается для обязательного); spawn-фикстура печатает
      >64 КБ через пайп — длина точная.
- [x] CHANGELOG Fixed, verify, tag `v0.53.2`, зелёный CI+npm, подтверждение
      потребителю.

## Acceptance

- [x] Оба новых теста красные на 0.53.1-поведении, зелёные после фикса.
- [x] `stitchkit@0.53.2` на npm.

## Что сделано

- [x] `packages/core/src/tools/cli.ts` — `f.required` в предикате stdin-заполнения; дефолтные writers через `writeSync(1|2)` с async-fallback
- [x] Тесты: `packages/core/tests/cli.test.ts::stdin is never read when every unset field is optional` (+ `piped stdin fills an unset REQUIRED field`); `packages/core/tests/cli-sync-stdout.test.ts::a payload beyond the 64 KB pipe buffer survives process.exit untruncated` (spawn реального CLI с дефолтными writers, фикстура `fixtures/cli-big-output.ts`)
- [x] CHANGELOG `[0.53.2]` Fixed; оба теста красные на старом поведении по построению (spy-каунтер = 1; парс обрезанного JSON падает)
