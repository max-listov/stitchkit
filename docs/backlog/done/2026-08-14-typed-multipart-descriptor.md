---
title: Типизированный multipart descriptor и multi-file uploads
description: Заменить строковый multipart API единым декларативным контрактом для одного или нескольких файлов, лимитов и transport-level MIME policy
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 07:21 +00:00
---

# Типизированный multipart descriptor и multi-file uploads

## Зачем

Текущий `multipart: 'file'` описывает только одно обязательное файловое поле.
Runtime вызывает `formData.get()`, handler получает optional `ctx.file`, typed client
принимает один `MultipartFile`, а OpenAPI публикует один binary property. Несколько
вложений требуют raw route, ручные `FormData`, auth, validation и response parsing.

Лимит всего multipart request вынесен в соседнее поле `maxUploadBytes`, а per-file
лимиты, количество и допустимые declared MIME каждый consumer проверяет вручную.
Нужен один источник правды, объединяющий cardinality и предварительную файловую
policy, а не отдельные конкурирующие API.

## Результат

- Контракт декларативно описывает все файловые поля multipart request.
- Single-поле типизируется как один файл, multiple-поле — как массив; optionality
  выводится из descriptor.
- Handler получает обязательный и точно типизированный `ctx.files`, а не общий
  optional `ctx.file`.
- Typed client, Web/React Native file descriptors и OpenAPI выводятся из того же
  descriptor.
- Общий request cap, per-file cap, количество и declared MIME проверяются до handler
  единообразными framework errors.

## Канонический API

```ts
uploadAttachments: {
  method: 'POST',
  path: '/:answerId/attachments',
  params: AnswerIdParamsSchema,
  input: UploadMetadataSchema,
  output: UploadedAttachmentsSchema,
  expose: ['HTTP'],
  multipart: {
    maxRequestBytes: 120 * 1024 * 1024,
    files: {
      cover: {
        required: false,
        maxBytes: 10 * 1024 * 1024,
        contentTypes: ['image/*'],
      },
      attachments: {
        multiple: true,
        maxFiles: 8,
        maxBytes: 20 * 1024 * 1024,
        contentTypes: ['image/*', 'application/pdf'],
      },
    },
  },
}
```

```ts
uploadAttachments: ({ params, input, files }) => {
  // files.cover: File | undefined
  // files.attachments: File[] (at least one entry)
}
```

`required` по умолчанию `true`, `multiple` по умолчанию `false`.
`maxFiles` разрешён только при `multiple: true`. `contentTypes` принимает точный
media type либо validated wildcard вида `image/*`. Это только проверка multipart
header; content sniffing, antivirus и storage policy остаются приложению.

## Breaking boundary

Это чистый hard cut:

- `multipart: 'file'` удаляется;
- top-level `maxUploadBytes` удаляется в пользу `multipart.maxRequestBytes`;
- `ctx.file` удаляется в пользу `ctx.files.<field>`;
- старый positional `parseMultipart(req, field, schema, maxBytes)` заменяется API,
  принимающим тот же descriptor, который использует contract runtime.

Deprecated overloads, aliases и временные wrappers не остаются. Breaking minor
должен содержать механический before → after migration guide.

## Семантика validation

- Необъявленный file field отклоняется, а не молча игнорируется.
- Text field с именем declared file field и file в месте text input отклоняются.
- Multiple field сохраняет порядок частей multipart.
- Общий cap считает весь request, включая boundaries, headers и text fields.
- Per-file cap считается отдельно для каждого файла и не доверяет `Content-Length`.
- `maxFiles` применяется во время parsing, до построения массива без ограничения.
- MIME сравнивается case-insensitive после нормализации parameters; пустой или
  неподходящий declared type отклоняется, если policy задана.
- Zod по-прежнему получает raw string text fields и владеет coercion/JSON parsing.

## План

- [x] Добавить Zod-validated/internal-normalized multipart descriptor и definition-time
      проверки против несовместимых HTTP methods и неверных лимитов.
- [x] Переписать contract/client/handler inference без type assertions в business API.
- [x] Заменить `MultipartResult.file` на typed files map и гарантировать runtime/type
      parity для required, optional и multiple fields.
- [x] Расширить capped buffered parser на `getAll`, field cardinality, caps и policy,
      не ослабляя текущую защиту от spoofed/missing `Content-Length`.
- [x] Обновить bare `createClient` и Ky-backed `createHttpClient` path; массивы должны
      append-иться повторяющимся field name в стабильном порядке.
- [x] Сохранить поддержку `Blob` и React Native `FileDescriptor` для каждого элемента.
- [x] Сгенерировать корректные OpenAPI schemas: binary property для single и array of
      binary для multiple, required fields и доступные ограничения.
- [x] Перевести все tests, fixtures, examples и owner-controlled consumer callsites на
      новый единственный API до релиза.
- [x] Обновить contracts/server/client guides, API reference, generated LLM docs и
      upgrade guide.
- [x] Добавить breaking-change запись в `[Unreleased]`.

## Тестовая матрица

- [x] Один required файл: handler и оба client path.
- [x] Один optional файл отсутствует/присутствует.
- [x] Multiple field принимает 1..N файлов и сохраняет порядок.
- [x] Несколько именованных single/multiple fields в одном request.
- [x] Missing required, empty multiple, extra field, wrong part kind и duplicate single.
- [x] Per-file, maxFiles и maxRequestBytes отклоняются на точной границе и выше неё.
- [x] Exact MIME, wildcard MIME, parameters/case normalization и mismatch.
- [x] Text fields остаются raw strings и проходят Zod validation.
- [x] React Native descriptors и web `Blob[]` создают ожидаемый `FormData`.
- [x] OpenAPI snapshot совпадает с runtime cardinality и required policy.
- [x] Type tests запрещают массив для single, scalar для multiple, пропуск required и
      `maxFiles` без `multiple: true`.

## Acceptance

- [x] Multi-file upload не требует raw route или ручного `request.formData()`.
- [x] Runtime, handler types, typed clients и OpenAPI имеют один источник правды.
- [x] В public API не остаётся `ctx.file`, строкового `multipart` или top-level
      `maxUploadBytes`.
- [x] File header policy явно документирована как предварительная, не content security.
- [x] Multipart endpoints остаются HTTP-only и не появляются в MCP/Agent/CLI surfaces.
- [x] Полный `bun run verify` и controlled-consumer migration gates зелёные.

## Не входит

- Streaming delivery: buffered parser остаётся ограниченным `maxRequestBytes`; streaming
  реализуется отдельной задачей.
- Storage adapters, S3, hashing, deduplication, antivirus и доменная модель файлов.
- Upload progress в браузере.

## Что сделано

- [x] **Contract:** `packages/core/src/contract/define.ts` содержит единый typed
      `MultipartDescriptor` с именованными single/optional/multiple fields, request/file
      limits и MIME policy; старые string/top-level формы удалены.
- [x] **Server/client:** `packages/core/src/server/multipart.ts`, `server/context.ts` и
      `browser/client-multipart.ts` используют один descriptor для parsing, handler types
      и repeated `FormData` fields в bare и Ky-backed clients.
- [x] **OpenAPI:** `packages/core/src/server/openapi.ts` публикует binary scalar/array,
      required cardinality и policy из того же descriptor.
- [x] **Тесты:** `packages/core/tests/multipart.test.ts` —
      `returns optional single and ordered multiple fields from one descriptor`,
      `rejects duplicate single, extra file and text in a file field`,
      `enforces maxFiles, per-file bytes and exact/wildcard MIME policy`,
      `both bare and Ky-backed typed clients append repeated file fields`;
      `packages/core/tests/openapi.test.ts` —
      `multipart descriptors preserve cardinality, required fields and file policy`.
- [x] **Гейты:** полный `bun run verify` прошёл; public surface и declaration guard зелёные.
