---
title: "CLI default command for bare and global-option-only invocation"
description: Let an application route an invocation with no explicit command to one declared command without maintaining an argv pre-router.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23T04:05:00Z
---

# CLI default command

## Зачем

`createCli` currently treats the first argv token as a required command. An
operator-style executable whose primary experience is a live list therefore
cannot make both `app` and `app --json` invoke `list`: it must inspect and
rewrite argv before Stitchkit. That pre-router owns command selection, global
option placement and help/version precedence outside the canonical CLI runner.

The gap is generic and narrow. Stitchkit already owns command discovery,
injected argv/writers/exit, global flags, native commands and managed surfaces;
it should also be able to select one of those existing commands when the caller
did not name one. It must not own the operator's rendering, refresh loop or
domain behavior.

## Результат

- `createCli({ defaultCommand: 'list', ... })` dispatches the declared `list`
  command when argv contains no command.
- With `defaultCommand` configured, a leading prefix of recognised framework
  global options is separated from command selection. `app --json` dispatches
  the default, while `app --json status x` is equivalent to
  `app status x --json`.
- Top-level `--help`/`-h` and `--version` retain their current meaning and never
  execute the default command.
- The default may target a native command, contract endpoint or runtime tool;
  it passes through the same validation, auth/startup and output path as an
  explicitly named invocation.
- A default absent from the resolved CLI surface fails deterministically rather
  than falling back silently. Resolution follows the exact explicit-command
  startup boundary: a native default dispatches without resolving auth or
  dynamic managed factories; a managed default is validated when that surface
  resolves.

## Public API proposal

```ts
await createCli({
  name: 'app',
  version: '1.0.0',
  defaultCommand: 'list',
  commands: [list],
})
```

`defaultCommand` is command selection only. It does not define a second handler,
duplicate a command schema or invent implicit arguments.

## План

- [x] Add optional `defaultCommand` to `CliConfig` and resolve it through the
      existing native/managed command maps rather than a second dispatch path.
- [x] Extract one shared framework-global token scanner/parser used by routing
      and `parseCliArgs`, and activate command-prefix routing only when
      `defaultCommand` is configured. It must understand boolean and
      value-bearing global forms, including `--json=false`,
      `--wait-timeout 30` and `--output-dir=x`, without mistaking an option value
      for a command or copying reserved-option grammar.
- [x] Define the routing matrix explicitly: after the recognised global prefix,
      the next non-option token is always an explicit command (including a
      typo). With no remaining token, or with a remaining option token, the
      default is inserted and its parser accepts or loudly rejects that option;
      `--` without a command is a usage error.
- [x] Preserve top-level help/version precedence and existing behavior when
      `defaultCommand` is omitted.
- [x] Validate defaults at the existing command-resolution boundary. A native
      match keeps ADR 0083's credential-free dispatch and does not resolve a
      dynamic managed surface merely to search for collisions; a managed
      dynamic default resolves identity once and uses the existing visibility
      and collision checks.
- [x] Mark the default in top-level help and render the command segment as
      optional without changing per-command help.
- [x] Route all per-command presentation policy through the existing resolved
      CLI descriptor boundary; do not create a second command lookup path for
      defaults.
- [x] Cover native, contract and runtime defaults, global-only argv, help,
      version, unknown default, dynamic availability, auth laziness and
      unchanged no-default behavior.
- [x] Update ADR 0083 (or add a superseding ADR only if command-selection
      ownership materially changes), CLI guide, API reference, public surface,
      generated agent docs and changelog.
- [x] Run `bun run verify` and packed Bun/Node consumer proof.

## Acceptance

- [x] `app`, `app --json` and `app list --json` execute the same declared
      command with equivalent parsed options and result semantics.
- [x] `app --json list` is the same explicit command; `app --json typo` remains
      an unknown-command error; a declared `app -f` reaches the default while
      undeclared `app -z` is its loud unknown-option error.
- [x] `app --help`, `app -h` and `app --version` never execute the default.
- [x] `app --json --help` and `app --json --version` retain top-level semantics;
      tokens after `--` are never reclassified as framework globals.
- [x] Top-level help wins before malformed global-value validation:
      `app --output-dir --help` and `app --json=invalid --help` print help and do
      not execute the default; `--help=false` follows normal parsing.
- [x] `--version` stays surface-free and need not validate the default;
      top-level help marks and validates the default when it resolves its help
      surface.
- [x] Explicit commands always win; a typo remains an unknown-command error and
      is never redirected to the default.
- [x] Native defaults preserve credential-free dispatch even beside dynamic
      managed factories; managed defaults keep the existing single-resolution
      auth/context/lifecycle path.
- [x] No application-owned rendering, polling, TTY detection or domain command
      enters Stitchkit.
- [x] Existing CLIs that omit `defaultCommand` have byte-equivalent behavior.
- [x] Exact regression test names are recorded in `Что сделано` before closure,
      and `bun run verify` is green.

## Конвейер 2/2 со стопом

- [x] Plan review 1: required an explicit leading-global grammar, exact
      native/dynamic resolution parity and a help/compatibility matrix.
- [x] Plan review 2: confirmed the gap and added value-bearing globals,
      discoverability and packed Bun/Node execution proof.
- [x] Owner approval received; implementation resumed on 2026-08-23.
- [x] Implementation review 1: routing/types/regression coverage.
- [x] Implementation review 2: packed consumer/docs/API ergonomics.

## Не входит

- Command or option aliases.
- A TTY renderer, table formatter, log follower or process supervisor.
- Consumer repository changes, release, commit, push or deploy.

## Что сделано

- `CliConfig.defaultCommand` и общий long-option classifier обеспечивают bare/global-only
  routing, explicit-command precedence и surface-free help/version без нарушения lazy native
  dispatch.
- Регрессия: `packages/core/tests/cli.test.ts` —
  `createCli — declarative command presentation policy > default command composes with global-only argv and explicit routing`,
  `default command preserves top-level help/version precedence without dispatch`,
  `native default remains credential-free beside dynamic managed surfaces`,
  `dynamic managed policy resolves identity, factories, context and lifecycle once`.
- Packed proof: `packages/core/scripts/consumer-lane/fixtures/full/src/app.ts` и
  `packages/core/scripts/consumer-lane/fixtures/node/src/runtime.mjs`; полный `bun run verify`
  прошёл 2026-08-23.
