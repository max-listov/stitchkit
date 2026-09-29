/**
 * The React binding of the key layers and zones: hooks only, no component and
 * no provider. The stack is one per window, created by the first layer that
 * mounts, so a layer inside a portal is on the same stack as the page.
 */
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  createKeyLayerStack,
  type KeyLayerHandle,
  type KeyLayerKind,
  type KeyLayerStack,
  type KeyLayerState,
} from './layers';
import {
  createNavZone,
  type NavZoneOptions,
  ZONE_ATTRIBUTE,
  type ZoneItemId,
  type ZoneOrientation,
} from './zone';

type WindowStack = KeyLayerStack<KeyboardEvent, Element>;

const stacks = new WeakMap<Window, WindowStack>();

function stackOf(view: Window): WindowStack {
  const existing = stacks.get(view);
  if (existing !== undefined) return existing;
  const created = createKeyLayerStack<KeyboardEvent, Element>(view);
  stacks.set(view, created);
  return created;
}

export interface KeyLayerOptions {
  readonly kind: KeyLayerKind;
  /** Return `true` when the key was taken: its default is prevented and no layer below hears it. */
  onKey(event: KeyboardEvent): boolean;
  /** Default `true`. Becoming active puts the layer on top of its kind. */
  readonly active?: boolean;
  /**
   * The element the layer belongs to. Given, the layer is heard only while the
   * element is mounted, visible and not `inert`, and it outranks layers of its
   * kind whose elements contain it.
   */
  readonly scope?: RefObject<Element | null>;
  /** Default `'skip'`: keys pressed in fields and `data-local-keys` areas, except Escape, pass it by. */
  readonly fields?: 'skip' | 'include';
}

function layerState(options: KeyLayerOptions): KeyLayerState<KeyboardEvent, Element> {
  const { scope } = options;
  return {
    kind: options.kind,
    active: options.active,
    fields: options.fields,
    scope: scope === undefined ? undefined : () => scope.current,
    onKey: (event) => options.onKey(event),
  };
}

/** Put a layer on the window's key stack for as long as the component is mounted. */
export function useKeyLayer(options: KeyLayerOptions): void {
  const handle = useRef<KeyLayerHandle<KeyboardEvent, Element> | null>(null);
  const initial = useRef(options);
  useEffect(() => {
    const added = stackOf(window).add(layerState(initial.current));
    handle.current = added;
    return () => {
      added.remove();
      handle.current = null;
    };
  }, []);
  useEffect(() => {
    handle.current?.update(layerState(options));
  });
}

export interface EscapeLayerOptions {
  readonly kind: 'overlay' | 'local' | 'route';
  /** Close one level. Return `false` when there was nothing to close, and the layer below is asked. */
  onEscape(): unknown;
  readonly active?: boolean;
  readonly scope?: RefObject<Element | null>;
}

/** One Escape closes one level: the first layer that takes it is the only one that hears it. */
export function useEscapeLayer(options: EscapeLayerOptions): void {
  useKeyLayer({
    kind: options.kind,
    active: options.active,
    scope: options.scope,
    onKey: (event) => event.key === 'Escape' && options.onEscape() !== false,
  });
}

/** Spread on the zone's element. */
export interface NavZoneProps {
  readonly ref: (element: HTMLElement | null) => void;
  readonly role: 'listbox' | 'tablist' | undefined;
  readonly 'aria-orientation': ZoneOrientation;
  readonly 'aria-label': string | undefined;
  readonly 'data-keyboard-zone': '';
  readonly onKeyDown: (event: { readonly nativeEvent: KeyboardEvent }) => void;
}

/** Spread on each item's element. */
export interface NavZoneItemProps {
  readonly ref: (element: HTMLElement | null) => void;
  readonly tabIndex: 0 | -1;
  readonly role: 'option' | 'tab' | undefined;
  readonly 'aria-selected': boolean | undefined;
  readonly 'aria-current': 'true' | undefined;
  readonly onFocus: () => void;
}

export interface NavZone<Id extends ZoneItemId> {
  /** Spread on the zone's element; it carries the element's `ref`. */
  readonly zoneProps: NavZoneProps;
  /** The zone's element, for what else needs it — an Escape layer scoped to the zone. */
  readonly element: RefObject<HTMLElement | null>;
  itemProps(id: Id): NavZoneItemProps;
  /** The tab stop: the item focus is on or was last on, else the chosen one, else the first. */
  readonly current: Id | null;
  /** Put focus on `id`, or on the current item — to move into this zone from another. */
  focus(id?: Id): boolean;
}

/**
 * A list the arrows move through with real focus. See `zone.ts` for the
 * modes, the cross axis and what happens past an end.
 */
export function useNavZone<Id extends ZoneItemId>(options: NavZoneOptions<Id>): NavZone<Id> {
  const [zone] = useState(() => createNavZone(options));
  zone.update(options);
  const current = useSyncExternalStore(zone.subscribe, zone.current, zone.current);
  const element = useRef<HTMLElement | null>(null);
  const [zoneRef] = useState(() => (node: HTMLElement | null) => {
    element.current = node;
  });
  const itemRefs = useRef(new Map<Id, (node: HTMLElement | null) => void>());

  useKeyLayer({
    kind: 'zone',
    active: options.active,
    scope: element,
    onKey: (event) => zone.keyFromOutside(event),
  });

  const role = options.role ?? 'listbox';
  const itemRef = (id: Id) => {
    const cached = itemRefs.current.get(id);
    if (cached !== undefined) return cached;
    const created = (node: HTMLElement | null) => {
      zone.setItemElement(id, node);
    };
    itemRefs.current.set(id, created);
    return created;
  };

  return {
    zoneProps: {
      ref: zoneRef,
      role: role === 'none' ? undefined : role,
      'aria-orientation': options.orientation ?? 'vertical',
      'aria-label': options.label,
      [ZONE_ATTRIBUTE]: '',
      onKeyDown: (event) => {
        zone.keyDown(event.nativeEvent, element.current);
      },
    },
    itemProps: (id) => {
      const chosen = id === options.value;
      return {
        ref: itemRef(id),
        tabIndex: id === current ? 0 : -1,
        role: role === 'listbox' ? 'option' : role === 'tablist' ? 'tab' : undefined,
        'aria-selected': role === 'none' ? undefined : chosen,
        'aria-current': role === 'none' && chosen ? 'true' : undefined,
        onFocus: () => zone.focused(id),
      };
    },
    element,
    current,
    focus: (id) => zone.focus(id),
  };
}
