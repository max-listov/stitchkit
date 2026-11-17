---
title: "ADR 0291: --output-dir saves what a result carries"
description: A CLI saves the files a result carries by their schema, whatever their type, prints a link in place of saved bytes, writes a name once per batch and never turns an executed command into a refusal.
type: decision
status: accepted
created: 2026-11-17 13:54 +07:00
updated: 2026-11-17 13:54 +07:00
---

# ADR 0291 — `--output-dir` saves what a result carries

Serves **I3**, **I8**, **I13**.

## Context

A tool can return a file as bytes: an `image` or `audio` block with base64 `data`, the shape
`defineViewFileTool` answers with, or MCP's embedded `resource`, which carries a file of any
type as a base64 `blob` or as `text`. A private file has no URL to download, so the bytes are
the only way it reaches a terminal — and a terminal that prints them prints the whole file as
text into a model's context.

`--output-dir` already saves the URL files an application names through `download`, through one
pinned root and an atomic contained writer (ADR 0276). Whether a result carries media is known
only after the call, which removes the one thing a refusal before the call could rely on: the
flag has no "configured" and "unconfigured" CLI any more.

Four questions follow, and each has a wrong answer that looks reasonable.

## Decision

**A file is what a schema says it is, and its type is not a list.** A part of a result's
top-level `content` is saved when it parses as an `image` or `audio` block of
`McpMediaContentSchema`, or as an embedded `resource` with a `blob` or `text`. The three shapes
are the ones the protocol has for inline bytes; none of them restricts the media type, so a PDF
or a spreadsheet is saved by the same rule as a picture. A part that only shares a word — a
rich-text node `{ type: 'image', attrs }` — is the result's own data: it is not saved, not
reported and not a failure. The schema owns the shape, including the optional `name`
a block is saved under; `defineViewFileTool` fills it from its source, so the name crosses an
MCP connection inside the block.

**One batch, one writer.** URL files and inline blocks are sources of the same batch: one pinned
root, one writer, one per-file outcome. A media block is named by its `name`, a resource by the
last path segment of its `uri`; a block that names no file is `<type>-<sha256><extension>`.

**A name is written once per batch.** The same bytes under the same name are one file. Different
bytes under a name the batch already wrote fail that file; the first one stays. Two sources with
one file name are otherwise a silent loss with two `saved` lines.

**Saved bytes leave stdout.** Each saved inline block is printed as an MCP resource link —
`{ type: 'resource_link', uri: 'file://…', name, mimeType, size }` — and a block that was not
saved keeps its bytes, so the printed result still accounts for everything the operation
returned. A result policy (`CliConfig.results`, ADR 0289) receives the operation's own result:
it is typed against the operation's schema, and a link is not in that schema.

**Nothing to save is not a refusal.** A result without media prints and exits as it does
without the flag, and stderr says that nothing was saved. By the time this is known the
operation has run; a usage exit code would tell a script to correct the command and run it
again, repeating the effect.

## Alternatives

- **Save only pictures and sound.** Rejected: the protocol's carrier for every other file is the
  embedded resource, and leaving it out prints a PDF as base64 beside a flag that asked for a file.
- **Treat every `content` part typed `image` as media and fail the malformed ones.** Rejected: a
  result is the application's data, and a document whose nodes are called `image` made a
  working `download` CLI exit non-zero.
- **Refuse `--output-dir` when a result has neither media nor a `download` callback.** Rejected:
  the same empty outcome exited `0` with a callback and `2` without one, and the refusal arrived
  after the effect.
- **Keep the bytes on stdout beside the saved file.** Rejected: the caller asked for a file
  precisely so the bytes would not be printed.
- **Let the last file under a name win.** Rejected: it reports two successes for one file.
- **Rename a colliding file.** Rejected: the name on disk would no longer be the name the result
  gave, and a second run would produce a third name.

## Consequences

A CLI without a `download` callback accepts `--output-dir` on every command. A `download`
callback that names two different files alike now fails the second one. A caller that needs
the bytes on stdout omits the flag. `packages/core/tests/cli-inline-media.test.ts`,
`cli-inline-outcomes.test.ts`, `cli-inline-containment.test.ts` and `cli-inline-mcp.test.ts`
hold each rule with its opposite case.
