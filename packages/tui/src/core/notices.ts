import { z } from 'zod';
import { TerminalToneSchema } from './theme';

export const TerminalNoticeSchema = z
  .object({
    id: z.string().min(1),
    tone: TerminalToneSchema.default('primary'),
    text: z.string().min(1),
    /** When it was raised, on the clock the application passes in. */
    at: z.number(),
    /** How long it stays; `null` stays until dismissed. */
    ttlMs: z.int().positive().nullable().default(4000),
  })
  .strict();

export type TerminalNotice = z.output<typeof TerminalNoticeSchema>;

export interface TerminalNoticesState {
  readonly notices: readonly TerminalNotice[];
  /** The most notices kept; the oldest goes first. */
  readonly limit: number;
}

export type TerminalNoticesAction =
  | { type: 'push'; notice: z.input<typeof TerminalNoticeSchema> }
  | { type: 'dismiss'; id: string }
  | { type: 'expire'; now: number }
  | { type: 'clear' };

export function createTerminalNotices(limit = 4): TerminalNoticesState {
  return { notices: [], limit: z.int().positive().parse(limit) };
}

/** Toasts: time comes in as an argument, so the queue is a pure function of its inputs. */
export function reduceTerminalNotices(
  state: TerminalNoticesState,
  action: TerminalNoticesAction,
): TerminalNoticesState {
  switch (action.type) {
    case 'push': {
      const notice = TerminalNoticeSchema.parse(action.notice);
      // The same id replaces its earlier text instead of stacking a duplicate.
      const rest = state.notices.filter(({ id }) => id !== notice.id);
      return { ...state, notices: [...rest, notice].slice(-state.limit) };
    }
    case 'dismiss':
      return { ...state, notices: state.notices.filter(({ id }) => id !== action.id) };
    case 'expire': {
      const notices = state.notices.filter(
        ({ at, ttlMs }) => ttlMs === null || action.now < at + ttlMs,
      );
      return notices.length === state.notices.length ? state : { ...state, notices };
    }
    case 'clear':
      return state.notices.length === 0 ? state : { ...state, notices: [] };
  }
}

/** When the next notice expires, so a host schedules one timer instead of polling. */
export function nextTerminalNoticeExpiry(state: TerminalNoticesState): number | null {
  const deadlines = state.notices.flatMap(({ at, ttlMs }) =>
    ttlMs === null ? [] : [at + ttlMs],
  );
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}
