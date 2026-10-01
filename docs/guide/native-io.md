---
title: Конечные команды и файловые гарантии
description: Native IO для Bun и Node, с явно выбранной durability, безопасными bounds и caller lifetime.
type: guide
status: active
created: 2026-10-01 20:44 +07:00
updated: 2026-10-01 21:31 +07:00
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-10-01 20:44 +07:00
---

# Native IO

Примеры используют публичные imports и одинаково исполняются в Bun и Node ≥22.

## Запись файла

```ts
import { writeFileAtomic, AtomicFilePublicationError } from 'stitchkit/files'

try {
  await writeFileAtomic('/srv/app/receipt.json', JSON.stringify({ id: 'receipt-1' }), {
    replace: false,
    mode: 0o600,
    durability: 'directory',
  })
} catch (error) {
  if (error instanceof AtomicFilePublicationError) {
    // target уже виден. Проверьте receipt, прежде чем решать о повторе.
    console.error(error.phase, error.cause)
  } else throw error
}
await writeFileAtomic('/srv/app/state.json', '{"version":2}', {
  replace: true, durability: 'directory',
})
```

По умолчанию `replace: true`, `durability: 'file'`, `mode: 0o600`: existing вызовы сохраняют
file-fsync и atomic replacement. `durability: 'none'` отключает sync; `'directory'` выполняет
полную запись → exact descriptor chmod → file fsync → rename (replace) либо link (create) →
удаление staging link → parent fsync. `writeFileAtomicSync` имеет те же options и порядок.
Create отказывает с native `EEXIST` при существующем файле, symlink или concurrent winner.
Никогда не переводите этот отказ в replace автоматически.

`AtomicFilePublicationError.published === true` отличает видимость от неподтверждённого
acknowledgement. `phase` — `cleanup`, `directory-sync` или `directory-close`; первичная причина
сохранена в `cause`. Ошибка до publish оставляет прежний target. Cleanup вторичен к первичной ошибке.
При create кратко существует второй hardlink; strict single-link reader вправе отказать в этом окне.

Directory fsync — native POSIX/filesystem capability. Windows явно отказывает; иной filesystem
может отказать при open/sync. Проверка на Linux не подтверждает поведение macOS, сетевой FS или
сохранность при отключении питания. Состояние диска определяется гарантиями самой FS/ОС.
`createManagedFileBoundary.write(..., { durable: true })` использует тот же publish owner и parent sync;
его create по умолчанию остаётся create, а `replace: true` явно разрешает replacement.

## Строгое чтение

```ts
import { createManagedFileBoundary } from 'stitchkit/files'

const files = await createManagedFileBoundary({ root: '/srv/app', maxReadBytes: 64 * 1024 })
const source = await files.read('receipt.json', {
  rejectSymlinks: true, singleLink: true, stable: true, observe: true,
})
console.log(source.observation) // dev, ino, size, nlink, mtimeMs, ctimeMs
const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes))
// schema.parse(receipt) и проверка digest принадлежат приложению.
```

Без новых options ответ сохраняет `{ ref, bytes }`, допускает trusted in-root symlink и hardlink.
`rejectSymlinks` запрещает requested leaf, `singleLink` проверяет `nlink` открытого descriptor,
`stable` сравнивает dev/ino/size/mtime/ctime/nlink вокруг byte read; `observe` добавляет metadata.
`FILE_NOT_FOUND`, `FILE_NOT_REGULAR`, `FILE_UNSAFE_LINK`, `FILE_TOO_LARGE`, `FILE_CHANGED`,
`FILE_UNSUPPORTED` и `FILE_IO_ERROR` различаются. Abort сохраняет caller reason.
Nonblocking open позволяет отказать FIFO без ожидания writer. Bytes ограничены во время чтения,
включая рост файла, не только initial stat. Chunk allocation ≤ maxBytes+1+64 KiB, flatten ≤ maxBytes;
FD закрывается при success, отказе, abort и IO error.
Ошибка close сохраняет первичную ошибку чтения; после успешного чтения ошибка close возвращается caller.

Root и ancestors принадлежат trusted actor. Эти options не дают descriptor-relative containment
при hostile concurrent ancestor replacement. Отдельного переключателя «считать ancestors безопасными»
нет: portable owner не предоставляет такую capability. Metadata stability не доказывает immutable
snapshot против произвольного hostile writer; используйте application lock/immutable publication.

## Команды

```ts
import { runNativeCommand } from 'stitchkit/process'

const captured = await runNativeCommand({
  executable: '/usr/bin/git', args: ['rev-parse', 'HEAD'], cwd: '/srv/app',
  envPolicy: 'declared-only', env: { PATH: '/usr/bin:/bin' },
  capture: true, maxOutputBytes: 4096, timeoutMs: 5000,
})
console.log(captured.exitCode, new TextDecoder().decode(captured.stdout))

const lifetime = new AbortController()
await runNativeCommand({
  executable: '/usr/bin/git', args: ['status'], signal: lifetime.signal,
  onOutput: async (bytes, channel, outputSignal) => {
    outputSignal.throwIfAborted()
    await output.write(bytes, channel, outputSignal) // application-owned bounded sink
  },
})
```

Команда требует caller signal или finite `timeoutMs` (1–2147483647 ms: native timer range; большее значение отказывается, не превращается в 1 ms). Streaming имеет caller lifetime, без скрытого
60-second timeout или 1-MiB output limit. `capture` по умолчанию false; true требует
`maxOutputBytes` для суммарных stdout+stderr. Лимит считает исходные bytes; API возвращает
`Uint8Array`, не преобразует invalid UTF-8. Result содержит наблюдаемый `exitCode: number | null`
и `signal: string | null`; signal termination не превращается в выдуманный exit code. `maxOutputBytes` может ограничивать и streaming.
`stdin` — bytes с `maxStdinBytes` (default 1 MiB). `envPolicy` default `declared-only`: отсутствие env
означает пустой environment; `ambient` явно разрешает наследование. Cwd/executable policy остаётся
приложению; этот primitive запускает native executable и сам не создаёт shell.

Вывод читается с backpressure отдельно для stdout/stderr: один выполняющийся sink на канал плюс
bounded native Readable buffer; накопления всей истории при streaming нет. Callback получает
lifetime signal. Abort освобождает ожидание даже игнорирующего signal callback, но не способен
отменить сторонние действия, которые сам callback продолжит после abort. Sink обязан отменять свои
IO, не сохранять бесконечную историю и не изменять shared descriptor flags. После abort новых
callbacks owner не запускает. Normal completion ждёт всех bytes и sinks.

Cleanup: POSIX process group, TERM, `killGraceMs` (default 100, maximum 10 000), затем KILL;
`cleanupTimeoutMs` (default 2000, maximum 30 000) ограничивает ожидание close после сигналов.
Сохраняется caller/sink причина; failure cleanup — `NativeCommandError` с `COMMAND_CLEANUP` и
AggregateError cause. Даже вышедший parent не исключает helper, удерживающий pipe. Windows
отказывает с `COMMAND_UNAVAILABLE`; потомок, самостоятельно покинувший группу через setsid,
лежит за границей этой capability. Это one-shot execution, не PTY, supervisor или daemon host.

## Механическая адаптация

Atomic file wrapper заменяется одним вызовом `writeFileAtomic` с выбранными options. Bounded
regular-file read заменяется `files.read`; JSON/schema, receipt conflicts, journal rotation и
application locks сохраняются. Spawn/drain/capture/cancellation wrapper заменяется `runNativeCommand`;
shell policy, command admission, логирование, redaction, bytes→text decoder и operator sink сохраняются.
Длительные signal-only команды остаются streaming; bounded tar/capture получают свои явные limits.
Импорт leaf не делает установку всего npm package маленькой; выбирайте dependency после измерения
packed размера и dependency closure.
