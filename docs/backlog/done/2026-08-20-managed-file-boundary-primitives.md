---
title: "Managed file boundary primitives для read, atomic write и typed refs"
description: Общий secure local-file boundary для managed view/download/upload без превращения Stitchkit в storage provider или domain artifact system.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 12:53 +00:00
related: docs/decisions/0082-view-file-has-one-managed-batch-operation.md
---

# Managed file boundary primitives

## Зачем

Managed `view`, `download` и `upload` уже устраняют часть повторяющейся
transport/security механики, но локальная file boundary пока неоднородна:
read path имеет root/realpath/symlink guards, download пишет напрямую, а upload
получает consumer path без общей проверки root, byte limit и content identity.
Consumers повторяют containment, MIME/extension checks, temporary files и
cleanup.

Нужны framework-owned security primitives, но не storage platform. Domain
artifact types, DB rows, provider keys, retention и transformations остаются в
приложении.

## Результат

- Нулевой этап — platform research/probe по Bun/Node filesystem primitives,
  `openat`-классу операций, atomic no-replace и Windows/macOS/Linux semantics.
  До кода фиксируется достижимый threat model.
- Если portable descriptor-relative traversal недоступен, default boundary
  честно защищает от untrusted relative input и pre-existing symlinks при
  application-owned root, который другой actor одновременно не мутирует.
  Защита от hostile concurrent filesystem actor не заявляется; strong
  OS-specific mode остаётся отдельной задачей.
- `createManagedFileBoundary({ root, limits, inspect? })` (рабочее имя)
  асинхронно canonicalize-ит и bind-ит существующую directory один раз;
  последующие read/write операции не принимают новый произвольный root.
- Read разрешает только root-relative paths, проверяет realpath и symlink
  containment, тип объекта и byte limit до выдачи содержимого.
- Read открывает handle/stream, проверяет file kind через handle и применяет
  byte cap во время чтения: предварительный `stat` не является единственной
  защитой от растущего файла.
- Atomic write создаёт exclusive temporary sibling с private mode, пишет stream
  с общим byte/abort budget и выполняет выбранный commit primitive только после
  успешной записи. Existing target policy задаётся явно: secure default
  `reject`, opt-in `replace`; алгоритмы отдельно доказаны для supported Bun/Node
  platforms и same-filesystem boundary.
- Гарантия разделяет atomic visibility и durability. `fsync`/crash durability не
  подразумевается без отдельной опции и доказательства. Owned temp удаляется
  после пойманной error/abort в живом процессе; cleanup failure наблюдаем
  internally. Crash debris получает recognisable naming/recovery policy, а не
  ложное обещание «debris невозможен».
- Optional content inspector получает bounded leading bytes, untrusted declared
  metadata и filename и возвращает только нормализованные generic `mediaType`/
  extension либо typed rejection. Actual path и measured byte size принадлежат
  boundary и не могут быть подменены inspector-ом.
- Успешная операция возвращает Zod-derived neutral `ManagedFileRef` с canonical
  POSIX-style root-relative path, measured byte size, optional media type/name;
  absolute/drive/UNC/dot segments, NUL и platform separators не проходят.
  Absolute host path не уходит в transport presenter или public error.
- Neutral `ManagedFileRefSchema` живёт в browser/contract-safe entrypoint;
  filesystem capability — в отдельном peer-free Bun/Node runtime entrypoint,
  не в browser root и не в MCP/AI-heavy `stitchkit/tools` graph.
- `defineViewFileTool`, `defineDownloadTool` и `defineUploadTool` переиспользуют
  boundary там, где применимо; URL SSRF policy остаётся отдельной существующей
  ответственностью.

## План

- [x] До implementation провести и записать research/probes по Bun/Node/Linux/
      macOS/Windows primitives: descriptor-relative traversal, no-follow,
      atomic `reject`/`replace`, same-filesystem rename/link и cleanup. На основе
      доказательств выбрать portable guarantee либо честно ограниченный threat
      model; абсолютную concurrent-swap гарантию без primitive не заявлять.
- [x] Зафиксировать ADR: existing canonical bound root, supported threat model,
      read/write state transitions, hard-link policy, temp ownership, visibility
      vs durability и границу framework/domain.
- [x] Вынести существующую canonical containment механику в один internal core,
      не создавая конкурирующих реализаций для view/static/multipart.
- [x] Определить exact API: accepted bytes/Web streams, finite positive default
      limits, existing-root initialization, normalized ref namespace, file mode,
      stable caller-safe errors и internal diagnostics. Boundary не отдаёт
      consumer-у unchecked/reopenable arbitrary path.
- [x] Реализовать bound read через opened handle + handle stat + capped read
      loop/Web stream + AbortSignal; directory/device/socket не читать как file.
- [x] Реализовать writer state `opened → writing → syncing? → committed |
      cleaned` с exclusive temp mode `0o600` (или documented platform
      equivalent), отдельными доказанными commit paths для `reject`/`replace`,
      failure injection после каждой transition и in-process cleanup.
- [x] Проверить доступные Bun/Node primitives и выбрать одинаковую public
      семантику; Node-only types не должны проникнуть в browser-clean entrypoints.
- [x] Спроектировать Zod-first `ManagedFileRefSchema` в contract-safe module и
      peer-free Bun/Node `stitchkit/files`-класс entrypoint для runtime
      capability; обновить exports/build/public-surface/browser-clean gates.
- [x] Добавить optional inspector contract. Если выбирается default MIME
      sniffer/dependency, подтвердить поддержку Bun/Node, bundle impact и
      magic-byte coverage отдельным research note до добавления dependency.
- [x] Перевести managed view/download/upload на общий boundary в рамках одной
      breaking minor: download streaming-write не буферизует весь лимит в
      памяти и возвращает relative ref вместо absolute path; upload callback
      получает bounded opened source/ref, а не raw host path; view сохраняет
      operation-specific limits/presenters.
- [x] Не переподчинять автоматически low-level `serveFile` и multipart receiver.
      Static/view могут переиспользовать совпадающий containment/open core;
      optional boundary-backed multipart receiver — отдельный helper только при
      совпадающих ownership/rollback semantics.
- [x] Покрыть traversal, absolute/drive/UNC/NUL/dot/platform paths, symlink
      file/parent в supported threat model, hard links, growing-file cap,
      oversized stream, abort mid-write, injected failure/cleanup failure,
      crash-debris recovery naming, target reject/replace races, non-file object,
      MIME mismatch и atomic visibility; не тестировать недостижимую гарантию.
- [x] Добавить Bun и Node fixtures на одинаковый supported semantic subset,
      packed-consumer coverage, guide/API/generated `llms` и
      `CHANGELOG.md` `⚠️ Breaking changes` с before → after для absolute download
      result, per-call directory/raw upload path и затронутых CLI/raw callers.
      Провести как breaking minor; релиз не входит.

## Acceptance

- [x] Managed local read/write/upload paths используют одну canonical root
      boundary; consumer не копирует realpath/containment/temp cleanup.
- [x] В зафиксированном и доказанном threat model traversal/pre-existing symlink
      не создаёт и не читает файл за root. Hostile concurrent mutation либо
      доказан platform primitive, либо явно объявлен вне portable guarantee.
- [x] После caught error/abort в живом процессе нет частичного target и boundary
      предпринимает/наблюдает cleanup owned temp; crash semantics и recovery
      задокументированы без абсолютного обещания.
- [x] Read cap применяется во время чтения, write cap — во время streaming;
      растущий файл и oversized download не обходят budget и не требуют полной
      буферизации.
- [x] `reject` не заменяет существующий target, `replace` имеет atomic visibility
      в пределах доказанных filesystem guarantees; durability заявляется
      отдельно только если реализована.
- [x] Transport output не содержит absolute host paths.
- [x] Приложение по-прежнему владеет storage provider, persistence, retention,
      domain taxonomy, image conversion и chunked-upload business protocol.
- [x] Upload callback не получает произвольный host path; inspector не может
      подменить actual size/path; low-level `serveFile`/multipart не получают
      несогласованную новую ownership semantics.
- [x] Core browser-clean gate и Bun/Node parity зелёные.
- [x] `bun run verify` зелёный.

## Что сделано

- Добавлен stitchkit/files с одним bound root, canonical transport-safe refs, capped opened-handle reads и streaming atomic writes.
- Managed view/download/upload переведены на boundary; low-level serveFile и multipart ownership намеренно не менялись.
- Зафиксированы ADR 0088 и research по portable Bun/Node/Linux/macOS threat model; обновлены guides, API, changelog, Node smoke и packed consumer.
- [x] Регрессия: packages/core/tests/managed-file-boundary.test.ts::binds one root and returns transport-safe refs without leaking it; packages/core/tests/managed-file-boundary.test.ts::rejects non-canonical paths and pre-existing symlinks outside the root; packages/core/tests/managed-file-boundary.test.ts::enforces the cap while reading the opened handle, not only from metadata; packages/core/tests/managed-file-boundary.test.ts::reject is atomic by default and replace is an explicit atomic cutover; packages/core/tests/managed-file-boundary.test.ts::stream overflow and inspector rejection leave no visible target or temp; packages/core/tests/managed-file-boundary.test.ts::an already-aborted write performs no filesystem mutation
