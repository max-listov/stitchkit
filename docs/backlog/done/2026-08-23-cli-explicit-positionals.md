---
title: "Explicit positional fields for createCli commands"
description: Let a CLI declare which schema fields are positional instead of advertising every non-boolean field as positional.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23T04:05:00Z
---

# Explicit CLI positional fields

## Зачем

`createCli` currently assigns positional tokens to every non-boolean field in
schema declaration order and advertises the same order in help. A command such
as `logs <target> --lines 100` therefore also accepts and documents
`logs <target> 100`, even when `lines` is intentionally option-only. A consumer
that must preserve that CLI contract cannot adopt the canonical parser without
keeping an argv/arity layer in front of Stitchkit.

Position is transport presentation, not domain schema. Stitchkit should let a
CLI opt into an exact ordered subset of existing top-level fields while keeping
the current automatic policy as the backward-compatible default.

## Результат

- Per-command CLI configuration declares the exact ordered positional fields;
  every other schema field remains non-positional in argv while retaining the
  existing required-field stdin fill.
- Parsing and help use the same declaration. Extra positional tokens are loud
  usage errors rather than being assigned to an option-only field.
- The policy works for native, contract and runtime commands after their
  presentation schemas resolve and does not mutate Zod schemas or other
  transports.
- Omitting the policy preserves today's automatic non-boolean positional order.

## Public API proposal

```ts
await createCli({
  name: 'app',
  version: '1.0.0',
  commands: [logs],
  positionals: {
    logs: ['target'],
  },
})
```

An empty list means no argv positional fields: every field remains addressable
through its long/short option, and required-field stdin fill is unchanged. The
validator may choose an equivalent CLI-local shape if native and managed
commands share one runtime and help path.

## План

- [x] Add optional per-command positional configuration resolved against the
      same top-level presentation fields used by parsing and help.
- [x] Validate duplicates, unknown/unsafe fields, boolean positional targets
      and dynamic surface availability at the existing resolution boundary.
      Reject an optional/default positional followed by a required positional.
- [x] Permit existing one-token positional kinds: string, number, bigint, date,
      enum, object and array. Arrays remain one JSON/repeated-value token rather
      than becoming variadic; boolean targets are rejected.
- [x] Replace implicit field-order selection only for configured commands;
      reuse the existing coercion, Zod validation, stdin and error paths.
- [x] Generate usage and argument tables from the exact configured order while
      retaining canonical long flags and any declared short aliases.
- [x] Reuse one resolved CLI descriptor/presentation-policy boundary for
      positional, alias and result presentation metadata. A policy naming a
      command absent from the resolved managed surface is a configuration error;
      selected native commands keep lazy isolation from unrelated factories.
- [x] Cover one positional plus option-only scalar, no positionals, several
      ordered positionals, missing/extra tokens, stdin interaction, aliases,
      native/managed dynamic resolution and unchanged implicit defaults.
- [x] Update ADR 0083 if needed, CLI guide, API reference, public surface,
      generated agent docs and changelog.
- [x] Run `bun run verify` and the shared packed Bun/Node CLI consumer proof.

## Acceptance

- [x] `logs target --lines 100` succeeds when only `target` is positional;
      `logs target 100` fails as an extra positional token.
- [x] Usage renders `app logs <target> [--flags]`, never `[lines]`; the Arguments
      row retains `--lines` (or `-n, --lines`) and its required marker.
- [x] `positionals: { command: [] }` defines no argv positional fields; all
      fields remain long/short-option addressable and required-field stdin fill
      is unchanged.
- [x] Stdin still fills the first required unset presentation field, including
      an option-only field; a field already supplied by long/short flag is
      skipped when assigning later configured positional tokens.
- [x] Optional-before-required positional declarations fail at resolution, and
      extra positional tokens remain loud usage errors.
- [x] Configured fields validate against resolved native, contract and runtime
      presentation schemas without changing HTTP/MCP/Agent contracts.
- [x] CLIs without `positionals` retain byte-equivalent parsing and help.
- [x] Exact regression test names are recorded in `Что сделано` before closure,
      and `bun run verify` is green.

## Конвейер 2/2 со стопом

- [x] Plan review 1: required current help syntax, exact stdin/order/type rules
      and the shared resolved-surface policy boundary.
- [x] Plan review 2: confirmed the gap and aligned usage/Arguments output with
      the existing renderer and consumer CLI contract.
- [x] Owner approval received; implementation resumed on 2026-08-23.
- [x] Implementation review 1: parser/types/regression coverage.
- [x] Implementation review 2: packed consumer/docs/API ergonomics.

## Не входит

- Variadic subcommands, arbitrary argv callbacks or schema mutation.
- Consumer repository changes, release, commit, push or deploy.

## Что сделано

- `positionals` задаёт точный ordered field list на том же descriptor, который используют parser
  и help; empty list отключает argv positionals, а explicit-policy stdin сохраняет field coercion.
- No-policy stdin и automatic positional behavior оставлены историческими.
- Регрессия: `packages/core/tests/cli.test.ts` —
  `createCli — execution & coercion > without positional policy stdin keeps the historical raw-string behavior`,
  `createCli — declarative command presentation policy > explicit positionals leave option-only fields to flags and stdin`,
  `command help reflects the exact aliases and positional policy`,
  `invalid command-scoped policies fail at the resolved surface boundary`,
  `parseCliArgs — unit > explicit date and bigint positionals reuse scalar coercion`.
- Packed Bun/Node execution и полный `bun run verify` прошли 2026-08-23.
