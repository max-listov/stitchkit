/**
 * Key layers: one listener, a fixed order, the innermost layer of a kind first.
 *
 * Driven without a DOM: an element is a node with a parent and the selectors it
 * matches, a key is a record with `preventDefault`.
 */
import { describe, expect, test } from 'bun:test';
import {
  createKeyLayerStack,
  isKeyFieldTarget,
  KEY_FIELD_SELECTOR,
  type KeyLayerKind,
  type KeyLayerState,
  type KeyListenerTarget,
  type LayerScope,
} from '../src/react/keyboard/layers';

class FakeElement extends EventTarget implements LayerScope<FakeElement> {
  isConnected = true;
  visible = true;
  constructor(
    readonly parent: FakeElement | null = null,
    readonly marks: ReadonlySet<string> = new Set(),
  ) {
    super();
  }
  contains(other: FakeElement | null): boolean {
    for (let node = other; node !== null; node = node.parent) if (node === this) return true;
    return false;
  }
  closest(selectors: string): FakeElement | null {
    for (let node: FakeElement | null = this; node !== null; node = node.parent) {
      if (node.marks.has(selectors)) return node;
    }
    return null;
  }
  checkVisibility(): boolean {
    return this.visible;
  }
}

class FakeKey {
  defaultPrevented = false;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly target: EventTarget | null;
  constructor(
    readonly key: string,
    init: { repeat?: boolean; isComposing?: boolean; target?: EventTarget | null } = {},
  ) {
    this.repeat = init.repeat ?? false;
    this.isComposing = init.isComposing ?? false;
    this.target = init.target ?? null;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeWindow implements KeyListenerTarget<FakeKey> {
  listeners = new Set<(event: FakeKey) => void>();
  added = 0;
  addEventListener(_type: 'keydown', listener: (event: FakeKey) => void): void {
    this.added += 1;
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'keydown', listener: (event: FakeKey) => void): void {
    this.listeners.delete(listener);
  }
  press(event: FakeKey): void {
    for (const listener of this.listeners) listener(event);
  }
}

type State = KeyLayerState<FakeKey, FakeElement>;

function setup() {
  const view = new FakeWindow();
  const stack = createKeyLayerStack<FakeKey, FakeElement>(view);
  const heard: string[] = [];
  /** A layer's `onKey` that records who heard what, then answers `takes`. */
  const hearing =
    (name: string, takes = true) =>
    (event: FakeKey) => {
      heard.push(`${name}:${event.key}`);
      return takes;
    };
  const layer = (
    name: string,
    kind: KeyLayerKind,
    { takes, ...state }: Omit<Partial<State>, 'onKey'> & { takes?: boolean } = {},
  ) => stack.add({ ...state, kind, onKey: hearing(name, takes) });
  return { view, stack, heard, layer, hearing };
}

const EVERY_KIND_BOTTOM_UP: readonly KeyLayerKind[] = [
  'global',
  'zone',
  'route',
  'local',
  'overlay',
];

const field = () => new FakeElement(null, new Set([KEY_FIELD_SELECTOR]));

describe('key layers: order', () => {
  test('layers are asked overlay, local, route, zone, global — whatever order they mount in', () => {
    const { stack, heard, layer } = setup();
    for (const kind of EVERY_KIND_BOTTOM_UP) layer(kind, kind, { takes: false });
    stack.dispatch(new FakeKey('x'));
    // The overlay is a barrier: with it live, nothing below hears the key.
    expect(heard).toEqual(['overlay:x']);
    const { stack: open, heard: openHeard, layer: openLayer } = setup();
    for (const kind of EVERY_KIND_BOTTOM_UP.slice(0, -1))
      openLayer(kind, kind, { takes: false });
    open.dispatch(new FakeKey('x'));
    expect(openHeard).toEqual(['local:x', 'route:x', 'zone:x', 'global:x']);
  });

  test('the first layer that takes the key is the only one that hears it, and its default is prevented', () => {
    const { stack, heard, layer } = setup();
    layer('route', 'route', {});
    layer('global', 'global', {});
    const key = new FakeKey('Escape');
    expect(stack.dispatch(key)).toBe(true);
    expect(heard).toEqual(['route:Escape']);
    expect(key.defaultPrevented).toBe(true);
  });

  test('a key no layer takes keeps its default', () => {
    const { stack, layer } = setup();
    layer('global', 'global', { takes: false });
    const key = new FakeKey('ArrowLeft');
    expect(stack.dispatch(key)).toBe(false);
    expect(key.defaultPrevented).toBe(false);
  });

  test('of two layers of a kind, the one activated last is asked first', () => {
    const { stack, heard, layer } = setup();
    layer('first', 'route', { takes: false });
    layer('second', 'route', { takes: false });
    stack.dispatch(new FakeKey('Escape'));
    expect(heard).toEqual(['second:Escape', 'first:Escape']);
  });

  test('an inner layer outranks the layer whose element contains it, even when it mounted first', () => {
    const { stack, heard, layer } = setup();
    const page = new FakeElement();
    const panel = new FakeElement(page);
    // React runs the child's effect first: the panel registers before the page.
    layer('panel', 'route', { scope: () => panel, takes: false });
    layer('page', 'route', { scope: () => page, takes: false });
    stack.dispatch(new FakeKey('Escape'));
    expect(heard).toEqual(['panel:Escape', 'page:Escape']);
  });
});

describe('key layers: what is live', () => {
  test('a layer that is not active is skipped, and becoming active puts it on top of its kind', () => {
    const { stack, heard, layer, hearing } = setup();
    const sleeper = layer('sleeper', 'route', { active: false, takes: false });
    layer('awake', 'route', { takes: false });
    stack.dispatch(new FakeKey('Escape'));
    expect(heard).toEqual(['awake:Escape']);
    heard.length = 0;
    sleeper.update({ kind: 'route', active: true, onKey: hearing('sleeper', false) });
    stack.dispatch(new FakeKey('Escape'));
    expect(heard).toEqual(['sleeper:Escape', 'awake:Escape']);
  });

  test('a layer whose element is unmounted, disconnected, hidden or inert is skipped', () => {
    const { stack, heard, layer } = setup();
    const root = new FakeElement();
    const inertRoot = new FakeElement(null, new Set(['[inert]']));
    const hidden = new FakeElement(root);
    hidden.visible = false;
    const gone = new FakeElement(root);
    gone.isConnected = false;
    layer('unmounted', 'global', { scope: () => null, takes: false });
    layer('gone', 'global', { scope: () => gone, takes: false });
    layer('hidden', 'global', { scope: () => hidden, takes: false });
    layer('inert', 'global', { scope: () => new FakeElement(inertRoot), takes: false });
    layer('shown', 'global', { scope: () => new FakeElement(root), takes: false });
    stack.dispatch(new FakeKey('ArrowRight'));
    expect(heard).toEqual(['shown:ArrowRight']);
  });

  test('keys pressed in a field pass layers by, except Escape; fields: include hears them', () => {
    const { stack, heard, layer } = setup();
    layer('skips', 'global', { takes: false });
    layer('includes', 'global', { fields: 'include', takes: false });
    stack.dispatch(new FakeKey('ArrowLeft', { target: field() }));
    expect(heard).toEqual(['includes:ArrowLeft']);
    heard.length = 0;
    stack.dispatch(new FakeKey('Escape', { target: field() }));
    expect(heard).toEqual(['includes:Escape', 'skips:Escape']);
  });

  test('a field is an input, a text area, an editable region or a data-local-keys area', () => {
    expect(isKeyFieldTarget(field())).toBe(true);
    expect(isKeyFieldTarget(new FakeElement(field()))).toBe(true);
    expect(isKeyFieldTarget(new FakeElement())).toBe(false);
    expect(isKeyFieldTarget(null)).toBe(false);
    for (const part of ['textarea', 'select', '[data-local-keys]', '[role=combobox]']) {
      expect(KEY_FIELD_SELECTOR).toContain(part);
    }
    expect(KEY_FIELD_SELECTOR).toContain('[type=checkbox]');
  });

  test('a key something nearer already took, a held Escape and a key mid-composition reach no layer', () => {
    const { stack, heard, layer } = setup();
    layer('route', 'route', {});
    const taken = new FakeKey('Escape');
    taken.preventDefault();
    expect(stack.dispatch(taken)).toBe(false);
    expect(stack.dispatch(new FakeKey('Escape', { repeat: true }))).toBe(false);
    expect(stack.dispatch(new FakeKey('Enter', { isComposing: true }))).toBe(false);
    expect(heard).toEqual([]);
    // An arrow may repeat: holding it moves on.
    expect(stack.dispatch(new FakeKey('ArrowDown', { repeat: true }))).toBe(true);
  });
});

describe('key layers: one listener', () => {
  test('the listener is attached with the first layer and detached with the last', () => {
    const { view, layer } = setup();
    expect(view.listeners.size).toBe(0);
    const first = layer('a', 'global');
    const second = layer('b', 'route');
    expect(view.added).toBe(1);
    expect(view.listeners.size).toBe(1);
    first.remove();
    expect(view.listeners.size).toBe(1);
    second.remove();
    second.remove();
    expect(view.listeners.size).toBe(0);
  });

  test('the installed listener dispatches', () => {
    const { view, heard, layer } = setup();
    layer('global', 'global');
    const key = new FakeKey('ArrowRight');
    view.press(key);
    expect(heard).toEqual(['global:ArrowRight']);
    expect(key.defaultPrevented).toBe(true);
  });
});
