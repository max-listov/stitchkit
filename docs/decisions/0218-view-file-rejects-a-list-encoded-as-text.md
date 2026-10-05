---
title: "ADR 0218: view_file rejects a list encoded as text"
description: "The semantic check of paths belongs to the shared view_file schema; a mistaken list is rejected before IO with a hint, without changing the shared string-union coercion."
status: active
created: 2026-09-30 15:26 +07:00
updated: 2026-09-30 15:26 +07:00
type: decision
---

# ADR 0218 — view_file rejects a list encoded as text

## Context

`paths` accepts one path as a string or a real array of paths. The string
`'["image.png"]'` passes an ordinary `z.string()`, but it means one wrong
filename. The extension check then reports a refusal to read media, although the
cause is the shape of the argument. The shared coercion deliberately keeps strings
in a string-union: an automatic JSON.parse changes the set of valid string values.

## Decision

The shared `ViewFileInputSchema` checks the semantics of each path. If a string
parses as a JSON array, the schema rejects it with the message
`paths is a list written as text — pass an array of paths or one path`.
The rule also applies inside an array, on the managed MCP/Agent/CLI surfaces and
on raw MCP. The refinement does not parse the string into an argument and does not
change the shared coercion. A correct bracket filename `[preview].PNG` stays valid.

The local refusal by extension, before the file is read, names the path the user
passed and the extension it found. Hidden paths of the file boundary stay hidden.

## Consequences and verification

Validation became stricter: release 0.102.0 marks this as a breaking change and
provides a migration from a string-encoded JSON array to a real array. Managed
surfaces return `VALIDATION_ERROR`; raw MCP uses its own input-validation refusal.

`managed-view-file.test.ts` checks both forms through real MCP/Agent mounts, the
refusal before any file/network IO, and the following successful read of one path
and of an array. A bad array element, an empty list written as text and a bracket
filename are separate counterexamples. The local refusal is checked by code, path,
extension and zero reads. The decision serves I2, I3, I8 and I13.
