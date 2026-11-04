import { describe, expect, test } from 'bun:test';
import {
  createTerminalFocus,
  createTerminalForm,
  createTerminalList,
  createTerminalNavigation,
  createTerminalNotices,
  createTerminalTable,
  defineTerminalKeymap,
  fitTerminalKeyHints,
  fitTerminalText,
  formatTerminalDuration,
  layoutTerminalDetails,
  layoutTerminalMeterGrid,
  matchTerminalKey,
  matchTerminalSearch,
  nextTerminalNoticeExpiry,
  readTerminalForm,
  reduceTerminalFocus,
  reduceTerminalForm,
  reduceTerminalList,
  reduceTerminalNavigation,
  reduceTerminalNotices,
  reduceTerminalTable,
  sanitizeTerminalText,
  searchTerminalItems,
  selectedTerminalListItem,
  terminalBreadcrumbs,
  terminalFormFieldsFromJsonSchema,
  terminalHighlightRuns,
  terminalJsonLines,
  terminalLabelsRu,
  terminalProgress,
  terminalSpinnerFrame,
  terminalTabsKey,
  terminalTextWidth,
  terminalTimeAxis,
  truncateTerminalText,
  visibleTerminalListLines,
  wrapTerminalText,
} from '../src/core';

describe('terminal text', () => {
  test('strips escape sequences and control characters from foreign text', () => {
    expect(
      sanitizeTerminalText('a\u001b[31mred\u001b[0m\u001b]0;title\u0007b\u0000\tc\r\nd'),
    ).toBe('aredb  c\nd');
  });

  test('measures, cuts and pads by terminal cells', () => {
    expect(terminalTextWidth('日本ab')).toBe(6);
    expect(truncateTerminalText('日本語テキスト', 5)).toBe('日本…');
    expect(fitTerminalText('ok', 5, 'center')).toBe(' ok  ');
    expect(fitTerminalText('Методы поиска', 6)).toBe('Метод…');
  });

  test('wraps words, breaks long ones and keeps hanging indentation', () => {
    expect(wrapTerminalText('  one two three', 9)).toEqual(['  one two', '  three']);
    expect(wrapTerminalText('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
    expect(wrapTerminalText('a\n\nb', 5)).toEqual(['a', '', 'b']);
  });
});

describe('terminal search', () => {
  test('ranks substrings over scattered letters and word starts over middles', () => {
    const titles = ['my_docs', 'notes_put', 'docs_get', 'queue_state', 'd_o_c'];
    expect(
      searchTerminalItems(titles, 'doc', (title) => title).map(({ item }) => item),
    ).toEqual(['docs_get', 'my_docs', 'd_o_c']);
    expect(matchTerminalSearch('qst', 'queue_state')?.ranges).toEqual([
      [0, 1],
      [6, 8],
    ]);
    expect(matchTerminalSearch('zz', 'queue_state')).toBeNull();
  });

  test('requires every word and highlights each', () => {
    const match = matchTerminalSearch('get doc', 'docs_get');
    expect(match?.ranges).toEqual([
      [0, 3],
      [5, 8],
    ]);
    expect(
      terminalHighlightRuns('docs_get', match?.ranges ?? [])
        .map(({ text, highlighted }) => (highlighted ? `[${text}]` : text))
        .join(''),
    ).toBe('[doc]s_[get]');
    expect(matchTerminalSearch('get missing', 'docs_get')).toBeNull();
  });

  test('keeps input order for an empty query and equal scores', () => {
    expect(searchTerminalItems(['b', 'a'], ' ', (x) => x).map(({ item }) => item)).toEqual([
      'b',
      'a',
    ]);
  });
});

describe('terminal keymap', () => {
  const keymap = defineTerminalKeymap([
    { id: 'open', keys: ['return'], display: 'Enter', label: 'open', priority: 0 },
    {
      id: 'search',
      keys: ['/'],
      display: '/',
      label: 'search everything',
      short: 'search',
      priority: 1,
    },
    { id: 'quit', keys: ['c'], ctrl: true, display: 'Ctrl+C', label: 'quit', priority: 2 },
    { id: 'down', keys: ['down'], display: '↓', label: 'down', hidden: true },
  ]);

  test('matches by key name, typed character and modifier', () => {
    expect(matchTerminalKey(keymap, { name: 'return' })?.id).toBe('open');
    expect(matchTerminalKey(keymap, { name: 'slash', sequence: '/' })?.id).toBe('search');
    expect(matchTerminalKey(keymap, { name: 'c', ctrl: true })?.id).toBe('quit');
    expect(matchTerminalKey(keymap, { name: 'c' })).toBeNull();
  });

  test('fits the footer by shortening labels, then dropping the least important hints', () => {
    expect(fitTerminalKeyHints(keymap, 80)).toBe(
      'Enter open · / search everything · Ctrl+C quit',
    );
    expect(fitTerminalKeyHints(keymap, 40)).toBe('Enter open · / search · Ctrl+C quit');
    expect(fitTerminalKeyHints(keymap, 25)).toBe('Enter open · / search');
  });

  test('refuses a key bound twice', () => {
    expect(() =>
      defineTerminalKeymap([
        { id: 'a', keys: ['x'], display: 'x', label: 'a' },
        { id: 'b', keys: ['x'], display: 'x', label: 'b' },
      ]),
    ).toThrow(/bound to both a and b/);
  });

  test('tabs answer Tab, Shift-Tab and digits', () => {
    expect(terminalTabsKey({ name: 'tab' })).toEqual({ type: 'move', delta: 1 });
    expect(terminalTabsKey({ name: 'tab', shift: true })).toEqual({ type: 'move', delta: -1 });
    expect(terminalTabsKey({ name: '3', sequence: '3' })).toEqual({
      type: 'select-index',
      index: 2,
    });
  });
});

describe('terminal list', () => {
  const items = [
    { key: 'search', title: 'Search all methods' },
    { key: 'docs', title: 'docs_read', meta: 'content', section: 'content', badge: 3 },
    { key: 'tasks', title: 'repo_query_issues', section: 'software' },
    { key: 'off', title: 'disabled_method', section: 'software', disabled: true },
  ];
  const sections = [
    { id: 'software', title: 'Software' },
    { id: 'content', title: 'Content' },
  ];

  test('groups items under ordered section headings that are never selected', () => {
    let state = createTerminalList({ items, sections });
    expect(
      state.lines.map((line) =>
        line.kind === 'section' ? `#${line.title} ${line.count}` : line.key,
      ),
    ).toEqual(['search', '#Software 2', 'tasks', 'off', '#Content 1', 'docs']);
    state = reduceTerminalList(state, { type: 'move', delta: 1 });
    expect(selectedTerminalListItem(state)?.key).toBe('tasks');
    state = reduceTerminalList(state, { type: 'section', delta: 1 });
    expect(selectedTerminalListItem(state)?.key).toBe('docs');
    state = reduceTerminalList(state, { type: 'section', delta: -1 });
    expect(selectedTerminalListItem(state)?.key).toBe('tasks');
  });

  test('a query flattens sections, ranks matches and selects the best', () => {
    let state = createTerminalList({ items, sections, selectedKey: 'search' });
    state = reduceTerminalList(state, { type: 'query', query: 'doc' });
    expect(state.lines.map(({ key }) => key)).toEqual(['docs']);
    expect(selectedTerminalListItem(state)?.key).toBe('docs');
    const line = state.lines[0];
    expect(line?.kind === 'item' ? line.titleRanges : null).toEqual([[0, 3]]);
  });

  test('multi-select picks and forgets keys that left the items', () => {
    let state = createTerminalList({ items, multiple: true });
    state = reduceTerminalList(state, { type: 'pick-all', picked: true });
    expect([...state.picked].sort()).toEqual(['docs', 'search', 'tasks']);
    state = reduceTerminalList(state, { type: 'items', items: items.slice(0, 2) });
    expect([...state.picked].sort()).toEqual(['docs', 'search']);
  });

  test('the window follows the selection and counts what is off screen', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      key: `k${index}`,
      title: `item ${index}`,
    }));
    let state = createTerminalList({ items: many });
    state = reduceTerminalList(state, { type: 'select', key: 'k20' });
    const window = visibleTerminalListLines(state, 5);
    expect(window.lines.map(({ key }) => key)).toContain('k20');
    expect(window.above + window.lines.length + window.below).toBe(30);
  });
});

describe('terminal form', () => {
  const schema = {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project id' },
      limit: { type: 'integer', default: 20 },
      status: { type: 'string', enum: ['inbox', 'done'] },
      dryRun: { type: 'boolean' },
      filter: { type: ['object', 'null'] },
      token: { type: 'string', format: 'password' },
    },
    required: ['project', 'status'],
  };

  test('reads JSON Schema into typed fields', () => {
    expect(
      terminalFormFieldsFromJsonSchema(schema).map(
        ({ name, kind, required }) => `${name}:${kind}:${required}`,
      ),
    ).toEqual([
      'project:text:true',
      'limit:integer:false',
      'status:choice:true',
      'dryRun:boolean:false',
      'filter:json:false',
      'token:secret:false',
    ]);
  });

  test('submits typed values and reports every bad field in the product language', () => {
    let state = createTerminalForm(terminalFormFieldsFromJsonSchema(schema));
    state = reduceTerminalForm(state, { type: 'submit' }, terminalLabelsRu.form);
    expect(state.errors).toEqual({
      project: 'Обязательное поле',
      status: 'Обязательное поле',
    });
    expect(state.focus).toBe(0);
    state = reduceTerminalForm(state, { type: 'set', name: 'project', text: 'base' });
    state = reduceTerminalForm(state, { type: 'cycle', name: 'status', delta: 1 });
    state = reduceTerminalForm(state, { type: 'cycle', name: 'dryRun', delta: 1 });
    state = reduceTerminalForm(state, { type: 'set', name: 'filter', text: '{"a":1}' });
    expect(readTerminalForm(state)).toEqual({
      ok: true,
      values: { project: 'base', limit: 20, status: 'inbox', dryRun: true, filter: { a: 1 } },
    });
    state = reduceTerminalForm(state, { type: 'set', name: 'limit', text: '2.5' });
    expect(readTerminalForm(state)).toEqual({
      ok: false,
      errors: { limit: 'Expected a whole number' },
    });
  });

  test('shows a field error once the reader leaves it', () => {
    let state = createTerminalForm([
      { name: 'a', label: 'A', kind: 'number' },
      { name: 'b', label: 'B', kind: 'text' },
    ]);
    state = reduceTerminalForm(state, { type: 'set', text: 'x' });
    expect(state.errors).toEqual({});
    state = reduceTerminalForm(state, { type: 'move', delta: 1 });
    expect(state.errors).toEqual({ a: 'Expected a number' });
  });
});

describe('terminal navigation, notices, focus and progress', () => {
  test('navigation keeps each level state and never pops the root', () => {
    let nav = createTerminalNavigation({
      id: 'home',
      label: 'Home',
      state: { selected: 'b' },
    });
    nav = reduceTerminalNavigation(nav, {
      type: 'push',
      entry: { id: 'm', label: 'Methods', state: { selected: 'x' } },
    });
    expect(terminalBreadcrumbs(nav)).toEqual(['Home', 'Methods']);
    nav = reduceTerminalNavigation(nav, { type: 'pop' });
    nav = reduceTerminalNavigation(nav, { type: 'pop' });
    expect(nav.stack).toEqual([{ id: 'home', label: 'Home', state: { selected: 'b' } }]);
  });

  test('notices expire on the clock they are given and replace by id', () => {
    let notices = createTerminalNotices(2);
    notices = reduceTerminalNotices(notices, {
      type: 'push',
      notice: { id: 'a', text: 'one', at: 0 },
    });
    notices = reduceTerminalNotices(notices, {
      type: 'push',
      notice: { id: 'b', text: 'two', at: 1000, ttlMs: null },
    });
    notices = reduceTerminalNotices(notices, {
      type: 'push',
      notice: { id: 'a', text: 'again', at: 2000 },
    });
    expect(notices.notices.map(({ text }) => text)).toEqual(['two', 'again']);
    expect(nextTerminalNoticeExpiry(notices)).toBe(6000);
    notices = reduceTerminalNotices(notices, { type: 'expire', now: 6000 });
    expect(notices.notices.map(({ id }) => id)).toEqual(['b']);
  });

  test('a layer takes focus and gives it back', () => {
    let focus = createTerminalFocus(['list', 'detail']);
    focus = reduceTerminalFocus(focus, { type: 'move', delta: 1 });
    focus = reduceTerminalFocus(focus, { type: 'open-layer', id: 'dialog' });
    expect(focus.focused).toBe('dialog');
    expect(reduceTerminalFocus(focus, { type: 'move', delta: 1 }).focused).toBe('dialog');
    focus = reduceTerminalFocus(focus, { type: 'close-layer' });
    expect(focus.focused).toBe('detail');
  });

  test('progress reports only what it can know', () => {
    expect(terminalProgress({ done: 50, total: 200, startedAt: 0, now: 10_000 })).toEqual({
      ratio: 0.25,
      elapsedMs: 10_000,
      rate: 5,
      etaMs: 30_000,
    });
    expect(terminalProgress({ done: null, total: null, startedAt: 0, now: 5 })).toMatchObject({
      ratio: null,
      etaMs: null,
    });
    expect(terminalSpinnerFrame('line', 250)).toBe('|');
    expect(formatTerminalDuration(185_000)).toBe('3m 05s');
  });
});

describe('terminal JSON and details', () => {
  test('prints JSON as toned lines and neutralises escapes in strings', () => {
    const lines = terminalJsonLines({ ok: true, items: [1, 'x\u001b[2J'], empty: {} });
    expect(lines.map((line) => line.map(({ text }) => text).join(''))).toEqual([
      '{',
      '  "ok": true,',
      '  "items": [',
      '    1,',
      '    "x\\u001b[2J"',
      '  ],',
      '  "empty": {}',
      '}',
    ]);
    expect(lines[1]?.map(({ tone }) => tone)).toEqual([
      'muted',
      'accent',
      'muted',
      'accent',
      'muted',
    ]);
  });

  test('aligns detail keys and cuts values to the width', () => {
    expect(
      layoutTerminalDetails(
        [
          { key: 'id', value: 'abc' },
          { key: 'status', value: 'x'.repeat(40) },
        ],
        20,
      ),
    ).toEqual([
      { key: 'id      ', value: 'abc', tone: 'primary' },
      { key: 'status  ', value: 'xxxxxxxxxxx…', tone: 'primary' },
    ]);
  });
});

describe('review regressions', () => {
  test('emoji, joined emoji and marks take the cells a terminal gives them', () => {
    expect(terminalTextWidth('🚀')).toBe(2);
    expect(terminalTextWidth('✅ ok')).toBe(5);
    expect(terminalTextWidth('👨‍👩‍👧')).toBe(2);
    expect(terminalTextWidth('é')).toBe(1);
    expect(truncateTerminalText('👨‍👩‍👧👨‍👩‍👧x', 3)).toBe('👨‍👩‍👧…');
  });

  test('sanitizing removes charset, keypad, C1 and unterminated string sequences', () => {
    expect(sanitizeTerminalText('a\u001b(B\u001b[mb\u001b7c\u009b31md')).toBe('abcd');
    expect(sanitizeTerminalText('x\u001b]0;evil title')).toBe('x');
    expect(sanitizeTerminalText('p\u001bPq#0;1\u001b\\q\u009dt\u0007r')).toBe('pqr');
    expect(sanitizeTerminalText('end\u001b')).toBe('end');
  });

  test('wrapping keeps a deep indent on its line and never starts with an empty one', () => {
    expect(wrapTerminalText('     hello', 10)).toEqual(['     hello']);
    expect(wrapTerminalText(`${' '.repeat(10)}hello`, 20)).toEqual([`${' '.repeat(10)}hello`]);
    expect(wrapTerminalText('中文', 1)).toEqual(['中', '文']);
  });

  test('search highlights stay on the original characters after case folding', () => {
    expect(matchTerminalSearch('x', 'İstanbul x')?.ranges).toEqual([[9, 10]]);
  });

  test('new list data during a search keeps the reader on their item', () => {
    const items = ['a1', 'a2', 'a3'].map((key) => ({ key, title: key }));
    let state = createTerminalList({ items });
    state = reduceTerminalList(state, { type: 'query', query: 'a' });
    state = reduceTerminalList(state, { type: 'select', key: 'a3' });
    state = reduceTerminalList(state, { type: 'items', items });
    expect(selectedTerminalListItem(state)?.key).toBe('a3');
  });

  test('closing a layer never returns focus to a widget that left the ring', () => {
    let focus = createTerminalFocus(['a', 'b']);
    focus = reduceTerminalFocus(focus, { type: 'open-layer', id: 'dialog' });
    focus = reduceTerminalFocus(focus, { type: 'order', order: ['b'] });
    focus = reduceTerminalFocus(focus, { type: 'close-layer' });
    expect(focus.focused).toBe('b');
  });

  test('a filtered table ignores collapse and draws no open mark without visible children', () => {
    const columns = [{ id: 'name', title: 'NAME', kind: 'text' as const, width: 10 }];
    let table = createTerminalTable({
      columns,
      rows: [
        { key: 'p', cells: { name: 'parent match' } },
        { key: 'c', parentKey: 'p', cells: { name: 'child' } },
      ],
      capacity: 5,
      expanded: ['p'],
    });
    table = reduceTerminalTable(table, { type: 'filter', query: 'match' });
    expect(table.view.map(({ row, expanded }) => [row.key, expanded])).toEqual([['p', false]]);
    table = reduceTerminalTable(table, { type: 'collapse', key: 'p' });
    table = reduceTerminalTable(table, { type: 'filter', query: '' });
    expect(table.expanded.has('p')).toBe(true);
  });

  test('a meter grid declares only the columns it fills', () => {
    expect(layoutTerminalMeterGrid({ count: 5, width: 100, minMeterWidth: 20 })).toMatchObject(
      {
        columns: 3,
        rows: 2,
      },
    );
  });

  test('JSON Schema enums with null or numbers are choices that read back as values', () => {
    const fields = terminalFormFieldsFromJsonSchema({
      properties: {
        mode: { type: ['string', 'null'], enum: ['a', 'b', null] },
        level: { enum: [1, 2] },
        any: true,
      },
    });
    expect(fields.map(({ kind }) => kind)).toEqual(['choice', 'choice', 'json']);
    let form = createTerminalForm(fields);
    form = reduceTerminalForm(form, { type: 'cycle', name: 'level', delta: 2 });
    expect(readTerminalForm(form)).toEqual({ ok: true, values: { level: 2 } });
  });

  test('numbers are read in decimal notation only', () => {
    const read = (text: string) =>
      readTerminalForm(
        reduceTerminalForm(createTerminalForm([{ name: 'n', label: 'N', kind: 'number' }]), {
          type: 'set',
          text,
        }),
      );
    expect(read(' -2.5e3 ')).toEqual({ ok: true, values: { n: -2500 } });
    for (const text of ['0x10', '0b1', 'Infinity', '1,5']) expect(read(text).ok).toBe(false);
  });

  test('a binding without shift conflicts with the shifted one and hints never overflow', () => {
    expect(() =>
      defineTerminalKeymap([
        { id: 'a', keys: ['tab'], display: 'Tab', label: 'a' },
        { id: 'b', keys: ['tab'], shift: true, display: '⇧Tab', label: 'b' },
      ]),
    ).toThrow(/shift\+tab/);
    const one = defineTerminalKeymap([{ id: 'a', keys: ['x'], display: '↑↓', label: 'move' }]);
    expect(terminalTextWidth(fitTerminalKeyHints(one, 4))).toBeLessThanOrEqual(4);
  });

  test('details align wide keys by cells and JSON survives cycles and dates', () => {
    const [pair] = layoutTerminalDetails([{ key: '名前', value: 'x' }], 30);
    expect(terminalTextWidth(pair?.key ?? '')).toBe(6);
    const cyclic: Record<string, unknown> = { at: new Date(0) };
    cyclic.self = cyclic;
    expect(
      terminalJsonLines(cyclic).map((line) => line.map(({ text }) => text).join('')),
    ).toEqual(['{', '  "at": "1970-01-01T00:00:00.000Z",', '  "self": [Circular]', '}']);
  });

  test('the time axis labels a fractional middle', () => {
    expect(terminalTimeAxis(3000, 30)).toContain('-1.5s');
  });
});
