---
title: Штатный исход инструмента никогда не выглядит поломкой сервера — и это держит гейт
description: Класс «plain Error → INTERNAL_SERVER_ERROR» закрывается не точечно, а механически, для всех coding tools сразу и навсегда.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 02:18 +00:00
related: 2026-09-01-write-file-parent-directories-and-opaque-failures.md
---

## Зачем

Таска про `write_file` чинит два случая. Чтение исходника показывает, что случаев — класс:
в coding-tool модулях каждый штатный отказ брошен plain `Error`, и `toolResultFromError`
(`tools/execute.ts:172`) вычищает их все до пустого `INTERNAL_SERVER_ERROR`:

- `read_file`: «not a regular file», отсутствующий файл (ENOENT из `openFileAt`);
- `edit_file`/патч: «text was not found», «is not unique», «exceeds maxWriteBytes»;
- `write_file`: «File exists», «do not overwrite symlinks», «exceeds maxWriteBytes»;
- `read_output`: битый reference (`NOT_FOUND`); а вот несогласованный `totalBytes` и превышение
  byte-бюджета хранилищем — НЕ штатные отказы: это нарушение контракта хостовым artifact store,
  настоящая internal-причина, остаётся generic (первая редакция этой таблицы ошибалась, поймано
  валидацией);
- граница пути: «escapes the workspace root», «is missing a basename».

У этого класса в репозитории уже есть прецедент лечения формой, а не списком:
`option-effects.test.ts` перечисляет опции механически и отказывает опции без теста. Здесь то же:
одиночные фиксы дрейфуют — следующий инструмент снова бросит `new Error`.

Модель — оператор ВНУТРИ границы workspace: сообщение, сформулированное от relative-пути и
фактов запроса, безопасно по построению. Правило приватности («generic наружу») остаётся для
причин уровня хоста: ENOENT с `/proc/self/fd/…`, отказ native binding, битый artifact store —
они как раз и есть настоящие internal errors.

## Правило конструкции и канал доставки (внесено валидацией 2/2)

**Default-deny по месту броска.** Один errno — два класса: ENOENT на файле, который модель
назвала, — штатный `NOT_FOUND`; ENOENT от `realpath(root)` или пропавшего `/proc/self/fd` —
host-fault. Различает не errno, а слой: typed `AppError` конструируется ТОЛЬКО в coding-tool-слое,
из известного там контекста (relative path, сегмент, счётчик); `contained-files.ts` остаётся
AppError-чистым общим слоем, и всё нетипизированное по-прежнему вычищается `normalizeError`.
EACCES/ENOSPC и прочие непоименованные семейства при default-deny корректно остаются generic.

**Канал доставки текста — и ловушка в нём.** Модель получает
`AgentToolError.message = JSON.stringify({error: code, details, _hint})`. В `toolResultFromError`
стоит `details: appErr.details ?? { message }` — **structured details вытесняют message
полностью**: отказ `conflict('found 3…', { occurrences: 3 })` пришёл бы модели немым
`{error:"CONFLICT", details:{occurrences:3}}`. Правило: инструктивный текст едет в `hint`
(доезжает как `_hint`) и/или дублируется в `details.message`; гейт ассертит присутствие текста в
СЕРИАЛИЗОВАННОМ model-facing конверте, а не только код ≠ INTERNAL_SERVER_ERROR — иначе гейт
зелёный ровно на том дефекте, ради которого существует.

**Подсказка на неизвестное имя** — слой `execute`/`mountAgent`, не coding-tools; и слот
`repairToolCall` ОДИН и уже занят `deferredToolRepair` (`run-execution.ts:547`). Требуется
композиция: typo вне каталога → nearest-name подсказка; известное-но-неактивное имя → существующий
deferred-repair. Разграничение записывается тестом на оба случая.

## Результат

- Словарь: штатный отказ = typed `AppError` с существующим stitch-кодом (`NOT_FOUND`,
  `CONFLICT`, `BAD_REQUEST`…) и инструктивным сообщением от workspace-relative фактов; internal
  остаётся internal.
- Гейт в тестах: для каждого coding tool перечислены его штатные отказные исходы, каждый вызван
  живьём и обязан вернуть код ≠ `INTERNAL_SERVER_ERROR`; новый инструмент без записи — красный.
- Обратная сторона тоже пришита: причина уровня хоста (недоступный root, сломанный binding)
  обязана остаться generic — тест кормит инструмент хостовым отказом и проверяет вычистку.
- Вызов НЕИЗВЕСТНОГО имени инструмента (опечатка модели вне deferred-набора) отвечает
  подсказкой с ближайшими именами, а не голой ошибкой валидации — тот же класс невнятности.

## Acceptance

- [x] Инструменты перечисляются механически из `AGENT_CODING_TOOL_NAMES` (по образцу
      option-effects): инструмент без ≥1 зарегистрированного refusal-кейса — красный гейт;
      таблица из одной строки не проходит.
- [x] Ни один штатный отказ не возвращает `INTERNAL_SERVER_ERROR`, И его инструктивный текст
      присутствует в сериализованном `AgentToolError.message`; ревертом типизации любого — красный.
- [x] Хостовые причины по-прежнему вычищаются; тест это доказывает, а не предполагает.

## Порядок пачки (общий для пяти тасок)

Один release train **0.71.0** (минор — breaking двигает минор), порядок по зависимостям:

1. `an-ordinary-tool-outcome-never-looks-like-a-server-fault` — словарь typed-отказов и гейт;
   три другие таски формулируют свои отказы в нём;
2. `coding-tools-edit-file-list-glob` — edit_file/list/glob + glob-компилятор;
3. `write-file-parent-directories-and-opaque-failures` — auto-mkdir поверх словаря отказов;
4. `search-files-regex-context-and-file-filter` — использует glob-компилятор из (2);
5. `deferred-tool-schemas-and-context-budget` — независим, едет последним слайсом.

Релиз, несущий breaking, перегенерирует cadence-предложение в `docs/guide/getting-started.md`
(гейт `scripts/surface-cadence.test.ts`); starter-слайс (approval-policy шаблона, ключующаяся
именем `apply_patch`) едет отдельным релизом `create-stitchkit` после core.

## Что сделано

### Core
- [x] `packages/core/src/agent-runtime/coding-tool-refusals.ts` — словарь: `codingRefusal`
      копирует message ВНУТРЬ details, поэтому вытеснение сообщения структурными деталями
      непредставимо, а не просто нежелательно; инструкция едет в `hint` → `_hint`.
- [x] `refuseMissingCodingPath` переводит ровно четыре errno-семейства, которые вызывающий может
      отработать: ENOENT, ENOTDIR, EISDIR, ELOOP. Остальное (EACCES, ENOSPC, сломанный биндинг)
      не имеет кейса и остаётся generic — default-deny по построению.
- [x] Границу пути типизирует слой инструментов (`coding-tool-paths.ts`): `..`, пустой и `.`
      сегменты отказываются здесь, потому что `contained-files.ts` — общий слой и обязан
      оставаться AppError-чистым.

### Tests
- [x] `packages/core/tests/coding-tool-refusals.test.ts` — 17 тестов: перечисление инструментов
      механическое из `AGENT_CODING_TOOL_NAMES`, 15 кейсов отказов, и обратная сторона —
      хостовая причина по-прежнему вычищается и не несёт пути хоста.
- [x] Гейт ассертит СЕРИАЛИЗОВАННЫЙ конверт, а не код: проверка только кода была бы зелёной
      ровно на дефекте вытеснения сообщения.

### Найдено гейтом при первом прогоне
- [x] Четыре пробела, которых не было в плане: чтение каталога, сегмент занятый файлом, листинг
      файла и symlink наружу — все приходили пустым INTERNAL_SERVER_ERROR. Все четыре закрыты.
- [x] Один кейс плана оказался неверным: `glob` с `[` компилируется корректно, потому что
      подмножество экранирует всё вне `*`/`?`. Тест исправлен на настоящий отказ glob — границу
      рабочего пространства.
