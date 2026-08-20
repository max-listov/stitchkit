---
title: "CLI JSON mode applies to structured errors"
description: Make --json emit one compact JSON record on either result stream.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 13:15 +00:00
---

## Зачем

`--json` already emits a compact success record on stdout, but the same
structured failure is always pretty-printed on stderr. A line-oriented script
therefore cannot consume success and failure symmetrically even though both are
JSON records.

## Результат

- `--json` produces one compact line for a structured success on stdout and one
  compact line for a structured failure on stderr.
- Without `--json`, both records remain human-readable pretty JSON.

## План

- [x] Route success and failure through the same JSON indentation decision.
- [x] Clarify the CLI flag and guide without claiming that progress/plain usage
      diagnostics are JSON.
- [x] Add exact compact-error and default-pretty regression coverage.
- [x] Update the Unreleased changelog and generated consumer documentation.

## Acceptance

- [x] A failed `--json` command writes exactly one newline-terminated JSON record.
- [x] Stream ownership and exit-code mapping do not change.
- [x] Default output remains pretty-printed.
- [x] `bun run verify` is green.

## Что сделано

- [x] Core: `packages/core/src/tools/cli-format.ts` applies one compact/pretty
      serialization decision to both success and structured failure records.
- [x] Docs: `packages/core/src/tools/cli.ts`, `packages/core/src/tools/cli-args.ts`,
      `docs/guide/cli.md`, `docs/api/reference.md`, `CHANGELOG.md` and generated
      `packages/core/llms*.txt` describe the exact stream/record semantics.
- [x] Регрессия: packages/core/tests/cli.test.ts::missing required field → VALIDATION_ERROR, exit 1; packages/core/tests/cli.test.ts::without --json a structured failure remains pretty-printed on stderr
