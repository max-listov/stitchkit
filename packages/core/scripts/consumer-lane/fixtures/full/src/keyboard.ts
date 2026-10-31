import {
  type FocusZoneOptions,
  type KeyLayerPhase,
  mergeRefs,
  type NavZoneOptions,
  nextZoneIndex,
  openedByKeyboard,
  useKeyLayer,
  useNavZone,
  type ZoneKeyEvent,
  type ZoneOptions,
} from 'stitchkit/react/keyboard';
import { createKeyboardTestBed, createNavZone } from 'stitchkit/react/keyboard/testing';

const chats: NavZoneOptions<string> = {
  items: ['general', 'support'],
  value: 'general',
  onChange: () => undefined,
  mode: 'highlight',
  onBoundary: (side) => side === 'end',
};

// Links and buttons choose for themselves; a drag the application runs is not the zone's key.
const toolbar: FocusZoneOptions<string> = {
  items: ['bold', 'italic'],
  mode: 'focus',
  outside: 'move',
  role: 'none',
  ignore: (event: ZoneKeyEvent) =>
    event.target instanceof Element && event.target.closest('[aria-pressed="true"]') !== null,
};

export const landed: number | 'before-start' | 'after-end' = nextZoneIndex({
  length: chats.items.length,
  index: 0,
  move: 'next',
  loop: false,
});

export function useChatsOrientation(): 'vertical' | 'horizontal' {
  return useNavZone(chats).zoneProps['aria-orientation'];
}

/** A union of both options shapes is one argument; the props carry optional keys, and a ref merges. */
export function useAnyZone(options: ZoneOptions<string>): {
  readonly ref: (node: HTMLElement | null) => void;
  readonly role: 'option' | 'tab' | undefined;
  readonly byKeyboard: boolean;
} {
  const zone = useNavZone(options);
  const props = zone.itemProps('bold');
  return {
    ref: mergeRefs(props.ref, undefined),
    role: props.role,
    byKeyboard: openedByKeyboard(),
  };
}

export const toolbarRole = useNavZone;
export const toolbarOptions = toolbar;

// The same engines, without React or a DOM.
const bed = createKeyboardTestBed();
const zoneElement = bed.element({ zone: true });
const zone = createNavZone<string>({ items: ['a', 'b'], mode: 'focus' });
zone.setItemElement('a', zoneElement.child());
export const arrowTaken: boolean = zone.keyDown(
  bed.key('ArrowDown', { target: zoneElement }),
  zoneElement,
);

/** A menu over a text field listens before the field does; only a local layer can. */
const menuPhase: KeyLayerPhase = 'capture';
export function useCommandMenu(open: boolean): void {
  useKeyLayer({
    kind: 'local',
    phase: menuPhase,
    fields: 'include',
    active: open,
    onKey: (event) => event.key === 'Enter',
  });
}
