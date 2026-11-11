---
title: "ADR 0289: A managed command owns its terminal result, and a stream is a command"
description: A CLI declares present and exitCode for a contract command where it is mounted, every command prints its schema, and a contract stream runs as a command that prints a line per item.
type: decision
status: accepted
created: 2026-11-11 13:51 +07:00
updated: 2026-11-11 13:51 +07:00
---

# ADR 0289 — A managed command owns its terminal result, and a stream is a command

Serves **I1**, **I2**, **I8**.

## Context

A command derived from a contract printed JSON or an aggregate view and exited `0` on success.
Only a native `defineCliCommand` could print text for a person, classify a successful result by
exit code, or describe its schema. A consuming project therefore wrote every command a person
reads as a native command, outside its contract: a second flag registry, a second parser, its own
schema output — and a typed client that knew none of those answers, so its consumers ran the
binary and kept copies of the schemas. A contract stream could not be a command at all.

## Decision

**The result policy is declared where the CLI is mounted.** `CliConfig.results` maps a command
name to `present` and `exitCode`, typed against the operation's output by `defineCliResult`. It is
not a contract field: a client and a server print nothing, and two CLIs over one contract may
print differently. One function applies the policy for native and managed commands, so the
guarantees are identical — after output validation, `CLI_PRESENTATION_FAILED` on a failed
presenter — and `createCliInvoker` returns the same exit code the command line does. The policy
carries the schema it is typed against, and mounting it on a command that answers with another
schema is a startup error. It speaks for the command's own result: an aggregate view and the
polled result of `--wait` print without it.

**Every command prints its schema.** `--schema` is a reserved option answering one JSON line with
the JSON Schema of the input and the output, converted from the Zod schemas the call is validated
against, in one dialect. It answers before validation and the call, like `--help`.

**A contract stream is a command.** A streaming endpoint may list `'CLI'` in `expose`, beside
`'HTTP'` or alone. The command opens through the shared tool runner and reads the handler's
iterable through the one loop the HTTP response uses, so an item, a terminal and a missing
terminal mean the same on both; it prints a line per item. A closed stdout, the application's
signal and the contract's `lifetimeMs` each end the command without waiting for a source that
ignores its signal. A stream is still never an MCP or
agent tool: a model call has one answer.

## Consequences

`schema` joins the reserved option names; a command field of that name is refused, as the
migration `cli-schema-option` shows. A stream command has no single result, so `exitCode` in its
policy is refused at startup and `createCliInvoker` does not reach it. A stream takes no `tool`
group, so its command name is always derived from the contract prefix and the endpoint key.
