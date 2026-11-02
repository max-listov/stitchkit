import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, createElement, type ReactNode } from 'react';
import type { createRoot as CreateRoot } from 'react-dom/client';
import { useNavZone, type ZoneOptions } from '../src/entrypoints/react/keyboard';
import { runNativeCommand } from '../src/process/command';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();

function Zone({ options }: { readonly options: ZoneOptions<string> }): ReactNode {
  const zone = useNavZone(options);
  return createElement(
    'div',
    zone.zoneProps,
    options.items.map((id) =>
      createElement(
        id === 'link' ? 'a' : 'button',
        { key: id, href: id === 'link' ? '#destination' : undefined, ...zone.itemProps(id) },
        id,
      ),
    ),
  );
}

test('the installed native-semantics proof holds on source', async () => {
  const result = await runNativeCommand({
    executable: process.execPath,
    args: [
      fileURLToPath(
        new URL(
          '../scripts/consumer-lane/fixtures/full/src/keyboard-native-semantics.mjs',
          import.meta.url,
        ),
      ),
      new URL('../src/entrypoints/react/keyboard.ts', import.meta.url).href,
    ],
    envPolicy: 'ambient',
    capture: true,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    onLeaderStarted: trackGroupLeader,
  });
  expect(new TextDecoder().decode(result.stderr)).toBe('');
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain(
    'packed keyboard native semantics: ok',
  );
}, 15_000);

let createRoot: typeof CreateRoot;
const mounted = new Set<() => void>();

beforeAll(async () => {
  GlobalRegistrator.register();
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  ({ createRoot } = await import('react-dom/client'));
});

afterEach(() => {
  for (const unmount of mounted) unmount();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test('DOM role changes remove orientation and preserve native link/button props and roving focus', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  const show = (options: ZoneOptions<string>) =>
    act(() => root.render(createElement(Zone, { options })));
  show({
    items: ['link', 'button'],
    mode: 'focus',
    role: 'tablist',
    orientation: 'horizontal',
  });
  const group = container.firstElementChild;
  expect(group?.getAttribute('aria-orientation')).toBe('horizontal');
  expect(group?.getAttribute('role')).toBe('tablist');
  show({ items: ['link', 'button'], role: 'none', mode: 'focus' });
  expect(group?.hasAttribute('role')).toBe(false);
  expect(group?.hasAttribute('aria-orientation')).toBe(false);
  const link = container.querySelector('a');
  const button = container.querySelector('button');
  if (link === null || button === null) throw new Error('native controls missing');
  expect(link.getAttribute('href')).toBe('#destination');
  expect(link.hasAttribute('role')).toBe(false);
  expect(button.hasAttribute('role')).toBe(false);
  expect(button.hasAttribute('aria-selected')).toBe(false);
  act(() => link.focus());
  act(() => {
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  expect(document.activeElement).toBe(button);
  expect(link.tabIndex).toBe(-1);
  expect(button.tabIndex).toBe(0);
  const enter = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    button.dispatchEvent(enter);
  });
  expect(enter.defaultPrevented).toBe(false);
  show({ items: ['link', 'button'], mode: 'focus' });
  expect(group?.getAttribute('role')).toBe('listbox');
  expect(group?.getAttribute('aria-orientation')).toBe('vertical');
  expect(button.getAttribute('role')).toBe('option');
  unmount();
});
