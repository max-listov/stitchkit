/**
 * Keyboard layers and zones without a DOM, a browser or React.
 *
 * The stack and the zone controller are plain objects that read a few members
 * of an element and of a key event. This file is those members as fakes: a
 * window that remembers its listener, elements with a parent, `inert` and
 * visibility, key events with `preventDefault`. A test builds the layers a
 * screen declares, presses keys on elements, and reads who heard what — the
 * order of layers, `scope` and `inert`, the edges of a zone — in milliseconds.
 *
 * What it cannot show is a real focus ring, scrolling or a screen reader; that
 * is a browser's.
 */
import {
  createKeyLayerStack,
  KEY_FIELD_SELECTOR,
  type KeyLayerStack,
  type KeyListenerTarget,
  type LayerScope,
} from './layers';
import { ZONE_ATTRIBUTE, type ZoneItemElement, type ZoneKeyEvent } from './zone';

export interface TestElementInit {
  /** The element this one is inside. */
  readonly parent?: TestElement;
  /** An input, text area or combobox: it keeps its own keys. */
  readonly field?: boolean;
  /** An area marked `data-local-keys`. */
  readonly localKeys?: boolean;
  /** The element of a zone (`data-keyboard-zone`). */
  readonly zone?: boolean;
  /** Inside an `inert` subtree, or itself `inert`. Change it later with `element.inert`. */
  readonly inert?: boolean;
  /** Not visible (`checkVisibility()` is `false`). Change it later with `element.hidden`. */
  readonly hidden?: boolean;
}

/** An element as the stack and the zone read it. Also a zone's item: it counts the focus it gets. */
export interface TestElement extends LayerScope<TestElement>, ZoneItemElement, EventTarget {
  readonly parent: TestElement | null;
  isConnected: boolean;
  inert: boolean;
  hidden: boolean;
  /** How many times `focus()` was called on it. */
  focusCount: number;
  /** How many times it was scrolled into view. */
  scrollCount: number;
  /** A new element inside this one. */
  child(init?: Omit<TestElementInit, 'parent'>): TestElement;
}

export interface TestKeyInit {
  readonly target?: EventTarget | null;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

/** A `keydown` as the stack and the zone read it. */
export interface TestKeyEvent extends ZoneKeyEvent {
  defaultPrevented: boolean;
  /** A layer took the key in the capture phase, so nothing nearer — the field — would hear it. */
  readonly propagationStopped: boolean;
  stopPropagation(): void;
}

export interface KeyboardTestBed {
  /** The stack, on a window that is not one: add layers to it as the hooks do. */
  readonly stack: KeyLayerStack<TestKeyEvent, TestElement>;
  /** Whether a window listener is attached: with the first layer, off with the last. */
  readonly listening: boolean;
  /** Whether the capture-phase listener is attached: only while a layer asks for that phase. */
  readonly listeningInCapture: boolean;
  element(init?: TestElementInit): TestElement;
  /** A key event, not yet pressed. Hand it to `zone.keyDown(event, zoneElement)`. */
  key(name: string, init?: TestKeyInit): TestKeyEvent;
  /**
   * Press a key on `init.target` through the window listeners: the capture
   * phase first, then — unless a layer took the key there — the bubble phase.
   * `event.defaultPrevented` is "a layer took it".
   */
  press(name: string, init?: TestKeyInit): TestKeyEvent;
}

class FakeElement extends EventTarget implements TestElement {
  isConnected = true;
  inert: boolean;
  hidden: boolean;
  focusCount = 0;
  scrollCount = 0;
  readonly parent: TestElement | null;
  private readonly marks: ReadonlySet<string>;

  constructor(init: TestElementInit = {}) {
    super();
    this.parent = init.parent ?? null;
    this.inert = init.inert ?? false;
    this.hidden = init.hidden ?? false;
    const marks = new Set<string>();
    if (init.field === true || init.localKeys === true) marks.add(KEY_FIELD_SELECTOR);
    if (init.zone === true) marks.add(`[${ZONE_ATTRIBUTE}]`);
    this.marks = marks;
  }

  contains(other: TestElement | null): boolean {
    for (let node = other; node !== null; node = node.parent) if (node === this) return true;
    return false;
  }

  closest(selectors: string): TestElement | null {
    for (let node: TestElement | null = this; node !== null; node = node.parent) {
      if (node instanceof FakeElement && node.matches(selectors)) return node;
    }
    return null;
  }

  private matches(selectors: string): boolean {
    return selectors === '[inert]' ? this.inert : this.marks.has(selectors);
  }

  checkVisibility(): boolean {
    return !this.hidden;
  }

  focus(): void {
    this.focusCount += 1;
  }

  scrollIntoView(): void {
    this.scrollCount += 1;
  }

  child(init: Omit<TestElementInit, 'parent'> = {}): TestElement {
    return new FakeElement({ ...init, parent: this });
  }
}

class FakeKey implements TestKeyEvent {
  defaultPrevented = false;
  propagationStopped = false;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly target: EventTarget | null;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;

  constructor(
    readonly key: string,
    init: TestKeyInit = {},
  ) {
    this.repeat = init.repeat ?? false;
    this.isComposing = init.isComposing ?? false;
    this.target = init.target ?? null;
    this.altKey = init.altKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeWindow implements KeyListenerTarget<TestKeyEvent> {
  readonly bubbling = new Set<(event: TestKeyEvent) => void>();
  readonly capturing = new Set<(event: TestKeyEvent) => void>();
  addEventListener(
    _type: 'keydown',
    listener: (event: TestKeyEvent) => void,
    capture = false,
  ): void {
    (capture ? this.capturing : this.bubbling).add(listener);
  }
  removeEventListener(
    _type: 'keydown',
    listener: (event: TestKeyEvent) => void,
    capture = false,
  ): void {
    (capture ? this.capturing : this.bubbling).delete(listener);
  }
}

/** A fresh stack, window, element and key factory for one test. */
export function createKeyboardTestBed(): KeyboardTestBed {
  const view = new FakeWindow();
  const stack = createKeyLayerStack<TestKeyEvent, TestElement>(view);
  return {
    stack,
    get listening() {
      return view.bubbling.size + view.capturing.size > 0;
    },
    get listeningInCapture() {
      return view.capturing.size > 0;
    },
    element: (init) => new FakeElement(init),
    key: (name, init) => new FakeKey(name, init),
    press(name, init) {
      const event = new FakeKey(name, init);
      for (const listener of view.capturing) listener(event);
      // A key taken before the element that has focus goes no further.
      if (event.propagationStopped) return event;
      for (const listener of view.bubbling) listener(event);
      return event;
    },
  };
}

export {
  createKeyLayerStack,
  type KeyLayerHandle,
  type KeyLayerStack,
  type KeyLayerState,
  type KeyListenerTarget,
  type LayerKeyEvent,
  type LayerScope,
} from './layers';
export { createNavZone, type NavZoneController, type ZoneItemElement } from './zone';
