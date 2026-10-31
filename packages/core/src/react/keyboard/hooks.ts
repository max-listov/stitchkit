/**
 * The React binding of the key layers and zones: hooks only, no component and
 * no provider. The stack is one per window, created by the first layer that
 * mounts, so a layer inside a portal is on the same stack as the page.
 */
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  createKeyLayerStack,
  type KeyLayerHandle,
  type KeyLayerKind,
  type KeyLayerPhase,
  type KeyLayerStack,
  type KeyLayerState,
} from './layers';
import {
  createNavZone,
  resolveZoneIndex,
  ZONE_ATTRIBUTE,
  type ZoneItemId,
  type ZoneOptions,
  type ZoneOrientation,
} from './zone';

/** Layout effects run on the server only as a warning in older React; there it is a plain effect. */
const useCommittedEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

type WindowStack = KeyLayerStack<KeyboardEvent, Element>;

const stacks = new WeakMap<Window, WindowStack>();

function stackOf(view: Window): WindowStack {
  const existing = stacks.get(view);
  if (existing !== undefined) return existing;
  const created = createKeyLayerStack<KeyboardEvent, Element>(view);
  stacks.set(view, created);
  return created;
}

/**
 * A layer on the window's key stack. `phase: 'capture'` is for a `local` layer
 * only — any other kind refuses it when it mounts: the layer then hears a key
 * before the element that has focus does, as a menu over a text field must, and
 * a key it takes reaches nothing nearer. Such a layer sets `fields: 'include'`,
 * since the key is pressed in the field.
 */
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
  /** Default `'bubble'`: after everything nearer. `'capture'`: before it, `local` layers only. */
  readonly phase?: KeyLayerPhase;
}

function layerState(options: KeyLayerOptions): KeyLayerState<KeyboardEvent, Element> {
  const { scope } = options;
  return {
    kind: options.kind,
    active: options.active,
    fields: options.fields,
    phase: options.phase,
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

/**
 * Spread on the zone's element. A key that has no value is absent, not
 * `undefined`, so spreading the props after an attribute of your own keeps it.
 */
export interface NavZoneProps {
  readonly ref: (element: HTMLElement | null) => void;
  readonly role?: 'listbox' | 'tablist';
  readonly 'aria-orientation': ZoneOrientation;
  readonly 'aria-label'?: string;
  readonly 'data-keyboard-zone': '';
  readonly onKeyDown: (event: { readonly nativeEvent: KeyboardEvent }) => void;
}

/**
 * Spread on each item's element. A key that has no value is absent, not
 * `undefined`: a `role` or `aria-selected` the element carries from another
 * library survives the spread.
 */
export interface NavZoneItemProps {
  readonly ref: (element: HTMLElement | null) => void;
  readonly tabIndex: 0 | -1;
  readonly role?: 'option' | 'tab';
  readonly 'aria-selected'?: boolean;
  readonly 'aria-current'?: 'true';
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
 * Ref callbacks for the items of a zone, one per id, created once and dropped
 * when their element goes. A list whose ids change over time — a conversation
 * list that loads more, a table that pages — would otherwise keep a callback for
 * every id it ever showed.
 */
export function createItemRefs<Id extends ZoneItemId>(
  set: (id: Id, node: HTMLElement | null) => void,
): { get(id: Id): (node: HTMLElement | null) => void; readonly size: number } {
  const cache = new Map<Id, (node: HTMLElement | null) => void>();
  return {
    get(id) {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const created = (node: HTMLElement | null) => {
        set(id, node);
        // An element that is gone takes its callback with it; one that was
        // already replaced by a newer callback leaves the newer one alone.
        if (node === null && cache.get(id) === created) cache.delete(id);
      };
      cache.set(id, created);
      return created;
    },
    get size() {
      return cache.size;
    },
  };
}

/**
 * A list the arrows move through with real focus. See `zone.ts` for the
 * modes, the cross axis and what happens past an end.
 *
 * Rendering never changes the zone: the options of a render are adopted when it
 * commits, and the tab stop of a render is worked out from that render's own
 * options. A render React starts and throws away — a suspended transition, an
 * interrupted update — leaves the zone as the last committed render left it.
 */
export function useNavZone<Id extends ZoneItemId>(options: ZoneOptions<Id>): NavZone<Id> {
  const [zone] = useState(() => createNavZone(options));
  useCommittedEffect(() => {
    zone.update(options);
  });
  // Subscribed to the tab stop, not to the pointed item: moving focus to the item
  // that is already the tab stop renders nothing.
  useSyncExternalStore(zone.subscribe, zone.current, zone.current);
  // A value that is new in this render takes the pointed item back to the chosen
  // one when the render commits; the render shows that already.
  const value = options.value ?? null;
  const pointed = value === (zone.options.value ?? null) ? zone.pointedItem() : null;
  const current = options.items[resolveZoneIndex(options.items, value, pointed)] ?? null;
  const element = useRef<HTMLElement | null>(null);
  const [zoneRef] = useState(() => (node: HTMLElement | null) => {
    element.current = node;
  });
  const [itemRefs] = useState(() =>
    createItemRefs<Id>((id, node) => zone.setItemElement(id, node)),
  );

  useKeyLayer({
    kind: 'zone',
    active: options.active,
    scope: element,
    onKey: (event) => zone.keyFromOutside(event),
  });

  const role = options.role ?? 'listbox';
  const label = options.label;
  const itemRole = role === 'listbox' ? 'option' : role === 'tablist' ? 'tab' : undefined;

  return {
    zoneProps: {
      ref: zoneRef,
      'aria-orientation': options.orientation ?? 'vertical',
      [ZONE_ATTRIBUTE]: '',
      onKeyDown: (event) => {
        zone.keyDown(event.nativeEvent, element.current);
      },
      ...(role !== 'none' && { role }),
      ...(label !== undefined && { 'aria-label': label }),
    },
    itemProps: (id) => {
      const chosen = id === value;
      return {
        ref: itemRefs.get(id),
        tabIndex: id === current ? 0 : -1,
        onFocus: () => zone.focused(id),
        ...(itemRole !== undefined && { role: itemRole }),
        ...(role !== 'none' && { 'aria-selected': chosen }),
        ...(role === 'none' && chosen && { 'aria-current': 'true' as const }),
      };
    },
    element,
    current,
    focus: (id) => zone.focus(id),
  };
}
