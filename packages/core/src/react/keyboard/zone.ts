/**
 * A list the arrow keys move through — with real focus.
 *
 * A zone is an ordered set of items, one of which is the tab stop (roving
 * tabindex): Tab enters the zone at that item, the arrows move DOM focus
 * between items, Tab leaves. Focus is the browser's own, so a screen reader
 * follows it, `:focus-visible` draws it and the browser scrolls to it; there is
 * no second "highlighted" state beside focus for a page to keep in sync.
 *
 * Two modes, by what moving means:
 *
 * - **select** — moving is choosing: the arrow calls `onChange(id, 'arrow')`
 *   (a sidebar whose item opens as you move).
 * - **highlight** — moving only points; Enter chooses with
 *   `onChange(id, 'confirm')` (a list where opening is expensive).
 *
 * Each zone keeps its own pointed item, so two zones on a page never share one.
 * The cross axis leaves the zone on purpose: `onEnter` (→ in a vertical zone)
 * goes into what the item opens, `onExit` (←) back out; past either end the
 * zone either loops or hands the key to `onBoundary`. A key the zone does not
 * take bubbles on — to the layers, where a section switch may want it.
 *
 * This file has no framework in it: `useNavZone` is a thin React binding.
 */
import { closestFromTarget, isKeyFieldTarget, type LayerKeyEvent } from './layers';

export type ZoneOrientation = 'vertical' | 'horizontal';
export type ZoneMove = 'next' | 'previous' | 'first' | 'last';
export type ZoneIntent =
  | { readonly type: 'move'; readonly move: ZoneMove }
  | { readonly type: 'enter' }
  | { readonly type: 'exit' }
  | { readonly type: 'confirm' };

/** Marks a zone's element; a key pressed inside it belongs to that zone. */
export const ZONE_ATTRIBUTE = 'data-keyboard-zone';

export interface NextZoneIndexInput {
  readonly length: number;
  /** The current index; `-1` when nothing is current. */
  readonly index: number;
  readonly move: ZoneMove;
  readonly loop: boolean;
}

/**
 * Where a move lands: an index, or the end it ran past. From nothing current,
 * `next` lands on the first item and `previous` on the last. An empty zone has
 * no index: every move runs past an end.
 */
export function nextZoneIndex({
  length,
  index,
  move,
  loop,
}: NextZoneIndexInput): number | 'before-start' | 'after-end' {
  if (length <= 0)
    return move === 'previous' || move === 'first' ? 'before-start' : 'after-end';
  if (move === 'first') return 0;
  if (move === 'last') return length - 1;
  if (index < 0 || index >= length) return move === 'next' ? 0 : length - 1;
  const target = move === 'next' ? index + 1 : index - 1;
  if (target >= 0 && target < length) return target;
  if (loop) return target < 0 ? length - 1 : 0;
  return target < 0 ? 'before-start' : 'after-end';
}

export interface ZoneKey {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** What a key means to a zone of this orientation; `null` for keys a zone leaves alone. */
export function zoneIntent(event: ZoneKey, orientation: ZoneOrientation): ZoneIntent | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const vertical = orientation === 'vertical';
  switch (event.key) {
    case vertical ? 'ArrowDown' : 'ArrowRight':
      return { type: 'move', move: 'next' };
    case vertical ? 'ArrowUp' : 'ArrowLeft':
      return { type: 'move', move: 'previous' };
    case vertical ? 'ArrowRight' : 'ArrowDown':
      return { type: 'enter' };
    case vertical ? 'ArrowLeft' : 'ArrowUp':
      return { type: 'exit' };
    case 'Home':
      return { type: 'move', move: 'first' };
    case 'End':
      return { type: 'move', move: 'last' };
    case 'Enter':
      return { type: 'confirm' };
    default:
      return null;
  }
}

export type ZoneItemId = string | number;
export type ZoneChangeCause = 'arrow' | 'confirm';

export interface NavZoneOptions<Id extends ZoneItemId> {
  /** The items in order. An id not listed here has no place in the zone. */
  readonly items: readonly Id[];
  /** The chosen item, or `null`. The zone never holds it: it reports changes. */
  readonly value: Id | null;
  onChange(id: Id, cause: ZoneChangeCause): void;
  /** Default `'select'`. */
  readonly mode?: 'select' | 'highlight';
  /** Default `'vertical'`. */
  readonly orientation?: ZoneOrientation;
  /**
   * Default `'listbox'`: the zone is a listbox and its items options, marked
   * `aria-selected`. `'tablist'`: tabs. `'none'`: the items keep their own
   * semantics (links, buttons) and the chosen one is marked `aria-current`.
   */
  readonly role?: 'listbox' | 'tablist' | 'none';
  /** Default `false`: moving past an end goes to `onBoundary`. `true`: it wraps. */
  readonly loop?: boolean;
  /**
   * The cross-axis forward key (→ in a vertical zone), and Enter in select
   * mode. Returning `false` leaves the key to the page; anything else takes it —
   * so do `onExit` and `onBoundary`.
   */
  onEnter?(id: Id): unknown;
  /** The cross-axis backward key (← in a vertical zone). */
  onExit?(): unknown;
  /** A move past an end of a zone that does not loop. */
  onBoundary?(side: 'start' | 'end'): unknown;
  /**
   * Default `true`. An active zone takes its arrows when focus is in no zone
   * at all — the first arrow on a page puts focus on the zone's current item.
   * Of several active zones the innermost, then the last activated, does.
   */
  readonly active?: boolean;
  /** The zone's accessible name. */
  readonly label?: string;
  /**
   * Focus went to an item that has no element yet — a row of a virtualized
   * list outside the rendered range. Scroll it in; focus lands on it as soon as
   * its element mounts.
   */
  onReveal?(id: Id): void;
}

/** The part of an item element the zone drives. An `HTMLElement` is one. */
export interface ZoneItemElement {
  focus(options?: { preventScroll?: boolean }): void;
  scrollIntoView?(options?: { block?: 'nearest'; inline?: 'nearest' }): void;
}

export interface ZoneKeyEvent extends LayerKeyEvent, ZoneKey {}

export interface NavZoneController<Id extends ZoneItemId> {
  update(options: NavZoneOptions<Id>): void;
  readonly options: NavZoneOptions<Id>;
  /** The tab stop: the pointed item, else the chosen one, else the first. */
  current(): Id | null;
  /** A key pressed inside the zone's element (`zone` is that element). `true` when taken. */
  keyDown(event: ZoneKeyEvent, zone: unknown): boolean;
  /** A key pressed outside every zone, offered by the zone's layer. `true` when taken. */
  keyFromOutside(event: ZoneKeyEvent): boolean;
  /** An item received focus by any means — a click, Tab, a move. */
  focused(id: Id): void;
  /**
   * Put focus on `id`, or on the current item — now, or when its element mounts.
   * `false` when there is no item to focus.
   */
  focus(id?: Id): boolean;
  setItemElement(id: Id, element: ZoneItemElement | null): void;
  subscribe(listener: () => void): () => void;
}

export function createNavZone<Id extends ZoneItemId>(
  initial: NavZoneOptions<Id>,
): NavZoneController<Id> {
  let options = initial;
  let pointed: Id | null = null;
  /** An item focus was sent to before its element existed. */
  let awaiting: Id | null = null;
  const elements = new Map<Id, ZoneItemElement>();
  const listeners = new Set<() => void>();

  const point = (id: Id | null) => {
    if (pointed === id) return;
    pointed = id;
    for (const listener of listeners) listener();
  };

  function current(): Id | null {
    const { items, value } = options;
    if (pointed !== null && items.includes(pointed)) return pointed;
    if (value !== null && items.includes(value)) return value;
    return items[0] ?? null;
  }

  function focusElement(element: ZoneItemElement): void {
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function focus(id?: Id): boolean {
    const target = id ?? current();
    if (target === null) return false;
    point(target);
    const element = elements.get(target);
    if (element === undefined) {
      awaiting = target;
      options.onReveal?.(target);
      return true;
    }
    awaiting = null;
    focusElement(element);
    return true;
  }

  const taken = (answer: unknown) => answer !== false;

  function apply(intent: ZoneIntent): boolean {
    const { items, mode = 'select', loop = false } = options;
    const id = current();
    switch (intent.type) {
      case 'move': {
        const index = id === null ? -1 : items.indexOf(id);
        const landed = nextZoneIndex({ length: items.length, index, move: intent.move, loop });
        if (typeof landed !== 'number') {
          if (options.onBoundary === undefined) return false;
          return taken(options.onBoundary(landed === 'before-start' ? 'start' : 'end'));
        }
        const next = items[landed];
        if (next === undefined) return false;
        focus(next);
        if (mode === 'select' && next !== options.value) options.onChange(next, 'arrow');
        return true;
      }
      case 'enter':
        return id !== null && options.onEnter !== undefined && taken(options.onEnter(id));
      case 'exit':
        return options.onExit !== undefined && taken(options.onExit());
      case 'confirm':
        if (id === null) return false;
        if (mode === 'highlight') {
          options.onChange(id, 'confirm');
          return true;
        }
        return options.onEnter !== undefined && taken(options.onEnter(id));
    }
  }

  return {
    update(next) {
      if (next.value !== options.value) pointed = null;
      options = next;
    },
    get options() {
      return options;
    },
    current,
    keyDown(event, zone) {
      if (event.defaultPrevented || event.isComposing || isKeyFieldTarget(event.target)) {
        return false;
      }
      // A zone nested inside this one had the key first and left it.
      if (closestFromTarget(event.target, `[${ZONE_ATTRIBUTE}]`) !== zone) return false;
      const intent = zoneIntent(event, options.orientation ?? 'vertical');
      if (intent === null || !apply(intent)) return false;
      event.preventDefault();
      return true;
    },
    keyFromOutside(event) {
      if (closestFromTarget(event.target, `[${ZONE_ATTRIBUTE}]`) !== null) return false;
      const intent = zoneIntent(event, options.orientation ?? 'vertical');
      if (intent?.type !== 'move' || (intent.move !== 'next' && intent.move !== 'previous')) {
        return false;
      }
      return focus();
    },
    focused(id) {
      if (!options.items.includes(id)) return;
      awaiting = null;
      point(id);
    },
    focus,
    setItemElement(id, element) {
      if (element === null) {
        elements.delete(id);
        return;
      }
      elements.set(id, element);
      if (id === awaiting) {
        awaiting = null;
        focusElement(element);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
