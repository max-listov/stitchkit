---
title: Client multipart — принимать platform file-descriptor, не только Blob (React Native)
description: Типизированный клиент при вызове multipart-эндпоинта требует `file instanceof Blob`. React Native отдаёт файл как `{uri,name,type}` (не Blob), поэтому RN-консьюмеры вынуждены слать FormData+fetch руками в обход клиента. Просьба принимать RN-style file-descriptor наравне с Blob.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 10:47
---

> **Решение (2026-06-05):** делаем — **вариант B** (экспортируем публичные типы),
> патч-релиз. Маленькое, генеричное (любой RN/Expo консьюмер упрётся в то же
> `instanceof Blob`), не доменное. Сделано ниже.

# Client multipart — принимать platform file-descriptor (React Native)

> **Заявка от консьюмера.** Пишет a consuming project (Tauri desktop + Bun
> local-runtime sidecar + React renderer + React Native mobile + Hono cloud — всё на
> StitchKit-контрактах, версия 0.8.1). Это запрос на расширение; мы готовы помочь с PR.
> Решайте сами — ниже наш кейс, предложение и трейд-оффы.

## Кто мы и что делаем
Консьюмер — голосовой транскрибатор. Аудиозаписи уходят на cloud (Hono) через
multipart-эндпоинт `transcriptions.transcribeFile` (`multipart: 'file'`). На **desktop**
загрузка уже идёт через типизированный клиент — `clients.transcriptions.transcribeFile({ file: blob, …fields })` —
и всё отлично: клиент сам строит FormData, добавляет auth-header, чтит per-endpoint timeout,
парсит output, кидает `ApiError`. Blob там реальный (`Bun.file(path)`).

## Проблема (на mobile)
На **React Native** файл — это не `Blob`, а дескриптор `{ uri, name, type }` (RN-fetch его
понимает и сам стримит с диска по `uri`). А клиент StitchKit в ветке multipart жёстко требует
Blob и бросает:

```js
// packages/core/src/contract/* — построитель метода клиента (в бандле dist/index.js):
if (endpoint.multipart) {
  const file = firstArg[endpoint.multipart];
  if (!(file instanceof Blob)) {
    throw new Error(`Missing multipart file field: ${endpoint.multipart}`);
  }
  const formData = new FormData();
  formData.append(endpoint.multipart, file);
  appendFormFields(formData, firstArg, new Set([...prefixKeys, endpoint.multipart]));
  return client.post(url, formData, …);
}
```

Из-за `instanceof Blob` RN-консьюмер вынужден **обходить клиент** и катать руками
`new FormData()` + `fetch(url, { body: form, headers:{ Authorization } })` + ручной парс ответа —
теряя baseUrl/auth/timeout/`ApiError`/output-парс, которые клиент даёт даром. У нас сейчас это
второй ручной upload именно по этой причине.

## Что просим
Разрешить в multipart-ветке клиента **platform file-descriptor** наравне с `Blob`:
- **Runtime:** заменить `!(file instanceof Blob)` на «Blob **или** похоже на RN file-descriptor»
  — объект с `uri: string` + `name: string` + `type: string`. Такой объект `FormData.append`
  в RN принимает как есть (это и есть штатный RN-способ слать файл). В вебе/Bun остаётся Blob.
- **Тип:** сейчас инпут multipart-метода добавляет `{ [P in K]: Blob }`
  (`packages/core/src/contract/define.ts`). Расширить до `Blob | FileDescriptor`, где
  `FileDescriptor = { uri: string; name: string; type: string }` — чтобы `{ file: { uri,name,type } }`
  типизировался без касто́в.

## Варианты реализации (на ваше усмотрение)
- **A (минимальный, рекоменд.):** принять «duck-typed» дескриптор (`uri`+`name`+`type`) в дополнение
  к Blob. Маленькая правка проверки + типа. Без новых зависимостей.
- **B:** ввести явный публичный тип `MultipartFile = Blob | FileDescriptor` и экспортировать его,
  чтобы консьюмеры типизировали свои хелперы.
- **C:** оставить как есть, задокументировать «RN multipart — мимо клиента». ❌ нас не разблокирует.

## Почему это общее, а не наш частный костыль
Любой RN/Expo консьюмер StitchKit, грузящий файл, упрётся в то же `instanceof Blob`. Чтение
файла в Blob на RN (`fetch(uri).blob()`) для крупных медиа — лишняя загрузка в память, плохо.
Нативный RN-путь — именно дескриптор. Поддержав его, клиент становится по-настоящему
кроссплатформенным для загрузок.

## Трейд-оффы / риски
- Маленький (одна проверка + один тип). Патч-релиз.
- Риск: «duck-typing» дескриптора не должен случайно матчить посторонние объекты — сузить до
  «есть `uri`+`name`+`type` и не Blob».
- Веб/Bun-путь не меняется (там по-прежнему Blob).

## Ссылки
- Построитель метода клиента (ветка `if (endpoint.multipart)`): `packages/core/src/contract/*`
  (виден в бандле `dist/index.js`).
- Тип инпута multipart (`[P in K]: Blob`): `packages/core/src/contract/define.ts`.
- Консьюмер-кейс: a consuming project — ручной upload, который заменяется на типизированный клиент.

## Что сделано (2026-06-05)

Вариант **B** — приняли `Blob | FileDescriptor`, экспортнули публичные типы.

### Shared / contract
- [x] `packages/core/src/contract/define.ts` — добавлены публичные типы
  `FileDescriptor` (`{ uri, name, type }`) и `MultipartFile = Blob | FileDescriptor`;
  `MultipartArgs` теперь даёт `{ [P in K]: MultipartFile }` (было `Blob`).
- [x] `packages/core/src/contract/index.ts` — реэкспорт `FileDescriptor` +
  `MultipartFile` (через `index.ts → export * from './contract'` они и на root, и на `/contract`).

### Client
- [x] `packages/core/src/browser/client.ts` — type-predicate `isFileDescriptor`
  (узко: object, не Blob, строковые `uri`+`name`+`type`) и `isMultipartFile`
  (`Blob | descriptor`); оба guard-места (`createHttpMethod` и `createFetchMethod`)
  заменены с `!(file instanceof Blob)` на `!isMultipartFile(file)`.
- [x] Cast-free append: хелпер `appendMultipartFile` пишет в `FormData` через
  структурный тип `{ append(name, value: string | MultipartFile): void }` —
  method-биваринтность позволяет реальному `FormData` ему присвоиться, `as` не нужен.

### Tests
- [x] `packages/core/tests/multipart.test.ts` — блок «platform file descriptor (RN)»:
  дескриптор принимается и запрос уходит (echo-сервер); Blob по-прежнему работает;
  мусор (`{uri}` без name/type) отклоняется guard'ом (негатив — через структурно
  расширенную ссылку, без `as`). 14/14 pass.

### Docs / CHANGELOG
- [x] `CHANGELOG.md` `[Unreleased] → ### Added`.
- [x] `docs/guide/client.md` (multipart-строка), `docs/api/reference.md` (строки
  `MultipartFile` / `FileDescriptor`) — фидят `llms.txt` на билде.

### Что НЕ делалось
- [x] RN on-device стриминг по `uri` — не тестируется (Bun-`FormData` дескриптор
  стрингифицирует; это RN-only поведение, проверяется только на устройстве). Guard
  и тип — наша зона; что платформенный `FormData` делает с дескриптором — его.

### Релиз
- [x] **Минор 0.9.0** — по решению мейнтейнера батчится вместе с local-WS BYO-transport
  таском (additive: новые экспорты + расширение принимаемого инпута, не ломает).
