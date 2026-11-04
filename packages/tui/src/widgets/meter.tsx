import {
  layoutTerminalMeterGrid,
  type TerminalMeterThreshold,
  terminalMeter,
} from '../core/meter';
import { fitTerminalText } from '../core/text';
import { useTerminalPalette } from './theme';

export interface TerminalMeterProps {
  label: string;
  /** `null` is "not measured": an empty bar and `—`. */
  value: number | null;
  max: number;
  /** Cells for the whole line: label, bracketed bar and reading. */
  width: number;
  labelWidth?: number;
  /** The reading after the bar; a percentage of `max` when omitted. */
  text?: string;
  textWidth?: number;
  thresholds?: readonly TerminalMeterThreshold[];
}

/** One htop-style meter line: `cpu3 [████▌      ] 41.2%`. */
export function TerminalMeter({
  label,
  value,
  max,
  width,
  labelWidth = Math.max(1, label.length),
  text,
  textWidth = 6,
  thresholds,
}: TerminalMeterProps) {
  const palette = useTerminalPalette();
  const barWidth = Math.max(0, width - labelWidth - textWidth - 3);
  const bar = terminalMeter({
    value,
    max,
    width: barWidth,
    ...(thresholds && { thresholds: [...thresholds] }),
  });
  const reading =
    text ??
    (bar.ratio === null || value === null ? '—' : `${((value / max) * 100).toFixed(1)}%`);
  return (
    <text wrapMode='none'>
      <span fg={palette.muted}>{fitTerminalText(label, labelWidth, 'left')}</span>
      <span fg={palette.border}>{' ['}</span>
      <span fg={palette[bar.tone]}>{bar.filled}</span>
      <span>{bar.empty}</span>
      <span fg={palette.border}>{']'}</span>
      <span fg={bar.ratio === null ? palette.muted : palette.primary}>
        {fitTerminalText(reading, textWidth, 'right')}
      </span>
    </text>
  );
}

export interface TerminalMeterGridProps {
  meters: readonly Omit<TerminalMeterProps, 'width' | 'labelWidth'>[];
  width: number;
  /** The narrowest a meter may get before the grid adds a row. */
  minMeterWidth?: number;
  gap?: number;
}

/** A block of meters, one per core, column-major like htop's CPU header. */
export function TerminalMeterGrid({
  meters,
  width,
  minMeterWidth = 20,
  gap = 1,
}: TerminalMeterGridProps) {
  const grid = layoutTerminalMeterGrid({ count: meters.length, width, minMeterWidth, gap });
  const labelWidth = Math.max(1, ...meters.map(({ label }) => label.length));
  return (
    <box style={{ flexDirection: 'column', width, height: grid.rows }}>
      {grid.cells.map((row) => (
        <box key={row.join(',')} style={{ flexDirection: 'row', height: 1, gap }}>
          {row.map((index) => {
            const meter = meters[index];
            if (!meter) return null;
            return (
              <box key={index} style={{ width: grid.meterWidth, height: 1 }}>
                <TerminalMeter {...meter} width={grid.meterWidth} labelWidth={labelWidth} />
              </box>
            );
          })}
        </box>
      ))}
    </box>
  );
}
