---
title: Bounded commands and file guarantees
description: Native IO for Bun and Node with an explicitly chosen durability, safe bounds and a caller-owned lifetime.
type: guide
status: active
created: 2026-10-01 20:44 +07:00
updated: 2026-10-06 19:45 +07:00
---

# Native IO

Shortest working example: publish a file atomically, then run one bounded command.

```ts
import { writeFileAtomic } from 'stitchkit/files'
import { runNativeCommand } from 'stitchkit/process'

await writeFileAtomic('/srv/app/state.json', '{"version":2}')
const { exitCode, stdout } = await runNativeCommand({
  executable: '/usr/bin/git', args: ['rev-parse', 'HEAD'], cwd: '/srv/app',
  capture: true, maxOutputBytes: 4096, timeoutMs: 5000,
})
console.log(exitCode, new TextDecoder().decode(stdout))
```

The examples use public imports and run the same in Bun and Node >= 22.

## Writing a file

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
    // The target is already visible. Check the receipt before deciding whether to retry.
    console.error(error.phase, error.cause)
  } else throw error
}
await writeFileAtomic('/srv/app/state.json', '{"version":2}', {
  replace: true, durability: 'directory',
})
```

The defaults are `replace: true`, `durability: 'file'` and `mode: 0o600`: file fsync and atomic
replacement. `durability: 'none'` skips every sync. `'directory'` runs the full sequence: write all
bytes, exact descriptor chmod, file fsync, rename (replace) or link (create), remove the staging
link, parent directory fsync. `writeFileAtomicSync` takes the same options and runs the same order.
Create fails with the native `EEXIST` when the target exists, is a symlink, or a concurrent writer
won. Never turn that refusal into a replace automatically.

`AtomicFilePublicationError.published === true` tells a visible target from an unconfirmed
acknowledgement. `phase` is `cleanup`, `directory-sync` or `directory-close`; the primary cause is
kept in `cause`. An error before publication leaves the previous target untouched. Cleanup errors are
secondary to the primary error. While a create is in flight a second hardlink briefly exists, so a
strict single-link reader may refuse in that window.

### Abandoned staging files

The bytes are staged beside the target under `.stitchkit-<24 lowercase hex>.tmp`, the same name for
`writeFileAtomic`, `writeFileAtomicSync`, the managed writer and the chunk spool. A process killed
between the staging and the publication (SIGKILL, OOM, power loss) leaves that file behind, and no
later write removes it: a random name alone cannot tell an abandoned write from one in flight.
Removing it is the caller's responsibility. A directory that does not exist yet has nothing to
sweep and yields `[]`; a file standing where the directory should be, or a denied listing, throws:

```ts
import { isAtomicStagingName, sweepAtomicStaging } from 'stitchkit/files'

// At startup, or before trusting that a directory holds only your own records:
const removed = await sweepAtomicStaging({ directory: '/srv/app/registry', olderThanMs: 60 * 60_000 })

// Skip staging files when listing a directory of your records:
const records = (await readdir('/srv/app/registry')).filter((name) => !isAtomicStagingName(name))
```

`olderThanMs` is required and must exceed the longest write in flight; a younger staging file is
left alone. The sweep removes only regular files, never follows a symlink and never enters a
subdirectory. The name form is a stable public contract: changing it is a breaking change of
`stitchkit/files`. An exclusive lock's `.lock-*.tmp` file is not an atomic-write staging file and
does not match.

Directory fsync is a native POSIX filesystem capability. Windows refuses it explicitly, and another
filesystem may refuse at open or sync. A check on Linux does not confirm macOS behavior, network
filesystems or survival of a power loss; the disk state is whatever the filesystem and OS guarantee.
`createManagedFileBoundary.write(..., { durable: true })` uses the same publish owner and parent sync;
its create stays a create, and `replace: true` allows replacement explicitly.

## Strict reads

```ts
import { createManagedFileBoundary } from 'stitchkit/files'

const files = await createManagedFileBoundary({ root: '/srv/app', maxReadBytes: 64 * 1024 })
const source = await files.read('receipt.json', {
  rejectSymlinks: true, singleLink: true, stable: true, observe: true,
})
console.log(source.observation) // dev, ino, size, nlink, mtimeMs, ctimeMs
const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes))
// Schema parsing and digest checks belong to the application.
```

Without options the result is `{ ref, bytes }` and a trusted in-root symlink or hardlink is
allowed. `rejectSymlinks` refuses a symlink at the requested leaf, `singleLink` checks `nlink` of
the opened descriptor, `stable` compares dev/ino/size/mtime/ctime/nlink around the byte read, and
`observe` adds the metadata. These refusals are distinct: `FILE_NOT_FOUND`, `FILE_NOT_REGULAR`,
`FILE_UNSAFE_LINK`, `FILE_TOO_LARGE`, `FILE_CHANGED`, `FILE_UNSUPPORTED` and `FILE_IO_ERROR`. Abort
keeps the caller's reason. A nonblocking open lets a FIFO be refused without waiting for a writer.
Bytes are bounded while reading, including a file that grows, not only by the initial stat. Chunk
allocation is at most `maxBytes + 1 + 64 KiB` and the flattened result at most `maxBytes`. The
descriptor closes on success, refusal, abort and IO error. A close error keeps the primary read error;
after a successful read a close error is returned to the caller.

The root and its ancestors belong to a trusted actor. These options do not give
descriptor-relative containment against a hostile concurrent ancestor replacement, and there is no
switch to treat ancestors as safe: the portable owner has no such capability. Metadata stability does
not prove an immutable snapshot against an arbitrary hostile writer; use an application lock or
immutable publication.

## Commands

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

A command needs a caller `signal` or a finite `timeoutMs` (1 to 2147483647 ms, the native timer
range; a larger value is refused, never turned into 1 ms). Streaming runs for the caller's lifetime,
with no hidden 60-second timeout or 1 MiB output limit. `capture` defaults to false; `true` requires
`maxOutputBytes` for the combined stdout and stderr. The limit counts source bytes; the API returns
`Uint8Array` and does not decode invalid UTF-8. The result holds the observed `exitCode: number | null`
and `signal: string | null`; a signal termination is never turned into an invented exit code.
`maxOutputBytes` may bound streaming too. `stdin` is bytes bounded by `maxStdinBytes` (default 1 MiB).
`envPolicy` defaults to `declared-only`: no `env` means an empty environment, and `ambient` inherits
explicitly. The application owns cwd and executable policy; the primitive launches a native
executable and never creates a shell.

`NativeCommandError.reason` classifies a limit error by machine: `deadline` when the command's own
`timeoutMs` expires, `output-budget` when the combined stdout and stderr bytes exceed the limit, in
capture or streaming. Both keep `code: 'COMMAND_LIMIT'`; `message` is for diagnosis, not for
protocols. `COMMAND_UNAVAILABLE` and `COMMAND_CLEANUP` have no reason. A caller abort and a sink
failure keep the original error. When cleanup fails, the original limit and its reason stay inside the
`AggregateError` cause.

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

The constructor is `new NativeCommandError(code, message, { cause })`; it accepts
`{ cause, reason: 'deadline' | 'output-budget' }` only for `COMMAND_LIMIT`. The owner always sets the
reason for its own limits. An error a caller constructs without a reason gets none inferred from the
text; its `reason` is `undefined`.

Output is read with backpressure, stdout and stderr separately: one running sink per channel plus a
bounded native Readable buffer, with no accumulation of the whole history while streaming. The
callback receives the lifetime signal. Abort releases the wait even for a callback that ignores the
signal, but it cannot cancel third-party work the callback continues after the abort. A sink must
cancel its own IO, must not keep an unbounded history and must not change shared descriptor flags.
After an abort the owner starts no new callbacks. Normal completion waits for all bytes and sinks.

Cleanup uses the POSIX process group under the `stop` policy, then KILL; `cleanupTimeoutMs`
(default 2000, maximum 30 000) bounds the wait for close after the signals. On
Darwin a transient `EPERM` when signalling a group can mean zombies the OS reaper has not collected
yet. The retry is bounded by `cleanupTimeoutMs`; success needs a delivered signal or `ESRCH`, and a
permanent refusal is kept in the cause. The close of every owned pipe and the leader's exit are
observed separately, including the absence of a shared `child.close` during teardown. The caller or
sink cause is kept; a cleanup failure is a `NativeCommandError` with `COMMAND_CLEANUP` and an
`AggregateError` cause. Even an exited parent does not exclude a helper that holds a pipe. Windows
refuses with `COMMAND_UNAVAILABLE`; a descendant that has left the group on its own with `setsid` is
outside this capability. This is one-shot execution, not a PTY, a supervisor or a daemon host.

### Stopping a command: the `stop` policy

A caller abort, the `timeoutMs` deadline, an exceeded output budget and a failing sink all stop the
command the same way, by its `stop` policy:

| field | meaning |
|---|---|
| `target` | `'group'`: `signal` goes to every member of the group. `'leader'`: `signal` goes to the leader alone; the leader's exit ends the grace at once. Required. |
| `signal` | `SIGTERM` (default), `SIGINT`, `SIGHUP`, `SIGQUIT`, `SIGUSR1` or `SIGUSR2`. KILL is not a stop signal: it is what the grace ends in. |
| `graceMs` | How long the leader (or the group) has to leave before the whole group gets KILL. 0 to 3 600 000 (one hour). Required. |
| `killOn` | Optional `AbortSignal`. Its abort stops the command with KILL to the whole group at once, also in the middle of a grace. |

Omitting `stop` means `{ target: 'group', signal: 'SIGTERM', graceMs: 100 }`; a command in the
caller's group (`group: 'caller'`) stops its leader alone, so its default is `target: 'leader'`
and a group target is refused (see [Terminal commands](#terminal-commands-inherited-stdio-and-the-callers-group)).

```ts
// Cooperative cancellation: the leader rolls its work back, its helpers are not asked.
await runNativeCommand({
  executable: '/usr/local/bin/migrate', args: ['apply'], signal: request.signal,
  stop: { target: 'leader', signal: 'SIGINT', graceMs: 15 * 60_000, killOn: shutdown.signal },
})
```

With `target: 'leader'` the rest of the group never receives the cooperative signal: they are
processes the leader started, and the leader decides what happens to them. Whatever is left in the
group when the leader exits, or when the grace ends, gets KILL, including a helper with its stdio
closed that no pipe would have revealed. A leader that has already exited is never signalled again.

The output pipes stay open until the stop sequence ends. Output a stopping command writes is read and
dropped, never passed to `onOutput` and never captured, so a leader that writes while it shuts down
does not meet a broken pipe. The result rejects with the abort reason once the group is gone and the
pipes are closed, so it can take `graceMs` plus `cleanupTimeoutMs` after the abort.

The grace is a timer inside the process that runs the command. If that process exits first, the
timer is gone and the group, which is detached into its own session, keeps running: nothing in this
package can bound it from outside. Abort `killOn` in your shutdown path, so the group is killed
before the process exits, and let the supervisor own the case where the process dies without a
shutdown. Under systemd, keep `KillMode=control-group` (the default) so the stop of the unit
reaches every process in its cgroup, whatever its process group; launchd only kills the job's own
process group, which a command's group is not.

### Stopping a group and its descendants

A group is signalled only while the kernel still reports members. `ESRCH` from the first signal,
or from the existence probe that follows it during the grace, means no member is left: no KILL
is sent afterwards, because a numeric group id that has vanished can already belong to an
unrelated group. A group that is still visible after the grace period receives KILL.

`descendants` declares what happens to processes the leader left running once it has exited
successfully:

| `descendants` | After the leader exits |
|---|---|
| `'terminate-after-leader'` (the default) | The group is stopped right after `onLeaderSettled` returns and before the pipes drain: with `target: 'group'` by the same signal, grace, KILL sequence as cancellation; with `target: 'leader'` by KILL at once, since the leader has already exited. A descendant that had already left the group with `setsid` when the leader exited stays out of reach. |
| `'leave'` | Nothing. A helper started with its stdio detached keeps running. One that inherited stdout or stderr keeps the pipes open, and the command then waits for it until its deadline or abort. |

Omitting the option means `'terminate-after-leader'`: a command does not leak the helpers it
started. The result's `descendantsStopped` is `true` when the group still had members after the
leader exited and they were stopped, so a helper that was ended this way is visible to the caller
rather than only missing afterwards; under `'leave'` it is always `false`.

A real daemon detaches into its own session (`setsid`, as `daemon(3)` does), is no member of the
group and is unaffected, provided it has left the group **before the leader exits**. Leaving is
the daemon's own system call, and the group is stopped as soon as the leader's exit is observed,
so a helper started in the background races the leader:

| launched by the leader as | after the leader exits |
|---|---|
| `setsid -f helper` | usually survives: `setsid -f` forks and returns at once, and the child calls `setsid()` a moment later, so a leader that exits immediately can still catch it in the group (13 of 300 launches under CPU load) |
| `setsid helper &`, `(setsid helper &)`, `nohup helper &` | stopped: the leader usually exits before the background job has left the group |
| a launch the leader waits on until the helper reports it has left the group | survives |
| any of these under `descendants: 'leave'` | survives |

Start a daemon so that the leader waits for the session to exist before it returns: the helper
writes its pid, or prints a line, only after its own `setsid()`, and the leader waits for that.
Or declare `'leave'`. Declare `'leave'` only for a helper that has to outlive the command while
staying in its group:

```ts
await runNativeCommand({
  executable: '/usr/local/bin/start-helper', timeoutMs: 60_000,
  // the helper started here outlives this command on purpose
  descendants: 'leave',
})
```

A command in the caller's group (`group: 'caller'`) has no group of its own: `descendants` is
refused there and nothing is stopped after its leader exits. A command whose group this package did not create (a structural
launcher supplied by a host) has no group to stop, and `descendants` has nothing to act on there.


## Replacing hand-written wrappers

An atomic-file wrapper becomes one `writeFileAtomic` call with the chosen options. A bounded
regular-file read becomes `files.read`; JSON and schema parsing, receipt conflicts, journal rotation
and application locks stay with the application. A spawn, drain, capture and cancellation wrapper
becomes `runNativeCommand`; shell policy, command admission, logging, redaction, the bytes-to-text
decoder and the operator sink stay with the application. Long signal-only commands stay streaming;
bounded tar or capture commands get their own explicit limits.

A child the caller holds until it exits is the same call. A guardian that forwards its own SIGTERM
passes an abort signal and `stop: { target: 'leader', signal: 'SIGTERM', graceMs }`. It records the
pid in `onLeaderStarted({ pid })`, which runs once right after the leader exists (a throw stops the
command with that error), and the leader's exit code and signal in `onLeaderSettled`: `'exit'`
when the leader ended on its own, `'stopped'` with the same fields when the guardian stopped it.
It reads stderr through `onOutput` or `capture` with `maxOutputBytes`. `drainTimeoutMs` bounds how
long the output pipes may stay open after the leader exited: a holder that left the group with
`setsid` keeps them open, and without the option the command waits for it until `timeoutMs` or
the signal; with it the command ends with `COMMAND_CLEANUP` (a holder inside the group is already
stopped by `descendants`). A worker whose whole group must stop on abort is the default
`target: 'group'`. A command that uses the caller's terminal is the next section. Importing one leaf does not make
installing the whole npm package smaller; choose a dependency after measuring packed size and its
dependency closure.

## Terminal commands: inherited stdio and the caller's group

An operator CLI that re-runs itself, or any command that prompts or prints in colour, needs the
caller's terminal itself rather than pipes. Two options give it that:

```ts
const { exitCode } = await runNativeCommand({
  executable: process.execPath, args: [cliPath, ...argv], envPolicy: 'ambient',
  signal: shutdown.signal,
  stdio: 'inherit',   // the command's stdin, stdout and stderr are the caller's: a TTY stays a TTY
  group: 'caller',    // it joins the caller's process group, so a Ctrl-C at the terminal reaches it
})
process.exitCode = exitCode ?? 1
```

`stdio: 'inherit'` hands the caller's three descriptors to the command; its bytes never pass
through this package, so `capture`, `onOutput`, `stdin`, `maxOutputBytes` and `drainTimeoutMs` are
refused by name with it, and the result's buffers stay empty.

`group: 'caller'` keeps the command in the caller's process group instead of a group of its own.
That is what an interactive command needs: the terminal sends Ctrl-C to its foreground group,
and a command in a group of its own is a background group there, which the kernel stops
(`SIGTTIN`) as soon as it reads the terminal. In the caller's group the command has no group of
its own, so:

- a stop signals the leader alone: `stop.target` is `'leader'` (the default here is
  `{ target: 'leader', signal: 'SIGTERM', graceMs: 100 }`), and `target: 'group'` is refused,
  because a group signal would reach the caller;
- `descendants` does not apply and is refused: what the leader leaves behind belongs to the
  caller's group, and `descendantsStopped` is always `false`;
- a Ctrl-C reaches the caller too; handle `SIGINT` in the caller when it must outlive the command.

The two options are independent: `stdio: 'inherit'` alone keeps colour and `isatty` for a command
that never reads the terminal, and `group: 'caller'` alone forwards Ctrl-C to a piped command.

## Resource-scoped launchers and shared owners

`onLeaderSettled(event, signal)` observes leader exit before inherited stdout/stderr pipes
close. A resource owner can stop its external scope there, allowing pipe drain to complete.
The callback runs once, with one of three events:

| `event.kind` | when | carries |
|---|---|---|
| `'exit'` | the leader ended on its own | `exitCode`, `signal` as the kernel reported them |
| `'stopped'` | the command was stopped (caller abort, `timeoutMs`, output budget, failing sink) and the leader's exit after the stop signals was observed | the stop's `cause`, and the leader's `exitCode` and `signal` (for example `SIGTERM`, or `SIGKILL` once the grace ended) |
| `'error'` | no exit of the leader was observed: it could not start, or its exit did not arrive within `cleanupTimeoutMs` | the `cause` |

A leader that ended on its own settles before the pipes drain; a stopped one settles after the
stop sequence, once its exit is known. A stop that comes after the leader already exited (a
deadline while a helper holds the pipe) does not change its `'exit'` event. Unavailable
executables, output sink failure and caller cancellation settle through the same owner. Synchronous native launch
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
proven-dead owner's file.

The lock is published with its owner already recorded: the owner record is written to a
private temporary file in the lock's directory, then hard-linked to the lock name. `link`
fails with `EEXIST` for every caller but one, and the name never exists without a complete
record, so a holder that stalls or dies before publishing leaves no lock and cannot be
displaced. The directory must therefore be on a filesystem that supports hard links. A crash
between the temporary write and the link can leave a `.lock-*.tmp` file behind; it is not a
lock and nothing waits on it.

`ownerlessGraceMs` defaults to `null`: a lock file with no readable owner is never taken
because of its age. This library does not produce such a file; only a writer that creates the name
before its owner record can leave one (for example an empty file from a crashed process).
`ownerlessGraceMs: <ms>` opts in to reclaiming an empty lock file older than that, and also governs
abandoned empty reclaim guards.
When unset, an empty reclaim guard left by an older writer is taken after 5 000 ms so recovery
is never disabled for good; `null` refuses that too.
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

The packaged Darwin loader computes its addon path at run time from its own file
(`module.filename`), so a bundler never follows it: bundling `stitchkit/server`,
`stitchkit/files` or `stitchkit/process` yields the same single JS file on every operating
system, with no `.node` output, `bun build --outfile` works, and no path of the build machine
becomes a literal of the artifact. A bundle has no installed package beside it, so without the
packaging plugin it never loads the addon: the first call that needs it reports the Darwin backend
`unavailable` with stage `packaging`, and the message names `createNativePackaging`. An artifact
that must carry the Darwin addon uses the packaging plugin of the next section; it is the only way
a static loader enters a bundle.

Only these calls load the addon, and only on macOS: process identity (`observeProcessInstance`
and `probeProcessOwner`), every exclusive lock (`withExclusiveLock` and what is built on it, such
as the file state store and the diagnostic journal) and the contained file operations of the Agent
coding tools. Without the addon a lock still works, but it cannot record or check its owner's
identity, so a lock held by a crashed owner is not reclaimed. The managed file boundary
(`createManagedFileBoundary` and the transfer tools built on it), atomic writes and the chunk
spool never load it, on any operating system. The package is free of import side effects
(`sideEffects: false`), so a bundle that imports only those parts carries no Darwin loader at all.

Check an artifact by its loader, never by whether it holds `.node` bytes: Bun can copy the addon
into a compiled executable even without the plugin, and the unpackaged loader does not use it.
`inspectNativeArtifact(bytes)` from `stitchkit/files/packaging` reads the marker every generated
loader carries and answers `packaged` (the plugin's static loader is inside), `unpackaged` (the
default loader is inside, and every call above refuses on macOS) or `no-loader` (nothing in the
artifact loads the addon). It reads both latin1 and UTF-16LE, because Bun stores source text with
non-ASCII characters as UTF-16, and it does not mistake the `STITCHKIT_NATIVE_NOT_PACKAGED` error
code, which every bundle with a lock carries, for a loader. Artifacts built by 0.107.0 or earlier
carry no marker and read `no-loader`.

```ts
import { inspectNativeArtifact } from 'stitchkit/files/packaging'

const loader = inspectNativeArtifact(await Bun.file('dist/cli').bytes())
if (loader === 'unpackaged') throw new Error('dist/cli was built without native packaging')
```

```sh
bun build src/native.ts --target=bun --minify --outfile=dist/native.js
```

That plain build serves Linux and the parts that never load the addon. A library whose consumers
take locks or read process identity on macOS builds each native entry with the companion plugin of
the next section (one entry per build, `naming.entry` equal to `entryPath`) and ships the addon it
writes beside the entries.

Qualify the complete output outside its build tree and installed dependency graph. Test process
identity, live-owner refusal, dead-owner recovery and contained file operations in artifacts built
with the packaging plugin, and check that an unpackaged build reports the backend `unavailable`
with stage `packaging` rather than certifying a dead owner. Bun and Node package imports retain the same
lazy loader; importing a portable leaf does not load a Darwin addon on another OS. Test
declarations too, and check that importing an unbundled Stitchkit leaf fails in a deliberately
isolated library distribution. A separate schema-only entry must not import the native entry.

If the Darwin backend cannot load, `observeProcessInstance` still returns `unavailable`.
Its backend `Error` preserves the original `cause`; JSON serialization carries only the stable
`DARWIN_BACKEND_UNAVAILABLE` code, architecture, safe message and failure stage
(`architecture`, `packaging`, `resolve`, `load` or `surface`), plus a recognized native error code
when present: `packaging` is a bundle built without the packaging plugin, with native code
`STITCHKIT_NATIVE_NOT_PACKAGED`.
It excludes stack, paths and nested cause. This backend diagnosis does not reclassify kernel
failures or turn unavailable identity into proof that an owner is dead. If a runtime provides
no recognized native error code, the stage stays `load`; the loader never infers errno from text.

This delivery removes a runtime kernel installation; it does not remove the build-time
Stitchkit installation or create an independent lightweight npm package.

## Public native packaging

Custom archives and installers use `stitchkit/files/packaging` at **build time**.
`createNativePackaging` resolves the installed version and target addon, reads the addon once and
checks it against the size and SHA256 that Stitchkit published in its `native-assets.json` when the
package was built. A ready asset carries those verified `bytes` with the published `size` and
`sha256`; its Bun-compatible plugin integrates the same bytes with the same lazy native loader.
Each call reads and hashes the selected addons, so call it once per build and reuse the result.
The leaf is evolving. It requires no optional peer or Bun ambient declarations for Node imports.
Calling it must happen in a process that runs it from its installed package: it locates the
package's `native-assets.json` beside its own file and throws `Native packaging must run from its
installed Stitchkit package` anywhere else, such as inside an application's runtime artifact.
Importing the leaf is side-effect free (it loads no addon and reads no file), so a module that
both builds and is bundled may import it; only the call has to stay in the build step.

```ts
import { createNativePackaging } from 'stitchkit/files/packaging'
import { mkdirSync, writeFileSync } from 'node:fs'
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
// Preserve every result.outputs file under dist, then write the verified companion bytes.
for (const asset of native.assets) {
  const destination = join('dist', asset.outputPath)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, asset.bytes)
}
```

In companion delivery, `entryPath` and `assetPath` are relative paths inside the application's output root, without
absolute paths, traversal or overlapping file/directory paths. `assetPath` may contain `[hash]`,
which becomes the first 16 hex digits of that addon's published SHA256: the digest is known before
the build, so `addons/darwin-arm64-[hash].node` gives two installed versions of the package
different companion names, and the loader requires exactly that name. It is the only template an
addon path accepts. `entryPath` is fixed, without
Bun naming templates such as `[dir]` or `[name]`. Companion JS builds require one entry, no splitting,
and `naming.entry` exactly matching `entryPath`; the plugin rejects a mismatching layout.
Choose any application layout; the framework does not prescribe an app directory or installer.
The plugin packages the loader of the installation it was created from. A build whose entry
imports another `stitchkit` installation — another version, or the same version under another
path, as when a build tool carries its own copy — fails with an error naming both versions and
roots: that installation's loader would refuse the addon at run time, so the artifact is never
written. Call `createNativePackaging` from the `stitchkit` the entry imports.
Keep every bundler output and write `asset.bytes`; never read the addon from `node_modules` a
second time. An installed addon whose size or SHA256 differs from the published manifest refuses
with `mismatch` / `NATIVE_ASSET_DIGEST_MISMATCH`, so a file substituted after installation never
reaches an artifact. Archive the complete output directory with an integrity manifest that records
`asset.sha256`, unpack to a clean directory, verify the same hashes there, and run offline without
the build tree or `node_modules`. The published digest ties the bytes to the package Stitchkit
built; the package itself is only as trusted as its tarball (the lockfile integrity of the install).
Signature and trust policy remain application-owned.

One JS artifact can run on both Darwin architectures; change only the packaging inputs:

```ts
const native = createNativePackaging({
  platform: 'darwin', architecture: ['arm64', 'x64'], delivery: 'companion',
  entryPath: 'app/native.js',
  assetPath: { arm64: 'addons/arm.node', x64: 'addons/intel.node' },
})
```

Use the same single plugin and write loop above. A single-target loader deliberately refuses the
other architecture; two competing plugins cannot produce a universal loader. The array form
requires exactly one distinct output path per declared target. A ready result carries the target
array and both verified assets with their published digests; `NativePackagingOptions<true>` /
`NativePackagingResult<true>` describe this form when explicitly annotating variables.
The loader selects only `process.arch`: a missing or wrong-architecture selected addon refuses,
even when the other valid addon is present. Linux runtime imports remain lazy and use Linux
process primitives without loading Darwin assets. Qualify the exact same JS bytes on real
Darwin arm64 and x64 machines, with both companions preserved through archive delivery.
Build-machine architecture and cross-build success cannot establish universal native support.

For a standalone executable use `delivery: 'embedded'` and its plugin in `Bun.build` with
`compile`. An executable carries the addon inside itself, so this form names no `entryPath` or
`assetPath`; passing one is a type error and a schema refusal, never silently ignored:

```ts
const native = createNativePackaging({
  platform: 'darwin', architecture: 'arm64', delivery: 'embedded',
})
if (native.state !== 'ready') throw new Error(native.code)
const result = await Bun.build({
  entrypoints: ['src/cli.ts'], minify: true,
  compile: { target: 'bun-darwin-arm64', outfile: 'dist/cli' },
  plugins: [native.plugin],
})
if (!result.success) throw new AggregateError(result.logs, 'Build failed')
```

Bun embeds the selected addon from the verified bytes the plugin holds, not from a second read of
the file, and the executable loads it from `/$bunfs/root/darwin-arm64-<hash>.node`. Its `assets`
(`NativePackagingEmbeddedAsset`: `bytes`, `size`, `sha256`) identify those bytes and their
published digest for qualification; there is nothing to write beside the executable.
Cross-builds must select the requested architecture explicitly; the artifact must run on that target.
The installed package must contain that target's addon. No automatic fallback/downgrade occurs.

`platform` is the closed set of platforms with native addons, today `'darwin'`: another name is a
type error and a schema refusal that throws, so pass the literal (or narrow `process.platform`
with `=== 'darwin'`) rather than a free string. The API returns `unsupported` /
`NATIVE_TARGET_UNSUPPORTED` for an unsupported architecture, `missing` / `NATIVE_ASSET_MISSING` for
an addon the package does not publish or whose file is gone, and `mismatch` /
`NATIVE_ASSET_DIGEST_MISMATCH` for an addon whose bytes differ from the published size or SHA256.
A `mismatch` names the first differing `architecture` and carries `expected` (the published
`{ size, sha256 }`) and `actual` (the installed file's size and the SHA256 of the bytes read), so
a build log can tell a truncated copy from a substituted one:

```ts
if (native.state === 'mismatch')
  throw new Error(
    `${native.architecture} addon: expected ${native.expected.size} bytes ` +
      `${native.expected.sha256}, found ${native.actual.size} bytes ${native.actual.sha256}`,
  )
```

Portable libraries
and Linux builds use their normal build, without a Darwin plugin; merely importing the build leaf
loads no addon.
Malformed inputs, a manifest whose `formatVersion` is not 2 and other IO errors throw before packaging.
A missing or corrupt companion at runtime yields the native `unavailable` result with the safe
stage and code from the observer; it never certifies a dead owner. Preserve the raw cause internally.
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
require their actual topology or failure environment. No age-only observation proves a
process dead; the lock's owner record exists before its name does.

A sandbox admission slot is released once a direct command's pipes have closed and its owner has settled.
A `COMMAND_CLEANUP` outcome means the death of its group was not proven, so the slot stays
occupied, `stop` keeps rejecting with the cleanup error, and the sandbox session is recreated to
recover.
