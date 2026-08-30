import { z } from 'zod';

export const TerminalFeedViewportSchema = z
  .object({
    total: z.int().nonnegative(),
    capacity: z.int().positive(),
    start: z.int().nonnegative(),
    followTail: z.boolean(),
    unseen: z.int().nonnegative(),
  })
  .strict();

export type TerminalFeedViewport = z.infer<typeof TerminalFeedViewportSchema>;

export type TerminalFeedViewportAction =
  | { type: 'append'; count: number }
  | { type: 'prepend'; count: number }
  | { type: 'scroll'; lines: number }
  | { type: 'page'; pages: number }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'resize'; capacity: number };

function maximumStart(total: number, capacity: number): number {
  return Math.max(0, total - capacity);
}
export function createTerminalFeedViewport(
  total: number,
  capacity: number,
): TerminalFeedViewport {
  const parsedTotal = z.int().nonnegative().parse(total);
  const parsedCapacity = z.int().positive().parse(capacity);
  return TerminalFeedViewportSchema.parse({
    total: parsedTotal,
    capacity: parsedCapacity,
    start: maximumStart(parsedTotal, parsedCapacity),
    followTail: true,
    unseen: 0,
  });
}

export function reduceTerminalFeedViewport(
  state: TerminalFeedViewport,
  action: TerminalFeedViewportAction,
): TerminalFeedViewport {
  const current = TerminalFeedViewportSchema.parse(state);
  if (action.type === 'append') {
    const count = Math.max(0, action.count);
    const total = current.total + count;
    return TerminalFeedViewportSchema.parse({
      ...current,
      total,
      start: current.followTail ? maximumStart(total, current.capacity) : current.start,
      unseen: current.followTail ? 0 : current.unseen + count,
    });
  }
  if (action.type === 'prepend') {
    const count = Math.max(0, action.count);
    return TerminalFeedViewportSchema.parse({
      ...current,
      total: current.total + count,
      start: current.start + count,
    });
  }
  if (action.type === 'resize') {
    const capacity = z.int().positive().parse(action.capacity);
    return TerminalFeedViewportSchema.parse({
      ...current,
      capacity,
      start: current.followTail
        ? maximumStart(current.total, capacity)
        : Math.min(current.start, maximumStart(current.total, capacity)),
    });
  }
  if (action.type === 'home') return { ...current, start: 0, followTail: false };
  if (action.type === 'end') {
    return {
      ...current,
      start: maximumStart(current.total, current.capacity),
      followTail: true,
      unseen: 0,
    };
  }
  const delta = action.type === 'page' ? action.pages * current.capacity : action.lines;
  const start = Math.max(
    0,
    Math.min(maximumStart(current.total, current.capacity), current.start + delta),
  );
  const atTail = start === maximumStart(current.total, current.capacity) && delta > 0;
  return { ...current, start, followTail: atTail, unseen: atTail ? 0 : current.unseen };
}

export function visibleTerminalFeedRange(state: TerminalFeedViewport): {
  start: number;
  end: number;
} {
  const parsed = TerminalFeedViewportSchema.parse(state);
  return { start: parsed.start, end: Math.min(parsed.total, parsed.start + parsed.capacity) };
}
