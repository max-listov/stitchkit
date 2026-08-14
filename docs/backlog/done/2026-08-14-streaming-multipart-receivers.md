---
title: Потоковые multipart receivers
description: Добавить Fetch-clean streaming multipart path, который передаёт file streams прямо в consumer-owned storage и гарантирует cancellation и cleanup
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 07:21 +00:00
---

# Потоковые multipart receivers

## Зависимости

- `2026-08-14-authorize-before-request-body.md` — receiver нельзя запускать до auth.
- `2026-08-14-typed-multipart-descriptor.md` — cardinality и policy берутся из одного
  канонического descriptor.

## Зачем

Текущий parser hard-cap-ит request во время чтения, но сохраняет все chunks, затем
копирует их в общий buffer и только после этого вызывает `Response.formData()`.
Разрешённый большой файл поэтому всё равно целиком живёт в RAM, а в момент parsing
может существовать несколько его представлений. Это неприемлемо для видео, архивов и
параллельных upload на сотни мегабайт.

Просто отдать несколько `ReadableStream` через `ctx.files` нельзя: multipart parts
последовательны, а text fields могут находиться после файлов. Нужен receiver phase,
который потребляет каждый file stream по мере parsing, возвращает storage handle и
регистрирует rollback до запуска обычного handler.

## Результат

- Multipart file bytes не собираются framework-ом целиком в памяти.
- Consumer направляет stream непосредственно в filesystem, object storage или другой
  sink, не передавая Stitchkit свою доменную storage model.
- После полного parsing и Zod validation обычный handler получает типизированные
  receiver results вместо временных streams.
- Disconnect, превышение лимита, parser/validation/receiver/handler error вызывают
  cancellation и cleanup уже принятых частей.

## Каноническая implementation shape

Contract включает `delivery: 'stream'` в общем multipart descriptor. Реализация такого
endpoint имеет две явные фазы:

```ts
const service = implement(uploadContract, {
  upload: {
    files: {
      video: async ({ metadata, stream, signal }) => {
        const stored = await storage.write({ metadata, stream, signal });
        return {
          value: stored,
          cleanup: () => storage.remove(stored.key),
        };
      },
    },
    handler: async ({ params, input, files }) => {
      // files.video is inferred from receiver.value
      return mediaService.attach(params.id, input, files.video);
    },
  },
});
```

- `metadata` содержит field name, original filename, declared media type и размер,
  только если он действительно известен.
- `stream` — Web `ReadableStream<Uint8Array>`, а `signal` связан с request disconnect
  и framework cancellation.
- Receiver keys обязаны точно совпадать с contract file fields; multiple field вызывает
  receiver для каждой части и даёт handler массив `value` в исходном порядке.
- `cleanup` обязателен для уже материализованного внешнего состояния. Framework вызывает
  его в обратном порядке при любом последующем failure; после успешного handler cleanup
  ownership переходит приложению.
- Buffered `delivery: 'buffer'` остаётся вариантом этого же descriptor, а не старым API.

## Архитектурные ограничения

- Parser остаётся Web Fetch-clean и работает одинаково на Bun и Node ≥22.
- Нельзя реализовать streaming через `File.stream()` после `formData()` — к этому моменту
  payload уже был buffered.
- Нельзя запускать handler до завершения text-field validation.
- Receiver может писать внешнее состояние до валидации поздних text fields, поэтому
  rollback lifecycle является частью correctness, а не optional callback.
- Framework не обещает atomicity внешнего storage и БД; handler должен связывать receiver
  handles со своей моделью транзакционно.

## План

- [x] Провести короткий source-level spike maintained multipart parsers с Web Streams,
      Bun/Node parity, hard limits и cancellation; решение и причины зафиксировать ADR.
- [x] Если внешняя библиотека не удовлетворяет Fetch-clean boundary, изолировать parser
      implementation в server adapter без протекания Node/Bun types в public declarations.
- [x] Добавить sequential part parser с ограничением total bytes, part headers, text-field
      bytes, file bytes и file count без доверия `Content-Length`.
- [x] Реализовать receiver implementation shape и inference для single/multiple fields.
- [x] Связать request abort/disconnect с parser, активным receiver и `ctx.signal`.
- [x] Реализовать rollback stack: exactly-once cleanup в обратном порядке; cleanup error
      наблюдаем, но не заменяет исходную business/validation error.
- [x] Не запускать ни parser, ни receiver до успешной HTTP authorization.
- [x] Сохранить обычный lifecycle после parsing: `beforeHandle` → handler → output validation.
- [x] Документировать storage receiver examples для filesystem и generic object storage,
      не добавляя конкретную storage dependency в core.
- [x] Добавить changelog и API reference; обновить generated LLM docs.

## Тестовая матрица

- [x] Большой файл проходит при ограниченном heap profile без размера payload в RAM.
- [x] Missing и spoofed `Content-Length` не обходят total/per-file limits.
- [x] Boundary, headers и chunks, разбитые в произвольных местах, корректно парсятся.
- [x] Client disconnect отменяет reader и receiver, затем вызывает cleanup.
- [x] Ошибка receiver, позднего text field, Zod validation, второго файла и handler вызывает
      cleanup всех ранее принятых handles exactly once.
- [x] Cleanup failure не скрывает исходную ошибку и доходит до framework diagnostics.
- [x] Multiple files сохраняют порядок receiver values.
- [x] Unauthorized request не запускает parser/receiver и не читает body.
- [x] Bun integration, Node smoke и consumer lane проходят одной реализацией.

## Acceptance

- [x] Framework не удерживает целиком ни один streaming file и весь multipart request.
- [x] Consumer может напрямую направить bytes в storage через Web stream.
- [x] Все частично созданные handles удаляются на любом незавершённом пути.
- [x] Handler запускается только после полного parsing и валидированного text input.
- [x] Streaming и buffered delivery используют один contract descriptor и одинаковую policy.
- [x] Public declarations не содержат Bun, Node stream или storage-specific types.
- [x] Полный `bun run verify` и heap/cancellation integration gates зелёные.

## Не входит

- Resumable/chunked upload protocol, presigned URLs и background transcoding.
- Автоматический S3/filesystem implementation внутри Stitchkit.
- Distributed transaction между storage и consumer database.

## Что сделано

- [x] **Исследование:** ADR 0071 фиксирует source-level проверку
      `@remix-run/multipart-parser@0.16.4`: библиотека буферизует part и не подходит для
      прямой передачи file stream в receiver.
- [x] **Parser:** `packages/core/src/server/multipart.ts` реализует Fetch-clean sequential
      parser с произвольными chunk boundaries, request/per-file limits и без полной
      материализации файла или request.
- [x] **Receiver API:** `packages/core/src/server/types.ts`, `implement.ts` и `context.ts`
      добавляют `defineMultipartStream`, inferred receiver values, abort propagation и
      exactly-once reverse rollback.
- [x] **Тесты:** `packages/core/tests/multipart-streaming.test.ts` —
      `parses arbitrary chunk boundaries and validates late text fields`,
      `delivers a large file incrementally instead of materialising the payload`,
      `request abort cancels the active receiver and rolls back earlier handles`,
      `cleanup failure is diagnosed without replacing the original parse error`,
      `hands inferred receiver values to the handler and rolls them back on handler failure`.
- [x] **Гейты:** полный `bun run verify` прошёл на Bun и Node, включая consumer lane.
