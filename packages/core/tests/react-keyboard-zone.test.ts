/**
 * Zones: where a move lands, what a key means, and what the controller does
 * with it — driven without a DOM.
 */
import { describe, expect, test } from 'bun:test';
import { KEY_FIELD_SELECTOR } from '../src/react/keyboard/layers';
import {
  createNavZone,
  type NavZoneOptions,
  nextZoneIndex,
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
