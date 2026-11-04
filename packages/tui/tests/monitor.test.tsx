import { describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';
import {
  createMonitorStore,
  MONITOR_HEIGHT,
  MONITOR_WIDTH,
  Monitor,
  type MonitorOptions,
} from './fixtures/monitor';

/** The line each landmark of the screen sits on, and how many lines carry text. */
function landmarks(frame: string): Record<string, number> {
  const lines = frame.split('\n');
  const find = (pattern: RegExp): number => lines.findIndex((line) => pattern.test(line));
  return {
    tabs: find(/1 Processes/),
    meters: find(/cpu0 /),
    lastMeters: find(/cpu3 /),
    axis: find(/-1m .*now/),
    header: find(/NAME .*PID .*CPU%/),
    footer: find(/\d+ of \d+ rows/),
  };
}

interface Run {
  frames: Record<string, number>[];
  cells: number[];
  heap: number[];
  rss: number[];
  historyLength: number;
  first: string;
  last: string;
}

/** Feed the fixture `ticks` updates, one rendered frame each, the way a 1 s monitor does. */
async function run(
  ticks: number,
  options: MonitorOptions = {},
  measureAt: number[] = [],
): Promise<Run> {
  const store = createMonitorStore(options);
  const setup = await testRender(<Monitor store={store} options={options} />, {
    width: MONITOR_WIDTH,
    height: MONITOR_HEIGHT,
  });
  try {
    await setup.renderOnce();
    const result: Run = {
      frames: [],
      cells: [],
      heap: [],
      rss: [],
      historyLength: 0,
      first: setup.captureCharFrame(),
      last: '',
    };
    for (let tick = 1; tick <= ticks; tick += 1) {
      act(() => store.tick());
      await setup.renderOnce();
      // React's development build records a measure with a props diff for every
      // render and Bun keeps them all (about 90 KB per table render). That is the
      // test runtime's growth, not the screen's: production React records none.
      performance.clearMeasures();
      const frame = setup.captureCharFrame();
      result.frames.push(landmarks(frame));
      result.cells.push(setup.getNativeStats().cellsUpdated);
      if (measureAt.includes(tick)) {
        Bun.gc(true);
        const usage = process.memoryUsage();
        result.heap.push(usage.heapUsed);
        result.rss.push(usage.rss);
      }
      result.last = frame;
    }
    result.historyLength = store.snapshot().cpu.samples.length;
    return result;
  } finally {
    // The renderer unmounts the React root as it is destroyed; inside act, as React expects.
    await act(async () => {
      await setup.dispose();
    });
  }
}

/** Every frame puts every landmark on the line it held in the first frame. */
function layoutHolds(frames: Record<string, number>[]): boolean {
  const first = frames[0];
  if (!first || Object.values(first).some((line) => line < 0)) return false;
  return frames.every((frame) => JSON.stringify(frame) === JSON.stringify(first));
}

const SCREEN = MONITOR_WIDTH * MONITOR_HEIGHT;

describe('live monitor fixture', () => {
  test('draws the tree table, sixteen meters, two charts and tabs', async () => {
    const { first, last } = await run(3);
    expect(first).toContain('1 Processes 1000');
    expect(last).toContain('cpu15');
    expect(last).toMatch(/▾ service-\d+/);
    expect(last).toMatch(/worker-\d/);
    expect(last).toContain('—');
    expect(last).toMatch(/[⠁-⣿]/);
    expect(last).toMatch(/\d+ of 1000 rows/);
  });

  test('ten minutes of one-second updates keep the layout and redraw only what changed', async () => {
    const { frames, cells } = await run(600);
    expect(layoutHolds(frames)).toBe(true);
    // A full redraw writes every cell; a live tick rewrites the values that moved.
    expect(Math.max(...cells)).toBeLessThan(SCREEN / 2);
  }, 120_000);

  test('the layout check fails a frame that loses its table', async () => {
    const { frames } = await run(4, { defect: 'blank' });
    expect(layoutHolds(frames)).toBe(false);
  });

  test('the redraw check fails a tick that repaints the screen', async () => {
    const { cells } = await run(4, { defect: 'repaint' });
    expect(Math.max(...cells)).toBeGreaterThanOrEqual(SCREEN / 2);
  });

  test('memory stays flat over ten minutes of updates', async () => {
    const { heap, rss, historyLength } = await run(600, {}, [120, 360, 600]);
    const [early = 0, middle = 0, late = 0] = heap;
    // Bounded state: the chart keeps one window, the table one generation of rows.
    expect(historyLength).toBe(61);
    expect(late - early).toBeLessThan(8 * 1024 * 1024);
    expect(Math.abs(late - middle)).toBeLessThan(8 * 1024 * 1024);
    const [rssEarly = 0, , rssLate = 0] = rss;
    expect(rssLate - rssEarly).toBeLessThan(64 * 1024 * 1024);
  }, 120_000);

  test('the memory check sees history that is not bounded by its window', async () => {
    const { historyLength } = await run(120, { defect: 'unbounded' });
    expect(historyLength).toBe(120);
  });
});

describe('keyboard ownership', () => {
  test('a digit typed into the table filter filters and leaves the tabs alone', async () => {
    const store = createMonitorStore();
    const setup = await testRender(<Monitor store={store} />, {
      width: MONITOR_WIDTH,
      height: MONITOR_HEIGHT,
    });
    try {
      await setup.renderOnce();
      await act(async () => {
        await setup.mockInput.typeText('/2');
        await Bun.sleep(5);
      });
      await setup.renderOnce();
      expect(store.snapshot().tabs.selectedId).toBe('proc');
      expect(store.snapshot().table.filter).toBe('2');
      expect(setup.captureCharFrame()).toContain('/2▏');
      // Out of the filter, the same digit is the tabs' again.
      await act(async () => {
        setup.mockInput.pressEnter();
        await setup.mockInput.typeText('2');
        await Bun.sleep(5);
      });
      expect(store.snapshot().tabs.selectedId).toBe('net');
    } finally {
      await act(async () => {
        await setup.dispose();
      });
    }
  });
});
