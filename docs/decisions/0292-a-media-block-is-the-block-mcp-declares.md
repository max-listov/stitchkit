---
title: "ADR 0292: A media block is the block MCP declares"
description: McpMediaContentSchema holds exactly the fields of MCP's image and audio content, and the file name of a block's source lives in its _meta, so one block has one shape on every surface.
type: decision
status: accepted
created: 2026-11-17 15:49 +07:00
updated: 2026-11-17 15:49 +07:00
---

# ADR 0292 — A media block is the block MCP declares

Amends [ADR 0291](0291-output-dir-saves-what-a-result-carries.md). Serves **I3**, **I8**, **I13**.

## Context

ADR 0291 let an `image` or `audio` block of `McpMediaContentSchema` say which file it came from,
so a CLI saves it under that name, and put the name in a field of the block's own: `name`. The
record says the name "crosses an MCP connection inside the block".

It crossed half of one. MCP's `ImageContent` and `AudioContent` declare `type`, `data`,
`mimeType`, `annotations` and `_meta`, and the official server SDK validates a tool result
against them before sending it, which drops every field they do not declare. A consuming project
captured the result on the wire: `structuredContent`, which is the output schema's value, carried
`name`; the same block in `content` did not. A host that reads `content` — the ordinary path for
a host — never saw the name, and a raw `mountViewFile`, which sends no `structuredContent`, lost
it altogether. `packages/core/tests/managed-view-file.test.ts` holds the SDK's behaviour as a
test of its own, so the reason is not taken on trust.

The defect is not the missing field on the wire. It is that a schema named for an MCP block held
a field MCP does not have, so the block had two shapes: the one the framework validated and the
one a host received.

## Decision

**`McpMediaContentSchema` is the protocol's block, field for field.** An `image` or `audio`
block is `type`, `data`, `mimeType`, `annotations` and `_meta`. It has no `name`.

**What a block carries beyond the protocol lives in `_meta`, under a namespaced key.** The file
name of a block's source is `_meta['stitchkit/fileName']`, exported as `MCP_FILE_NAME_META_KEY`.
`_meta` is the place the protocol reserves for this, the SDK passes it through, and the key is
namespaced because that place is shared — the reason `stitchkit/catalog` is.

**One block, one shape.** The handler's output, the Agent's result, `structuredContent` and MCP
`content` carry the same block, and a reader looks in one place. A CLI's `--output-dir` saves a
media block under `_meta['stitchkit/fileName']`; an embedded resource is still named by its
`uri`, which the protocol already declares. No surface encodes or decodes the block.

## Alternatives

- **Keep `name` and move it into `_meta` when a result goes out over MCP.** Rejected: the block
  keeps two shapes, `content` and `structuredContent` differ for good, every reader accepts both,
  and every tool that returns media has to call the encoder or loses the name as before.
- **Say in the changelog that `content` carries no name and point a host at
  `structuredContent`.** Rejected: a raw MCP tool has no `structuredContent`, and a host reading
  `content` would name every saved file by its hash.
- **Send a file as an embedded `resource`, whose `uri` names it.** Rejected for media: a host
  shows a model an `image` or `audio` block, and is not required to show it a resource's bytes.
- **Refuse an unknown field in a block.** Rejected: the schema also reads results of servers the
  framework did not write, and a field a later protocol revision adds would make their media
  unreadable. A block built in TypeScript with a `name` is already a compile error against
  `McpMediaContent`.

## Consequences

`name` on a media block, one release old, is removed without an alias; a tool that built it by
hand writes `_meta` instead, and the migration is `media-block-file-name` in
`docs/guide/upgrading.md`. A host that is not built on this framework reads the name under a key
it has to know; the guide names it. `packages/core/tests/managed-view-file.test.ts` compares the
bytes a host receives, before any client parses them, for `defineViewFileTool` and
`mountViewFile`, with the Agent's result and `structuredContent`;
`packages/core/tests/cli-inline-mcp.test.ts` saves the media of both through a real MCP
connection under their source names.
