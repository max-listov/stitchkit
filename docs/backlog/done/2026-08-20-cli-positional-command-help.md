---
title: "CLI help exposes accepted positional arguments"
description: Show the positional command form derived from the same schema order as argv parsing.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 13:15 +00:00
---

## Зачем

The CLI parser accepts non-boolean fields positionally in schema declaration
order, but command help only renders their `--field` form and a generic
`[args]` placeholder. The executable accepts a concise form it cannot explain.

## Результат

- Per-command usage names every accepted positional field in parser order.
- The argument table presents positional and flag forms as alternatives while
  preserving requiredness, type and description.

## План

- [x] Derive positional help from the parser's canonical field classification.
- [x] Render required and optional positional syntax in command usage.
- [x] Keep boolean fields flag-only and preserve the existing flag form.
- [x] Cover native and contract-derived commands with regression tests.
- [x] Update the Unreleased changelog and CLI guide.

## Acceptance

- [x] A required string field is shown as `<field>` and `--field`.
- [x] Optional/default non-boolean fields are shown as `[field]`; booleans are
      absent from positional usage.
- [x] Help order exactly matches positional parsing order.
- [x] Native and managed commands share the behavior.
- [x] `bun run verify` is green.

## Что сделано

- [x] Core: `packages/core/src/tools/cli.ts` derives usage positionals from
      `describeSchemaFields`, the same classification/order used by argv parsing.
- [x] Help: required fields render as `<field>`, optional/default fields as
      `[field]`, argument rows show the positional and `--field` alternatives,
      and boolean fields remain flag-only.
- [x] Docs: `docs/guide/cli.md`, `docs/api/reference.md`, `CHANGELOG.md` and
      generated `packages/core/llms*.txt` document the surfaced syntax.
- [x] Регрессия: packages/core/tests/cli.test.ts::command --help shows the flag table; packages/core/tests/cli.test.ts::lists, documents, validates and emits one typed native command
