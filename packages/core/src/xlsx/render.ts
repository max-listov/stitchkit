import { cellOf, type XlsxCell } from './cells';
import { type XlsxColumn, type XlsxWorkbook, XlsxWorkbookSchema } from './schema';
import { zip } from './zip';

export const XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Excel keeps a leading one of these for formulas when a person edits the cell. */
const FORMULA_START = /^[=+\-@]/;
const STYLE_HEADER = 1;
const STYLE_LITERAL_TEXT = 2;
const FIRST_CUSTOM_STYLE = 3;
const FIRST_CUSTOM_FORMAT = 164;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * OOXML text. A control character has no XML form, so it travels as `_xHHHH_`,
 * and a literal that looks like that escape has its underscore escaped, or Excel
 * would decode it into a different string.
 */
function escapeText(value: string): string {
  return escapeXml(
    value.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_').replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: these are what it escapes.
      /[\u0000-\u0008\u000b-\u001f￾￿]/g,
      (character) => `_x${character.charCodeAt(0).toString(16).padStart(4, '0')}_`,
    ),
  );
}

function columnName(index: number): string {
  let name = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

function numberFormat(column: XlsxColumn): string | undefined {
  switch (column.type) {
    case 'date':
      return 'yyyy\\-mm\\-dd';
    case 'datetime':
      return 'yyyy\\-mm\\-dd\\ hh:mm:ss';
    case 'money':
      return `#,##0${column.scale > 0 ? `.${'0'.repeat(column.scale)}` : ''}\\ "${column.currency}"`;
    case 'number':
      return column.format;
    default:
      return undefined;
  }
}

/** One style per distinct number format, numbered as `cellXfs` will list them. */
class StyleTable {
  readonly formats: string[] = [];

  styleOf(column: XlsxColumn): number {
    const format = numberFormat(column);
    if (format === undefined) return 0;
    const known = this.formats.indexOf(format);
    if (known !== -1) return FIRST_CUSTOM_STYLE + known;
    this.formats.push(format);
    return FIRST_CUSTOM_STYLE + this.formats.length - 1;
  }

  xml(): string {
    const formats = this.formats
      .map(
        (format, index) =>
          `<numFmt numFmtId="${FIRST_CUSTOM_FORMAT + index}" formatCode="${escapeXml(format)}"/>`,
      )
      .join('');
    const styles = this.formats
      .map(
        (_, index) =>
          `<xf numFmtId="${FIRST_CUSTOM_FORMAT + index}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
      )
      .join('');
    return `${XML_DECLARATION}<styleSheet xmlns="${SPREADSHEET}">${
      formats ? `<numFmts count="${this.formats.length}">${formats}</numFmts>` : ''
    }<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${FIRST_CUSTOM_STYLE + this.formats.length}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1" applyNumberFormat="1"/>${styles}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
}

function textCell(reference: string, value: string, style: number): string {
  const styled = style === 0 ? '' : ` s="${style}"`;
  return `<c r="${reference}"${styled} t="inlineStr"><is><t xml:space="preserve">${escapeText(value)}</t></is></c>`;
}

function cellXml(reference: string, cell: XlsxCell, style: number): string {
  switch (cell.kind) {
    case 'text':
      return textCell(
        reference,
        cell.value,
        FORMULA_START.test(cell.value) ? STYLE_LITERAL_TEXT : 0,
      );
    case 'boolean':
      return `<c r="${reference}" t="b"><v>${cell.value ? 1 : 0}</v></c>`;
    case 'number':
      return `<c r="${reference}"${style === 0 ? '' : ` s="${style}"`}><v>${cell.value}</v></c>`;
  }
}

function sheetXml(
  sheet: {
    name: string;
    columns: readonly XlsxColumn[];
    rows: readonly Record<string, unknown>[];
  },
  styles: StyleTable,
): string {
  const keys = new Set(sheet.columns.map((column) => column.key));
  if (keys.size !== sheet.columns.length) {
    throw new TypeError(`sheet "${sheet.name}": a column key repeats`);
  }
  const columnStyles = sheet.columns.map((column) => styles.styleOf(column));
  const widths = sheet.columns
    .map((column, index) => {
      const width = column.width ?? Math.max(12, Math.min(column.header.length + 2, 60));
      return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    })
    .join('');
  const header = sheet.columns
    .map((column, index) => textCell(`${columnName(index)}1`, column.header, STYLE_HEADER))
    .join('');
  const rows = sheet.rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = sheet.columns.flatMap((column, columnIndex) => {
      const value = row[column.key];
      if (value === undefined || value === null) return [];
      const reference = `${columnName(columnIndex)}${rowNumber}`;
      const cell = cellOf(value, column, `sheet "${sheet.name}" ${reference}`);
      return [cellXml(reference, cell, columnStyles[columnIndex] ?? 0)];
    });
    return `<row r="${rowNumber}">${cells.join('')}</row>`;
  });
  const lastCell = `${columnName(sheet.columns.length - 1)}${sheet.rows.length + 1}`;
  return `${XML_DECLARATION}<worksheet xmlns="${SPREADSHEET}"><dimension ref="A1:${lastCell}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData><row r="1">${header}</row>${rows.join('')}</sheetData><autoFilter ref="A1:${lastCell}"/></worksheet>`;
}

/**
 * A workbook as XLSX bytes: typed cells from rows, identical bytes for identical
 * input on one runtime. Text is stored as text, so a cell that reads `=HYPERLINK("x")` is what it
 * says and the file holds no formula at all. A value of the wrong type, or one
 * Excel could not hold exactly, refuses with the cell's address instead of
 * landing wrong. The whole workbook is built in memory.
 */
export async function renderXlsx(workbook: XlsxWorkbook): Promise<Uint8Array> {
  const { sheets } = XlsxWorkbookSchema.parse(workbook);
  const styles = new StyleTable();
  const worksheets = sheets.map((sheet, index) => ({
    name: `xl/worksheets/sheet${index + 1}.xml`,
    content: sheetXml(sheet, styles),
  }));
  const contentTypes = `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${worksheets
    .map(
      ({ name }) =>
        `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('')}</Types>`;
  const packageRelationships = `${XML_DECLARATION}<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbookXml = `${XML_DECLARATION}<workbook xmlns="${SPREADSHEET}" xmlns:r="${OFFICE_RELATIONSHIPS}"><bookViews><workbookView/></bookViews><sheets>${sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('')}</sheets></workbook>`;
  const workbookRelationships = `${XML_DECLARATION}<Relationships xmlns="${RELATIONSHIPS}">${sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join(
      '',
    )}<Relationship Id="rId${sheets.length + 1}" Type="${OFFICE_RELATIONSHIPS}/styles" Target="styles.xml"/></Relationships>`;
  return await zip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: packageRelationships },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRelationships },
    { name: 'xl/styles.xml', content: styles.xml() },
    ...worksheets,
  ]);
}
