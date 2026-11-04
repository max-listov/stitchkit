/**
 * A live monitor screen on a real terminal:
 * `NODE_ENV=production bun examples/monitor.tsx`. A screen that lives for
 * hours runs React's production build: the development build records a
 * performance measure with a props diff for every render, and Bun keeps them.
 * Tab / Shift-Tab or 1–3 switch tabs; in the process table ↑↓ j k PgUp PgDn
 * Home End move, → ← open and close a service, < > pick the sort column, I
 * inverts it, / filters, Enter shows the selected row; q quits.
 */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { TerminalKeyPriority, useTerminalKeyboard } from '../src/widgets';
import { createMonitorStore, Monitor } from '../tests/fixtures/monitor';

const tickMs = Number(process.env.MONITOR_TICK_MS ?? 1000);
const ticks = Number(process.env.MONITOR_TICKS ?? Number.POSITIVE_INFINITY);
const rssLog = process.env.MONITOR_RSS_LOG;

const renderer = await createCliRenderer({ exitOnCtrlC: true });
const store = createMonitorStore();

/** `q` quits — through the kit's router, so a `q` typed into the filter stays a letter. */
function App() {
  useTerminalKeyboard(
    (key) => {
      if (key.name !== 'q' || key.ctrl) return false;
      renderer.destroy();
      process.exit(0);
    },
    { priority: TerminalKeyPriority.global },
  );
  return <Monitor store={store} />;
}

createRoot(renderer).render(<App />);

let tick = 0;
const timer = setInterval(async () => {
  store.tick();
  tick += 1;
  if (rssLog && tick % 60 === 0) {
    Bun.gc(true);
    const { rss, heapUsed } = process.memoryUsage();
    await Bun.write(
      rssLog,
      `${await Bun.file(rssLog)
        .text()
        .catch(
          () => '',
        )}${tick} ${Math.round(rss / 1048576)} ${Math.round(heapUsed / 1048576)}\n`,
    );
  }
  if (tick >= ticks) {
    clearInterval(timer);
    renderer.destroy();
    process.exit(0);
  }
}, tickMs);
