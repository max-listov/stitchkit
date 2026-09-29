/**
 * The React binding, rendered by react-dom into happy-dom: layers mount and
 * unmount with their components, zones put real focus on real elements.
 *
 * happy-dom is registered for this file only and removed after it, so the rest
 * of the suite keeps running without DOM globals.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement, type ReactNode, useRef } from 'react';
import type { createRoot as CreateRoot } from 'react-dom/client';
import {
  type EscapeLayerOptions,
  type KeyLayerOptions,
  type NavZoneOptions,
  useEscapeLayer,
  useKeyLayer,
  useNavZone,
} from '../src/entrypoints/react/keyboard';

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

function List(props: { readonly options: NavZoneOptions<string> }): ReactNode {
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
