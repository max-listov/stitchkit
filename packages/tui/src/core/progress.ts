import { z } from 'zod';

export const TerminalSpinnerKindSchema = z.enum(['dots', 'line', 'pulse', 'arc']);

export type TerminalSpinnerKind = z.infer<typeof TerminalSpinnerKindSchema>;

export const terminalSpinners: Readonly<
  Record<TerminalSpinnerKind, { intervalMs: number; frames: readonly string[] }>
> = Object.freeze({
  dots: { intervalMs: 80, frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] },
  line: { intervalMs: 120, frames: ['-', '\\', '|', '/'] },
  pulse: { intervalMs: 160, frames: ['·', '•', '●', '•'] },
  arc: { intervalMs: 100, frames: ['◜', '◠', '◝', '◞', '◡', '◟'] },
});

/** The frame a spinner shows `elapsedMs` after it started. */
export function terminalSpinnerFrame(kind: TerminalSpinnerKind, elapsedMs: number): string {
  const spinner = terminalSpinners[kind];
  const index =
    Math.floor(Math.max(0, elapsedMs) / spinner.intervalMs) % spinner.frames.length;
  return spinner.frames[index] ?? '';
}

/** `0.8s`, `12s`, `3m 05s`, `1h 02m`: elapsed time at the precision a reader needs. */
export function formatTerminalDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`;
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const ProgressInputSchema = z
  .object({
    /** Work done; `null` while unknown, which draws an indeterminate bar. */
    done: z.number().nonnegative().nullable(),
    total: z.number().positive().nullable(),
    startedAt: z.number(),
    now: z.number(),
  })
  .strict();

export interface TerminalProgress {
  /** `done / total` in `[0, 1]`, or `null` when either is unknown. */
  ratio: number | null;
  elapsedMs: number;
  /** Units per second since the start, or `null` before any measurable time. */
  rate: number | null;
  /** Time left at the average rate so far, or `null` when it cannot be estimated. */
  etaMs: number | null;
}

/** Progress of a job: how far, how fast, how long is left — never a guessed number. */
export function terminalProgress(
  input: z.input<typeof ProgressInputSchema>,
): TerminalProgress {
  const { done, total, startedAt, now } = ProgressInputSchema.parse(input);
  const elapsedMs = Math.max(0, now - startedAt);
  const ratio = done === null || total === null ? null : Math.min(1, done / total);
  const rate = done === null || elapsedMs === 0 ? null : (done * 1000) / elapsedMs;
  const etaMs =
    done === null || total === null || rate === null || rate === 0
      ? null
      : Math.max(0, ((total - done) / rate) * 1000);
  return { ratio, elapsedMs, rate, etaMs };
}

/** Where an indeterminate bar's moving block sits, as `[start, length]` in cells. */
export function terminalIndeterminateBlock(
  width: number,
  elapsedMs: number,
  periodMs = 1600,
): [number, number] {
  const length = Math.max(1, Math.floor(width / 4));
  const travel = Math.max(0, width - length);
  const phase = (Math.max(0, elapsedMs) % periodMs) / periodMs;
  const position = phase < 0.5 ? phase * 2 : 2 - phase * 2;
  return [Math.round(position * travel), length];
}

/** The four states every screen that loads something passes through. */
export type TerminalAsyncState<DATA> =
  | { status: 'loading'; startedAt: number; label?: string }
  | { status: 'error'; message: string; retryable: boolean }
  | { status: 'empty'; message?: string }
  | { status: 'ready'; data: DATA };
