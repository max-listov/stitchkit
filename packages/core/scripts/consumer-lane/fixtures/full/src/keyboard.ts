import { type NavZoneOptions, nextZoneIndex, useNavZone } from 'stitchkit/react/keyboard';

const chats: NavZoneOptions<string> = {
  items: ['general', 'support'],
  value: 'general',
  onChange: () => undefined,
  mode: 'highlight',
  onBoundary: (side) => side === 'end',
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
