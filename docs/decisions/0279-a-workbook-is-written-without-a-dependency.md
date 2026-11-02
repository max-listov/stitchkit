---
title: "ADR 0279: A workbook is written without a dependency"
description: stitchkit/xlsx writes OOXML itself, stores text as text, and refuses what Excel cannot hold exactly.
type: decision
status: accepted
created: 2026-11-03
updated: 2026-11-03
---

# ADR 0279 — A workbook is written without a dependency

Serves **I8**, **I9**, **I13**.

## Context

A consuming project found that none of the four reference applications exports Excel, while client admin
panels almost always ask for it, and each project picks a library again. The failures are the same each
time: user text that runs as a formula, an amount that changes in the double a cell stores, and a date a time
zone away from the one written.

## Decision

`stitchkit/xlsx` starts evolving and writes the format itself: a deflated ZIP of XML through the platform's
`CompressionStream`, about 500 lines. The package has one runtime dependency, and a write-only workbook
with six column types does not justify a second.

Cells are typed by their column. Text is an inline string, so the file has no formula element whatever the
text says, and a leading `=`, `+`, `-` or `@` also gets Excel's quote prefix. Anything Excel would store
differently from what was written refuses with the cell's address: a number past 15 significant digits, a
date before 1900-03-01, a value of the wrong type. An instant is written as the wall clock of the column's
declared zone, because a cell stores none; the repeated hour of a daylight-saving change is the one loss that
cannot be refused, and the guide names it.

## Alternatives

- A library such as exceljs: rejected for the shipped code. It brings about 170 packages for features this
  does not use. It stays as a development dependency, because a reader this package did not write is what
  proves the bytes.
- A CSV export: rejected, it has no types, and leading `=` needs a mangling that changes the data.
- Accepting doubles for money and rounding silently: rejected, that is the defect exact money exists to
  prevent.

## Consequences

Reading, charts, merged cells and streaming are out of scope; an application that needs them takes a library.
A workbook is built in memory, so its size is the caller's to bound. Proven in
`packages/core/tests/xlsx.test.ts` through exceljs.
