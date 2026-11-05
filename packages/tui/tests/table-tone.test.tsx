import { describe, expect, test } from 'bun:test';
import { RGBA, TextAttributes } from '@opentui/core';
import { useReducer } from 'react';
import {
  createTerminalTable,
  reduceTerminalTable,
  type TerminalTableAction,
  type TerminalTableColumn,
  type TerminalTableRowInput,
  type TerminalTableState,
} from '../src/core/table';
import { type TerminalThemeMode, terminalPalettes } from '../src/core/theme';
import { renderTerminalTest } from '../src/testing';
import { TerminalTable } from '../src/widgets/table';

const columns: TerminalTableColumn[] = [
  { id: 'name', title: 'NAME', kind: 'text', width: 12 },
  {
    id: 'status',
    title: 'STATUS',
    kind: 'text',
    width: 8,
    tone: (value) =>
      value === 'errored' ? 'danger' : value === 'online' ? 'success' : undefined,
  },
];

const rows: TerminalTableRowInput[] = [
  { key: 'api', cells: { name: 'api', status: 'online' } },
  { key: 'cron', cells: { name: 'cron', status: 'stopped' }, tone: 'muted' },
  { key: 'mailer', cells: { name: 'mailer', status: 'errored' }, tone: 'danger' },
];

function Table() {
  const [state, dispatch] = useReducer(
    (current: TerminalTableState, action: TerminalTableAction) =>
      reduceTerminalTable(current, action),
    undefined,
    () => createTerminalTable({ columns, rows, capacity: 5, sort: null }),
  );
  return <TerminalTable state={state} onAction={dispatch} width={21} height={6} />;
}

type Span = { text: string; fg: RGBA; attributes: number };

/** The span holding `text` on the line that starts with `row`. */
function spanOf(lines: { spans: Span[] }[], row: string, text: string): Span {
  const line = lines.find(({ spans }) =>
    spans
      .map((span) => span.text)
      .join('')
      .trimStart()
      .startsWith(row),
  );
  const span = line?.spans.find((candidate) => candidate.text.includes(text));
  if (!span) throw new Error(`no span "${text}" on row "${row}"`);
  return span;
}

const hex = (color: string) => RGBA.fromHex(color).toInts().join(',');
const rgb = (color: RGBA) => color.toInts().join(',');

describe('table row and cell tone', () => {
  for (const mode of ['dark', 'light'] as const satisfies readonly TerminalThemeMode[]) {
    test(`a stopped row is muted, an errored one red, in the ${mode} palette`, async () => {
      const palette = terminalPalettes[mode];
      const screen = await renderTerminalTest(<Table />, {
        width: 21,
        height: 6,
        themeMode: mode,
      });
      try {
        await screen.frame();
        const { lines } = screen.setup.captureSpans() as unknown as {
          lines: { spans: Span[] }[];
        };
        // Row tone: the whole stopped row muted and dim, the errored row red and bold.
        expect(rgb(spanOf(lines, 'cron', 'cron').fg)).toBe(hex(palette.muted));
        expect(spanOf(lines, 'cron', 'cron').attributes & TextAttributes.DIM).toBeTruthy();
        expect(rgb(spanOf(lines, 'mailer', 'mailer').fg)).toBe(hex(palette.danger));
        expect(
          spanOf(lines, 'mailer', 'mailer').attributes & TextAttributes.BOLD,
        ).toBeTruthy();
        // Cell tone over the row: online green while the name stays in the default colour.
        expect(rgb(spanOf(lines, 'api', 'online').fg)).toBe(hex(palette.success));
        expect(rgb(spanOf(lines, 'api', 'api').fg)).toBe(hex(palette.primary));
        expect(spanOf(lines, 'api', 'api').attributes).toBe(TextAttributes.NONE);
      } finally {
        await screen.close();
      }
    });
  }

  test('the selected row keeps its tone on the selection background', async () => {
    const screen = await renderTerminalTest(<Table />, { width: 21, height: 6 });
    try {
      await screen.press('ARROW_DOWN');
      await screen.press('ARROW_DOWN');
      const { lines } = screen.setup.captureSpans() as unknown as {
        lines: { spans: Span[] }[];
      };
      expect(rgb(spanOf(lines, 'mailer', 'mailer').fg)).toBe(
        hex(terminalPalettes.dark.danger),
      );
    } finally {
      await screen.close();
    }
  });
});
