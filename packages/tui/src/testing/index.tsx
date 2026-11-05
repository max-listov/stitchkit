/**
 * `stitchkit-tui/testing` — drive a screen on a test terminal by real keys.
 *
 * Every step runs inside React's `act`, so the effects of the screen a key
 * opened — its keyboard subscription included — have run before the next key
 * arrives, and a lone Esc waits out the input parser's escape timeout before
 * the frame is read. A test reads like a session: press, type, look.
 */
import { testRender } from '@opentui/react/test-utils';
import { act, type ReactNode } from 'react';
import { type TerminalLabels, terminalLabelsEn } from '../core/labels';
import type { TerminalPalette, TerminalThemeMode } from '../core/theme';
import { TerminalErrorBoundary } from '../widgets/app';
import { TerminalLabelsProvider } from '../widgets/context';
import { TerminalThemeProvider } from '../widgets/theme';

type TestSetup = Awaited<ReturnType<typeof testRender>>;
type MockInput = TestSetup['mockInput'];

/** A key as the renderer's mock input names it: `'RETURN'`, `'ESCAPE'`, `'ARROW_DOWN'`, `'a'`. */
export type TerminalTestKey = Parameters<MockInput['pressKey']>[0];
export type TerminalTestModifiers = Parameters<MockInput['pressKey']>[1];

export interface TerminalTestOptions {
  width?: number;
  height?: number;
  /** A fixed palette by default: a test must not depend on the terminal it runs in. */
  themeMode?: TerminalThemeMode;
  palette?: Partial<TerminalPalette>;
  labels?: TerminalLabels;
  /** How long a lone Esc waits for the parser to give it up as a key (its own timeout is 20 ms). */
  escapeDelayMs?: number;
}

export interface TerminalTestScreen {
  /** The current frame as text, after pending effects and timers have run. */
  frame(): Promise<string>;
  press(key: TerminalTestKey, modifiers?: TerminalTestModifiers): Promise<string>;
  /** Keys that reach the screen in one burst, with no render between them. */
  burst(keys: readonly TerminalTestKey[]): Promise<string>;
  /** Type text one character at a time; returns the frame after the last one. */
  type(text: string): Promise<string>;
  /** Let `ms` of real time pass (timers, spinners) and return the frame. */
  advance(ms: number): Promise<string>;
  /** Resolve with the first frame that contains `text`, or fail with the last frame seen. */
  waitForText(text: string, options?: { timeoutMs?: number }): Promise<string>;
  resize(width: number, height: number): Promise<string>;
  close(): Promise<void>;
  /** The underlying OpenTUI test renderer, for what the helpers do not cover. */
  setup: TestSetup;
}

const SETTLE_MS = 5;

/** Render a screen inside the kit's providers on a test terminal. */
export async function renderTerminalTest(
  screen: ReactNode,
  options: TerminalTestOptions = {},
): Promise<TerminalTestScreen> {
  const escapeDelayMs = options.escapeDelayMs ?? 40;
  let setup: TestSetup | undefined;
  await act(async () => {
    setup = await testRender(
      <TerminalThemeProvider
        mode={options.themeMode ?? 'dark'}
        {...(options.palette && { palette: options.palette })}
      >
        <TerminalLabelsProvider labels={options.labels ?? terminalLabelsEn}>
          <TerminalErrorBoundary>{screen}</TerminalErrorBoundary>
        </TerminalLabelsProvider>
      </TerminalThemeProvider>,
      { width: options.width ?? 80, height: options.height ?? 24 },
    );
  });
  if (!setup) throw new Error('testRender did not return a renderer');
  const test = setup;
  const settle = async (ms: number): Promise<void> => {
    await act(async () => {
      await Bun.sleep(ms);
    });
  };
  const frame = async (): Promise<string> => {
    await settle(SETTLE_MS);
    await act(async () => {
      await test.renderOnce();
    });
    return test.captureCharFrame();
  };
  return {
    setup: test,
    frame,
    async press(key, modifiers) {
      await act(async () => {
        test.mockInput.pressKey(key, modifiers);
        await Bun.sleep(key === 'ESCAPE' && !modifiers ? escapeDelayMs : SETTLE_MS);
      });
      return frame();
    },
    async burst(keys) {
      await act(async () => {
        await test.mockInput.pressKeys([...keys]);
      });
      return frame();
    },
    async type(text) {
      for (const character of Array.from(text)) {
        await act(async () => {
          test.mockInput.pressKey(character);
          await Bun.sleep(0);
        });
      }
      return frame();
    },
    async advance(ms) {
      await settle(ms);
      return frame();
    },
    async waitForText(text, { timeoutMs = 1000 } = {}) {
      const deadline = performance.now() + timeoutMs;
      let last = await frame();
      while (!last.includes(text)) {
        if (performance.now() > deadline) {
          throw new Error(
            `"${text}" did not appear within ${timeoutMs} ms; last frame:\n${last}`,
          );
        }
        last = await frame();
      }
      return last;
    },
    async resize(width, height) {
      await act(async () => {
        test.resize(width, height);
      });
      return frame();
    },
    async close() {
      await act(async () => {
        await test.dispose();
      });
    },
  };
}
