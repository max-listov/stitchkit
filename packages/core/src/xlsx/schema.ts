import { z } from 'zod';

const ColumnBase = {
  /** The property of a row this column reads. */
  key: z.string().min(1),
  header: z.string().min(1),
  /** Width in characters. Default: the longer of the header and 12. */
  width: z.number().positive().max(255).optional(),
};

const TimeZoneSchema = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, 'expected an IANA time zone');

export const XlsxColumnSchema = z.discriminatedUnion('type', [
  z.object({ ...ColumnBase, type: z.literal('text') }),
  z.object({
    ...ColumnBase,
    type: z.literal('number'),
    /** An Excel number format such as `0.00`. */
    format: z.string().min(1).optional(),
  }),
  /** A calendar date, `YYYY-MM-DD`: it has no time zone to get wrong. */
  z.object({ ...ColumnBase, type: z.literal('date') }),
  /** An instant, shown as the wall clock of `timeZone`: Excel cells store no zone. */
  z.object({ ...ColumnBase, type: z.literal('datetime'), timeZone: TimeZoneSchema }),
  z.object({
    ...ColumnBase,
    type: z.literal('money'),
    /** Every cell must hold this currency, and it is printed in the number format. */
    currency: z.string().regex(/^[\p{L}\p{Sc}\d .]{1,12}$/u),
    /** Decimal places of the currency. */
    scale: z.number().int().min(0).max(6),
  }),
  z.object({ ...ColumnBase, type: z.literal('boolean') }),
]);
export type XlsxColumn = z.infer<typeof XlsxColumnSchema>;

/** Excel's own rule, plus what XML cannot carry; `History` is a name it keeps for itself. */
const SHEET_NAME = /^(?!')[^\p{Cc}[\]:*?/\\\ufffe\uffff]{1,31}(?<!')$/u;

export const XlsxSheetSchema = z.object({
  name: z
    .string()
    .regex(SHEET_NAME, 'expected a sheet name Excel accepts')
    .max(31)
    .refine((name) => name.toLowerCase() !== 'history', 'Excel keeps the name History'),
  columns: z.array(XlsxColumnSchema).min(1).max(16_384).readonly(),
  rows: z.array(z.record(z.string(), z.unknown())).max(1_048_575).readonly(),
});

export const XlsxWorkbookSchema = z.object({
  sheets: z
    .array(XlsxSheetSchema)
    .min(1)
    .refine(
      (sheets) =>
        new Set(sheets.map((sheet) => sheet.name.toLowerCase())).size === sheets.length,
      'sheet names must differ, ignoring case',
    )
    .readonly(),
});
export type XlsxWorkbook = z.input<typeof XlsxWorkbookSchema>;
