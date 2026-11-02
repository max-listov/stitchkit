/**
 * The bytes are read back by a library this package does not ship, so the proof
 * is what a real reader sees, not what the writer meant.
 */
import { describe, expect, test } from 'bun:test';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { defineMoney } from '../src/entrypoints/primitives';
import { renderXlsx, XLSX_MEDIA_TYPE, XlsxCellError } from '../src/entrypoints/xlsx';

const rub = defineMoney('RUB');

async function read(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as never);
  return workbook;
}

/** Every XML part of the archive, decoded by hand from its central directory. */
function parts(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = new Map<string, string>();
  const decoder = new TextDecoder();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const compressedSize = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const start = at + 30 + nameLength;
    const name = decoder.decode(bytes.subarray(at + 30, start));
    const body = bytes.subarray(start, start + compressedSize);
    found.set(name, decoder.decode(inflateRawSync(body)));
    at = start + compressedSize;
  }
  return found;
}

const ORDERS = {
  name: 'Заказы',
  columns: [
    { key: 'title', header: 'Название', type: 'text' },
    { key: 'count', header: 'Кол-во', type: 'number', format: '0.00' },
    { key: 'day', header: 'Дата', type: 'date' },
    { key: 'at', header: 'Создан', type: 'datetime', timeZone: 'Asia/Bangkok' },
    { key: 'total', header: 'Сумма', type: 'money', currency: 'RUB', scale: 2 },
    { key: 'paid', header: 'Оплачен', type: 'boolean' },
  ],
  rows: [
    {
      title: 'Колонка «Ёлка» & <бант>',
      count: '2.5',
      day: '2026-11-03',
      at: new Date('2026-11-02T22:30:00.000Z'),
      total: rub.create('504182'),
      paid: true,
    },
    { title: '007', count: 3 },
  ],
} as const;

describe('renderXlsx', () => {
  test('a reader gets back the types that were written', async () => {
    const workbook = await read(await renderXlsx({ sheets: [ORDERS] }));
    const sheet = workbook.getWorksheet('Заказы');
    if (!sheet) throw new Error('the sheet is missing');
    expect(sheet.getRow(1).getCell(1).value).toBe('Название');
    expect(sheet.getRow(1).getCell(1).font?.bold).toBe(true);
    const row = sheet.getRow(2);
    expect(row.getCell(1).value).toBe('Колонка «Ёлка» & <бант>');
    expect(row.getCell(2).value).toBe(2.5);
    expect(row.getCell(2).numFmt).toBe('0.00');
    expect(row.getCell(3).value).toEqual(new Date('2026-11-03T00:00:00.000Z'));
    expect(row.getCell(4).value).toEqual(new Date('2026-11-03T05:30:00.000Z'));
    expect(row.getCell(5).value).toBe(5041.82);
    expect(row.getCell(5).numFmt).toContain('RUB');
    expect(row.getCell(6).value).toBe(true);
    expect(sheet.getRow(3).getCell(1).value).toBe('007');
    expect(sheet.getRow(3).getCell(3).value).toBeNull();
  });

  test('a string that looks like a formula stays text, and the file holds no formula', async () => {
    const bytes = await renderXlsx({
      sheets: [
        {
          name: 'Текст',
          columns: [{ key: 'note', header: '=SUM(A1)', type: 'text' }],
          rows: [
            { note: '=HYPERLINK("x")' },
            { note: '+1' },
            { note: '-1' },
            { note: '@cmd' },
            { note: "'=1+1" },
          ],
        },
      ],
    });
    const sheet = (await read(bytes)).worksheets[0];
    expect(sheet?.getRow(2).getCell(1).value).toBe('=HYPERLINK("x")');
    expect(sheet?.getRow(2).getCell(1).type).toBe(ExcelJS.ValueType.String);
    for (const xml of parts(bytes).values()) expect(xml).not.toMatch(/<f[ >]/);
    expect(parts(bytes).get('xl/worksheets/sheet1.xml')).toContain('s="2" t="inlineStr"');
  });

  test('characters XML cannot carry survive, and an escape lookalike stays itself', async () => {
    const text = 'a\u0001b _x0041_ c';
    const bytes = await renderXlsx({
      sheets: [
        { name: 'A', columns: [{ key: 't', header: 'T', type: 'text' }], rows: [{ t: text }] },
      ],
    });
    const xml = parts(bytes).get('xl/worksheets/sheet1.xml') ?? '';
    expect(xml).toContain('a_x0001_b _x005F_x0041_ c');
    await read(bytes);
  });

  test('the same workbook is the same bytes', async () => {
    const first = await renderXlsx({ sheets: [ORDERS] });
    const second = await renderXlsx({ sheets: [ORDERS] });
    expect(second).toEqual(first);
  });

  test('more than one sheet, and a style shared between columns', async () => {
    const workbook = await read(
      await renderXlsx({
        sheets: [
          {
            name: 'A',
            columns: [
              { key: 'x', header: 'X', type: 'money', currency: 'JPY', scale: 0 },
              { key: 'y', header: 'Y', type: 'money', currency: 'JPY', scale: 0 },
            ],
            rows: [
              { x: { minor: '1500', currency: 'JPY' }, y: { minor: '2', currency: 'JPY' } },
            ],
          },
          { name: 'B', columns: [{ key: 'z', header: 'Z', type: 'text' }], rows: [] },
        ],
      }),
    );
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['A', 'B']);
    expect(workbook.getWorksheet('A')?.getRow(2).getCell(2).value).toBe(2);
  });

  test('column twenty-seven is AA', async () => {
    const columns = Array.from({ length: 28 }, (_, index) => ({
      key: `c${index}`,
      header: `C${index}`,
      type: 'text' as const,
    }));
    const bytes = await renderXlsx({
      sheets: [{ name: 'Wide', columns, rows: [{ c26: 'here', c27: 'there' }] }],
    });
    expect(parts(bytes).get('xl/worksheets/sheet1.xml')).toContain('r="AA2"');
    expect(parts(bytes).get('xl/worksheets/sheet1.xml')).toContain('r="AB2"');
    expect((await read(bytes)).worksheets[0]?.getCell('AA2').value).toBe('here');
  });

  test.each([
    [{ key: 'v', header: 'V', type: 'text' }, 1],
    [{ key: 'v', header: 'V', type: 'text' }, 'x'.repeat(32_768)],
    [{ key: 'v', header: 'V', type: 'number' }, Number.NaN],
    [{ key: 'v', header: 'V', type: 'number' }, 'abc'],
    [{ key: 'v', header: 'V', type: 'number' }, '1234567890123456'],
    [{ key: 'v', header: 'V', type: 'date' }, '2026-02-30'],
    [{ key: 'v', header: 'V', type: 'date' }, '1900-02-28'],
    [{ key: 'v', header: 'V', type: 'date' }, new Date(0)],
    [{ key: 'v', header: 'V', type: 'datetime', timeZone: 'UTC' }, '2026-11-03 10:00'],
    [{ key: 'v', header: 'V', type: 'number' }, `0.${'0'.repeat(399)}1`],
    [{ key: 'v', header: 'V', type: 'number' }, `1${'0'.repeat(400)}`],
    [
      { key: 'v', header: 'V', type: 'datetime', timeZone: 'America/New_York' },
      '1900-03-01T00:00:00Z',
    ],
    [{ key: 'v', header: 'V', type: 'datetime', timeZone: 'UTC' }, '2026-02-30T10:00:00Z'],
    [{ key: 'v', header: 'V', type: 'datetime', timeZone: 'UTC' }, '01/02/2026 10:00 +07:00'],
    [
      { key: 'v', header: 'V', type: 'datetime', timeZone: 'UTC' },
      new Date('0050-06-01T00:00:00Z'),
    ],
    [
      { key: 'v', header: 'V', type: 'datetime', timeZone: 'UTC' },
      new Date('12000-01-01T00:00:00Z'),
    ],
    [
      { key: 'v', header: 'V', type: 'money', currency: 'RUB', scale: 2 },
      { minor: 'abc', currency: 'RUB' },
    ],
    [{ key: 'v', header: 'V', type: 'boolean' }, 'true'],
    [{ key: 'v', header: 'V', type: 'money', currency: 'RUB', scale: 2 }, 100],
    [
      { key: 'v', header: 'V', type: 'money', currency: 'RUB', scale: 2 },
      { minor: '1', currency: 'USD' },
    ],
    [
      { key: 'v', header: 'V', type: 'money', currency: 'RUB', scale: 2 },
      { minor: '1234567890123456', currency: 'RUB' },
    ],
  ] as const)('a %j cell refuses %j with its address', async (column, value) => {
    const refusal = await renderXlsx({
      sheets: [{ name: 'S', columns: [column], rows: [{ v: value }] }],
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(XlsxCellError);
    expect(String(refusal)).toContain('sheet "S" A2');
  });

  test.each([
    [{ sheets: [] }],
    [
      {
        sheets: [
          { name: 'a/b', columns: [{ key: 'k', header: 'H', type: 'text' }], rows: [] },
        ],
      },
    ],
    [
      {
        sheets: [
          {
            name: 'x'.repeat(32),
            columns: [{ key: 'k', header: 'H', type: 'text' }],
            rows: [],
          },
        ],
      },
    ],
    [
      {
        sheets: [
          { name: 'Same', columns: [{ key: 'k', header: 'H', type: 'text' }], rows: [] },
          { name: 'SAME', columns: [{ key: 'k', header: 'H', type: 'text' }], rows: [] },
        ],
      },
    ],
    [
      {
        sheets: [
          {
            name: 'Dup',
            columns: [
              { key: 'k', header: 'H', type: 'text' },
              { key: 'k', header: 'I', type: 'text' },
            ],
            rows: [],
          },
        ],
      },
    ],
  ])('a workbook Excel would not open is refused: %#', async (workbook) => {
    await expect(renderXlsx(workbook as never)).rejects.toThrow();
  });

  test('an apostrophe inside a sheet name is fine, and so is a value with trailing zeros', async () => {
    const workbook = await read(
      await renderXlsx({
        sheets: [
          {
            name: "Bob's",
            columns: [{ key: 'n', header: 'N', type: 'number' }],
            rows: [{ n: '1000000000000000000000' }],
          },
        ],
      }),
    );
    expect(workbook.worksheets[0]?.getRow(2).getCell(1).value).toBe(1e21);
  });

  test('the media type is the one an export operation declares', () => {
    expect(XLSX_MEDIA_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});
