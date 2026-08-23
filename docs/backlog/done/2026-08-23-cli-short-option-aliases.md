---
title: "Schema-bound short option aliases for createCli"
description: Let one command declare exact short aliases such as -f for a typed input field without a consumer-owned argv parser.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23T04:05:00Z
---

# CLI short option aliases

## Зачем

`parseCliArgs` accepts schema field names as long flags and reserves only the
framework's global options. A conventional operator command such as
`logs <target> -f --lines 100` cannot express `-f` through the declared Zod
input today. The application must rewrite argv or parse the whole command
before `createCli`, recreating validation, positionals, usage and error rules.

The framework should own exact alias normalization because it already owns the
schema-to-argv mapping. The application still owns which aliases exist. This is
not permission for heuristic abbreviation, grouped POSIX flags or a second CLI
parser.

## Результат

- A command can bind an exact one-character alias to one declared input field;
  for example `-f` maps to the boolean `follow` field and `-n 100` maps to a
  numeric `lines` field.
- Aliases target top-level fields in the command's resolved presentation schema,
  are scoped to one command and normalize into the existing `parseCliArgs` path
  before coercion and Zod validation.
- Help renders the alias beside the canonical long option; errors continue to
  name the canonical field where that is clearer.
- Alias keys match `/^[A-Za-z]$/` and are case-sensitive. Definitions fail at
  the existing surface-resolution boundary on unknown fields, unsafe keys,
  multiple aliases targeting one field or reserved lowercase `h`.
- Existing long flags, positionals, dotted objects, arrays, passthrough and
  reserved options remain unchanged.

## Public API proposal

Prefer transport configuration beside command routing rather than modifying a
domain Zod schema or endpoint definition:

```ts
await createCli({
  name: 'app',
  version: '1.0.0',
  commands: [logs],
  optionAliases: {
    logs: { f: 'follow', n: 'lines' },
  },
})
```

The validator may select a more type-safe equivalent shape if it keeps aliases
CLI-local, works uniformly for native and managed commands and does not copy
input schemas.

## План

- [x] Define a minimal CLI-local runtime-validated alias contract. Static/native
      entries validate when their command resolves; managed dynamic entries
      validate with the identity-dependent surface and never force unrelated
      auth/factory resolution.
- [x] Treat an alias policy naming a command absent from the currently resolved
      managed surface as a deterministic configuration error; selected native
      commands do not resolve unrelated dynamic entries.
- [x] Normalize declared short aliases into canonical long-field tokens before
      the existing parser; do not duplicate scalar/boolean/array/object
      coercion.
- [x] Specify exact v1 grammar: `-f` and `-f=true|false` for booleans;
      `-n 100` and `-n=100` for values; repeated aliases reuse canonical array
      accumulation. Reject `-fn`, `-n100`, multi-character aliases, undeclared
      abbreviations and `--no-f`; negation remains canonical `--no-follow`.
- [x] Allow aliases only for top-level presented fields. Dotted targets and
      passthrough targets remain unsupported; unknown short flags never enter
      passthrough.
- [x] Extend generated command help with exact aliases and deterministic
      collision diagnostics.
- [x] Reuse one resolved CLI descriptor/presentation-policy boundary for alias,
      positional and result presentation metadata; do not build an independent
      command lookup/validation path.
- [x] Cover native, contract and runtime commands; booleans, numbers, objects,
      repeated arrays, missing values, `-h`, cross-command reuse, dynamic
      surfaces, passthrough and unchanged long-form parsing. Mixed alias/long
      scalar input keeps the existing repeated-scalar error; arrays accumulate
      in argv order.
- [x] Update ADR 0083 (or add a superseding ADR only if alias ownership changes
      the architecture), CLI guide, API reference, public surface, generated
      agent docs and changelog.
- [x] Run `bun run verify` and packed Bun/Node consumer proof.

## Acceptance

- [x] A declared `-f` reaches the same Zod field and handler value as
      `--follow`; a declared value alias has identical coercion and validation
      to its long form.
- [x] `command --help` displays canonical long options and their exact short
      aliases from one declaration (`-f, --follow`; `-n, --lines`). Positional
      fields retain their positional marker beside the aliases.
- [x] Unknown short flags remain loud usage errors; aliases never leak between
      commands or into MCP/Agent/HTTP schemas.
- [x] `-h` remains help, global Stitchkit options cannot be shadowed and
      grouped short flags are not accepted implicitly.
- [x] A central reserved-short registry protects `h` and future framework short
      options; `1`, `-`, `_` and Unicode alias keys are rejected, and one
      canonical field cannot acquire multiple short aliases.
- [x] A declared `-f` composes with `defaultCommand`; an undeclared `-z` remains
      a loud option error from that default.
- [x] `command --help -z` still prints help without parsing the unrelated typo,
      matching the existing help-precedence guarantee.
- [x] Consumers can delete their alias-only argv rewrite without changing the
      command handler, schema or output behavior.
- [x] Existing CLIs that omit `optionAliases` have byte-equivalent behavior.
- [x] Exact regression test names are recorded in `Что сделано` before closure,
      and `bun run verify` is green.

## Конвейер 2/2 со стопом

- [x] Plan review 1: fixed token grammar, dynamic validation boundary,
      presentation-field lookup and mixed alias/canonical behavior.
- [x] Plan review 2: confirmed the real parser gap and constrained v1 to exact
      top-level aliases with runtime validation and packed proof.
- [x] Owner approval received; implementation resumed on 2026-08-23.
- [x] Implementation review 1: parser/types/regression coverage.
- [x] Implementation review 2: packed consumer/docs/API ergonomics.

## Не входит

- Command aliases, implicit prefix matching or grouped POSIX flags.
- A generic terminal UI, streaming renderer or application log policy.
- Consumer repository changes, release, commit, push or deploy.

## Что сделано

- `optionAliases` разрешается на общем command descriptor, валидирует own command keys,
  reserved/collision/schema boundaries и нормализует short form в canonical field до coercion.
- Регрессия: `packages/core/tests/cli.test.ts` —
  `createCli — declarative command presentation policy > managed commands accept aliases and explicit positionals after surface resolution`,
  `dynamic managed policy resolves identity, factories, context and lifecycle once`,
  `short aliases share canonical duplicate and coercion rules`,
  `command help reflects the exact aliases and positional policy`,
  `invalid command-scoped policies fail at the resolved surface boundary`.
- Packed Bun/Node execution и полный `bun run verify` прошли 2026-08-23.
