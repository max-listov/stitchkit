---
title: Тексты говорят ровно то, что делает код
description: Полтора десятка мест, где документация, комментарий или правило обещают больше или другое, чем реализация, — включая два, написанных в этом же заходе.
type: task
status: done
tags: [docs, honesty, declaration]
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 20:51 +00:00
---

# Тексты говорят ровно то, что делает код

## Зачем

Один класс дефекта, много мест. Каждое воспроизведено чтением или пробником.

### Мои собственные, из этого захода

- **`declaration.ts:28` — «**Every** remaining free string is checked against
  `namesAMachine`».** Не проверяются: `identity.name`, ключи и значения
  `description`, члены enum в `env.variables`. Пробник: `identity.name = "api at
  10.0.0.5:5432"` и `description.en = "postgres://u:p@db.internal:5432/x"`
  принимаются, хотя `namesAMachine` на них отвечает «an absolute address».
- **`declaration.ts:22` — «a part may not be an ASSIGNMENT in any form».**
  Проходят `_API_TOKEN=secret`, `--set:key=value`, `--opt[k]=v`.
- **`docs/guide/upgrading.md:1410`** отправляет «за *Released migration* ниже» —
  секция называется *Unreleased* и лежит **выше**.

### Имена инструментов и правила

- **Дефис в производном имени инструмента.** `toToolName('billing','get-invoice')`
  → `"get-invoice_billing"`. `docs/guide/contracts.md:197`,
  `docs/guide/mcp-and-agents.md:35` и `skills/stitchkit/SKILL.md:60` утверждают,
  что дефис выживает только в явном `toolName`. ADR 0035 прямо решает обратное
  для method-половины — значит неправ текст.
- **Сколько видов endpoint никогда не инструменты.** Код
  (`tools/internal/surface-projector.ts:192`) пропускает **четыре**:
  `multipart`, `rawBody`, `responseMeta`, `rawResponse`. `mcp-and-agents.md:25`
  говорит «два», `contracts.md:178` — «три».
- **`suppressUnauthorizedFor` выбирает путь, а не операцию.**
  `browser/client-url.ts:91` не читает `endpoint.method`; матчер — это
  `(pathname) => boolean`. `docs/guide/client.md:44` обещает выбор операций и что
  «общий префикс никогда не подавит соседний защищённый endpoint». Соседний по
  тому же пути на другом методе подавляется.
- **`serviceName`/`action` есть не на каждом событии.**
  `docs/guide/observability.md:245` — «present on every event, including a
  pre-handler 400»; `setRequestEndpoint` вызывается только после совпадения
  контрактного маршрута (`server/create.ts:421`), а raw-route, короткое замыкание
  `onRequest` и 404/405 выходят раньше. Оба поля опциональны в типе.
- **`middleware/cors.ts:41` — «`X-Request-Id` — trace id, который несёт **каждый**
  ответ».** `server/create.ts:577` намеренно пропускает установку на неизменяемых
  заголовках и честно это объясняет; соседний текст — нет.

### Правила репозитория, которые сильнее дерева

- **`AGENTS.md:55` про `bun run verify`** перечисляет lint/typecheck/test/build/
  node smoke (+ consumer lane), а `package.json:21` гоняет ещё `smoke:next-ssr` и
  `starter-lane` с Playwright и настоящим PostgreSQL. В обратную сторону CI гоняет
  `test:agent-store-postgres` и весь job `supervised`, которых в `verify` нет, —
  то есть «CI runs the same suite» неверно в обе стороны.
- **`AGENTS.md:196` — «`pre-push` runs the same checks».** `assert-head`
  вызывается только из `release.yml`; путь тега в `release-plan.ts:595` его не
  зовёт и `origin/master` не читает. `CONTRIBUTING.md:149` описывает pre-push
  правильно.
- **`AGENTS.md:30` про `as`-касты** перечисляет площадки и требует у каждой
  комментарий; в `packages/core/src` тринадцать ассерций, пять вне перечисленных
  мест, три из них без обоснования. `CONTRIBUTING.md:219` формулирует правило
  третьим способом. Гейта нет.
- **`AGENTS.md:82` Layout** рисует закрытое дерево из восьми каталогов; в
  `packages/core/src` их двенадцать — нет `files/`, `observability/`, `realtime/`,
  `testing/`, все четыре опубликованы.
- **`AGENTS.md:166`** отправляет за релизным флоу в шапку `ci.yml`; флоу тега — в
  `release.yml`.

### Мелкие расхождения текстов

- `ROADMAP.md:22` обещает stateful HTTP mode, снесённый ADR 0068.
- `docs/decisions/README.md:51` помечает ADR 0034 superseded, сам файл —
  `status: accepted`. Единственное расхождение индекса и файла.
- `docs/decisions/0059-…md:13` ссылается на несуществующий
  `0014-tool-context-and-mcp-native-output.md`.
- `CONTRIBUTING.md:94` называет файл `_env`, которого нет.
- `docs/README.md` не знает про `icebox/`, называет раздел `## What was done`
  (в 326 файлах из 332 он `## Что сделано`) и отправляет за форматом ADR в
  `decisions/README.md`, где раздела о формате нет.
- `docs/guide/application-kernel.md:157` перечисляет поля проекции статуса без
  `id`, хотя он там есть, и формулирует это как намеренное «no resource ids».
- Матрица опциональных peers существует в трёх копиях
  (`getting-started.md:147`, `SKILL.md:80`, `README.md:413`) и разошлась: во всех
  трёх нет `@socket.io/component-emitter`, в README нет `srvx`.
- `docs/guide/upgrading.md:21` — Flow из шести шагов ни разу не отправляет
  читателя в секции `## Released migration:` того же файла, ради которых
  существует гейт продвижения. Стартерный `UPGRADING.md:35` делает это правильно,
  но отправляет в секции, которых для выпущенных версий пока нет.
- `.github/ISSUE_TEMPLATE/config.yml:4` ведёт на `maxlistov/stitchkit` вместо
  `max-listov/stitchkit` — это ссылка приватного репорта уязвимостей, и она 404.

## Результат

- Ни один из перечисленных текстов не обещает того, чего код не делает.
- Там, где дешевле починить код (границы декларации), чинится код.
- Где обещание верное, но не проверялось, — появляется проверка.

## План

- [x] Декларация: применить `refuseMachineNames` к оставшимся свободным строкам
      и расширить запрет присваивания; пополнить таблицу отказов.
- [x] Привести перечисленные тексты к коду, по одному месту на утверждение.
- [x] Матрицу peers свести к одной полной формулировке.
- [x] Исправить битые ссылки и статусы ADR.

## Acceptance

- [x] Каждое утверждение из списка проверено против кода после правки.
- [x] `bun run verify` зелёный.

## Что сделано

### Где дешевле починить код — починен код

- [x] `refuseMachineNames` применён к `identity.name`, к ключам **и** значениям
      `description` и к членам enum. Четыре формы, принимавшиеся раньше,
      отвергнуты; закреплены в таблице `REFUSED`.
- [x] Запрет присваивания переписан на `^[^=\s]+=` — «в любой форме» теперь
      правда: `_API_TOKEN=secret`, `--set:key=value`, `--opt[k]=v` отвергнуты,
      все три в таблице.

### Тексты приведены к коду

- [x] Правило дефиса в имени инструмента исправлено в трёх местах
      (`contracts.md`, `mcp-and-agents.md`, `SKILL.md`): нормализация **по
      половинам**, method-половина дефис сохраняет — как и решает ADR 0035.
- [x] «Сколько видов endpoint никогда не инструменты» — четыре, и так теперь
      сказано в обоих местах вместо «двух» и «трёх».
- [x] `docs/guide/client.md` — `suppressUnauthorizedFor` описан как выбор
      **пути**, с конкретным примером, как соседняя операция на том же пути
      теряет сигнал `unauthorized`, и что с этим делать.
- [x] `docs/guide/observability.md` — `serviceName`/`action` есть на событиях
      **контрактных** маршрутов; перечислено, где их нет и почему оба поля
      опциональны.
- [x] `middleware/cors.ts` — «каждый ответ» заменено на честное «когда заголовки
      можно записать», с названным случаем редиректа.
- [x] `application-kernel.md` — в списке полей проекции появился `id`, и
      «no resource ids» уточнено до «no per-resource ids».
- [x] `ROADMAP.md` — снято обещание stateful HTTP mode.

### Правила репозитория

- [x] `AGENTS.md`: `verify` описан тем, что он делает, **и** названы две вещи,
      которые гоняет только CI; про `pre-push` сказано, что `assert-head` там
      нет и чем это грозит; правило `as` перечисляет реальные площадки и прямо
      говорит, что гейта нет; Layout дорисован до двенадцати каталогов; ссылка
      на релизный флоу ведёт в `release.yml`.
- [x] `docs/guide/upgrading.md` — Flow отправляет читателя в секции
      `## Released migration:` того же файла и объясняет, почему `bun run check`
      их не заменяет. Указатель «ниже» исправлен: секция называется *Unreleased*
      и лежит выше.
- [x] `packages/create-stitchkit/UPGRADING.md` — сказано, что канал начинается
      с 0.4.0 и что для более ранних версий есть только changelog.
- [x] `docs/README.md` — появился `icebox/`, раздел называется `## Что сделано`
      (как в 326 записях из 332), а формат ADR описан тем, что ADR реально
      несут, вместо ссылки на несуществующий раздел.
- [x] `docs/decisions/README.md` — легенда покрывает статус `active`, который
      используют девять ADR.
- [x] ADR 0034 помечен superseded в самом файле, как и в индексе; битая ссылка
      в ADR 0059 исправлена; `CONTRIBUTING.md` называет `_env.example`.
- [x] `.github/ISSUE_TEMPLATE/config.yml` — ссылка приватного репорта
      уязвимостей вела на несуществующий `maxlistov/stitchkit` и 404-ла.
- [x] Матрица опциональных peers: канонической осталась одна (getting-started,
      дополнена `@socket.io/component-emitter`); копия в `SKILL.md` заменена
      указателем на неё с четырьмя частыми случаями; таблица в README — не
      дубликат по назначению (она про «почему именно этот пакет»), дополнена
      `srvx` и `@socket.io/component-emitter`.

### Проверка

- [x] `bun run verify` — exit 0.
