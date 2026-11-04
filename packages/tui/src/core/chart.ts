import { z } from 'zod';
import { type TerminalTone, TerminalToneSchema } from './theme';

const SampleSchema = z
  .object({
    at: z.number(),
    /** `null` records a gap: nothing was measured from here to the next sample. */
    value: z.number().nullable(),
  })
  .strict();

export type TerminalSample = z.infer<typeof SampleSchema>;

export interface TerminalTimeSeries {
  readonly windowMs: number;
  /** A hard bound on retained samples, whatever the sampling rate. */
  readonly maxSamples: number;
  /** Ascending by `at`; never older than the window behind the newest sample. */
  readonly samples: readonly TerminalSample[];
}

const TimeSeriesOptionsSchema = z
  .object({
    windowMs: z.int().positive(),
    maxSamples: z.int().min(2).default(4096),
  })
  .strict();

export function createTerminalTimeSeries(
  options: z.input<typeof TimeSeriesOptionsSchema>,
): TerminalTimeSeries {
  return { ...TimeSeriesOptionsSchema.parse(options), samples: [] };
}

/**
 * Add a reading and forget what left the window. One sample before the window
 * is kept, so the line enters the chart from its left edge instead of starting
 * mid-way. Memory is bounded by the window and by `maxSamples`, however long
 * the monitor runs.
 */
export function appendTerminalSample(
  series: TerminalTimeSeries,
  sample: TerminalSample,
): TerminalTimeSeries {
  const next = SampleSchema.parse(sample);
  const last = series.samples.at(-1);
  if (last !== undefined && next.at < last.at) {
    throw new Error(
      `Terminal samples must arrive in time order: ${next.at} is before ${last.at}`,
    );
  }
  const horizon = next.at - series.windowMs;
  let first = Math.max(0, series.samples.length + 1 - series.maxSamples);
  while (
    first + 1 < series.samples.length &&
    (series.samples[first + 1]?.at ?? 0) <= horizon
  ) {
    first += 1;
  }
  return { ...series, samples: [...series.samples.slice(first), next] };
}

/**
 * The value in force at `count` evenly spaced instants across the window that
 * ends at `now`: the newest sample at or before each instant, or `null` when
 * there is none or it recorded a gap.
 */
export function sampleTerminalTimeSeries(
  series: TerminalTimeSeries,
  input: { now: number; count: number },
): (number | null)[] {
  const count = z.int().nonnegative().parse(input.count);
  const values: (number | null)[] = [];
  let cursor = -1;
  for (let index = 0; index < count; index += 1) {
    const instant =
      count === 1
        ? input.now
        : input.now - series.windowMs + (series.windowMs * index) / (count - 1);
    while (
      cursor + 1 < series.samples.length &&
      (series.samples[cursor + 1]?.at ?? 0) <= instant
    ) {
      cursor += 1;
    }
    values.push(cursor < 0 ? null : (series.samples[cursor]?.value ?? null));
  }
  return values;
}

export interface TerminalChartScale {
  min: number;
  max: number;
}

/** `[min, max]` for the values, starting at zero, never empty. */
export function terminalChartScale(
  values: readonly (number | null)[],
  fixed: { min?: number | undefined; max?: number | undefined } = {},
): TerminalChartScale {
  const present = values.filter((value): value is number => value !== null);
  const min = fixed.min ?? Math.min(0, ...present);
  const max = fixed.max ?? Math.max(min, ...present);
  return { min, max: max > min ? max : min + 1 };
}

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/** One cell per value; a gap is a space so a missing reading never looks like zero. */
export function terminalSparkline(
  values: readonly (number | null)[],
  scale: Partial<TerminalChartScale> = {},
): string {
  const { min, max } = terminalChartScale(values, scale);
  return values
    .map((value) => {
      if (value === null) return ' ';
      const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
      return BARS[Math.round(ratio * (BARS.length - 1))] ?? ' ';
    })
    .join('');
}

/** Braille dot bits by `[row][column]` inside one 2×4 cell (Unicode dot order 1–8). */
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

const ChartInputSchema = z
  .object({
    series: z.array(
      z
        .object({
          values: z.array(z.number().nullable()),
          tone: TerminalToneSchema,
        })
        .strict(),
    ),
    width: z.int().positive(),
    height: z.int().positive(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** Shade the area under each line, as btop does. */
    fill: z.boolean().default(false),
  })
  .strict();

export type TerminalBrailleChartInput = z.input<typeof ChartInputSchema>;

export interface TerminalChartSegment {
  text: string;
  /** `null` for blank cells, which take no colour. */
  tone: TerminalTone | null;
}

/**
 * A multi-series line chart in braille: each cell holds 2×4 dots, so a chart
 * `width` cells wide plots `2 × width` points. `values` are the points left to
 * right (`sampleTerminalTimeSeries` with `count: 2 × width`); a later series
 * draws over an earlier one and colours the cells it touches. Rows are top to
 * bottom, each a list of same-tone segments ready to render as spans.
 */
export function terminalBrailleChart(
  input: TerminalBrailleChartInput,
): TerminalChartSegment[][] {
  const { series, width, height, fill, ...fixed } = ChartInputSchema.parse(input);
  const dotsHigh = height * 4;
  const dotsWide = width * 2;
  const bits = new Uint8Array(width * height);
  const tones: (TerminalTone | null)[] = new Array(width * height).fill(null);
  const scale = terminalChartScale(
    series.flatMap(({ values }) => values),
    fixed,
  );
  const level = (value: number): number =>
    Math.round(
      Math.min(1, Math.max(0, (value - scale.min) / (scale.max - scale.min))) * (dotsHigh - 1),
    );
  const plot = (x: number, y: number, tone: TerminalTone): void => {
    const row = dotsHigh - 1 - y;
    const cell = Math.floor(row / 4) * width + Math.floor(x / 2);
    bits[cell] = (bits[cell] ?? 0) | (DOT_BITS[row % 4]?.[x % 2] ?? 0);
    tones[cell] = tone;
  };
  for (const { values, tone } of series) {
    let previous: number | null = null;
    for (let x = 0; x < Math.min(dotsWide, values.length); x += 1) {
      const value = values[x] ?? null;
      if (value === null) {
        previous = null;
        continue;
      }
      const y = level(value);
      const from = fill ? 0 : previous === null ? y : Math.min(previous, y);
      const to = fill ? y : previous === null ? y : Math.max(previous, y);
      for (let dot = from; dot <= to; dot += 1) plot(x, dot, tone);
      previous = y;
    }
  }
  return Array.from({ length: height }, (_, row) => {
    const segments: TerminalChartSegment[] = [];
    for (let column = 0; column < width; column += 1) {
      const cell = row * width + column;
      const value = bits[cell] ?? 0;
      const tone = value === 0 ? null : (tones[cell] ?? null);
      const text = value === 0 ? ' ' : String.fromCharCode(0x2800 + value);
      const last = segments.at(-1);
      if (last !== undefined && last.tone === tone) last.text += text;
      else segments.push({ text, tone });
    }
    return segments;
  });
}

function durationLabel(ms: number): string {
  const exact = ms / 1000;
  if (!Number.isInteger(exact) && exact < 60) return `${Number(exact.toFixed(1))}s`;
  const seconds = Math.round(exact);
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** The time axis under a chart: the window's age at the left, `now` at the right. */
export function terminalTimeAxis(windowMs: number, width: number): string {
  const cells = z.int().nonnegative().parse(width);
  const left = `-${durationLabel(z.int().positive().parse(windowMs))}`;
  const right = 'now';
  if (cells < left.length + right.length + 1) return right.padStart(cells).slice(0, cells);
  const middle = `-${durationLabel(windowMs / 2)}`;
  const gap = cells - left.length - right.length;
  if (gap < middle.length + 2) return left + ' '.repeat(gap) + right;
  const before = Math.floor((gap - middle.length) / 2);
  return left + ' '.repeat(before) + middle + ' '.repeat(gap - middle.length - before) + right;
}
