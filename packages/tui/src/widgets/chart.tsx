import {
  sampleTerminalTimeSeries,
  type TerminalTimeSeries,
  terminalBrailleChart,
  terminalSparkline,
  terminalTimeAxis,
} from '../core/chart';
import type { TerminalTone } from '../core/theme';
import { useTerminalPalette } from './theme';

export interface TerminalChartSeries {
  data: TerminalTimeSeries;
  tone: TerminalTone;
}

export interface TerminalChartProps {
  series: readonly TerminalChartSeries[];
  /** The right edge of the window; pass the clock of the tick being drawn. */
  now: number;
  width: number;
  /** Lines of plot, not counting the axis. */
  height: number;
  min?: number;
  max?: number;
  fill?: boolean;
  /** Draw the time axis line under the plot. */
  axis?: boolean;
}

/** A btop-style braille line chart over the series' shared time window. */
export function TerminalChart({
  series,
  now,
  width,
  height,
  min,
  max,
  fill = false,
  axis = true,
}: TerminalChartProps) {
  const palette = useTerminalPalette();
  const rows = terminalBrailleChart({
    series: series.map(({ data, tone }) => ({
      values: sampleTerminalTimeSeries(data, { now, count: width * 2 }),
      tone,
    })),
    width,
    height,
    fill,
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
  });
  const windowMs = Math.max(1, ...series.map(({ data }) => data.windowMs));
  return (
    <box style={{ flexDirection: 'column', width, height: height + (axis ? 1 : 0) }}>
      {rows.map((segments, line) => (
        // Lines and runs are positions, not identities: each tick rewrites them in place.
        <text key={line} wrapMode='none'>
          {segments.map((segment, index) => (
            <span key={index} {...(segment.tone && { fg: palette[segment.tone] })}>
              {segment.text}
            </span>
          ))}
        </text>
      ))}
      {axis ? (
        <text fg={palette.muted} wrapMode='none'>
          {terminalTimeAxis(windowMs, width)}
        </text>
      ) : null}
    </box>
  );
}

export interface TerminalSparklineProps {
  data: TerminalTimeSeries;
  now: number;
  width: number;
  tone?: TerminalTone;
  min?: number;
  max?: number;
}

/** One line, one cell per point across the window. */
export function TerminalSparkline({
  data,
  now,
  width,
  tone = 'accent',
  min,
  max,
}: TerminalSparklineProps) {
  const palette = useTerminalPalette();
  const values = sampleTerminalTimeSeries(data, { now, count: width });
  return (
    <text fg={palette[tone]} wrapMode='none'>
      {terminalSparkline(values, {
        ...(min !== undefined && { min }),
        ...(max !== undefined && { max }),
      })}
    </text>
  );
}
