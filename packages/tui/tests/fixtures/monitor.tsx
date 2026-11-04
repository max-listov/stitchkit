import { useSyncExternalStore } from 'react';
import {
  appendTerminalSample,
  createTerminalTable,
  createTerminalTabs,
  createTerminalTimeSeries,
  reduceTerminalTable,
  reduceTerminalTabs,
  type TerminalTableAction,
  type TerminalTableColumn,
  type TerminalTableRowInput,
  type TerminalTableState,
  type TerminalTabsAction,
  type TerminalTabsState,
  type TerminalTimeSeries,
} from '../../src/core';
import {
  TerminalChart,
  TerminalMeterGrid,
  TerminalTable,
  TerminalTabs,
  TerminalThemeProvider,
} from '../../src/widgets';

/**
 * The acceptance fixture: a htop/btop-shaped screen with a 1 000-row process
 * tree, sixteen core meters, two braille charts and tabs, fed once per tick
 * from a store outside React — the way a monitor feeds a live screen.
 */

export const MONITOR_WIDTH = 100;
export const MONITOR_HEIGHT = 40;
const APPS = 100;
const WORKERS = 9;
const CORES = 16;
const WINDOW_MS = 60_000;

const columns: TerminalTableColumn[] = [
  { id: 'name', title: 'NAME', kind: 'text', width: { flex: 1 } },
  { id: 'pid', title: 'PID', kind: 'number', width: 7, filterable: true },
  { id: 'cpu', title: 'CPU%', kind: 'number', width: 6, format: (v) => Number(v).toFixed(1) },
  {
    id: 'mem',
    title: 'MEM',
    kind: 'number',
    width: 8,
    format: (v) => `${Math.round(Number(v))}M`,
  },
];

/** Deterministic noise, so a frame is reproducible from its tick. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43_758.5453;
  return x - Math.floor(x);
}

export interface MonitorOptions {
  /**
   * Negative controls: `blank` drops the process table on odd ticks (a frame
   * that loses its layout), `repaint` changes every cell every tick (a full
   * redraw), `unbounded` grows the chart history without a window bound.
   */
  defect?: 'blank' | 'repaint' | 'unbounded';
}

export interface MonitorSnapshot {
  tick: number;
  now: number;
  table: TerminalTableState;
  tabs: TerminalTabsState;
  cores: (number | null)[];
  cpu: TerminalTimeSeries;
  memory: TerminalTimeSeries;
}

function processRows(tick: number): TerminalTableRowInput[] {
  const rows: TerminalTableRowInput[] = [];
  for (let app = 0; app < APPS; app += 1) {
    // A tenth of the apps restart every minute: new pids, the same names.
    const generation = app % 10 === 0 ? Math.floor(tick / 60) : 0;
    const key = `app-${app}-${generation}`;
    rows.push({
      key,
      parentKey: null,
      cells: {
        name: `service-${app}`,
        pid: 1000 + app * 10 + generation * 7,
        cpu: Math.round(noise(app * 31 + tick) * 400) / 10,
        // An app that has not reported memory yet shows `—`.
        mem: app % 17 === 0 ? null : 50 + noise(app + tick * 0.01) * 900,
      },
    });
    for (let worker = 0; worker < WORKERS; worker += 1) {
      rows.push({
        key: `${key}/w${worker}`,
        parentKey: key,
        cells: {
          name: `worker-${worker}`,
          pid: 100_000 + app * 100 + worker,
          cpu: Math.round(noise(app * 97 + worker * 13 + tick) * 1000) / 10,
          mem: 10 + noise(worker + app + tick * 0.02) * 200,
        },
      });
    }
  }
  return rows;
}

export function createMonitorStore(options: MonitorOptions = {}) {
  const listeners = new Set<() => void>();
  const unbounded = options.defect === 'unbounded';
  const series = () =>
    createTerminalTimeSeries({
      windowMs: unbounded ? Number.MAX_SAFE_INTEGER : WINDOW_MS,
      maxSamples: unbounded ? Number.MAX_SAFE_INTEGER : 4096,
    });
  let snapshot: MonitorSnapshot = {
    tick: 0,
    now: 0,
    table: createTerminalTable({
      columns,
      rows: processRows(0),
      capacity: 10,
      sort: { columnId: 'cpu', direction: 'desc' },
      expanded: ['app-3-0', 'app-10-0'],
    }),
    tabs: createTerminalTabs([
      { id: 'proc', label: 'Processes', badge: APPS * (WORKERS + 1) },
      { id: 'net', label: 'Network', badge: 0 },
      { id: 'disk', label: 'Disks', badge: null },
    ]),
    cores: Array.from({ length: CORES }, () => null),
    cpu: series(),
    memory: series(),
  };
  const publish = (next: MonitorSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    tick(): void {
      const tick = snapshot.tick + 1;
      const now = tick * 1000;
      const cores = Array.from({ length: CORES }, (_, core) =>
        // Core 15 is offline for the first ten ticks: a meter with no reading.
        core === 15 && tick < 10 ? null : Math.round(noise(core * 7 + tick) * 1000) / 10,
      );
      const total = cores.reduce<number>((sum, value) => sum + (value ?? 0), 0) / CORES;
      publish({
        tick,
        now,
        table: reduceTerminalTable(snapshot.table, { type: 'rows', rows: processRows(tick) }),
        tabs: reduceTerminalTabs(snapshot.tabs, { type: 'badge', id: 'net', badge: tick % 7 }),
        cores,
        cpu: appendTerminalSample(snapshot.cpu, { at: now, value: total }),
        memory: appendTerminalSample(snapshot.memory, {
          at: now,
          value: tick % 30 === 29 ? null : 40 + noise(tick) * 20,
        }),
      });
    },
    table(action: TerminalTableAction): void {
      publish({ ...snapshot, table: reduceTerminalTable(snapshot.table, action) });
    },
    tabs(action: TerminalTabsAction): void {
      publish({ ...snapshot, tabs: reduceTerminalTabs(snapshot.tabs, action) });
    },
  };
}

export type MonitorStore = ReturnType<typeof createMonitorStore>;

export function Monitor({
  store,
  options = {},
}: {
  store: MonitorStore;
  options?: MonitorOptions;
}) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const blank = options.defect === 'blank' && state.tick % 2 === 1;
  const repaint = options.defect === 'repaint' && state.tick % 2 === 1;
  return (
    <TerminalThemeProvider
      mode='dark'
      {...(repaint && {
        palette: { primary: '#000001', muted: '#000002', canvas: '#ffffff' },
      })}
    >
      <box
        style={{
          flexDirection: 'column',
          width: MONITOR_WIDTH,
          height: MONITOR_HEIGHT,
          ...(repaint && { backgroundColor: '#202020' }),
        }}
      >
        <TerminalTabs state={state.tabs} onAction={store.tabs} />
        <TerminalMeterGrid
          width={MONITOR_WIDTH}
          minMeterWidth={24}
          meters={state.cores.map((value, core) => ({ label: `cpu${core}`, value, max: 100 }))}
        />
        <box style={{ flexDirection: 'row', height: 6, gap: 2 }}>
          <TerminalChart
            series={[{ data: state.cpu, tone: 'accent' }]}
            now={state.now}
            width={49}
            height={5}
            min={0}
            max={100}
          />
          <TerminalChart
            series={[{ data: state.memory, tone: 'success' }]}
            now={state.now}
            width={49}
            height={5}
            min={0}
            max={100}
            fill
          />
        </box>
        {blank ? null : (
          <TerminalTable
            state={state.table}
            onAction={store.table}
            width={MONITOR_WIDTH}
            height={MONITOR_HEIGHT - 11}
            focused={state.tabs.selectedId === 'proc'}
          />
        )}
      </box>
    </TerminalThemeProvider>
  );
}
