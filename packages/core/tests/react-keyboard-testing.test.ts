/**
 * The keyboard test bed, used the way a consumer's test uses it: through the
 * public entrypoint, with no DOM and no React.
 */
import { describe, expect, test } from 'bun:test';
import {
  createKeyboardTestBed,
  createNavZone,
  type KeyLayerState,
  type TestElement,
  type TestKeyEvent,
} from '../src/entrypoints/react/keyboard/testing';

type Layer = KeyLayerState<TestKeyEvent, TestElement>;

function listener(heard: string[], name: string, takes: boolean): Layer['onKey'] {
  return (event) => {
    heard.push(`${name}:${event.key}`);
    return takes;
  };
}

describe('the keyboard test bed: layers', () => {
  test('layers are asked overlay, local, route, zone, global, and a taken key stops there', () => {
    const bed = createKeyboardTestBed();
    const heard: string[] = [];
    for (const kind of ['global', 'zone', 'route', 'local', 'overlay'] as const) {
      bed.stack.add({ kind, onKey: listener(heard, kind, kind === 'route') });
    }
    // A live overlay is a barrier: nothing below it is asked, taken or not.
    const behind = bed.press('x');
    expect(heard).toEqual(['overlay:x']);
    expect(behind.defaultPrevented).toBe(false);
  });

  test('the window listener is attached with the first layer and detached with the last', () => {
    const bed = createKeyboardTestBed();
    expect(bed.listening).toBe(false);
    const first = bed.stack.add({ kind: 'global', onKey: () => false });
    const second = bed.stack.add({ kind: 'route', onKey: () => false });
    expect(bed.listening).toBe(true);
    first.remove();
    expect(bed.listening).toBe(true);
    second.remove();
    expect(bed.listening).toBe(false);
  });

  test('a scoped layer is heard while its element is visible and outside an inert subtree', () => {
    const bed = createKeyboardTestBed();
    const heard: string[] = [];
    const page = bed.element();
    const panel = page.child();
    bed.stack.add({
      kind: 'route',
      scope: () => panel,
      onKey: listener(heard, 'panel', true),
    });

    expect(bed.press('Escape').defaultPrevented).toBe(true);
    // The page behind a dialog is inert: its descendants stop hearing keys.
    page.inert = true;
    expect(bed.press('Escape').defaultPrevented).toBe(false);
    page.inert = false;
    panel.hidden = true;
    expect(bed.press('Escape').defaultPrevented).toBe(false);
    panel.hidden = false;
    panel.isConnected = false;
    expect(bed.press('Escape').defaultPrevented).toBe(false);
    expect(heard).toEqual(['panel:Escape']);
  });

  test('the inner of two nested layers of a kind hears the key first', () => {
    const bed = createKeyboardTestBed();
    const heard: string[] = [];
    const outer = bed.element();
    const inner = outer.child();
    bed.stack.add({
      kind: 'route',
      scope: () => inner,
      onKey: listener(heard, 'inner', false),
    });
    bed.stack.add({
      kind: 'route',
      scope: () => outer,
      onKey: listener(heard, 'outer', false),
    });
    bed.press('Escape');
    expect(heard).toEqual(['inner:Escape', 'outer:Escape']);
  });

  test('a key pressed in a field or a local-keys area skips layers, except Escape', () => {
    const bed = createKeyboardTestBed();
    const heard: string[] = [];
    bed.stack.add({ kind: 'global', onKey: listener(heard, 'global', false) });
    const field = bed.element({ field: true });
    const area = bed.element({ localKeys: true }).child();
    bed.press('ArrowRight', { target: field });
    bed.press('ArrowRight', { target: area });
    expect(heard).toEqual([]);
    bed.press('Escape', { target: field });
    expect(heard).toEqual(['global:Escape']);
  });

  test('holding Escape closes one level, and a composing key is nobody’s', () => {
    const bed = createKeyboardTestBed();
    const heard: string[] = [];
    bed.stack.add({ kind: 'route', onKey: listener(heard, 'route', true) });
    bed.press('Escape');
    bed.press('Escape', { repeat: true });
    bed.press('a', { isComposing: true });
    expect(heard).toEqual(['route:Escape']);
  });
});

describe('the keyboard test bed: the capture phase', () => {
  test('a local layer in the capture phase hears the key before the bubble layers, and a taken key goes no further', () => {
    const bed = createKeyboardTestBed();
    const heard: string[] = [];
    bed.stack.add({ kind: 'global', onKey: listener(heard, 'global', true) });
    bed.stack.add({
      kind: 'local',
      phase: 'capture',
      fields: 'include',
      onKey: listener(heard, 'menu', true),
    });
    const field = bed.element({ field: true });
    const event = bed.press('Enter', { target: field });
    expect(heard).toEqual(['menu:Enter']);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test('a key the capture layer leaves reaches the bubble layers, and only those', () => {
    const bed = createKeyboardTestBed();
    const heard: string[] = [];
    bed.stack.add({ kind: 'global', onKey: listener(heard, 'global', true) });
    bed.stack.add({ kind: 'local', phase: 'capture', onKey: listener(heard, 'menu', false) });
    const event = bed.press('x');
    expect(heard).toEqual(['menu:x', 'global:x']);
    expect(event.propagationStopped).toBe(false);
  });

  test('a capture layer keeps the field rules: a key pressed in a field is skipped unless it asks', () => {
    const bed = createKeyboardTestBed();
    const heard: string[] = [];
    bed.stack.add({ kind: 'local', phase: 'capture', onKey: listener(heard, 'skips', false) });
    bed.stack.add({
      kind: 'local',
      phase: 'capture',
      fields: 'include',
      onKey: listener(heard, 'includes', false),
    });
    bed.press('ArrowDown', { target: bed.element({ field: true }) });
    expect(heard).toEqual(['includes:ArrowDown']);
  });

  test('a live overlay is a barrier for a capture layer below it too', () => {
    const bed = createKeyboardTestBed();
    const heard: string[] = [];
    bed.stack.add({ kind: 'local', phase: 'capture', onKey: listener(heard, 'menu', true) });
    bed.stack.add({ kind: 'overlay', onKey: listener(heard, 'dialog', false) });
    bed.press('ArrowDown');
    expect(heard).toEqual(['dialog:ArrowDown']);
  });

  test('the capture listener exists only while a layer asks for the capture phase', () => {
    const bed = createKeyboardTestBed();
    expect(bed.listeningInCapture).toBe(false);
    const global = bed.stack.add({ kind: 'global', onKey: () => false });
    expect(bed.listening).toBe(true);
    expect(bed.listeningInCapture).toBe(false);
    const menu = bed.stack.add({ kind: 'local', phase: 'capture', onKey: () => false });
    expect(bed.listeningInCapture).toBe(true);
    menu.update({ kind: 'local', onKey: () => false });
    expect(bed.listeningInCapture).toBe(false);
    menu.update({ kind: 'local', phase: 'capture', onKey: () => false });
    expect(bed.listeningInCapture).toBe(true);
    menu.remove();
    global.remove();
    expect(bed.listening).toBe(false);
  });

  test('only a local layer can listen in the capture phase, and says so when it asks', () => {
    const bed = createKeyboardTestBed();
    for (const kind of ['overlay', 'route', 'zone', 'global'] as const) {
      expect(() => bed.stack.add({ kind, phase: 'capture', onKey: () => false })).toThrow(
        `A ${kind} layer cannot listen in the capture phase; only a local layer can`,
      );
    }
    const route = bed.stack.add({ kind: 'route', onKey: () => false });
    expect(() =>
      route.update({ kind: 'route', phase: 'capture', onKey: () => false }),
    ).toThrow('cannot listen in the capture phase');
    expect(bed.listeningInCapture).toBe(false);
  });
});

describe('the keyboard test bed: a zone', () => {
  function setup() {
    const bed = createKeyboardTestBed();
    const zoneElement = bed.element({ zone: true });
    const rows = new Map(['a', 'b', 'c'].map((id) => [id, zoneElement.child()]));
    const chosen: string[] = [];
    const edges: string[] = [];
    const zone = createNavZone<string>({
      items: [...rows.keys()],
      value: 'a',
      onChange: (id, cause) => chosen.push(`${id}:${cause}`),
      onBoundary: (side) => {
        edges.push(side);
      },
    });
    for (const [id, row] of rows) zone.setItemElement(id, row);
    const press = (name: string, from: TestElement) => {
      const event = bed.key(name, { target: from });
      return { taken: zone.keyDown(event, zoneElement), event };
    };
    return { bed, zone, zoneElement, rows, chosen, edges, press };
  }

  test('an arrow moves focus, scrolls the row in and reports the choice', () => {
    const { rows, press, chosen, zone } = setup();
    const a = rows.get('a');
    const b = rows.get('b');
    if (!a || !b) throw new Error('rows');
    const { taken, event } = press('ArrowDown', a);
    expect(taken).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(b.focusCount).toBe(1);
    expect(b.scrollCount).toBe(1);
    expect(chosen).toEqual(['b:arrow']);
    expect(zone.current()).toBe('b');
  });

  test('past the last row the zone hands the key to its boundary', () => {
    const { rows, press, edges, zone } = setup();
    zone.focus('c');
    const c = rows.get('c');
    if (!c) throw new Error('rows');
    expect(press('ArrowDown', c).taken).toBe(true);
    expect(edges).toEqual(['end']);
  });

  test('a key from a field inside the zone is left alone', () => {
    const { bed, zone, zoneElement } = setup();
    const field = zoneElement.child({ field: true });
    const event = bed.key('ArrowDown', { target: field });
    expect(zone.keyDown(event, zoneElement)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
