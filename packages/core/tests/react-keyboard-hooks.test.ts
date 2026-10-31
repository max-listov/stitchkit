/**
 * The React binding, rendered by react-dom into happy-dom: layers mount and
 * unmount with their components, zones put real focus on real elements.
 *
 * happy-dom is registered for this file only and removed after it, so the rest
 * of the suite keeps running without DOM globals.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import {
  act,
  createElement,
  type ReactNode,
  Suspense,
  startTransition,
  use,
  useRef,
} from 'react';
import type { createRoot as CreateRoot } from 'react-dom/client';
import {
  type EscapeLayerOptions,
  type FocusZoneOptions,
  type KeyLayerOptions,
  mergeRefs,
  type NavZoneOptions,
  openedByKeyboard,
  useEscapeLayer,
  useKeyLayer,
  useNavZone,
} from '../src/entrypoints/react/keyboard';
import { createItemRefs } from '../src/react/keyboard/hooks';

let createRoot: typeof CreateRoot;

beforeAll(async () => {
  GlobalRegistrator.register();
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  // react-dom reads the DOM globals as it is evaluated: it is loaded after they exist.
  ({ createRoot } = await import('react-dom/client'));
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** An `onKey` that records `name` and answers `takes`. */
const recordTo =
  (heard: string[], name: string, takes: boolean) =>
  (event: KeyboardEvent): boolean => {
    heard.push(name === 'key' ? event.key : name);
    return takes;
  };

const mounted = new Set<() => void>();

// A test that fails midway must not leave its layers on the window's stack.
afterEach(() => {
  for (const unmount of mounted) unmount();
  document.body.replaceChildren();
});

function render(node: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  const unmount = () => {
    if (!mounted.delete(unmount)) return;
    act(() => root.unmount());
    container.remove();
  };
  mounted.add(unmount);
  return {
    container,
    root,
    rerender: (next: ReactNode) => act(() => root.render(next)),
    unmount,
  };
}

function press(key: string, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** A layer; `inert` scopes it to an element inside an inert subtree. */
function Layer({
  inert,
  ...options
}: Omit<KeyLayerOptions, 'scope'> & { readonly inert?: boolean }): ReactNode {
  const scope = useRef<HTMLDivElement | null>(null);
  useKeyLayer({ ...options, scope: inert ? scope : undefined });
  return createElement('div', { inert }, createElement('div', { ref: scope }));
}

function Escape(props: EscapeLayerOptions & { readonly children?: ReactNode }): ReactNode {
  const scope = useRef<HTMLDivElement | null>(null);
  useEscapeLayer({ ...props, scope });
  return createElement('div', { ref: scope }, props.children);
}

function List(props: {
  readonly options: NavZoneOptions<string> | FocusZoneOptions<string>;
}): ReactNode {
  const zone = useNavZone(props.options);
  return createElement(
    'ul',
    { ...zone.zoneProps },
    props.options.items.map((id) =>
      createElement('li', { key: id, 'data-id': id, ...zone.itemProps(id) }, id),
    ),
  );
}

const item = (container: HTMLElement, id: string) => {
  const found = container.querySelector(`[data-id="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no item ${id}`);
  return found;
};

describe('useKeyLayer', () => {
  test('a layer is heard while its component is mounted and active', () => {
    const heard: string[] = [];
    const onKey = recordTo(heard, 'key', true);
    const view = render(createElement(Layer, { kind: 'global', onKey, active: false }));
    press('ArrowRight');
    expect(heard).toEqual([]);
    view.rerender(createElement(Layer, { kind: 'global', onKey }));
    const event = press('ArrowRight');
    expect(heard).toEqual(['ArrowRight']);
    expect(event.defaultPrevented).toBe(true);
    view.unmount();
    press('ArrowRight');
    expect(heard).toEqual(['ArrowRight']);
  });

  test('a layer scoped to an inert element is not heard', () => {
    const heard: string[] = [];
    const view = render(
      createElement(Layer, {
        kind: 'global',
        inert: true,
        onKey: recordTo(heard, 'key', true),
      }),
    );
    press('ArrowRight');
    expect(heard).toEqual([]);
    view.unmount();
  });

  test('keys typed in an input reach only a layer that includes fields', () => {
    const heard: string[] = [];
    const input = document.createElement('input');
    document.body.append(input);
    const view = render([
      createElement(Layer, {
        key: 'skip',
        kind: 'global',
        onKey: recordTo(heard, 'skip', false),
      }),
      createElement(Layer, {
        key: 'include',
        kind: 'global',
        fields: 'include',
        onKey: recordTo(heard, 'include', false),
      }),
    ]);
    press('ArrowLeft', input);
    expect(heard).toEqual(['include']);
    view.unmount();
    input.remove();
  });
});

describe('useEscapeLayer', () => {
  test('one Escape closes one level: the inner panel, then the page, though both mounted together', () => {
    const closed: string[] = [];
    const view = render(
      createElement(
        Escape,
        { kind: 'route', onEscape: () => closed.push('page') },
        createElement(Escape, { kind: 'route', onEscape: () => closed.push('panel') }),
      ),
    );
    press('Escape');
    expect(closed).toEqual(['panel']);
    view.rerender(
      createElement(Escape, { kind: 'route', onEscape: () => closed.push('page') }),
    );
    press('Escape');
    expect(closed).toEqual(['panel', 'page']);
    view.unmount();
  });

  test('a layer with nothing to close answers false and the one below is asked', () => {
    const closed: string[] = [];
    const view = render([
      createElement(Escape, {
        key: 'page',
        kind: 'route',
        onEscape: () => closed.push('page'),
      }),
      createElement(Escape, { key: 'editor', kind: 'local', onEscape: () => false }),
    ]);
    press('Escape');
    expect(closed).toEqual(['page']);
    view.unmount();
  });

  test('an inactive Escape layer is passed over, and hears again once active', () => {
    const closed: string[] = [];
    const layers = (active: boolean) => [
      createElement(Escape, {
        key: 'page',
        kind: 'route',
        onEscape: () => closed.push('page'),
      }),
      createElement(Escape, {
        key: 'search',
        kind: 'local',
        active,
        onEscape: () => closed.push('search'),
      }),
    ];
    const view = render(layers(false));
    press('Escape');
    view.rerender(layers(true));
    press('Escape');
    expect(closed).toEqual(['page', 'search']);
    view.unmount();
  });

  test('an open overlay takes Escape before the page, and nothing below it hears other keys', () => {
    const heard: string[] = [];
    const view = render([
      createElement(Escape, {
        key: 'page',
        kind: 'route',
        onEscape: () => heard.push('page'),
      }),
      createElement(Layer, {
        key: 'sections',
        kind: 'global',
        onKey: recordTo(heard, 'sections', true),
      }),
      createElement(Escape, {
        key: 'dialog',
        kind: 'overlay',
        onEscape: () => heard.push('dialog'),
      }),
    ]);
    press('Escape');
    press('ArrowRight');
    expect(heard).toEqual(['dialog']);
    view.unmount();
  });
});

describe('useNavZone', () => {
  const base = (overrides: Partial<NavZoneOptions<string>> = {}): NavZoneOptions<string> => ({
    items: ['a', 'b', 'c'],
    value: 'a',
    onChange: () => undefined,
    ...overrides,
  });

  test('a listbox of options: one tab stop, the chosen option selected, orientation and name', () => {
    const view = render(
      createElement(List, { options: base({ value: 'b', label: 'Chats' }) }),
    );
    const list = view.container.querySelector('ul');
    expect(list?.getAttribute('role')).toBe('listbox');
    expect(list?.getAttribute('aria-orientation')).toBe('vertical');
    expect(list?.getAttribute('aria-label')).toBe('Chats');
    expect(item(view.container, 'b').getAttribute('role')).toBe('option');
    expect(item(view.container, 'b').getAttribute('aria-selected')).toBe('true');
    expect(item(view.container, 'a').getAttribute('aria-selected')).toBe('false');
    expect(item(view.container, 'b').tabIndex).toBe(0);
    expect(item(view.container, 'a').tabIndex).toBe(-1);
    view.unmount();
  });

  test('a tablist has tabs; role none keeps the items own and marks the chosen one current', () => {
    const tabs = render(
      createElement(List, { options: base({ role: 'tablist', orientation: 'horizontal' }) }),
    );
    expect(tabs.container.querySelector('ul')?.getAttribute('role')).toBe('tablist');
    expect(tabs.container.querySelector('ul')?.getAttribute('aria-orientation')).toBe(
      'horizontal',
    );
    expect(item(tabs.container, 'a').getAttribute('role')).toBe('tab');
    tabs.unmount();
    const links = render(createElement(List, { options: base({ role: 'none' }) }));
    expect(links.container.querySelector('ul')?.hasAttribute('role')).toBe(false);
    expect(item(links.container, 'a').hasAttribute('role')).toBe(false);
    expect(item(links.container, 'a').getAttribute('aria-current')).toBe('true');
    expect(item(links.container, 'b').hasAttribute('aria-current')).toBe(false);
    links.unmount();
  });

  test('an arrow moves real focus and the tab stop, and chooses in select mode', () => {
    const changes: string[] = [];
    let value = 'a';
    const options = () =>
      base({ value, onChange: (id, cause) => changes.push(`${id}:${cause}`) });
    const view = render(createElement(List, { options: options() }));
    item(view.container, 'a').focus();
    const event = press('ArrowDown', item(view.container, 'a'));
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(item(view.container, 'b'));
    expect(changes).toEqual(['b:arrow']);
    value = 'b';
    view.rerender(createElement(List, { options: options() }));
    expect(item(view.container, 'b').tabIndex).toBe(0);
    expect(item(view.container, 'a').tabIndex).toBe(-1);
    view.unmount();
  });

  test('a key the zone leaves bubbles on to the layers: sideways switches the section', () => {
    const sections: string[] = [];
    const view = render([
      createElement(List, { key: 'list', options: base() }),
      createElement(Layer, {
        key: 'sections',
        kind: 'global',
        onKey: (event) => event.key === 'ArrowRight' && sections.push('next') > 0,
      }),
    ]);
    item(view.container, 'a').focus();
    press('ArrowDown', item(view.container, 'a'));
    press('ArrowRight', document.activeElement ?? document.body);
    expect(sections).toEqual(['next']);
    view.unmount();
  });

  test('with focus in no zone, an arrow lands on the active zone, and an inactive zone takes none', () => {
    const view = render(createElement(List, { options: base({ value: 'c' }) }));
    press('ArrowDown');
    expect(document.activeElement).toBe(item(view.container, 'c'));
    view.unmount();
    const idle = render(createElement(List, { options: base({ active: false }) }));
    const event = press('ArrowDown');
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
    idle.unmount();
  });
});

describe('useNavZone: the rest of the contract', () => {
  const base = (overrides: Partial<NavZoneOptions<string>> = {}): NavZoneOptions<string> => ({
    items: ['a', 'b', 'c'],
    value: 'a',
    onChange: () => undefined,
    ...overrides,
  });

  test('a focus zone moves focus on arrows and leaves Enter to the element', () => {
    const view = render(
      createElement(List, {
        options: { items: ['a', 'b', 'c'], mode: 'focus', role: 'none' },
      }),
    );
    item(view.container, 'a').focus();
    press('ArrowDown', item(view.container, 'a'));
    expect(document.activeElement).toBe(item(view.container, 'b'));
    const enter = press('Enter', item(view.container, 'b'));
    expect(enter.defaultPrevented).toBe(false);
    view.unmount();
  });

  test('a key that has no value is absent, so a spread after your own attribute keeps it', () => {
    const Links = (): ReactNode => {
      const zone = useNavZone<string>({ items: ['a', 'b'], mode: 'focus', role: 'none' });
      return createElement(
        'div',
        { 'aria-label': 'mine', ...zone.zoneProps },
        createElement('a', { 'data-id': 'a', role: 'menuitem', ...zone.itemProps('a') }, 'a'),
        createElement('a', { 'data-id': 'b', ...zone.itemProps('b') }, 'b'),
      );
    };
    const view = render(createElement(Links));
    const group = view.container.firstElementChild;
    expect(group?.getAttribute('aria-label')).toBe('mine');
    expect(group?.hasAttribute('role')).toBe(false);
    expect(item(view.container, 'a').getAttribute('role')).toBe('menuitem');
    expect(item(view.container, 'a').hasAttribute('aria-selected')).toBe(false);
    view.unmount();

    const Probe = (): ReactNode => {
      const zone = useNavZone<string>({ items: ['a'], mode: 'focus', role: 'none' });
      const props: object = zone.itemProps('a');
      return createElement('i', {
        'data-keys': Object.keys(props).sort().join(','),
        'data-zone': Object.keys(zone.zoneProps).sort().join(','),
      });
    };
    const keys = render(createElement(Probe));
    expect(keys.container.firstElementChild?.getAttribute('data-keys')).toBe(
      'onFocus,ref,tabIndex',
    );
    expect(keys.container.firstElementChild?.getAttribute('data-zone')).toBe(
      'aria-orientation,data-keyboard-zone,onKeyDown,ref',
    );
    keys.unmount();
  });

  test('role none marks the chosen item aria-current, a listbox marks it aria-selected', () => {
    const view = render(createElement(List, { options: base({ role: 'none', value: 'b' }) }));
    expect(item(view.container, 'b').getAttribute('aria-current')).toBe('true');
    expect(item(view.container, 'a').hasAttribute('aria-current')).toBe(false);
    view.unmount();
  });

  test('mergeRefs hands the element to every ref and takes it back from every one', () => {
    const seen: (HTMLElement | null)[] = [];
    const object: { current: HTMLElement | null } = { current: null };
    const Row = (): ReactNode => {
      const zone = useNavZone<string>({ items: ['a'], mode: 'focus' });
      const merged = mergeRefs<HTMLElement>(
        zone.itemProps('a').ref,
        (node) => {
          seen.push(node);
        },
        object,
        undefined,
        null,
      );
      return createElement(
        'ul',
        zone.zoneProps,
        createElement('li', { 'data-id': 'a', ref: merged }, 'a'),
      );
    };
    const view = render(createElement(Row));
    expect(seen[0]).toBe(item(view.container, 'a'));
    expect(object.current).toBe(item(view.container, 'a'));
    view.unmount();
    expect(object.current).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  test('ignore leaves an arrow to the application, inside the zone and outside it', () => {
    let dragging = false;
    const options = base({ ignore: () => dragging });
    const view = render(createElement(List, { options }));
    item(view.container, 'a').focus();
    dragging = true;
    const ignored = press('ArrowDown', item(view.container, 'a'));
    expect(ignored.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(item(view.container, 'a'));
    document.body.focus();
    expect(press('ArrowDown').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
    dragging = false;
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    view.unmount();
  });

  test('an item ref is dropped with its element, and a list that churns its ids keeps none', () => {
    const cache = createItemRefs<number>(() => undefined);
    const nodes = new Map<number, HTMLElement>();
    for (let round = 0; round < 5; round += 1) {
      for (let id = round * 1_000; id < (round + 1) * 1_000; id += 1) {
        const node = document.createElement('li');
        nodes.set(id, node);
        cache.get(id)(node);
      }
      expect(cache.size).toBe(1_000);
      // The page moves on: the previous round's rows unmount.
      for (const id of nodes.keys()) cache.get(id)(null);
      nodes.clear();
      expect(cache.size).toBe(0);
    }
    // Asked again for an id that is still mounted, it is the same callback.
    const same = cache.get(7);
    expect(cache.get(7)).toBe(same);
    expect(cache.size).toBe(1);
  });

  test('a render React throws away leaves the zone as the last committed render left it', async () => {
    const chosen: string[] = [];
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    // One Suspense boundary in both trees: a boundary React has already revealed
    // keeps its content while a transition inside it waits.
    const Gate = (props: { readonly wait: boolean }): ReactNode => {
      if (props.wait) use(pending);
      return null;
    };
    const page = (options: NavZoneOptions<string>, wait: boolean): ReactNode =>
      createElement(
        Suspense,
        { fallback: null },
        createElement(List, { options }),
        createElement(Gate, { wait }),
      );
    const committed = base({ value: 'a', onChange: (id) => chosen.push(`committed:${id}`) });
    const discarded = base({ value: 'c', onChange: (id) => chosen.push(`discarded:${id}`) });
    const view = render(page(committed, false));
    item(view.container, 'a').focus();

    // A transition that suspends: the list renders with the new options and the
    // tree is not committed, so the page keeps showing — and the keys keep meaning — the old one.
    await act(async () => {
      startTransition(() => view.root.render(page(discarded, true)));
    });
    // Pressed inside an awaited act: a synchronous one would meet the suspended render.
    await act(async () => {
      item(view.container, 'a').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    expect(chosen).toEqual(['committed:b']);
    expect(item(view.container, 'a').tabIndex).toBe(-1);
    expect(item(view.container, 'b').tabIndex).toBe(0);
    // Let the waiting render finish while the DOM still exists.
    await act(async () => {
      release();
      await pending;
    });
    view.unmount();
  });
});

describe('openedByKeyboard', () => {
  let matches: Element['matches'];
  beforeEach(() => {
    matches = Element.prototype.matches;
  });
  afterEach(() => {
    Reflect.set(Element.prototype, 'matches', matches);
  });

  test('is the focus ring of the element that has focus now', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    Reflect.set(Element.prototype, 'matches', function (this: Element, selector: string) {
      return selector === ':focus-visible' ? this === button : matches.call(this, selector);
    });
    expect(openedByKeyboard()).toBe(true);
    document.body.focus();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(openedByKeyboard()).toBe(false);
  });

  test('is false for a browser that does not know :focus-visible, and on a server', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    Reflect.set(Element.prototype, 'matches', () => {
      throw new SyntaxError("':focus-visible' is not a valid selector");
    });
    expect(openedByKeyboard()).toBe(false);

    const view = Reflect.get(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'document');
    try {
      expect(openedByKeyboard()).toBe(false);
    } finally {
      Reflect.set(globalThis, 'document', view);
    }
  });
});

describe('a menu over a text field', () => {
  /** A composer that submits on Enter, and a menu layer over it. */
  function Composer(props: {
    readonly submitted: string[];
    readonly picked: string[];
    readonly phase: 'bubble' | 'capture';
    readonly open?: boolean;
  }): ReactNode {
    const menu = useRef<HTMLDivElement | null>(null);
    useKeyLayer({
      kind: 'local',
      phase: props.phase,
      fields: 'include',
      scope: menu,
      onKey: (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'Enter') return false;
        props.picked.push(event.key);
        return true;
      },
    });
    return createElement(
      'div',
      null,
      createElement('textarea', {
        id: 'composer',
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Enter') props.submitted.push('sent');
        },
      }),
      props.open === false
        ? null
        : createElement('div', { ref: menu, role: 'menu' }, 'commands'),
    );
  }

  const textarea = (container: HTMLElement): HTMLElement => {
    const found = container.querySelector('#composer');
    if (!(found instanceof HTMLElement)) throw new Error('no composer');
    return found;
  };

  test('in the capture phase the layer takes Enter and the field never submits', () => {
    const submitted: string[] = [];
    const picked: string[] = [];
    const view = render(createElement(Composer, { submitted, picked, phase: 'capture' }));
    textarea(view.container).focus();
    const event = press('Enter', textarea(view.container));
    expect(picked).toEqual(['Enter']);
    expect(submitted).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    view.unmount();
  });

  test('in the bubble phase the field has already submitted when the layer hears the key', () => {
    const submitted: string[] = [];
    const picked: string[] = [];
    const view = render(createElement(Composer, { submitted, picked, phase: 'bubble' }));
    textarea(view.container).focus();
    press('Enter', textarea(view.container));
    expect(submitted).toEqual(['sent']);
    expect(picked).toEqual(['Enter']);
    view.unmount();
  });

  test('a capture layer whose menu is not on the page leaves the key to the field', () => {
    const submitted: string[] = [];
    const picked: string[] = [];
    const view = render(
      createElement(Composer, { submitted, picked, phase: 'capture', open: false }),
    );
    textarea(view.container).focus();
    press('Enter', textarea(view.container));
    expect(picked).toEqual([]);
    expect(submitted).toEqual(['sent']);
    view.unmount();
  });
});
