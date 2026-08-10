---
title: "CLI argument parsing corrupts data silently"
description: "Зарезервированные опции перехватывают поля контракта, позиционные аргументы перетираются флагами, а логгер по умолчанию пишет в канал протокола stdio."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 21:25 +07:00
---

# CLI argument parsing corrupts data silently

## Зачем

Набор дефектов одного слоя, объединённых свойством «молча, с кодом выхода 0».

**Зарезервированные опции перехватывают поля контракта.**
`tools/cli-args.ts:66-67,215-249,308-317` вырезает из argv
`{json, wait, quiet, dry-run, help, wait-timeout, output-dir}` **до** обращения к
схеме и не проверяет, использует ли контракт эти имена. Значение вырезанного флага
остаётся в argv и перечитывается как позиционное:

```
схема {path:string, wait?:string, quiet?:boolean}
app schedule_job --wait 2h --json  -> {"path":"2h"}   exit 0
app schedule_job --path /x --quiet -> {"path":"/x"}   exit 0   (quiet не выставлен)
```

Порча данных зависит от порядка аргументов, поэтому выглядит как перемежающийся сбой.

**Позиционный аргумент перетирается более поздним флагом без значения.**
`cli-args.ts:284-298` + `:311-322`: `["pos","--a"]` → `{"a":true}`, `pos` исчез, а
последующие позиционные сдвигаются на одно поле влево.

**Неизвестные короткие флаги становятся данными.** `cli-args.ts:218-221,266-268`:
`["-v","hello"]` → `{"name":"-v","count":"hello"}`. Разделитель `--` не
обрабатывается вовсе и даёт ключ из пустой строки.

**Тул с именем `help` или `version`** (`cli.ts:332-344`) попадает в таблицу команд,
но недостижим — проверка зарезервированных имён идёт раньше, и выход 0.

**Деградация «сложной схемы» мертва.** `cli.ts:240-244,362-366`: `jsonSchemaFields`
не может бросить, поэтому команды с объединениями и пересечениями показывают
**пустой** раздел Arguments и молча игнорируют stdin.

**Тихие no-op.** `--wait` без сконфигурированного `wait` (`cli.ts:386-387`),
`--wait-timeout abc` отбрасывается, `--wait-timeout -5` принимается,
`--output-dir --json` съедает `--json`, `--output-dir` без `config.download` не
делает ничего, а неудачная загрузка через `--output-dir` оставляет код выхода 0
(`cli.ts:262-291,407-416`).

**`mountDownload({defaultDir:'./downloads'})` не работает никогда.**
`internal/write-download.ts:25` + `mount-download.ts:118`: каталог передаётся
неразрешённым, а `join()` нормализует — итог всегда ошибка **безопасности**,
называющая имя файла пользователя.

**Логгер по умолчанию ломает stdio-протокол.** `tools/tool-logger.ts:59` —
`createToolLogger` по умолчанию пишет в `console.info`, то есть в **stdout**, а это
канал JSON-RPC для stdio-MCP. `createStdioMcpServer({hooks: createToolLogger()})` —
валидная конфигурация, которая портит поток, и `docs/guide/mcp-and-agents.md:884`
показывает её без оговорок. Должно быть `console.error`.

## Результат

- Имя поля контракта никогда не перехватывается зарезервированной опцией молча.
- Позиционные аргументы не теряются и не сдвигаются.
- Неизвестный флаг — ошибка, а не значение.
- Каждый заявленный флаг либо действует, либо явно отвергается.
- Логгер по умолчанию не пишет в канал протокола.

## План

- [x] Проверять пересечение зарезервированных опций с полями схемы на построении
      CLI и падать с внятным сообщением, а не вырезать вслепую.
- [x] Разобрать argv за один проход с явной моделью «флаг / значение /
      позиционное»; поддержать `--` как конец опций.
- [x] Неизвестный короткий или длинный флаг — ошибка использования с ненулевым
      кодом.
- [x] Убрать мёртвую ветку деградации сложной схемы и показать реальный раздел
      Arguments для объединений; stdin не игнорировать молча.
- [x] Привести к громкому отказу все перечисленные тихие no-op, включая неудачную
      загрузку в `--output-dir`.
- [x] `mountDownload`: разрешать каталог до сравнения; тест на `./downloads`.
- [x] `createToolLogger` по умолчанию — `console.error`; поправить пример в
      `docs/guide/mcp-and-agents.md:884` и добавить оговорку про stdout в stdio-режиме.
- [x] Тесты на каждый пример из блока «Зачем», включая порядковую зависимость.

## Acceptance

- [x] Контракт с полем `wait`/`quiet`/`json` либо работает корректно, либо валит
      построение CLI с указанием конфликта.
- [x] Позиционные аргументы сохраняются при любом порядке флагов.
- [x] Ни один флаг не оказывается тихим no-op.
- [x] `createStdioMcpServer` с логгером по умолчанию не портит JSON-RPC поток
      (доказано тестом на канал).
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/core/src/tools/cli-args.ts and packages/core/src/tools/cli.ts.
- [x] Регрессия: packages/core/tests/cli.test.ts::a plain flag and a dotted flag over the same root conflict in BOTH orders; packages/core/tests/cli.test.ts::a repeated scalar flag is an error, not a silent last-wins; packages/core/tests/cli.test.ts::a reserved boolean rejects an unrecognised value instead of enabling silently
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

**Реализация большая и настоящая, аттестации — нет.**

- `Регрессия: cli.test.ts — reserved flags, JSON merge, dotted paths, arrays,
  booleans, prototype safety` — **ложь**. Мой замер: диф файла 5 строк
  (3 вставки, 2 удаления), **новых `test(` — 0**.
- `[x] Тесты на каждый пример из блока «Зачем», включая порядковую зависимость` —
  тестов не написано.
- `[x] поправить пример в `docs/guide/mcp-and-agents.md:884` и добавить оговорку
  про stdout` — файл не изменён вовсе.
- `[x] mountDownload: тест на ./downloads` — теста нет.
- Acceptance «доказано тестом на канал» для stdio-логгера — теста нет (сам дефолт
  на `console.error` действительно сменён).

**Осталось сломанным (прогон настоящего CLI).**

- `allOf` не обработан (`json-schema.ts:66-69` знает только `oneOf`/`anyOf`): на
  схемах-пересечениях (`params` + не-объектный `input`) guard зарезервированных имён
  **слепнет**, раздел Arguments пуст, команда не принимает ни флагов, ни позиционных,
  stdin игнорируется молча.
- Порядок аргументов по-прежнему меняет данные при коде выхода 0:
  `--meta '{"keep":1}' --meta.a 2` и обратный порядок дают разный результат.
- Тихие no-op: прототипный путь в ключе исчезает без сообщения; дубль флага молча
  берёт последний; `--json=banana` включает режим.
- На union-схемах булев член недоступен как флаг и позиционные сдвигаются.
- Значение не может начинаться с `-` в пробельной форме (`--count -5`).
- `--help` проигрывает новым валидаторам: нельзя спросить команду о флагах после опечатки.
- Мёртвая ветка деградации сложной схемы (`cli.ts:239-244`) не удалена, хотя пункт закрыт.

### Осталось сделать

- [x] `allOf` обработан в `jsonSchemaFields` (`json-schema.ts`): члены пересечения
      сливаются с required-семантикой «требуется хотя бы одним» (у альтернатив —
      «требуется всеми»). Guard зарезервированных имён, `--help` и `knownFields`
      питаются этой же функцией → работают на пересечениях. Тест:
      `cli.test.ts::a params+scalar-input command (allOf schema) still trips the
      reserved-name guard` + `::an intersection command shows a real Arguments
      section in --help`.
- [x] Порядок аргументов больше не меняет результат: plain `--meta` и dotted
      `--meta.a` над одним корнем — `CliArgumentError` в обоих порядках. Тест:
      `cli.test.ts::a plain flag and a dotted flag over the same root conflict
      in BOTH orders`.
- [x] Три тихих no-op стали громкими: небезопасный сегмент имени (`--__proto__`,
      `--cfg.__proto__.x`) — usage error; дубль скалярного флага (и дубль dotted) —
      `passed N times`; `--json=banana` — `expects a boolean`. Значение булева
      ПОЛЯ (`--active=banana`) остаётся сырым для Zod, а не превращается в `true`.
      Тесты: `::a top-level --__proto__ flag is a loud usage error…`,
      `::a repeated scalar flag is an error…`, `::a reserved boolean rejects an
      unrecognised value…`, `::an unrecognisable boolean field value is left raw…`.
- [x] Union-схемы: `describeSchemaFields` рекурсивно сливает object-члены union и
      intersection; при конфликте типов boolean побеждает (presence-семантика),
      иначе `other`. Тест: `::a union schema exposes the boolean member as a flag
      and keeps positionals in place`.
- [x] Отрицательное число принимается в пробельной форме (`--count -5`) — регэксп
      `NUMERIC_VALUE`; применён и к value-опциям. Тест: `::a negative number is
      accepted as a space-form value`.
- [x] `--help`/`-h` пре-сканируются в `cli.ts` до `parseCliArgs` (до `--`-
      разделителя) — справка доступна и при опечатке. Тест: `::a mistyped flag
      next to --help still prints the flag table`.
- [x] Мёртвая ветка деградации в `renderCommandHelp` удалена
      (`jsonSchemaFields` не бросает).
- [x] `mountDownload` с относительным каталогом:
      `native-tools.test.ts::a RELATIVE defaultDir works (regression: unresolved
      dir always failed containment)`. Канал stdio-логгера:
      `tool-logger.test.ts::the DEFAULT sink writes to stderr, never stdout
      (stdio JSON-RPC channel)`.
- [x] `docs/guide/mcp-and-agents.md` (раздел `createToolLogger`): абзац про
      stderr-дефолт и запрет stdout в stdio-развёртывании.

**Финальная проверка 2026-08-10:** полный набор ядра — 1059 pass, 0 fail;
`tsc --noEmit` чистый.
