---
title: "Validated native-command presentation and exit policy"
description: Let a typed native command render its validated result and derive a process exit code without bypassing the canonical runner.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23T04:05:00Z
---

# Native-command result presentation and exit policy

## Зачем

`createCli` returns exit `0` for every successful `ToolResult` and automatically
serializes every declared native-command output as JSON. That is correct for
ordinary commands, but an observational command may successfully produce a
typed `{ status: 'degraded', ... }` report that must render as a table or compact
status on stdout while the process exits non-zero. Throwing converts valid
domain data into an error envelope; using an outputless handler to print
manually gives up declared output validation and still cannot set a non-zero
successful exit through the injected runner.

Presentation and exit classification are CLI transport policy. A native command
definition already owns only the local executable surface and retains its exact
Zod output generic, so the policy belongs there rather than in an erased
name-keyed `CliConfig` map.

## Результат

- An optional `exitCode` callback on a typed native command maps its validated
  output to an integer process code; absent policy preserves exit `0`.
- An optional pure `present` callback maps the same validated output and
  read-only CLI options to a complete stdout string. Stitchkit writes that
  string verbatim exactly once: the presenter owns all whitespace and newlines.
  Absent presentation retains canonical JSON.
- Thrown/structured failures, validation failures, dry-run, help, version and
  native-command semantics retain their existing error envelopes and exit
  mappings.
- Presentation/exit policy remains native-command-only and never enters managed
  contract/runtime definitions or HTTP/MCP/Agent surfaces without separate
  consumer evidence.

## Public API proposal

```ts
const doctor = defineCliCommand({
  name: 'doctor',
  description: 'Inspect runtime health',
  input: z.object({}),
  output: DoctorResultSchema,
  handler: inspectHealth,
  present: ({ result, options }) =>
    options.json ? `${JSON.stringify(result)}\n` : `${renderDoctorTable(result)}\n`,
  exitCode: (result) => result.status === 'ok' ? 0 : 1,
})
```

Both callbacks are inferred from `DoctorResultSchema` and run only after its
declared output validation. `present` returns the complete string; it does not
write it, so a failure cannot leave a partial success record.

## План

- [x] Extend the generic-preserving native command definition with optional
      typed `present` and `exitCode` callbacks; do not place CLI policy in the
      Zod schema or erased name-keyed config.
- [x] Execute handler → declared output validation → exit classification → pure
      presentation → one stdout write. Without `present`, reuse canonical JSON;
      without `exitCode`, return `0`.
- [x] Validate exit codes as safe integers in `0..255`. A throwing callback or
      invalid code becomes canonical `INTERNAL_SERVER_ERROR` on stderr, emits no
      success stdout and exits through the merged failure `exitCodes` mapping.
- [x] Runtime-validate `present` output as a string. A non-string return follows
      the same normalized internal-error path and emits no partial stdout.
- [x] Keep dry-run/help/version from invoking either callback. Output validation
      failure and ordinary thrown/structured failures remain authoritative and
      cannot be converted into a successful presentation.
- [x] Cover exact output inference, nonexistent-field type errors, table/string
      presentation, canonical fallback JSON, compact `--json`, zero/non-zero
      classification, invalid/throwing callbacks and existing failure exits.
- [x] Update ADR 0083 if needed, CLI guide, API reference, public surface,
      generated agent docs and changelog.
- [x] Run `bun run verify` and the shared packed Bun/Node CLI consumer proof.

## Acceptance

- [x] A validated `{ status: 'degraded' }` result can render a consumer-owned
      table/string and exit `1`; `{ status: 'ok' }` can render through the same
      presenter and exit `0`.
- [x] With no presenter, canonical JSON remains unchanged; a presenter receives
      read-only `options.json` and returns the complete deterministic record,
      including its chosen trailing newline, which is written verbatim once.
- [x] Both callbacks infer the exact declared Zod output; a compile-time probe
      rejects access to nonexistent result fields.
- [x] Failure envelopes and `exitCodes` remain authoritative for failed
      `ToolResult` values; native success policy cannot convert a failure.
- [x] Invalid/throwing policy emits no success stdout, produces normalized
      `INTERNAL_SERVER_ERROR` on stderr and honors an overridden internal-error
      exit code.
- [x] A runtime non-string presenter result follows the same internal-error
      path; TypeScript inference is not the only enforcement boundary.
- [x] Native commands without `present`/`exitCode` retain byte-equivalent output
      and exit codes.
- [x] Exact regression test names are recorded in `Что сделано` before closure,
      and `bun run verify` is green.

## Конвейер 2/2 со стопом

- [x] Plan review 1: rejected an erased name-keyed callback and required exact
      validation/presentation/error ordering plus exit range.
- [x] Plan review 2: required typed command-local presentation so manual
      table/string output and non-zero success can coexist without bypassing
      output validation.
- [x] Owner approval received; implementation resumed on 2026-08-23.
- [x] Implementation review 1: execution/types/regression coverage.
- [x] Implementation review 2: packed consumer/docs/API ergonomics.

## Не входит

- Managed contract/runtime result policy, streaming presentation, domain status
  names, health policy or a second error envelope.
- Consumer repository changes, release, commit, push or deploy.

## Что сделано

- Output-bearing `defineCliCommand` получил exact-Zod-typed `present` и `exitCode`; callbacks
  выполняются только после output validation, invalid policy нормализуется без partial stdout.
- Public declarations экспортируют полный CLI policy surface; guide, API reference, ADR 0083,
  changelog и generated agent docs синхронизированы.
- Регрессия: `packages/core/tests/cli.test.ts` —
  `createCli — native result presentation and exit policy > validated native output can render exact bytes and classify successful exit`,
  `exit policy without a presenter retains canonical JSON output`,
  `policy callbacks never run for help, dry-run or failed output validation`,
  `throwing or invalid result policy becomes a normalized internal failure`.
- Packed Bun/Node execution и полный `bun run verify` прошли 2026-08-23.
