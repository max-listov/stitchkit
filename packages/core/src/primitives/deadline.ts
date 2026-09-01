import { z } from 'zod';

const DAY_MS = 86_400_000;

export const DeadlineResultSchema = z.object({
  dueAt: z.iso.datetime({ offset: true }),
  remainingDays: z.number().int(),
  overdueDays: z.number().int().nonnegative(),
  category: z.string().min(1),
});
export type DeadlineResult = z.infer<typeof DeadlineResultSchema>;

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function partsInZone(value: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`[stitchkit] timezone projection omitted ${type}`);
    return Number(part);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function partsEpoch(parts: ZonedParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function localPartsToEpoch(parts: ZonedParts, timeZone: string): number {
  const desired = partsEpoch(parts);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const projected = partsEpoch(partsInZone(new Date(candidate), timeZone));
    candidate += desired - projected;
  }
  return candidate;
}

function addCalendarDays(anchor: Date, days: number, timeZone: string): Date {
  const parts = partsInZone(anchor, timeZone);
  const shifted = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  return new Date(localPartsToEpoch(partsInZone(shifted, 'UTC'), timeZone));
}

function calendarDayKey(value: Date, timeZone: string): number {
  const parts = partsInZone(value, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
}

export function defineDeadlinePolicy<
  const TOnTrack extends string,
  const TWarning extends string,
  const TOverdue extends string,
>(config: {
  readonly boundary: 'elapsed-day' | 'calendar-day';
  readonly timeZone: string;
  readonly warningDays: number;
  readonly categories: {
    readonly onTrack: TOnTrack;
    readonly warning: TWarning;
    readonly overdue: TOverdue;
  };
}) {
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format(new Date(0));
  if (!Number.isSafeInteger(config.warningDays) || config.warningDays < 0) {
    throw new RangeError('warningDays must be a non-negative safe integer');
  }
  const addDays = (value: Date, days: number): Date =>
    config.boundary === 'calendar-day'
      ? addCalendarDays(value, days, config.timeZone)
      : new Date(value.getTime() + days * DAY_MS);
  return Object.freeze({
    definition: config,
    evaluate(input: {
      readonly anchorAt: Date;
      readonly durationDays: number;
      readonly now: Date;
    }): DeadlineResult {
      if (!Number.isSafeInteger(input.durationDays) || input.durationDays < 0) {
        throw new RangeError('durationDays must be a non-negative safe integer');
      }
      const dueAt = addDays(input.anchorAt, input.durationDays);
      const remainingDays =
        config.boundary === 'calendar-day'
          ? calendarDayKey(dueAt, config.timeZone) - calendarDayKey(input.now, config.timeZone)
          : Math.ceil((dueAt.getTime() - input.now.getTime()) / DAY_MS);
      const category =
        remainingDays < 0
          ? config.categories.overdue
          : remainingDays <= config.warningDays
            ? config.categories.warning
            : config.categories.onTrack;
      return DeadlineResultSchema.parse({
        dueAt: dueAt.toISOString(),
        remainingDays,
        overdueDays: Math.max(0, -remainingDays),
        category,
      });
    },
    queryBoundary(now: Date) {
      return Object.freeze({
        overdueBefore: now.toISOString(),
        warningBefore: addDays(now, config.warningDays).toISOString(),
      });
    },
  });
}
