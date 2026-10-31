/**
 * Who gets a key: one listener, a fixed order of layers, and the innermost
 * layer of a kind first.
 *
 * A page with a menu, a dialog, a list and section shortcuts usually ends up
 * with a `keydown` listener per concern, and their order is the order they
 * happened to mount in: Escape closes the dialog and the page behind it, an
 * arrow in a dialog switches the section underneath. Here every concern is a
 * layer on one stack, asked in a fixed order until one of them takes the key:
 *
 *   overlay → local → route → zone → global
 *
 * - **overlay** — something modal. While one is live, nothing below it hears a
 *   key at all, handled or not.
 * - **local** — a component that has the user's attention without being modal:
 *   an open command menu, an editor's own mode.
 * - **route** — the page's "go up one level": Escape closes the open entity.
 * - **zone** — a list the keys move through when focus is not in any list
 *   (see `zone.ts`).
 * - **global** — shortcuts of the whole screen, such as switching sections.
 *
 * Within a kind the innermost layer wins: of two layers whose elements nest,
 * the inner one; otherwise the one activated last. React runs a child's effects
 * before its parent's, so activation order alone would let a page's layer
 * shadow the panel inside it when both mount together — the element tree is
 * what says which is inside which.
 *
 * The listener sits on the window, in the bubbling phase: everything closer to
 * the key — a widget's own `onKeyDown`, a text field, a popover that closes on
 * Escape — hears it first and keeps it by `preventDefault` or
 * `stopPropagation`. A layer only gets what nobody nearer wanted.
 *
 * One kind of layer is the exception: a `local` layer may ask for the capture
 * phase. A menu that hangs over a text field keeps focus in the field and wants
 * the arrows and Enter *before* the field acts on them; the field cannot be
 * made to wait, so the layer goes first and, when it takes a key, nothing nearer
 * hears it at all.
 */

export type KeyLayerKind = 'overlay' | 'local' | 'route' | 'zone' | 'global';

/** Where in the event's path a layer listens: after everything nearer, or before it. */
export type KeyLayerPhase = 'bubble' | 'capture';

const RANK: Readonly<Record<KeyLayerKind, number>> = {
  overlay: 4,
  local: 3,
  route: 2,
  zone: 1,
  global: 0,
};

/** The part of a `keydown` event the stack reads; a DOM `KeyboardEvent` is one. */
export interface LayerKeyEvent {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
  /** A DOM event has it; a layer that takes a key in the capture phase uses it. */
  stopPropagation?(): void;
}

/** The part of an element the stack reads to decide whether a layer is live and where it sits. */
export interface LayerScope<S> {
  readonly isConnected: boolean;
  contains(other: S | null): boolean;
  closest(selectors: string): unknown;
  checkVisibility?(): boolean;
}

/**
 * Where keys belong to the element rather than to the page: fields, controls
 * that move on arrows themselves, and any area marked `data-local-keys`.
 */
export const KEY_FIELD_SELECTOR = [
  'input:not([type=button],[type=submit],[type=reset],[type=checkbox],[type=image])',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable=false])',
  '[role=textbox]',
  '[role=combobox]',
  '[role=slider]',
  '[role=spinbutton]',
  '[data-local-keys]',
].join(',');

interface ClosestTarget {
  closest(selectors: string): unknown;
}

function hasClosest(target: unknown): target is ClosestTarget {
  return (
    typeof target === 'object' &&
    target !== null &&
    'closest' in target &&
    typeof target.closest === 'function'
  );
}

/** The nearest element matching `selectors` from an event target or an element, or `null`. */
export function closestFromTarget(target: unknown, selectors: string): unknown {
  return hasClosest(target) ? target.closest(selectors) : null;
}

/** The key was pressed in a field or an area that keeps its keys. */
export function isKeyFieldTarget(target: EventTarget | null): boolean {
  const field = closestFromTarget(target, KEY_FIELD_SELECTOR);
  return field !== null && field !== undefined;
}

export interface KeyLayerState<E extends LayerKeyEvent, S extends LayerScope<S>> {
  readonly kind: KeyLayerKind;
  /** Default `true`. A layer that is not active is skipped; becoming active puts it on top of its kind. */
  readonly active?: boolean;
  /**
   * The element the layer belongs to. Given, the layer is live only while the
   * element is connected, visible and outside any `inert` subtree, and it is
   * ordered by nesting against layers of its kind. `null` means "declared, not
   * mounted": the layer is skipped.
   */
  readonly scope?: () => S | null;
  /**
   * `'skip'` (default): keys pressed in a field or a `data-local-keys` area do
   * not reach the layer — except Escape, which a field that wants it keeps by
   * `preventDefault`. `'include'`: the layer hears them too.
   */
  readonly fields?: 'skip' | 'include';
  /**
   * Default `'bubble'`. `'capture'` is for a `local` layer only: it hears the key
   * before the element that has focus does, and a key it takes goes no further.
   */
  readonly phase?: KeyLayerPhase;
  /** Return `true` when the key was taken: its default is prevented and no layer below hears it. */
  onKey(event: E): boolean;
}

export interface KeyLayerHandle<E extends LayerKeyEvent, S extends LayerScope<S>> {
  update(state: KeyLayerState<E, S>): void;
  remove(): void;
}

/** Where the stack listens. A `Window` is one. */
export interface KeyListenerTarget<E> {
  addEventListener(type: 'keydown', listener: (event: E) => void, capture?: boolean): void;
  removeEventListener(type: 'keydown', listener: (event: E) => void, capture?: boolean): void;
}

export interface KeyLayerStack<E extends LayerKeyEvent, S extends LayerScope<S>> {
  add(state: KeyLayerState<E, S>): KeyLayerHandle<E, S>;
  /**
   * Offer one key to the layers that listen in `phase` (default `'bubble'`);
   * `true` when one took it. The installed listeners call this.
   */
  dispatch(event: E, phase?: KeyLayerPhase): boolean;
}

interface Entry<E extends LayerKeyEvent, S extends LayerScope<S>> {
  state: KeyLayerState<E, S>;
  order: number;
}

function liveScope<E extends LayerKeyEvent, S extends LayerScope<S>>(
  entry: Entry<E, S>,
): S | 'unscoped' | null {
  const read = entry.state.scope;
  if (read === undefined) return 'unscoped';
  const element = read();
  if (element === null || !element.isConnected) return null;
  const inert = element.closest('[inert]');
  if (inert !== null && inert !== undefined) return null;
  if (element.checkVisibility !== undefined && !element.checkVisibility()) return null;
  return element;
}

interface LiveLayer<E extends LayerKeyEvent, S extends LayerScope<S>> {
  entry: Entry<E, S>;
  scope: S | 'unscoped';
  depth: number;
}

/** Live layers in the order they are asked. */
function askingOrder<E extends LayerKeyEvent, S extends LayerScope<S>>(
  entries: Iterable<Entry<E, S>>,
): LiveLayer<E, S>[] {
  const live: LiveLayer<E, S>[] = [];
  for (const entry of entries) {
    if (entry.state.active === false) continue;
    const scope = liveScope(entry);
    if (scope !== null) live.push({ entry, scope, depth: 0 });
  }
  for (const layer of live) {
    const own = layer.scope;
    if (own === 'unscoped') continue;
    layer.depth = live.filter(
      (other) =>
        other !== layer &&
        other.entry.state.kind === layer.entry.state.kind &&
        other.scope !== 'unscoped' &&
        other.scope !== own &&
        other.scope.contains(own),
    ).length;
  }
  return live.sort(
    (left, right) =>
      RANK[right.entry.state.kind] - RANK[left.entry.state.kind] ||
      right.depth - left.depth ||
      right.entry.order - left.entry.order,
  );
}

/**
 * A stack listening on `target`. A listener is attached with the first layer of
 * its phase and detached with the last, so a page without layers carries none,
 * and a page with no capture layer carries no capture listener.
 */
export function createKeyLayerStack<E extends LayerKeyEvent, S extends LayerScope<S>>(
  target: KeyListenerTarget<E>,
): KeyLayerStack<E, S> {
  const entries = new Set<Entry<E, S>>();
  let activations = 0;
  const bubbling = (event: E) => {
    dispatch(event, 'bubble');
  };
  const capturing = (event: E) => {
    dispatch(event, 'capture');
  };
  const attached = { bubble: false, capture: false };

  const phaseOf = (state: KeyLayerState<E, S>): KeyLayerPhase => state.phase ?? 'bubble';

  /** Attach the listener of every phase that has a layer, detach the others. */
  function sync(): void {
    for (const phase of ['bubble', 'capture'] as const) {
      const wanted = [...entries].some((entry) => phaseOf(entry.state) === phase);
      if (wanted === attached[phase]) continue;
      attached[phase] = wanted;
      const listener = phase === 'capture' ? capturing : bubbling;
      if (wanted) target.addEventListener('keydown', listener, phase === 'capture');
      else target.removeEventListener('keydown', listener, phase === 'capture');
    }
  }

  function refuseUnlessLocal(state: KeyLayerState<E, S>): void {
    if (phaseOf(state) === 'capture' && state.kind !== 'local') {
      throw new Error(
        `A ${state.kind} layer cannot listen in the capture phase; only a local layer can`,
      );
    }
  }

  function dispatch(event: E, phase: KeyLayerPhase = 'bubble'): boolean {
    if (event.defaultPrevented || event.isComposing) return false;
    const isEscape = event.key === 'Escape';
    // Holding Escape repeats it; one press closes one level.
    if (isEscape && event.repeat) return false;
    const inField = !isEscape && isKeyFieldTarget(event.target);
    let behindOverlay = false;
    for (const { entry } of askingOrder(entries)) {
      const { kind } = entry.state;
      // A live overlay is a barrier for every layer below it, whichever phase either is in.
      if (behindOverlay && kind !== 'overlay') break;
      if (kind === 'overlay') behindOverlay = true;
      if (phaseOf(entry.state) !== phase) continue;
      if (inField && entry.state.fields !== 'include') continue;
      if (entry.state.onKey(event)) {
        event.preventDefault();
        // Taken before the element that has focus: it must not act on the key as well.
        if (phase === 'capture') event.stopPropagation?.();
        return true;
      }
    }
    return false;
  }

  function add(state: KeyLayerState<E, S>): KeyLayerHandle<E, S> {
    refuseUnlessLocal(state);
    const entry: Entry<E, S> = { state, order: ++activations };
    entries.add(entry);
    sync();
    return {
      update(next) {
        refuseUnlessLocal(next);
        const reactivated = entry.state.active === false && next.active !== false;
        const moved = phaseOf(entry.state) !== phaseOf(next);
        entry.state = next;
        if (reactivated) entry.order = ++activations;
        if (moved) sync();
      },
      remove() {
        if (!entries.delete(entry)) return;
        sync();
      },
    };
  }

  return { add, dispatch };
}
