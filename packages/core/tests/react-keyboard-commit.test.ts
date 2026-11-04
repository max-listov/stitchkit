import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useEscapeLayer, useKeyLayer } from '../src/entrypoints/react/keyboard';
import { runNativeCommand } from '../src/process/command';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();

function ServerLayer() {
  useKeyLayer({ kind: 'route', onKey: () => true });
  useEscapeLayer({ kind: 'overlay', onEscape: () => true });
  return createElement('span', null, 'server');
}

test('key and Escape layers render on the server without DOM globals', () => {
  expect(typeof window).toBe('undefined');
  expect(typeof document).toBe('undefined');
  expect(renderToStaticMarkup(createElement(ServerLayer))).toBe('<span>server</span>');
});

test('committed layers handle keys before passive effects and ignore abandoned renders', async () => {
  const result = await runNativeCommand({
    executable: process.execPath,
    args: [
      fileURLToPath(
        new URL(
          '../scripts/consumer-lane/fixtures/full/src/keyboard-layer-commit.mjs',
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
    'packed keyboard layer commit: ok',
  );
}, 15_000);
