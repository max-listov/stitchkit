---
title: XLSX
description: A workbook from rows and typed columns, with no dependency and no formula in the file.
---

# XLSX

`stitchkit/xlsx` turns rows into a workbook. It is evolving, it needs nothing beyond the `zod` the package
already requires, and it runs wherever
`CompressionStream` does: Bun, Node and a browser.

```ts
import { defineMoney } from 'stitchkit/primitives'
import { renderXlsx, XLSX_MEDIA_TYPE } from 'stitchkit/xlsx'

const rub = defineMoney('RUB')

const bytes = await renderXlsx({
  sheets: [
    {
      name: 'Orders',
      columns: [
        { key: 'title', header: 'Title', type: 'text' },
        { key: 'count', header: 'Count', type: 'number', format: '0.00' },
        { key: 'day', header: 'Day', type: 'date' },
        { key: 'at', header: 'Created', type: 'datetime', timeZone: 'Asia/Bangkok' },
        { key: 'total', header: 'Total', type: 'money', currency: 'RUB', scale: 2 },
        { key: 'paid', header: 'Paid', type: 'boolean' },
      ],
      rows: [
        {
          title: 'First order',
          count: '2.5',
          day: '2026-11-03',
          at: new Date(),
          total: rub.create('504182'),
          paid: true,
        },
      ],
    },
  ],
})

return new Response(bytes, {
  headers: {
    'content-type': XLSX_MEDIA_TYPE,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('Übersicht.xlsx')}`,
  },
})
```

A missing or `null` value leaves the cell empty. The first row holds the headers, stays frozen and carries a
filter. The same input produces the same bytes on one runtime; Bun and Node compress differently.

## Column types

| `type` | Cell value | In the file |
|---|---|---|
| `text` | string | text, whatever it looks like: `007` keeps its zeros |
| `number` | number, bigint or decimal string | a number, with an optional Excel `format` |
| `date` | `YYYY-MM-DD` | a date serial; a calendar date has no time zone to get wrong |
| `datetime` | `Date` or ISO instant with an offset | the wall clock of the column's `timeZone` to the second, since a cell stores no zone |
| `money` | `Money` in the column's `currency` | a number with `scale` places and the currency in its format |
| `boolean` | boolean | a boolean |

## What it refuses

A value of the wrong type throws `XlsxCellError` naming the cell, such as `sheet "Orders" B2: expected a
number or a decimal string`, instead of landing as a wrong cell.

Excel keeps numbers as doubles, so 15 significant digits are what survives. A decimal string or `Money` with
more refuses rather than turning into a different amount. Keep such a value in a `text` column if it must
stay exact and needs no arithmetic. Dates before 1900-03-01 refuse too: Excel counts a leap day that never
happened, so its serials before it are off by one.

A wall clock cannot tell the two hours of a daylight-saving change apart: 05:30Z and 06:30Z on a New York
autumn night are the same cell. Use `UTC` for a column whose order must survive that hour.

## Text is never a formula

Cells are written as inline strings, so `=HYPERLINK("x")` from a user's input is text a reader shows,
and the file has no formula element at all. A cell that starts with `=`, `+`, `-` or `@` also carries Excel's
quote prefix, so it stays text when a person edits that cell.

## Limits

Everything is built in memory, up to Excel's own 1 048 576 rows per sheet. There is no reading, no
charts, no merged cells and no streaming: an application that needs them takes a library.
