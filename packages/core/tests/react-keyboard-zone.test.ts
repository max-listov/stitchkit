/**
 * Zones: where a move lands, what a key means, and what the controller does
 * with it — driven without a DOM.
 */
import { describe, expect, test } from 'bun:test';
import { KEY_FIELD_SELECTOR } from '../src/react/keyboard/layers';
import {
  createNavZone,
  type FocusZoneOptions,
  type NavZoneOptions,
  nextZoneIndex,
  resolveZoneIndex,
  ZONE_ATTRIBUTE,
  type ZoneKeyEvent,
  zoneIntent,
} from '../src/react/keyboard/zone';

class FakeNode extends EventTarget {
  focusedTimes = 0;
  scrolled = 0;
  constructor(
    readonly parent: FakeNode | null = null,
    readonly marks: ReadonlySet<string> = new Set(),
  ) {
    super();
  }
  closest(selectors: string): FakeNode | null {
    for (let node: FakeNode | null = this; node !== null; node = node.parent) {
      if (node.marks.has(selectors)) return node;
    }
    return null;
  }
  focus(): void {
    this.focusedTimes += 1;
  }
  scrollIntoView(): void {
    this.scrolled += 1;
  }
}

const ZONE_MARK = `[${ZONE_ATTRIBUTE}]`;

function key(
  name: string,
  target: EventTarget | null,
  modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {},
): ZoneKeyEvent & { defaultPrevented: boolean } {
  return {
    key: name,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    target,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function setup(overrides: Partial<NavZoneOptions<string>> = {}) {
  const changes: string[] = [];
  const zoneElement = new FakeNode(null, new Set([ZONE_MARK]));
  const items = ['a', 'b', 'c'];
  const elements = new Map(items.map((id) => [id, new FakeNode(zoneElement)]));
  let options: NavZoneOptions<string> = {
    items,
    value: 'a',
    onChange: (id, cause) => {
      changes.push(`${id}:${cause}`);
      // The page answers a change by rendering the new value.
      options = { ...options, value: id };
      zone.update(options);
    },
    ...overrides,
  };
  const zone = createNavZone(options);
  for (const [id, element] of elements) zone.setItemElement(id, element);
  const inside = (id: string) => elements.get(id) ?? zoneElement;
  const press = (name: string, from = inside(zone.current() ?? 'a')) => {
    const event = key(name, from);
    const taken = zone.keyDown(event, zoneElement);
    expect(event.defaultPrevented).toBe(taken);
    return taken;
  };
  return { zone, changes, elements, zoneElement, press, inside };
}

describe('nextZoneIndex', () => {
  test('moves by one, jumps to the ends, and reports the end it ran past', () => {
    const at = (index: number, move: 'next' | 'previous' | 'first' | 'last', loop = false) =>
      nextZoneIndex({ length: 3, index, move, loop });
    expect(at(0, 'next')).toBe(1);
    expect(at(1, 'previous')).toBe(0);
    expect(at(1, 'first')).toBe(0);
    expect(at(0, 'last')).toBe(2);
    expect(at(2, 'next')).toBe('after-end');
    expect(at(0, 'previous')).toBe('before-start');
    expect(at(-1, 'next')).toBe(0);
    expect(at(-1, 'previous')).toBe(2);
    expect(nextZoneIndex({ length: 0, index: -1, move: 'next', loop: true })).toBe(
      'after-end',
    );
    expect(nextZoneIndex({ length: 0, index: -1, move: 'first', loop: false })).toBe(
      'before-start',
    );
  });

  test('a looping zone wraps past either end', () => {
    expect(nextZoneIndex({ length: 3, index: 2, move: 'next', loop: true })).toBe(0);
    expect(nextZoneIndex({ length: 3, index: 0, move: 'previous', loop: true })).toBe(2);
  });
});

describe('zoneIntent', () => {
  test('the main axis moves, the cross axis enters and exits, by orientation', () => {
    const intent = (name: string, orientation: 'vertical' | 'horizontal') =>
      zoneIntent(key(name, null), orientation);
    expect(intent('ArrowDown', 'vertical')).toEqual({ type: 'move', move: 'next' });
    expect(intent('ArrowUp', 'vertical')).toEqual({ type: 'move', move: 'previous' });
    expect(intent('ArrowRight', 'vertical')).toEqual({ type: 'enter' });
    expect(intent('ArrowLeft', 'vertical')).toEqual({ type: 'exit' });
    expect(intent('ArrowRight', 'horizontal')).toEqual({ type: 'move', move: 'next' });
    expect(intent('ArrowLeft', 'horizontal')).toEqual({ type: 'move', move: 'previous' });
    expect(intent('ArrowDown', 'horizontal')).toEqual({ type: 'enter' });
    expect(intent('ArrowUp', 'horizontal')).toEqual({ type: 'exit' });
    expect(intent('Home', 'vertical')).toEqual({ type: 'move', move: 'first' });
    expect(intent('End', 'horizontal')).toEqual({ type: 'move', move: 'last' });
    expect(intent('Enter', 'vertical')).toEqual({ type: 'confirm' });
    expect(intent('a', 'vertical')).toBeNull();
  });

  test('a key with a modifier is left to the page', () => {
    const modifiers: readonly ('altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey')[] = [
      'altKey',
      'ctrlKey',
      'metaKey',
      'shiftKey',
    ];
    for (const modifier of modifiers) {
      expect(zoneIntent(key('ArrowDown', null, { [modifier]: true }), 'vertical')).toBeNull();
    }
  });
});

describe('a zone', () => {
  test('in select mode an arrow moves focus and chooses the item', () => {
    const { press, changes, elements, zone } = setup();
    expect(press('ArrowDown')).toBe(true);
    expect(changes).toEqual(['b:arrow']);
    expect(elements.get('b')?.focusedTimes).toBe(1);
    expect(elements.get('b')?.scrolled).toBe(1);
    expect(zone.current()).toBe('b');
  });

  test('in highlight mode an arrow only moves focus, and Enter chooses', () => {
    const { press, changes, zone } = setup({ mode: 'highlight' });
    press('ArrowDown');
    press('ArrowDown');
    expect(changes).toEqual([]);
    expect(zone.current()).toBe('c');
    expect(press('Enter')).toBe(true);
    expect(changes).toEqual(['c:confirm']);
  });

  test('past the last item a zone hands the key to onBoundary, or leaves it', () => {
    const sides: string[] = [];
    const { press } = setup({ value: 'c', onBoundary: (side) => sides.push(side) });
    expect(press('ArrowDown')).toBe(true);
    expect(sides).toEqual(['end']);
    const bare = setup({ value: 'c' });
    expect(bare.press('ArrowDown')).toBe(false);
    const declined = setup({ value: 'a', onBoundary: () => false });
    expect(declined.press('ArrowUp')).toBe(false);
  });

  test('a looping zone wraps instead of reaching a boundary', () => {
    const { press, changes } = setup({ value: 'c', loop: true, onBoundary: () => true });
    press('ArrowDown');
    expect(changes).toEqual(['a:arrow']);
  });

  test('the cross axis calls onEnter with the current item and onExit, horizontal too', () => {
    const calls: string[] = [];
    const { press } = setup({
      onEnter: (id) => calls.push(`enter:${id}`),
      onExit: () => calls.push('exit'),
    });
    expect(press('ArrowRight')).toBe(true);
    expect(press('ArrowLeft')).toBe(true);
    expect(press('Enter')).toBe(true);
    expect(calls).toEqual(['enter:a', 'exit', 'enter:a']);
    const flat = setup({
      orientation: 'horizontal',
      onEnter: (id) => calls.push(`down:${id}`),
    });
    expect(flat.press('ArrowRight')).toBe(true);
    expect(flat.changes).toEqual(['b:arrow']);
    expect(flat.press('ArrowDown')).toBe(true);
    expect(calls.at(-1)).toBe('down:b');
    const none = setup();
    expect(none.press('ArrowRight')).toBe(false);
    expect(none.press('Enter')).toBe(false);
  });

  test('the tab stop is the pointed item, else the chosen one, else the first — of the listed items', () => {
    const { zone } = setup({ value: 'b' });
    expect(zone.current()).toBe('b');
    zone.focused('c');
    expect(zone.current()).toBe('c');
    zone.focused('stranger');
    expect(zone.current()).toBe('c');
    // A new value from the page — a back button, a click elsewhere — takes over.
    zone.update({ ...zone.options, value: 'a' });
    expect(zone.current()).toBe('a');
    zone.update({ ...zone.options, items: ['x', 'y'], value: 'gone' });
    expect(zone.current()).toBe('x');
    zone.update({ ...zone.options, items: [], value: null });
    expect(zone.current()).toBeNull();
    expect(zone.focus()).toBe(false);
  });

  test('a key from a field inside the zone, from a nested zone, or already taken is left alone', () => {
    const { zone, zoneElement, changes } = setup();
    const input = new FakeNode(zoneElement, new Set([KEY_FIELD_SELECTOR]));
    expect(zone.keyDown(key('ArrowDown', input), zoneElement)).toBe(false);
    const nested = new FakeNode(new FakeNode(zoneElement, new Set([ZONE_MARK])));
    expect(zone.keyDown(key('ArrowDown', nested), zoneElement)).toBe(false);
    const taken = key('ArrowDown', new FakeNode(zoneElement));
    taken.preventDefault();
    expect(zone.keyDown(taken, zoneElement)).toBe(false);
    expect(changes).toEqual([]);
  });

  test('from outside every zone an arrow on the axis focuses the current item without moving', () => {
    const { zone, elements, changes } = setup({ value: 'b' });
    expect(zone.keyFromOutside(key('ArrowDown', new FakeNode()))).toBe(true);
    expect(elements.get('b')?.focusedTimes).toBe(1);
    expect(changes).toEqual([]);
    expect(zone.keyFromOutside(key('ArrowRight', new FakeNode()))).toBe(false);
    expect(zone.keyFromOutside(key('Home', new FakeNode()))).toBe(false);
    const inAnotherZone = new FakeNode(new FakeNode(null, new Set([ZONE_MARK])));
    expect(zone.keyFromOutside(key('ArrowDown', inAnotherZone))).toBe(false);
  });

  test('an item without an element is revealed, and focused the moment its element mounts', () => {
    const revealed: string[] = [];
    const { press, zone, elements } = setup({ onReveal: (id) => revealed.push(id) });
    const far = elements.get('c');
    zone.setItemElement('c', null);
    expect(press('End')).toBe(true);
    expect(revealed).toEqual(['c']);
    expect(zone.current()).toBe('c');
    expect(far?.focusedTimes).toBe(0);
    if (far) zone.setItemElement('c', far);
    expect(far?.focusedTimes).toBe(1);
    // Mounting again later does not pull focus back.
    zone.setItemElement('c', null);
    if (far) zone.setItemElement('c', far);
    expect(far?.focusedTimes).toBe(1);
  });

  test('focus given elsewhere cancels a focus still waiting for its element', () => {
    const { press, zone, elements } = setup();
    const far = elements.get('c');
    zone.setItemElement('c', null);
    press('End');
    zone.focused('a');
    if (far) zone.setItemElement('c', far);
    expect(far?.focusedTimes).toBe(0);
  });

  test('subscribers hear the pointed item change, and only when it does', () => {
    const { zone } = setup({ mode: 'highlight' });
    let heard = 0;
    const stop = zone.subscribe(() => {
      heard += 1;
    });
    zone.focused('b');
    zone.focused('b');
    expect(heard).toBe(1);
    stop();
    zone.focused('c');
    expect(heard).toBe(1);
  });
});

/** A zone of links or buttons that choose for themselves: three items, no `onChange`. */
function focusSetup(overrides: Partial<FocusZoneOptions<string>> = {}) {
  const zoneElement = new FakeNode(null, new Set([ZONE_MARK]));
  const items = ['a', 'b', 'c'];
  const elements = new Map(items.map((id) => [id, new FakeNode(zoneElement)]));
  const zone = createNavZone<string>({ items, mode: 'focus', ...overrides });
  for (const [id, element] of elements) zone.setItemElement(id, element);
  const press = (name: string, from: FakeNode | null = elements.get('a') ?? null) => {
    const event = key(name, from);
    const taken = zone.keyDown(event, zoneElement);
    return { taken, event };
  };
  return { zone, elements, zoneElement, press };
}

describe('a zone in focus mode', () => {
  test('arrows move focus and report nothing; Enter is left to the focused element', () => {
    const { zone, elements, press } = focusSetup();
    expect(press('ArrowDown').taken).toBe(true);
    expect(elements.get('b')?.focusedTimes).toBe(1);
    expect(zone.current()).toBe('b');

    const enter = press('Enter', elements.get('b') ?? null);
    expect(enter.taken).toBe(false);
    // The key is the element's: nothing prevented, so a button clicks and a link follows.
    expect(enter.event.defaultPrevented).toBe(false);
  });

  test('Enter stays with the element even when the zone has an onEnter for the cross axis', () => {
    const entered: string[] = [];
    const { press, elements } = focusSetup({ onEnter: (id) => entered.push(id) });
    expect(press('Enter', elements.get('a') ?? null).taken).toBe(false);
    expect(entered).toEqual([]);
    // The cross-axis key still goes in.
    expect(press('ArrowRight').taken).toBe(true);
    expect(entered).toEqual(['a']);
  });

  test('select and highlight modes keep their Enter', () => {
    const select = setup();
    expect(select.press('Enter')).toBe(false);
    const highlight = setup({ mode: 'highlight' });
    expect(highlight.press('Enter')).toBe(true);
    expect(highlight.changes).toEqual(['a:confirm']);
  });
});

describe('a key the application is using itself', () => {
  test('inside the zone, ignore leaves the key whole: no move, not taken, not prevented', () => {
    const asked: string[] = [];
    const dragging = new Set<FakeNode>();
    const { zone, elements, press } = focusSetup({
      ignore: (event) => {
        asked.push(event.key);
        return event.target instanceof FakeNode && dragging.has(event.target);
      },
    });
    const row = elements.get('a');
    if (row) dragging.add(row);

    const ignored = press('ArrowDown', row ?? null);
    expect(ignored.taken).toBe(false);
    expect(ignored.event.defaultPrevented).toBe(false);
    expect(elements.get('b')?.focusedTimes).toBe(0);
    expect(zone.current()).toBe('a');
    expect(asked).toEqual(['ArrowDown']);

    // The same key from another item is the zone's.
    expect(press('ArrowDown', elements.get('c') ?? null).taken).toBe(true);
  });

  test('outside every zone, an ignored arrow does not pull focus into the zone', () => {
    const page = new FakeNode();
    let ignoring = true;
    const { zone, elements } = focusSetup({ ignore: () => ignoring });
    expect(zone.keyFromOutside(key('ArrowDown', page))).toBe(false);
    expect(elements.get('a')?.focusedTimes).toBe(0);
    ignoring = false;
    expect(zone.keyFromOutside(key('ArrowDown', page))).toBe(true);
    expect(elements.get('a')?.focusedTimes).toBe(1);
  });

  test('a key the zone would not act on is never put to ignore', () => {
    const asked: string[] = [];
    const { press } = focusSetup({
      ignore: (event) => {
        asked.push(event.key);
        return false;
      },
    });
    press('x');
    expect(asked).toEqual([]);
  });
});

describe('a zone follows committed options only', () => {
  test('a new value takes the pointed item back to the chosen one, and subscribers hear it', () => {
    const { zone } = setup({ value: 'a' });
    zone.focused('c');
    let heard = 0;
    zone.subscribe(() => {
      heard += 1;
    });
    zone.update({ ...zone.options, value: 'b' });
    expect(heard).toBe(1);
    expect(zone.pointedItem()).toBeNull();
    expect(zone.current()).toBe('b');
    // The same value again is not news.
    zone.update({ ...zone.options });
    expect(heard).toBe(1);
  });

  test('pointedItem is the raw pointing, whatever the list holds', () => {
    const { zone } = setup({ value: 'a' });
    expect(zone.pointedItem()).toBeNull();
    zone.focused('b');
    expect(zone.pointedItem()).toBe('b');
    // An id the zone does not list is not an item, and the pointing does not move to it.
    zone.focused('stranger');
    expect(zone.pointedItem()).toBe('b');
  });
});

describe('resolveZoneIndex', () => {
  test('the pointed item, else the chosen one, else the first — an index, one scan when pointed', () => {
    const items = ['a', 'b', 'c'];
    expect(resolveZoneIndex(items, 'b', 'c')).toBe(2);
    expect(resolveZoneIndex(items, 'b', null)).toBe(1);
    expect(resolveZoneIndex(items, null, null)).toBe(0);
    expect(resolveZoneIndex(items, 'gone', 'stranger')).toBe(0);
    expect(resolveZoneIndex([], null, null)).toBe(-1);
    expect(resolveZoneIndex([], 'a', 'b')).toBe(-1);
  });
});

describe('focus on the zone element itself', () => {
  test('the first arrow in either direction lands on the current item, not one step from it', () => {
    const { zone, elements, zoneElement } = focusSetup({ items: ['a', 'b', 'c'] });
    const next = key('ArrowDown', zoneElement);
    expect(zone.keyDown(next, zoneElement)).toBe(true);
    expect(next.defaultPrevented).toBe(true);
    expect(elements.get('a')?.focusedTimes).toBe(1);
    expect(elements.get('b')?.focusedTimes).toBe(0);

    // Now on an item, the same key moves.
    expect(zone.keyDown(key('ArrowDown', elements.get('a') ?? null), zoneElement)).toBe(true);
    expect(elements.get('b')?.focusedTimes).toBe(1);

    const {
      zone: other,
      elements: others,
      zoneElement: container,
    } = focusSetup({ value: 'c' });
    expect(other.keyDown(key('ArrowUp', container), container)).toBe(true);
    expect(others.get('c')?.focusedTimes).toBe(1);
    expect(others.get('b')?.focusedTimes).toBe(0);
  });

  test('Home, End and the cross axis keep their meaning there', () => {
    const { zone, elements, zoneElement } = focusSetup();
    expect(zone.keyDown(key('End', zoneElement), zoneElement)).toBe(true);
    expect(elements.get('c')?.focusedTimes).toBe(1);
  });

  test('an empty zone has nowhere to land and leaves the key', () => {
    const { zone, zoneElement } = focusSetup({ items: [] });
    expect(zone.keyDown(key('ArrowDown', zoneElement), zoneElement)).toBe(false);
  });
});

describe('the first arrow from outside every zone', () => {
  const page = new FakeNode();

  test('by default it puts focus on the current item and changes nothing', () => {
    const { zone, elements, changes } = setup({ value: 'b' });
    expect(zone.keyFromOutside(key('ArrowDown', page))).toBe(true);
    expect(elements.get('b')?.focusedTimes).toBe(1);
    expect(elements.get('c')?.focusedTimes).toBe(0);
    expect(changes).toEqual([]);
  });

  test("with outside: 'move' it moves from the current item, and in select mode chooses the neighbour", () => {
    const { zone, elements, changes } = setup({ value: 'a', outside: 'move' });
    expect(zone.keyFromOutside(key('ArrowDown', page))).toBe(true);
    expect(elements.get('b')?.focusedTimes).toBe(1);
    expect(elements.get('a')?.focusedTimes).toBe(0);
    expect(changes).toEqual(['b:arrow']);
  });

  test("outside: 'move' goes the other way on the up arrow, and meets the edge like a key inside", () => {
    const edges: string[] = [];
    const { zone, elements } = setup({
      value: 'a',
      outside: 'move',
      onBoundary: (side) => {
        edges.push(side);
      },
    });
    expect(zone.keyFromOutside(key('ArrowUp', page))).toBe(true);
    expect(edges).toEqual(['start']);
    expect(elements.get('a')?.focusedTimes).toBe(0);

    const none = setup({ value: 'a', outside: 'move' });
    // No boundary handler: the key is not taken, so the page keeps it.
    expect(none.zone.keyFromOutside(key('ArrowUp', page))).toBe(false);
  });

  test("outside: 'move' in a focus zone moves focus and reports nothing; sideways keys stay the page's", () => {
    const { zone, elements } = focusSetup({ outside: 'move' });
    expect(zone.keyFromOutside(key('ArrowDown', page))).toBe(true);
    expect(elements.get('b')?.focusedTimes).toBe(1);
    expect(zone.keyFromOutside(key('ArrowRight', page))).toBe(false);
    expect(zone.keyFromOutside(key('Enter', page))).toBe(false);
  });

  test("outside: 'move' still asks ignore first", () => {
    const { zone, elements } = focusSetup({ outside: 'move', ignore: () => true });
    expect(zone.keyFromOutside(key('ArrowDown', page))).toBe(false);
    expect(elements.get('b')?.focusedTimes).toBe(0);
  });
});

describe('an area that contains the zone keeps its own keys without switching the zone off', () => {
  const FIELD = new Set([KEY_FIELD_SELECTOR]);

  function panelled(marks: { panel?: boolean; zone?: boolean } = {}) {
    const panel = new FakeNode(null, marks.panel === false ? new Set() : FIELD);
    const zoneElement = new FakeNode(
      panel,
      marks.zone === true ? new Set([ZONE_MARK, KEY_FIELD_SELECTOR]) : new Set([ZONE_MARK]),
    );
    const items = ['a', 'b', 'c'];
    const rows = new Map(items.map((id) => [id, new FakeNode(zoneElement)]));
    const zone = createNavZone<string>({ items, mode: 'focus' });
    for (const [id, row] of rows) zone.setItemElement(id, row);
    return { panel, zoneElement, rows, zone };
  }

  test('a panel marked data-local-keys around the zone leaves the zone its arrows', () => {
    const { zone, zoneElement, rows } = panelled();
    const event = key('ArrowDown', rows.get('a') ?? null);
    expect(zone.keyDown(event, zoneElement)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(rows.get('b')?.focusedTimes).toBe(1);
  });

  test('the zone element carrying the mark itself does not switch it off either', () => {
    const { zone, zoneElement, rows } = panelled({ panel: false, zone: true });
    expect(zone.keyDown(key('ArrowDown', rows.get('a') ?? null), zoneElement)).toBe(true);
    expect(rows.get('b')?.focusedTimes).toBe(1);
  });

  test('a field inside one of its rows still keeps its keys, in a marked panel too', () => {
    const { zone, zoneElement, rows } = panelled();
    const row = rows.get('a');
    const input = new FakeNode(row ?? null, FIELD);
    const event = key('ArrowDown', input);
    expect(zone.keyDown(event, zoneElement)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
