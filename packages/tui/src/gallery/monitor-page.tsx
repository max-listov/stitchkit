import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appendTerminalSample,
  createTerminalTimeSeries,
  type TerminalTimeSeries,
} from '../core/chart';
import { layoutTerminalMeterGrid } from '../core/meter';
import {
  createTerminalTable,
  reduceTerminalTable,
  type TerminalTableAction,
  type TerminalTableColumn,
  type TerminalTableRowInput,
  type TerminalTableState,
} from '../core/table';
import { TerminalChart } from '../widgets/chart';
import { TerminalMeterGrid } from '../widgets/meter';
import { TerminalTable } from '../widgets/table';

const columns: TerminalTableColumn[] = [
  { id: 'name', title: 'NAME', kind: 'text', width: { flex: 1 } },
  { id: 'pid', title: 'PID', kind: 'number', width: 7, filterable: true },
  { id: 'cpu', title: 'CPU%', kind: 'number', width: 6, format: (v) => Number(v).toFixed(1) },
  {
    id: 'mem',
    title: 'MEM',
    kind: 'number',
    width: 7,
    format: (v) => `${Math.round(Number(v))}M`,
  },
];

function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43_758.5453;
  return x - Math.floor(x);
}

function rows(tick: number): TerminalTableRowInput[] {
  return Array.from({ length: 30 }, (_, app) => [
    {
      key: `app-${app}`,
      parentKey: null,
      cells: {
        name: `service-${app}`,
        pid: 1000 + app,
        cpu: Math.round(noise(app * 31 + tick) * 400) / 10,
        mem: app % 9 === 0 ? null : 40 + noise(app) * 600,
      },
    },
    ...Array.from({ length: 4 }, (_, worker) => ({
      key: `app-${app}/w${worker}`,
      parentKey: `app-${app}`,
      cells: {
        name: `worker-${worker}`,
        pid: 20_000 + app * 10 + worker,
        cpu: Math.round(noise(app * 7 + worker + tick) * 1000) / 10,
        mem: 10 + noise(worker + app) * 100,
      },
    })),
  ]).flat();
}

/** A compact htop/btop screen fed once a second. */
export function MonitorDemo({
  width,
  height,
  active,
  clock,
}: {
  width: number;
  height: number;
  active: boolean;
  clock: () => number;
}) {
  const tick = useRef(0);
  const [table, setTable] = useState<TerminalTableState>(() =>
    createTerminalTable({
      columns,
      rows: rows(0),
      capacity: 10,
      sort: { columnId: 'cpu', direction: 'desc' },
      expanded: ['app-1'],
    }),
  );
  const [cpu, setCpu] = useState<TerminalTimeSeries>(() =>
    createTerminalTimeSeries({ windowMs: 60_000 }),
  );
  const [cores, setCores] = useState<(number | null)[]>(() =>
    Array.from({ length: 8 }, () => null),
  );
  const onAction = useCallback(
    (action: TerminalTableAction) =>
      setTable((current) => reduceTerminalTable(current, action)),
    [],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      tick.current += 1;
      const next = tick.current;
      const values = Array.from(
        { length: 8 },
        (_, core) => Math.round(noise(core * 5 + next) * 1000) / 10,
      );
      setCores(values);
      setCpu((series) =>
        appendTerminalSample(series, {
          at: clock(),
          value: values.reduce((a, b) => a + b, 0) / 8,
        }),
      );
      setTable((state) => reduceTerminalTable(state, { type: 'rows', rows: rows(next) }));
    }, 1000);
    return () => clearInterval(timer);
  }, [clock]);
  const chartWidth = Math.max(10, width);
  // Meters take as many rows as the width forces; the table takes what is left.
  const meterRows = layoutTerminalMeterGrid({
    count: cores.length,
    width,
    minMeterWidth: 24,
  }).rows;
  return (
    <box style={{ flexDirection: 'column', width, height }}>
      <TerminalMeterGrid
        width={width}
        minMeterWidth={24}
        meters={cores.map((value, core) => ({ label: `cpu${core}`, value, max: 100 }))}
      />
      <TerminalChart
        series={[{ data: cpu, tone: 'accent' }]}
        now={clock()}
        width={chartWidth}
        height={3}
        min={0}
        max={100}
        fill
      />
      <TerminalTable
        state={table}
        onAction={onAction}
        width={width}
        height={Math.max(3, height - meterRows - 4)}
        focused={active}
      />
    </box>
  );
}
