import { z } from 'zod';
import { assertValidSystemdUnitName } from './systemd-inspect';
import {
  formatSystemdDuration,
  formatSystemdScalar,
  SystemdScopeSchema,
  SystemdTimespanSchema,
  SystemdUnitError,
  toStringList,
} from './systemd-render-shared';

const OnCalendarItemSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'onCalendar expression must not be empty');

/**
 * Zod schema for rendering a systemd `.timer` unit file with strict escaping and
 * validated calendar/monotonic trigger directives.
 */
export const SystemdTimerUnitConfigSchema = z
  .strictObject({
    description: z.string().min(1),
    scope: SystemdScopeSchema.default('system'),
    after: z.array(z.string().min(1)).optional(),
    wants: z.array(z.string().min(1)).optional(),
    /** Target `.service` unit to activate; defaults to the matching stem. */
    unit: z.string().min(1).optional(),
    /** One or more `OnCalendar=` calendar event expressions (rendered on separate lines). */
    onCalendar: z
      .union([OnCalendarItemSchema, z.array(OnCalendarItemSchema).min(1)])
      .optional(),
    onBootSec: SystemdTimespanSchema.optional(),
    onStartupSec: SystemdTimespanSchema.optional(),
    onActiveSec: SystemdTimespanSchema.optional(),
    onUnitActiveSec: SystemdTimespanSchema.optional(),
    onUnitInactiveSec: SystemdTimespanSchema.optional(),
    accuracySec: SystemdTimespanSchema.optional(),
    randomizedDelaySec: SystemdTimespanSchema.optional(),
    /** Catch up missed calendar runs after downtime (valid only with `onCalendar`). */
    persistent: z.boolean().optional(),
    /** Target(s) in `[Install]`; defaults to `['timers.target']`, or pass `[]` to omit `[Install]`. */
    wantedBy: z.array(z.string().min(1)).optional(),
    /** Explicitly preserve `%h` unescaped while escaping every other `%`. Defaults to `false`. */
    allowHomeSpecifier: z.boolean().default(false),
  })
  .check((ctx) => {
    const value = ctx.value;
    const hasTrigger =
      value.onCalendar !== undefined ||
      value.onBootSec !== undefined ||
      value.onStartupSec !== undefined ||
      value.onActiveSec !== undefined ||
      value.onUnitActiveSec !== undefined ||
      value.onUnitInactiveSec !== undefined;
    if (!hasTrigger) {
      ctx.issues.push({
        code: 'custom',
        input: value,
        path: ['onCalendar'],
        message:
          'systemd timer unit requires at least one trigger (onCalendar, onBootSec, onStartupSec, onActiveSec, onUnitActiveSec, or onUnitInactiveSec)',
      });
    }
    if (value.persistent === true && value.onCalendar === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: value,
        path: ['persistent'],
        message: 'systemd Persistent=yes requires onCalendar',
      });
    }
    if (value.unit !== undefined && !value.unit.endsWith('.service')) {
      ctx.issues.push({
        code: 'custom',
        input: value.unit,
        path: ['unit'],
        message: `systemd timer 'unit' must end with '.service': ${JSON.stringify(value.unit)}`,
      });
    }
  });

/** Input configuration accepted by {@link renderSystemdTimerUnit}. */
export type SystemdTimerUnitConfig = z.input<typeof SystemdTimerUnitConfigSchema>;

/** Render a deterministic systemd `.timer` unit file with strict directive escaping. */
export function renderSystemdTimerUnit(config: SystemdTimerUnitConfig): string {
  const parsedResult = SystemdTimerUnitConfigSchema.safeParse(config);
  if (!parsedResult.success) {
    throw new SystemdUnitError(
      'INVALID_CONFIG',
      `Invalid systemd timer configuration: ${parsedResult.error.message}`,
      { cause: parsedResult.error },
    );
  }
  const parsed = parsedResult.data;
  const allowHome = parsed.allowHomeSpecifier;

  const unitLines: string[] = [
    '[Unit]',
    `Description=${formatSystemdScalar('description', parsed.description, allowHome)}`,
  ];
  if (parsed.after && parsed.after.length > 0) {
    const items = parsed.after.map((item, i) =>
      formatSystemdScalar(`after[${i}]`, item, false, true),
    );
    unitLines.push(`After=${items.join(' ')}`);
  }
  if (parsed.wants && parsed.wants.length > 0) {
    const items = parsed.wants.map((item, i) =>
      formatSystemdScalar(`wants[${i}]`, item, false, true),
    );
    unitLines.push(`Wants=${items.join(' ')}`);
  }

  const timerLines: string[] = ['[Timer]'];
  if (parsed.unit !== undefined) {
    assertValidSystemdUnitName(parsed.unit);
    timerLines.push(`Unit=${formatSystemdScalar('unit', parsed.unit, false, true)}`);
  }
  for (const [index, expr] of toStringList(parsed.onCalendar).entries()) {
    timerLines.push(
      `OnCalendar=${formatSystemdScalar(`onCalendar[${index}]`, expr, false, false)}`,
    );
  }
  if (parsed.onBootSec !== undefined) {
    timerLines.push(`OnBootSec=${formatSystemdDuration('onBootSec', parsed.onBootSec)}`);
  }
  if (parsed.onStartupSec !== undefined) {
    timerLines.push(
      `OnStartupSec=${formatSystemdDuration('onStartupSec', parsed.onStartupSec)}`,
    );
  }
  if (parsed.onActiveSec !== undefined) {
    timerLines.push(`OnActiveSec=${formatSystemdDuration('onActiveSec', parsed.onActiveSec)}`);
  }
  if (parsed.onUnitActiveSec !== undefined) {
    timerLines.push(
      `OnUnitActiveSec=${formatSystemdDuration('onUnitActiveSec', parsed.onUnitActiveSec)}`,
    );
  }
  if (parsed.onUnitInactiveSec !== undefined) {
    timerLines.push(
      `OnUnitInactiveSec=${formatSystemdDuration('onUnitInactiveSec', parsed.onUnitInactiveSec)}`,
    );
  }
  if (parsed.accuracySec !== undefined) {
    timerLines.push(`AccuracySec=${formatSystemdDuration('accuracySec', parsed.accuracySec)}`);
  }
  if (parsed.randomizedDelaySec !== undefined) {
    timerLines.push(
      `RandomizedDelaySec=${formatSystemdDuration('randomizedDelaySec', parsed.randomizedDelaySec)}`,
    );
  }
  if (parsed.persistent !== undefined) {
    timerLines.push(`Persistent=${parsed.persistent ? 'yes' : 'no'}`);
  }

  const sections: string[] = [unitLines.join('\n'), timerLines.join('\n')];
  if (parsed.wantedBy === undefined || parsed.wantedBy.length > 0) {
    const wantedBy = parsed.wantedBy ?? ['timers.target'];
    const targets = wantedBy.map((item, i) =>
      formatSystemdScalar(`wantedBy[${i}]`, item, false, true),
    );
    sections.push(['[Install]', `WantedBy=${targets.join(' ')}`].join('\n'));
  }
  return `${sections.join('\n\n')}\n`;
}
