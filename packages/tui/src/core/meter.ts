import { z } from 'zod';
import { type TerminalTone, TerminalToneSchema } from './theme';

/** Left-aligned eighth blocks: index `n` fills `n` eighths of one cell. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const;
const FULL = '█';

export const TerminalMeterThresholdSchema = z
  .object({
    /** The bar takes this tone once `value / max` reaches `ratio`. */
    ratio: z.number().min(0).max(1),
    tone: TerminalToneSchema,
  })
  .strict();

export type TerminalMeterThreshold = z.infer<typeof TerminalMeterThresholdSchema>;

/** htop's reading of load: green while easy, yellow when busy, red when saturated. */
export const defaultTerminalMeterThresholds: readonly TerminalMeterThreshold[] = Object.freeze(
  [
    { ratio: 0, tone: 'success' },
    { ratio: 0.6, tone: 'warning' },
    { ratio: 0.85, tone: 'danger' },
  ],
);

const MeterInputSchema = z
  .object({
    /** `null` is "not measured": an empty, muted bar, never a zero reading. */
    value: z.number().nullable(),
    max: z.number().positive(),
    width: z.int().nonnegative(),
    thresholds: z.array(TerminalMeterThresholdSchema).min(1).optional(),
  })
  .strict();

export type TerminalMeterInput = z.input<typeof MeterInputSchema>;

export interface TerminalMeterBar {
  /** The filled part, whole cells then one partial eighth block. */
  filled: string;
  /** Spaces that pad the bar to its width. */
  empty: string;
  /** `value / max`, clamped to `[0, 1]`; `null` when not measured. */
  ratio: number | null;
  tone: TerminalTone;
}

function toneFor(ratio: number, thresholds: readonly TerminalMeterThreshold[]): TerminalTone {
  const sorted = [...thresholds].sort((a, b) => a.ratio - b.ratio);
  let tone: TerminalTone = sorted[0]?.tone ?? 'success';
  for (const threshold of sorted) {
    if (ratio >= threshold.ratio) tone = threshold.tone;
  }
  return tone;
}

/** A horizontal bar with sub-cell precision, toned by the threshold it reached. */
export function terminalMeter(input: TerminalMeterInput): TerminalMeterBar {
  const { value, max, width, thresholds } = MeterInputSchema.parse(input);
  if (value === null) {
    return { filled: '', empty: ' '.repeat(width), ratio: null, tone: 'muted' };
  }
  const ratio = Math.min(1, Math.max(0, value / max));
  const eighths = Math.round(ratio * width * 8);
  const whole = Math.floor(eighths / 8);
  const partial = EIGHTHS[eighths % 8] ?? '';
  const filled = FULL.repeat(whole) + partial;
  const used = whole + (partial ? 1 : 0);
  return {
    filled,
    empty: ' '.repeat(width - used),
    ratio,
    tone: toneFor(ratio, thresholds ?? defaultTerminalMeterThresholds),
  };
}

const GridInputSchema = z
  .object({
    count: z.int().nonnegative(),
    width: z.int().positive(),
    /** The narrowest a meter, label included, may get before another row is cheaper. */
    minMeterWidth: z.int().positive(),
    gap: z.int().nonnegative().default(1),
  })
  .strict();

export interface TerminalMeterGridLayout {
  columns: number;
  rows: number;
  meterWidth: number;
  /** Meter indices per row, column-major like htop's CPU block. */
  cells: number[][];
}

/** Columns for a block of meters (one per CPU core) that fits the width. */
export function layoutTerminalMeterGrid(
  input: z.input<typeof GridInputSchema>,
): TerminalMeterGridLayout {
  const { count, width, minMeterWidth, gap } = GridInputSchema.parse(input);
  if (count === 0) return { columns: 0, rows: 0, meterWidth: width, cells: [] };
  const fit = Math.max(1, Math.floor((width + gap) / (minMeterWidth + gap)));
  const rows = Math.ceil(count / Math.min(count, fit));
  // Column-major filling may need fewer columns than fit: 5 meters in rows of 2 use 3.
  const columns = Math.ceil(count / rows);
  const meterWidth = Math.max(1, Math.floor((width - gap * (columns - 1)) / columns));
  const cells = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => column * rows + row).filter(
      (index) => index < count,
    ),
  );
  return { columns, rows, meterWidth, cells };
}
