import { describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import { TerminalGallery } from '../src/gallery/app';

const WIDTH = 100;
const HEIGHT = 34;

/** The gallery on a test terminal, driven by real key sequences. */
async function gallery() {
  let now = 1_000_000;
  const clock = () => now;
  const setup = await testRender(<TerminalGallery clock={clock} onExit={() => undefined} />, {
    width: WIDTH,
    height: HEIGHT,
  });
  const frame = async (): Promise<string> => {
    await act(async () => {
      await Bun.sleep(5);
    });
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const press = async (
    key: Parameters<typeof setup.mockInput.pressKey>[0],
    modifiers?: Parameters<typeof setup.mockInput.pressKey>[1],
  ) => {
    await act(async () => {
      setup.mockInput.pressKey(key, modifiers);
      await Bun.sleep(5);
    });
    return frame();
  };
  const type = async (text: string) => {
    await act(async () => {
      await setup.mockInput.typeText(text);
      await Bun.sleep(5);
    });
    return frame();
  };
  const advance = async (ms: number) => {
    now += ms;
    await act(async () => {
      await Bun.sleep(ms);
    });
    return frame();
  };
  const close = async () => {
    await act(async () => {
      await setup.dispose();
    });
  };
  const burst = (keys: Parameters<typeof setup.mockInput.pressKeys>[0]) =>
    setup.mockInput.pressKeys(keys);
  return { frame, press, type, advance, close, burst };
}

describe('terminal gallery', () => {
  test('a catalogue walks pick, search, form, errors, run and JSON result by keyboard', async () => {
    const g = await gallery();
    try {
      let screen = await g.frame();
      expect(screen).toContain('stitchkit-tui › Catalogue');
      expect(screen).toContain('Documents 5');
      expect(screen).toContain('› docs_read');
      expect(screen).toContain('Documents: read across every project');
      expect(screen).toMatch(/↑↓ move · Enter open/);

      screen = await g.type('qissues');
      expect(screen).toContain('⌕ qissues');
      expect(screen).toContain('› repo_query_issues');

      screen = await g.press('RETURN');
      expect(screen).toContain('Catalogue › repo_query_issues');
      expect(screen).toMatch(/› project \*/);
      expect(screen).toContain('‹ true ›');

      // Submitting an incomplete form lands on the first error.
      screen = await g.press('RETURN');
      expect(screen).toContain('Required');

      screen = await g.type('base');
      screen = await g.press('TAB');
      screen = await g.press('ARROW_RIGHT');
      expect(screen).toContain('‹ inbox ›');
      screen = await g.press('TAB');
      screen = await g.press('TAB');
      // After a submit, a field re-validates as it is typed.
      screen = await g.type('{"a":');
      expect(screen).toContain('Invalid JSON');
      screen = await g.type('1}');
      expect(screen).not.toContain('Invalid JSON');
      screen = await g.press('TAB', { shift: true });
      expect(screen).toMatch(/› dryRun/);

      screen = await g.press('RETURN');
      expect(screen).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo_query_issues/);

      screen = await g.advance(1300);
      expect(screen).toContain('"method": "repo_query_issues"');
      expect(screen).toContain('"status": "inbox"');
      expect(screen).toContain('repo_query_issues done');

      screen = await g.press('ESCAPE');
      expect(screen).toContain('› repo_query_issues');
    } finally {
      await g.close();
    }
  }, 30_000);

  test('a destructive method asks first, in the language the product chose', async () => {
    const g = await gallery();
    try {
      await g.press('l', { ctrl: true });
      let screen = await g.type('restart');
      expect(screen).toContain('› hosts_restart');
      screen = await g.press('RETURN');
      screen = await g.press('ARROW_RIGHT');
      screen = await g.press('RETURN');
      expect(screen).toContain('Да (y)');
      expect(screen).toContain('Нет (n)');
      screen = await g.press('n');
      expect(screen).toContain('machine *');
    } finally {
      await g.close();
    }
  }, 30_000);

  test('keys that arrive in one burst act on the latest state', async () => {
    const g = await gallery();
    try {
      // Down, down and Enter before any render in between open the third item.
      await act(async () => {
        await g.burst(['ARROW_DOWN', 'ARROW_DOWN', 'RETURN']);
      });
      const screen = await g.frame();
      expect(screen).toContain('Catalogue › docs_projects');
    } finally {
      await g.close();
    }
  }, 30_000);

  test('the monitor and widget pages draw their live widgets', async () => {
    const g = await gallery();
    try {
      let screen = await g.press('F2');
      expect(screen).toContain('stitchkit-tui › Monitor');
      expect(screen).toContain('NAME');
      expect(screen).toContain('CPU%▼');
      expect(screen).toContain('▾ service-1');
      screen = await g.press('F3');
      expect(screen).toContain('Progress');
      expect(screen).toContain('spinner dots');
      expect(screen).toContain('cpu  [');
      expect(screen).toContain('swap [');
      expect(screen).toContain('■ danger');
      expect(screen).toContain('https://example.invalid/a/very/lon…');
    } finally {
      await g.close();
    }
  }, 30_000);
});
