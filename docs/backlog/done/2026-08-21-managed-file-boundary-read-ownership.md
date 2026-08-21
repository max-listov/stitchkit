---
title: "Managed file read inspection, root ownership and safe failures"
description: Дополнить bound files безопасным root bootstrap, read-side metadata inspection и caller-safe native-tool errors.
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
related: docs/decisions/0096-managed-file-boundary-owns-safe-read-semantics.md
---

# Managed file boundary: read inspection, ownership и safe failures

## Зачем

`createManagedFileBoundary` требует заранее существующий root, хотя boundary
может безопасно владеть его bootstrap. Inspector применяется только на write,
поэтому pre-existing files после `read()` теряют проверенный media metadata.
Кроме того, managed download/upload factories пропускают ожидаемые
`ManagedFileError` в generic internal-error normalization, хотя invalid path,
not found, too large, exists и inspection rejection являются безопасными
caller-facing failures.

Нельзя при этом раскрывать абсолютные paths, raw filesystem errors или делать
`FILE_IO_ERROR` публичной validation-ошибкой.

## Результат

- `createManagedFileBoundary({ root, createRoot: true })` одним `mkdir` создаёт
  отсутствующую final application-owned directory под уже существующим trusted
  parent с requested mode `0o700` (umask может сделать его строже), затем
  проходит тот же canonical realpath binding; default по-прежнему требует
  существующий root.
- `read()` применяет bounded inspector к фактически прочитанному prefix и
  возвращает normalized `mediaType`/`name` в `ManagedFileRef`.
- Expected managed-file codes (`INVALID_PATH`/`OUTSIDE_ROOT` 400, `NOT_FOUND`
  404, `NOT_REGULAR`/`INSPECTION_REJECTED` 422, `TOO_LARGE` 413, `EXISTS` 409)
  входят в `STITCH_ERROR_STATUS` и централизованно превращаются native factories в
  stable caller-safe `AppError` statuses/codes; `FILE_IO_ERROR` и unknown causes
  остаются internal и логируются canonical normalizer'ом.
- View-file partial errors используют безопасные сообщения и не печатают raw
  internal filesystem cause/path.

## План

- [x] Зафиксировать existing trusted parent, single final-root mkdir,
      mode/umask, concurrent `EEXIST` revalidation, root-file reject и
      сохранение текущей canonicalized-root-symlink policy.
- [x] Реализовать explicit `createRoot` до canonical bind без смены default.
- [x] Переиспользовать один bounded inspection path для read/write и сохранить
      measured path/size ownership boundary.
- [x] Определить exhaustive safe-code→status mapping, обновить official error
      registry и shared native-tool
      adapter; internal IO/cause не конвертировать в caller message.
- [x] Применить mapping в managed download/upload/view definitions и raw
      adapters; unexpected view/raw error логировать internally и scrub'ить.
- [x] Покрыть missing root default/create, concurrency, root symlink/file,
      read MIME/name, inspection rejection, every safe code и scrubbed IO error
      через MCP/Agent paths.
- [x] Обновить ADR/reference/guide/generated docs/changelog и Node/browser
      entrypoint gates.

## Acceptance

- [x] Opt-in root bootstrap устраняет отдельный app mkdir и не ослабляет
      containment/default existing-root contract.
- [x] Read-side inspector получает не больше configured prefix и не может
      подменить path/size.
- [x] Expected file mistakes доходят как stable domain/validation failures;
      unexpected IO остаётся `INTERNAL_SERVER_ERROR` с internal log cause.
- [x] Ни один caller-facing result/error не содержит framework-derived boundary
      root/host path; отражённый caller input path/URL не считается утечкой.
- [x] Inspector получает bounded prefix и signal; outer abort перестаёт ждать
      non-cooperative callback, а write после abort не commit'ит target.
- [x] Bun и Node проходят одинаковую semantic matrix.
- [x] `bun run verify` зелёный.

## Конвейер 2/2

- [x] Plan validator 1/2 — уточнены portable mkdir, symlink и error table.
- [x] Plan validator 2/2 — добавлены registry/raw adapters/abort boundary.
- [x] Implementation validator 1/2 — PASS: public safe-error mapping и
      inspection ownership не выдают filesystem internals.
- [x] Implementation validator 2/2 — PASS: trusted-parent bootstrap,
      isolated read prefix, abort/deadline и Node parity закрыты.

## Что сделано

- [x] Core: opt-in `createRoot` создаёт только final root под существующим
      trusted parent; read/write используют один bounded inspector с signal и
      deadline, а returned bytes не разделяют mutable inspector buffer.
- [x] Errors/transports: полный safe `FILE_*` registry получает стабильные HTTP,
      MCP и Agent mappings; unknown/`FILE_IO_ERROR` логируются и scrub'ятся.
- [x] Регрессии:
      `packages/core/tests/managed-file-boundary.test.ts::bootstraps only the final root on opt-in and revalidates concurrent creators`;
      `packages/core/tests/managed-file-boundary.test.ts::inspects the bounded read prefix and returns only normalized metadata ownership`;
      `packages/core/tests/managed-file-boundary.test.ts::bounds non-cooperative inspection by caller abort and deadline without committing writes`;
      `packages/core/tests/managed-file-errors.test.ts::maps every registered safe code without exposing the boundary message`.
