---
title: Конечные команды и файловые гарантии
description: Native IO для Bun и Node, с явно выбранной durability, безопасными bounds и caller lifetime.
type: guide
status: active
created: 2026-10-01 20:44 +07:00
updated: 2026-10-04 20:04 +07:00
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-10-01 20:44 +07:00
  - role: implemented
    harness: Codex
    model: GPT-6
    at: 2026-10-02 00:08 +07:00
  - role: implemented
    harness: Codex
    model: GPT-6
    at: 2026-10-03 13:36 +07:00
  - role: implemented
    harness: Codex
    model: GPT-6
    at: 2026-10-04 09:21 +07:00
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

Машинная классификация limit error использует `NativeCommandError.reason`: `deadline` при
истечении собственного `timeoutMs`, `output-budget` при превышении суммарных bytes stdout+stderr
в capture или streaming. Оба случая сохраняют `code: 'COMMAND_LIMIT'`; `message` служит
диагностике, не протоколу. У `COMMAND_UNAVAILABLE` и `COMMAND_CLEANUP` reason отсутствует;
caller abort и sink failure сохраняют исходную ошибку. При cleanup failure первоначальный
limit вместе с reason остаётся внутри `AggregateError` cause.

```ts
import { NativeCommandError } from 'stitchkit/process'

try {
  await runNativeCommand({ executable: '/usr/bin/git', args: ['status'], timeoutMs: 5000 })
} catch (error) {
  if (error instanceof NativeCommandError && error.code === 'COMMAND_LIMIT') {
    if (error.reason === 'deadline') console.error('Command timed out')
    if (error.reason === 'output-budget') console.error('Command produced too many bytes')
  }
  throw error
}
```

Конструктор сохраняет вызов `new NativeCommandError(code, message, { cause })` и принимает
`{ cause, reason: 'deadline' | 'output-budget' }` только для `COMMAND_LIMIT`. Owner всегда
заполняет reason для собственных limits. Созданная вызывающей стороной ошибка без reason
не получает выдуманную причину из текста; её reason остаётся `undefined`.

Вывод читается с backpressure отдельно для stdout/stderr: один выполняющийся sink на канал плюс
bounded native Readable buffer; накопления всей истории при streaming нет. Callback получает
lifetime signal. Abort освобождает ожидание даже игнорирующего signal callback, но не способен
отменить сторонние действия, которые сам callback продолжит после abort. Sink обязан отменять свои
IO, не сохранять бесконечную историю и не изменять shared descriptor flags. После abort новых
callbacks owner не запускает. Normal completion ждёт всех bytes и sinks.

Cleanup: POSIX process group, TERM, `killGraceMs` (default 100, maximum 10 000), затем KILL;
`cleanupTimeoutMs` (default 2000, maximum 30 000) ограничивает ожидание close после сигналов.
На Darwin временный `EPERM` при сигнале группе может означать zombies, ещё не убранные
OS reaper. Повтор ограничен `cleanupTimeoutMs`; успех требует доставленного сигнала или
`ESRCH`, постоянный отказ сохраняется в cause. Закрытие каждого owned pipe и выход leader
наблюдаются отдельно, включая отсутствие общего `child.close` при teardown.
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
## Resource-scoped launchers and shared owners

`onLeaderSettled(event, signal)` observes leader exit before inherited stdout/stderr pipes
close. A resource owner can stop its external scope there, allowing pipe drain to complete.
The callback runs once: `event.kind === 'exit'` carries observed `exitCode`/`signal`; a terminal
failure uses `kind: 'error'` and preserves its cause. Unavailable executables, output sink
failure and caller cancellation settle through the same owner. Synchronous native launch
failures such as `E2BIG` also return a rejected result after this bounded settlement;
schema-invalid and already-aborted inputs refuse before native ownership and do not invoke
the hook. A failing hook preserves both the initial launch error and cleanup cause.
`cleanupTimeoutMs` bounds
the callback after settlement starts; it never becomes a deadline for signal-only execution.
Honor the settlement signal; arbitrary user promises cannot be forcibly cancelled.

```ts
await runNativeCommand({
  executable: launcher,
  args,
  signal: scope.signal,
  onOutput: (bytes, channel, signal) => scope.write(bytes, channel, signal),
  onLeaderSettled: (event, signal) => scope.settle(event, signal),
});
```

`observeProcessInstance(pid)` returns `observed` with a `ProcessInstance`, or `unavailable`
with its cause. `probeProcessOwner(pid, recorded)` compares that evidence on the machine the
caller established: `matched`, `different-boot`, `reused-pid`, `pid-gone`, `legacy` or
`unavailable`. Missing/partial/denied evidence is not death. Supervisor tree fencing remains
the caller's job; a PID lifetime is not proof that its whole workload stopped.

Exclusive acquisition checks cancellation again before invoking the protected callback;
an aborted acquisition releases its newly owned lock without starting the callback.
Existing lock and reclaim-guard records are opened with nonblocking/no-follow flags,
must be regular files with one link, and are capped at 16 KiB. Descriptor metadata must
remain stable during the read. Unsafe records are not evidence of absence or permission
to reclaim. This bounds local record reads; it does not make a hung remote-filesystem
syscall interruptible or provide a snapshot against a hostile writer.

An exclusive lock applies exact requested permissions through its creating descriptor,
independent of umask. Default `0600` stays private. Shared `0640` requires a common group and
traversable directories; another UID also needs directory write permission to reclaim a
proven-dead owner's file. Set `ownerlessGraceMs: null` to refuse every age-only reclaim,
including ownerless reclaim guards. The default remains 5000 ms for existing clients.
Stale reclaim guards use the same lock owner and a child guard for the inode check and
unlink. Recovery depth is capped at 16; a deeper stale chain refuses recovery with a depth diagnosis retained as the cause of
the bounded `LOCK_TIMEOUT`. Live owners, unknown process-lifetime evidence and unsafe records are never
reclaimed. Concurrent writers cannot bypass a guard while a prior unlink is paused.

## Libraries with a Zod-only runtime

Public leaves keep optional peers out of their import closure. Installing `stitchkit` still
installs the complete package and ky; selective imports alone do not avoid that installation.
A library can use Stitchkit as a build dependency, bundle its selected public native imports,
keep Zod external, and publish the resulting implementation with its library artifact.

```ts
// The library's build entry; all mechanisms remain owned by Stitchkit.
export { canonicalJson } from 'stitchkit/primitives';
export { writeFileAtomic, withExclusiveLock } from 'stitchkit/files';
export { observeProcessInstance, probeProcessOwner, runNativeCommand } from 'stitchkit/process';
```

Bundle for Node-compatible execution with Zod external. Publish declarations from the same
version: carry their reachable relative `.d.ts` closure, rather than emitting references to
`stitchkit` that force clients to install it for types. A library exposing its own DTOs may
instead emit declarations for only that DTO contract. Keep the library's manifest at runtime
`dependencies: {}` and `peerDependencies: { zod: ... }` when that is its declared promise.

The packaged Darwin loader has static references to both architecture addons. Bun compilation
embeds the matching `.node` asset; ordinary Bun bundling emits native assets alongside its JS
output. Publish **every output returned by `Bun.build`**, preserving relative paths. Copying only
the JS file drops its native dependency. No runtime Stitchkit installation or manually chosen
native path is required for these bundled artifacts.

```sh
bun build src/native.ts --target=bun --minify --outdir=dist
bun build src/native.ts --compile --bytecode --format=esm --outfile=dist/native
```

For a JS build that previously used `--outfile=dist/native.js`, use
`--outdir=dist --entry-naming=native.js` instead: the output can now include native assets.
The standalone executable still uses `--outfile` because those assets are embedded inside it.

Qualify the complete output outside its build tree and installed dependency graph. Test process
identity, live-owner refusal, dead-owner recovery and contained file operations in the resulting
JS bundle and standalone executable. Bun and Node package imports retain the same lazy loader;
importing a portable leaf does not load a Darwin addon on another OS. Test declarations too,
and check that importing an unbundled Stitchkit leaf fails in a deliberately isolated library
distribution. A separate schema-only entry must not import the native entry.

If the Darwin backend cannot load, `observeProcessInstance` still returns `unavailable`.
Its backend `Error` preserves the original `cause`; JSON serialization carries only the stable
`DARWIN_BACKEND_UNAVAILABLE` code, architecture, safe message and failure stage
(`architecture`, `resolve`, `load` or `surface`), plus a recognized native error code when present.
It excludes stack, paths and nested cause. This backend diagnosis does not reclassify kernel
failures or turn unavailable identity into proof that an owner is dead. If a runtime provides
no recognized native error code, the stage stays `load`; the loader never infers errno from text.

This delivery removes a runtime kernel installation; it does not remove the build-time
Stitchkit installation or create an independent lightweight npm package.

## Public native packaging

Custom archives and installers use `stitchkit/files/packaging` at **build time**.
`createNativePackaging` resolves the installed version and target addon with its original SHA256;
its Bun-compatible plugin integrates that asset with the same lazy native loader.
The leaf is evolving. It requires no optional peer or Bun ambient declarations for Node imports.
It must run unbundled from its installed package, never from an application's runtime artifact.
This contract is available from 0.104.1; versions 0.103.13–0.104.0 use the complete-output recipe
in the previous section.

```ts
import { createNativePackaging } from 'stitchkit/files/packaging'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const native = createNativePackaging({
  platform: 'darwin', architecture: 'arm64', delivery: 'companion',
  entryPath: 'app/native.js', assetPath: 'addons/owner.node',
})
if (native.state !== 'ready') throw new Error(native.code)
const result = await Bun.build({
  entrypoints: ['src/native.ts'], target: 'node', format: 'esm',
  outdir: 'dist', naming: { entry: 'app/native.js' }, splitting: false,
  plugins: [native.plugin],
})
if (!result.success) throw new AggregateError(result.logs, 'Build failed')
// Preserve every result.outputs file under dist, then add the selected companion.
for (const asset of native.assets) {
  const bytes = readFileSync(asset.sourcePath)
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new Error('Native asset changed during build')
  const destination = join('dist', asset.outputPath)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(asset.sourcePath, destination)
}
```

`entryPath` and `assetPath` are relative paths inside the application's output root, without
absolute paths, traversal or overlapping file/directory paths. `entryPath` is fixed, without
Bun naming templates such as `[dir]` or `[name]`. Companion JS builds require one entry, no splitting,
and `naming.entry` exactly matching `entryPath`; the plugin rejects a mismatching layout.
Choose any application layout; the framework does not prescribe an app directory or installer.
Keep every bundler output, then verify copied addon bytes against the original SHA256.
Archive the complete output directory with an integrity manifest, unpack to a clean directory,
verify the same hashes there, and run offline without the build tree or `node_modules`.
A digest provides integrity, not authenticity: signature and trust policy remain application-owned.

For a standalone executable use `delivery: 'embedded'` and the same plugin in `Bun.build`
with `compile: { outfile: ... }`. Bun embeds the selected addon; `assets` identifies its
original bytes for qualification, not a companion that must be installed beside the executable.
Cross-builds must select the requested architecture explicitly; the artifact must run on that target.
The installed package must contain that target's addon. No automatic fallback/downgrade occurs.

The API returns `unsupported` / `NATIVE_TARGET_UNSUPPORTED` for non-Darwin or unsupported
architectures, and `missing` / `NATIVE_ASSET_MISSING` for a missing addon. Portable Linux libraries
use their normal build, without a Darwin plugin; merely importing the build leaf loads no addon.
Malformed inputs, unsupported metadata versions and other IO errors throw before packaging.
Runtime missing/corrupt companions preserve the native `unavailable` result and safe stage/code
from the existing observer; they never certify a dead owner. Preserve the raw cause internally.
The plugin does not parse consumer JS or establish a second runtime native implementation.

## Qualification boundaries

Native command cleanup owns the child before launch subscriptions are installed. Setup
refusal still settles leader closure and teardown within the cleanup budget; failure to
prove closure reports `COMMAND_CLEANUP` with the original failure retained. Process-group
signaling requires evidence from the actual detached launcher, not a structural PID field.
The built-in sandbox transport carries that ownership across the package's split entrypoints.
Internal finite deadlines and Darwin retry admission use monotonic elapsed time.

Linux UID-refusal qualification is a separate privileged installed-package proof in Bun
and real Node; an unsupported platform or insufficient UID reports an explicit skip.
A generic native-owner marker does not certify the privileged case. Real Darwin CI remains
the qualification for native Darwin behavior.

Local filesystem tests do not attest delayed NFS visibility, shared-volume microVM or gVisor
ownership, actual PGID reuse, power-loss durability or macOS full-sync behavior. Those
require their actual topology or failure environment. The default ownerless grace remains
5000 ms; stricter callers can retain `ownerlessGraceMs: null`. No age-only observation
proves a partially published owner's process dead.
