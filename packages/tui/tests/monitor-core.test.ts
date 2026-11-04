import { describe, expect, test } from 'bun:test';
import {
  appendTerminalSample,
  createTerminalTable,
  createTerminalTabs,
  createTerminalTimeSeries,
  fitTerminalText,
  layoutTerminalMeterGrid,
  layoutTerminalTableColumns,
  reduceTerminalTable,
  reduceTerminalTabs,
  resolveTerminalPalette,
  sampleTerminalTimeSeries,
  selectedTerminalTab,
  selectedTerminalTableRow,
  type TerminalTableColumn,
  type TerminalTableRowInput,
  terminalBrailleChart,
  terminalMeter,
  terminalPalettes,
  terminalSparkline,
  terminalTableTreePrefix,
  terminalTimeAxis,
  visibleTerminalTableRows,
} from '../src/core';

const columns: TerminalTableColumn[] = [
  { id: 'name', title: 'NAME', kind: 'text', width: { flex: 1 } },
  {
    id: 'cpu',
    title: 'CPU%',
    kind: 'number',
    width: 6,
    format: (value) => `${Number(value).toFixed(1)}`,
  },
];

function row(
  key: string,
  name: string,
  cpu: number | null,
  parentKey: string | null = null,
): TerminalTableRowInput {
  return { key, parentKey, cells: { name, cpu } };
}

const order = (state: ReturnType<typeof createTerminalTable>): string[] =>
  state.view.map(({ row }) => row.key);

describe('terminal table', () => {
  test('sorts numbers with missing values last in both directions and ties by key', () => {
    const rows = [
      row('b', 'beta', 5),
      row('n', 'none', null),
      row('a', 'alpha', 5),
      row('c', 'c', 9),
    ];
    let state = createTerminalTable({
      columns,
      rows,
      capacity: 10,
      sort: { columnId: 'cpu', direction: 'desc' },
    });
    expect(order(state)).toEqual(['c', 'a', 'b', 'n']);
    state = reduceTerminalTable(state, { type: 'sort-invert' });
    expect(order(state)).toEqual(['a', 'b', 'c', 'n']);
  });

  test('sorts text by a numeric-aware collation', () => {
    const rows = [row('1', 'worker-10', 1), row('2', 'worker-9', 1), row('3', 'Alpha', 1)];
    const state = createTerminalTable({
      columns,
      rows,
      capacity: 10,
      sort: { columnId: 'name', direction: 'asc' },
    });
    expect(order(state)).toEqual(['3', '2', '1']);
  });

  test('keeps the selection on its row while data reorders it', () => {
    let state = createTerminalTable({
      columns,
      rows: [row('a', 'a', 1), row('b', 'b', 2), row('c', 'c', 3)],
      capacity: 2,
      sort: { columnId: 'cpu', direction: 'desc' },
    });
    state = reduceTerminalTable(state, { type: 'select', key: 'a' });
    state = reduceTerminalTable(state, {
      type: 'rows',
      rows: [row('a', 'a', 9), row('b', 'b', 2), row('c', 'c', 3)],
    });
    expect(selectedTerminalTableRow(state)?.key).toBe('a');
    expect(visibleTerminalTableRows(state).map(({ row }) => row.key)).toEqual(['a', 'c']);
  });

  test('expands a parent to its sorted children and collapsing moves the selection up', () => {
    const rows = [
      row('app', 'app', 10),
      row('w1', 'worker', 2, 'app'),
      row('w2', 'worker', 7, 'app'),
      row('db', 'db', 5),
    ];
    let state = createTerminalTable({
      columns,
      rows,
      capacity: 10,
      sort: { columnId: 'cpu', direction: 'desc' },
    });
    expect(order(state)).toEqual(['app', 'db']);
    state = reduceTerminalTable(state, { type: 'expand', key: 'app' });
    expect(order(state)).toEqual(['app', 'w2', 'w1', 'db']);
    expect(state.view.map(terminalTableTreePrefix)).toEqual(['▾ ', '    ', '    ', '  ']);
    state = reduceTerminalTable(state, { type: 'select', key: 'w1' });
    state = reduceTerminalTable(state, { type: 'collapse' });
    expect(selectedTerminalTableRow(state)?.key).toBe('app');
    state = reduceTerminalTable(state, { type: 'collapse' });
    expect(order(state)).toEqual(['app', 'db']);
    expect(selectedTerminalTableRow(state)?.key).toBe('app');
  });

  test('collapsing a row by key over the selection lands on that row, not a stranger', () => {
    let state = createTerminalTable({
      columns,
      rows: [
        row('p', 'p', 1),
        row('k1', 'k', 1, 'p'),
        row('k2', 'k', 1, 'p'),
        row('z', 'z', 1),
      ],
      capacity: 10,
      expanded: ['p'],
    });
    state = reduceTerminalTable(state, { type: 'select', key: 'k2' });
    state = reduceTerminalTable(state, { type: 'toggle', key: 'p' });
    expect(selectedTerminalTableRow(state)?.key).toBe('p');
  });

  test('filters on displayed text and opens the ancestors of a match without expanding them', () => {
    let state = createTerminalTable({
      columns,
      rows: [row('app', 'app', 1), row('w', 'needle', 1, 'app'), row('db', 'db', 1)],
      capacity: 10,
    });
    state = reduceTerminalTable(state, { type: 'filter', query: 'NEED' });
    expect(order(state)).toEqual(['app', 'w']);
    expect(state.view.map(({ matched }) => matched)).toEqual([false, true]);
    expect(state.expanded.size).toBe(0);
    state = reduceTerminalTable(state, { type: 'filter', query: '' });
    expect(order(state)).toEqual(['app', 'db']);
  });

  test('forgets expanded rows that left the data', () => {
    let state = createTerminalTable({
      columns,
      rows: [row('p1', 'p', 1), row('c1', 'c', 1, 'p1')],
      capacity: 5,
      expanded: ['p1'],
    });
    for (let tick = 2; tick < 600; tick += 1) {
      state = reduceTerminalTable(state, { type: 'expand', key: `p${tick - 1}` });
      state = reduceTerminalTable(state, {
        type: 'rows',
        rows: [row(`p${tick}`, 'p', 1), row(`c${tick}`, 'c', 1, `p${tick}`)],
      });
    }
    expect(state.expanded.size).toBe(0);
  });

  test('refuses rows that do not fit the declared columns or form a cycle', () => {
    expect(() =>
      createTerminalTable({
        columns,
        rows: [{ key: 'a', cells: { name: 'a' } }],
        capacity: 1,
      }),
    ).toThrow(/no cell for column cpu/);
    expect(() =>
      createTerminalTable({
        columns,
        rows: [{ key: 'a', cells: { name: 'a', cpu: '1' } }],
        capacity: 1,
      }),
    ).toThrow(/string in number column cpu/);
    expect(() =>
      createTerminalTable({
        columns,
        rows: [row('a', 'a', 1, 'b'), row('b', 'b', 1, 'a')],
        capacity: 1,
      }),
    ).toThrow(/cycle/);
  });

  test('shows a row with an unknown parent as a root', () => {
    const state = createTerminalTable({
      columns,
      rows: [row('a', 'a', 1, 'gone')],
      capacity: 1,
    });
    expect(state.view.map(({ depth }) => depth)).toEqual([0]);
  });

  test('cycles the sort column and starts numbers descending', () => {
    let state = createTerminalTable({ columns, rows: [], capacity: 1 });
    state = reduceTerminalTable(state, { type: 'sort-next', delta: 1 });
    expect(state.sort).toEqual({ columnId: 'name', direction: 'asc' });
    state = reduceTerminalTable(state, { type: 'sort-next', delta: 1 });
    expect(state.sort).toEqual({ columnId: 'cpu', direction: 'desc' });
    state = reduceTerminalTable(state, { type: 'sort', columnId: 'cpu' });
    expect(state.sort?.direction).toBe('asc');
  });

  test('lays out fixed and flexible columns and fits cells', () => {
    expect(layoutTerminalTableColumns(columns, 20)).toEqual([
      { id: 'name', width: 13 },
      { id: 'cpu', width: 6 },
    ]);
    expect(layoutTerminalTableColumns(columns, 5)).toEqual([
      { id: 'name', width: 5 },
      { id: 'cpu', width: 0 },
    ]);
    expect(fitTerminalText('postgres', 5, 'left')).toBe('post…');
    expect(fitTerminalText('42', 5, 'right')).toBe('   42');
  });
});

describe('terminal meter', () => {
  test('fills whole cells, one partial eighth, and tones by threshold', () => {
    expect(terminalMeter({ value: 50, max: 100, width: 4 })).toEqual({
      filled: '██',
      empty: '  ',
      ratio: 0.5,
      tone: 'success',
    });
    expect(terminalMeter({ value: 0.7, max: 1, width: 2 })).toMatchObject({
      filled: '█▍',
      tone: 'warning',
    });
    expect(terminalMeter({ value: 200, max: 100, width: 3 })).toMatchObject({
      filled: '███',
      empty: '',
      tone: 'danger',
    });
  });

  test('draws an unmeasured value as an empty muted bar, not a zero reading', () => {
    expect(terminalMeter({ value: null, max: 1, width: 3 })).toEqual({
      filled: '',
      empty: '   ',
      ratio: null,
      tone: 'muted',
    });
  });

  test('arranges sixteen core meters column-major in the columns that fit', () => {
    const grid = layoutTerminalMeterGrid({ count: 16, width: 80, minMeterWidth: 18 });
    expect(grid).toMatchObject({ columns: 4, rows: 4, meterWidth: 19 });
    expect(grid.cells[0]).toEqual([0, 4, 8, 12]);
    expect(layoutTerminalMeterGrid({ count: 3, width: 10, minMeterWidth: 18 }).columns).toBe(
      1,
    );
  });
});

describe('terminal charts', () => {
  test('bounds a series by its window and by its sample count', () => {
    let series = createTerminalTimeSeries({ windowMs: 10_000 });
    for (let second = 0; second <= 600; second += 1) {
      series = appendTerminalSample(series, { at: second * 1000, value: second });
    }
    // The window's 10 s plus the sample in force at its left edge.
    expect(series.samples.length).toBe(11);
    expect(series.samples[0]?.at).toBe(590_000);
    let capped = createTerminalTimeSeries({ windowMs: 10_000, maxSamples: 3 });
    for (let at = 0; at < 10; at += 1)
      capped = appendTerminalSample(capped, { at, value: at });
    expect(capped.samples.map(({ at }) => at)).toEqual([7, 8, 9]);
    expect(() => appendTerminalSample(capped, { at: 1, value: 1 })).toThrow(/time order/);
    expect(() => appendTerminalSample(capped, { at: 20, value: Number.NaN })).toThrow();
  });

  test('samples the value in force and keeps gaps as gaps', () => {
    let series = createTerminalTimeSeries({ windowMs: 4 });
    series = appendTerminalSample(series, { at: 1, value: 10 });
    series = appendTerminalSample(series, { at: 2, value: null });
    series = appendTerminalSample(series, { at: 3, value: 30 });
    expect(sampleTerminalTimeSeries(series, { now: 4, count: 5 })).toEqual([
      null,
      10,
      null,
      30,
      30,
    ]);
  });

  test('draws sparklines with gaps as spaces', () => {
    expect(terminalSparkline([0, 4, null, 8], { max: 8 })).toBe('▁▅ █');
  });

  test('places braille dots in Unicode dot order', () => {
    const chart = (values: (number | null)[]) =>
      terminalBrailleChart({
        series: [{ values, tone: 'accent' }],
        width: 1,
        height: 1,
        min: 0,
        max: 3,
      })
        .flat()
        .map(({ text }) => text)
        .join('');
    expect(chart([0, null])).toBe('⡀');
    expect(chart([null, 0])).toBe('⢀');
    expect(chart([3, null])).toBe('⠁');
    expect(chart([null, 3])).toBe('⠈');
    // A rise connects: the right column fills from the left point's level up.
    expect(chart([0, 3])).toBe('⣸');
  });

  test('colours a cell by the series drawn last and merges same-tone runs', () => {
    const rows = terminalBrailleChart({
      series: [
        { values: [1, 1, 1, 1], tone: 'success' },
        { values: [null, null, 1, 1], tone: 'danger' },
      ],
      width: 2,
      height: 1,
      min: 0,
      max: 1,
    });
    expect(rows[0]?.map(({ tone }) => tone)).toEqual(['success', 'danger']);
  });

  test('labels the time axis from the window to now', () => {
    expect(terminalTimeAxis(60_000, 20)).toBe('-1m     -30s     now');
    expect(terminalTimeAxis(60_000, 2)).toBe('no');
    expect(terminalTimeAxis(60_000, 0)).toBe('');
  });
});

describe('terminal tabs and palette', () => {
  test('moves with wrap, selects by digit, and keeps the selected tab across reconcile', () => {
    let tabs = createTerminalTabs([
      { id: 'proc', label: 'Processes' },
      { id: 'net', label: 'Network', badge: 2 },
    ]);
    tabs = reduceTerminalTabs(tabs, { type: 'move', delta: -1 });
    expect(tabs.selectedId).toBe('net');
    tabs = reduceTerminalTabs(tabs, { type: 'select-index', index: 7 });
    expect(tabs.selectedId).toBe('net');
    tabs = reduceTerminalTabs(tabs, { type: 'badge', id: 'net', badge: 5 });
    expect(selectedTerminalTab(tabs).badge).toBe(5);
    tabs = reduceTerminalTabs(tabs, {
      type: 'reconcile',
      tabs: [
        { id: 'net', label: 'Net' },
        { id: 'disk', label: 'Disk' },
      ],
    });
    expect(selectedTerminalTab(tabs)).toEqual({ id: 'net', label: 'Net', badge: null });
    tabs = reduceTerminalTabs(tabs, {
      type: 'reconcile',
      tabs: [{ id: 'disk', label: 'Disk' }],
    });
    expect(tabs.selectedId).toBe('disk');
    expect(() => reduceTerminalTabs(tabs, { type: 'badge', id: 'disk', badge: -1 })).toThrow();
  });

  test('resolves a palette per terminal background with overrides', () => {
    expect(resolveTerminalPalette('light').danger).toBe(terminalPalettes.light.danger);
    expect(resolveTerminalPalette('dark', { accent: '#000000' }).accent).toBe('#000000');
    expect(resolveTerminalPalette('dark', { accent: 'orange' }).accent).toBe('orange');
    expect(() => resolveTerminalPalette('dark', { accent: '' })).toThrow();
  });
});
